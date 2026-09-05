import { afterEach, describe, expect, it } from "bun:test";

import { createRuntimeServer } from "../../opencode-plugin/src/runtime/server";
import { createHtmlRuntime } from "../../opencode-plugin/src/runtime";

describe("安全 HTML runtime server", () => {
  const servers: Array<{ stop(force?: boolean): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop(true)));
  });

  it("提供 wrapper、当前页面和受保护提交 endpoint", async () => {
    const runtime = createHtmlRuntime({ openBrowser: false });
    const created = await runtime.createSession({ title: "选择", html: "<h1>safe</h1>" });
    const server = await createRuntimeServer(runtime, { skipBrowser: true });
    servers.push(server);

    const wrapper = await fetch(`${server.url}/session/${created.sessionId}`);
    expect(wrapper.status).toBe(200);
    expect(await wrapper.text()).toContain('sandbox="allow-scripts"');

    const page = await fetch(`${server.url}/session/${created.sessionId}/page`);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("<h1>safe</h1>");

    const waiting = runtime.waitSubmission({ sessionId: created.sessionId, timeoutMs: 500 });
    const response = await fetch(`${server.url}/session/${created.sessionId}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-runtime-token": runtime.getSession(created.sessionId)?.token ?? "" },
      body: JSON.stringify({ ...created, kind: "confirm", data: { ok: true }, metadata: {}, protocolVersion: 1 }),
    });
    expect(response.status).toBe(200);
    await expect(waiting).resolves.toMatchObject({ kind: "confirm", pageVersion: 1 });
  });

  it("拒绝缺少 token、错误 JSON、旧页面和超大 body", async () => {
    const runtime = createHtmlRuntime({ openBrowser: false });
    const created = await runtime.createSession({ html: "<p>page</p>" });
    const server = await createRuntimeServer(runtime, { skipBrowser: true, maxPayloadBytes: 1_000 });
    servers.push(server);
    const endpoint = `${server.url}/session/${created.sessionId}/submit`;
    const envelope = { sessionId: created.sessionId, pageId: created.pageId, pageVersion: 1, kind: "ok", data: {}, metadata: {}, protocolVersion: 1 };
    const headers = { "content-type": "application/json", "x-runtime-token": runtime.getSession(created.sessionId)?.token ?? "" };

    await expect(fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope) })).resolves.toMatchObject({ status: 401 });
    await expect(fetch(endpoint, { method: "POST", headers: { ...headers, "x-runtime-token": "wrong" }, body: JSON.stringify(envelope) })).resolves.toMatchObject({ status: 401 });
    await expect(fetch(endpoint, { method: "POST", headers, body: "{" })).resolves.toMatchObject({ status: 400 });
    await expect(fetch(endpoint, { method: "POST", headers, body: "x".repeat(1_001) })).resolves.toMatchObject({ status: 413 });
    await expect(fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ ...envelope, pageVersion: 2 }) })).resolves.toMatchObject({ status: 409 });
  });
});
