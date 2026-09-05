import { afterEach, describe, expect, it } from "bun:test";

import { createHtmlRuntime } from "../../opencode-plugin/src/runtime";
import { createRuntimeServer } from "../../opencode-plugin/src/runtime/server";
import type { HtmlRuntime } from "../../opencode-plugin/src/runtime/types";

type PostResult = { status: number; code?: string };

// 只从 wrapper HTML 提取 sandbox iframe 的 page URL，不直接拼 runtime 内部状态
const extractPageUrl = (wrapperHtml: string): string => {
  const match = wrapperHtml.match(/<iframe sandbox="allow-scripts" src="([^"]+)"/);
  if (!match) throw new Error("wrapper HTML 未包含 sandbox iframe");
  return match[1];
};

const postEnvelope = async (
  endpoint: string,
  token: string,
  envelope: Record<string, unknown>,
): Promise<PostResult> => {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-runtime-token": token },
    body: JSON.stringify(envelope),
  });
  const body = (await response.json()) as { code?: string };
  return { status: response.status, code: body.code };
};

describe("runtime 集成流程", () => {
  const runtimes: HtmlRuntime[] = [];
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
    for (const runtime of runtimes.splice(0)) {
      await Promise.all(
        runtime.listSessions().map((session) => runtime.endSession(session.sessionId)),
      );
    }
  });

  it("通过 HTTP 路由完成创建、等待、更新、再等待、结束的完整流程", async () => {
    const runtime = createHtmlRuntime();
    runtimes.push(runtime);
    const resourceId = `integration-${crypto.randomUUID()}`;
    const created = await runtime.createSession({
      title: `集成 ${resourceId}`,
      html: `<main data-resource="${resourceId}"><h1>阶段 1</h1></main>`,
    });
    const server = await createRuntimeServer(runtime, { openBrowser: false });
    let serverStopped = false;
    cleanups.push(async () => {
      if (!serverStopped) {
        serverStopped = true;
        await server.stop(true);
      }
    });

    // wrapper 与 page 都只通过 HTTP 获取
    const wrapperResponse = await fetch(created.url);
    expect(wrapperResponse.status).toBe(200);
    const pageUrl = extractPageUrl(await wrapperResponse.text());
    const pageResponse = await fetch(pageUrl);
    expect(pageResponse.status).toBe(200);
    expect(await pageResponse.text()).toContain(resourceId);

    const endpoint = `${server.url}/session/${created.sessionId}/submit`;
    const token = runtime.getSession(created.sessionId)?.token ?? "";

    // 无效 token 的失败请求不破坏后续流程
    const unauthorized = await postEnvelope(endpoint, "invalid-token", {
      sessionId: created.sessionId,
      pageId: created.pageId,
      pageVersion: created.pageVersion,
      kind: "probe",
      data: {},
      metadata: {},
      protocolVersion: 1,
    });
    expect(unauthorized).toMatchObject({ status: 401, code: "INVALID_AUTHORITY" });

    // 第一阶段：等待并提交 version 1
    const firstWait = runtime.waitSubmission({ sessionId: created.sessionId, timeoutMs: 5_000 });
    firstWait.catch(() => undefined);
    const firstPost = await postEnvelope(endpoint, token, {
      sessionId: created.sessionId,
      pageId: created.pageId,
      pageVersion: created.pageVersion,
      kind: "phase-1",
      data: { resourceId },
      metadata: { source: "integration" },
      protocolVersion: 1,
    });
    expect(firstPost.status).toBe(200);
    await expect(firstWait).resolves.toMatchObject({
      kind: "phase-1",
      pageVersion: 1,
      data: { resourceId },
    });
    expect(runtime.countWaiters(created.sessionId)).toBe(0);
    expect(runtime.countLiveSessions()).toBe(1);

    // 更新到 version 2 并完成第二阶段提交
    const updated = await runtime.updateSession({
      sessionId: created.sessionId,
      html: `<main data-resource="${resourceId}"><h1>阶段 2</h1></main>`,
    });
    expect(updated.pageVersion).toBe(2);
    const updatedPage = await fetch(pageUrl);
    expect(updatedPage.status).toBe(200);
    expect(await updatedPage.text()).toContain("阶段 2");
    const secondWait = runtime.waitSubmission({ sessionId: created.sessionId, timeoutMs: 5_000 });
    secondWait.catch(() => undefined);
    const secondPost = await postEnvelope(endpoint, token, {
      sessionId: created.sessionId,
      pageId: updated.pageId,
      pageVersion: updated.pageVersion,
      kind: "phase-2",
      data: { resourceId, phase: 2 },
      metadata: {},
      protocolVersion: 1,
    });
    expect(secondPost.status).toBe(200);
    await expect(secondWait).resolves.toMatchObject({ kind: "phase-2", pageVersion: 2 });

    // 结束 session 且第二次结束幂等，无残留 session 或 waiter
    await expect(runtime.endSession(created.sessionId)).resolves.toEqual({ ok: true });
    await expect(runtime.endSession(created.sessionId)).resolves.toEqual({ ok: false });
    expect(runtime.countLiveSessions()).toBe(0);
    expect(runtime.countWaiters()).toBe(0);

    // server 停止后不再接受请求
    serverStopped = true;
    await server.stop(true);
    await expect(fetch(created.url)).rejects.toThrow();
  });
});
