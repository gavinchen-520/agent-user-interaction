import { describe, expect, it } from "bun:test";

import { createHtmlRuntime } from "../../opencode-plugin/src/runtime";

describe("HTML session runtime", () => {
  it("创建页面为版本 1，更新生成版本 2 和新 pageId", async () => {
    const runtime = createHtmlRuntime({ openBrowser: false });
    const created = await runtime.createSession({ html: "<h1>one</h1>" });
    const updated = await runtime.updateSession({
      sessionId: created.sessionId,
      html: "<h1>two</h1>",
    });

    expect(created.pageVersion).toBe(1);
    expect(created.pageId).toBeString();
    expect(updated.pageVersion).toBe(2);
    expect(updated.pageId).not.toBe(created.pageId);
  });

  it("首个有效提交唤醒 waiter，重复提交不再唤醒", async () => {
    const runtime = createHtmlRuntime({ openBrowser: false });
    const created = await runtime.createSession({ html: "<button>ok</button>" });
    const envelope = {
      sessionId: created.sessionId,
      pageId: created.pageId,
      pageVersion: created.pageVersion,
      kind: "confirmation",
      data: { ok: true },
      metadata: {},
      protocolVersion: 1 as const,
    };
    const waiting = runtime.waitSubmission({ sessionId: created.sessionId, timeoutMs: 100 });
    expect(await runtime.submitSubmission(envelope)).toEqual({
      ok: true,
      submission: envelope,
    });
    await expect(waiting).resolves.toMatchObject({ kind: "confirmation", pageVersion: 1 });
    await expect(runtime.submitSubmission(envelope)).rejects.toThrow(
      expect.objectContaining({ code: "DUPLICATE_SUBMISSION" }),
    );
  });

  it("拒绝旧页面提交，超时返回 WAIT_TIMEOUT，结束操作幂等", async () => {
    const runtime = createHtmlRuntime({ openBrowser: false });
    const created = await runtime.createSession({ html: "<h1>one</h1>" });
    const updated = await runtime.updateSession({ sessionId: created.sessionId, html: "<h1>two</h1>" });
    await expect(runtime.submitSubmission({
      sessionId: created.sessionId,
      pageId: created.pageId,
      pageVersion: created.pageVersion,
      kind: "stale",
      data: null,
      metadata: null,
      protocolVersion: 1,
    })).rejects.toThrow(expect.objectContaining({ code: "STALE_PAGE" }));
    await expect(runtime.waitSubmission({ sessionId: created.sessionId, timeoutMs: 1 })).rejects.toThrow(
      expect.objectContaining({ code: "WAIT_TIMEOUT" }),
    );
    expect(await runtime.endSession(created.sessionId)).toEqual({ ok: true });
    expect(await runtime.endSession(created.sessionId)).toEqual({ ok: false });
    expect(updated.pageVersion).toBe(2);
  });
});
