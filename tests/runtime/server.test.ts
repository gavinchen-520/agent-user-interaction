import { afterEach, describe, expect, it } from "bun:test";
import { createHtmlRuntime } from "../../opencode-v1-aui/src/runtime";
import {
  createRuntimeServer,
  readRequestBodyWithLimit,
} from "../../opencode-v1-aui/src/runtime/server";

describe("安全 HTML runtime server", () => {
  const servers: Array<{ stop(force?: boolean): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop(true)));
  });

  it("在没有 Content-Length 的请求体流超限时提前终止", async () => {
    const request = new Request("http://localhost/submit", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("12345"));
          controller.enqueue(new TextEncoder().encode("67890"));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);

    await expect(readRequestBodyWithLimit(request, 8)).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      status: 413,
    });
  });

  it("提供 wrapper、当前页面和受保护提交 endpoint", async () => {
    const runtime = createHtmlRuntime();
    const created = await runtime.createSession({ title: "选择", html: "<h1>safe</h1>" });
    const server = await createRuntimeServer(runtime, { openBrowser: false });
    servers.push(server);

    const wrapper = await fetch(`${server.url}/session/${created.sessionId}`);
    expect(wrapper.status).toBe(200);
    expect(await wrapper.text()).toContain('sandbox="allow-scripts"');
    expect(wrapper.headers.get("content-security-policy")).toContain("connect-src 'self'");

    const root = await fetch(server.url);
    expect(root.status).toBe(404);
    expect(await root.text()).not.toContain(runtime.getSession(created.sessionId)?.token ?? "");

    const page = await fetch(`${server.url}/session/${created.sessionId}/page`);
    expect(page.status).toBe(200);
    const pageText = await page.text();
    expect(pageText).toBe("<h1>safe</h1>");
    expect(pageText).not.toContain(runtime.getSession(created.sessionId)?.token ?? "");
    expect(page.headers.get("content-security-policy")).toContain("connect-src 'none'");
    expect(page.headers.get("content-security-policy")).toContain("navigate-to 'none'");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'unsafe-inline'");

    const waiting = runtime.waitSubmission({ sessionId: created.sessionId, timeoutMs: 500 });
    const response = await fetch(`${server.url}/session/${created.sessionId}/submit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-runtime-token": runtime.getSession(created.sessionId)?.token ?? "",
      },
      body: JSON.stringify({
        ...created,
        kind: "confirm",
        data: { ok: true },
        metadata: {},
        protocolVersion: 1,
      }),
    });
    expect(response.status).toBe(200);
    await expect(waiting).resolves.toMatchObject({ kind: "confirm", pageVersion: 1 });
  });

  it("server 启动后创建 session 会返回可直接打开的 wrapper URL", async () => {
    const runtime = createHtmlRuntime();
    const server = await createRuntimeServer(runtime, { openBrowser: false });
    servers.push(server);
    const created = await runtime.createSession({ html: "<h1>after server</h1>" });

    expect(created.url).toBe(`${server.url}/session/${created.sessionId}`);
  });

  it("server 启动后会回写已创建 session 的 URL", async () => {
    const runtime = createHtmlRuntime();
    const created = await runtime.createSession({ html: "<h1>before server</h1>" });
    const server = await createRuntimeServer(runtime, { openBrowser: false });
    servers.push(server);

    const parsedUrl = new URL(created.url);
    expect(parsedUrl.port).toBe(new URL(server.url).port);
    expect((await fetch(created.url)).status).toBe(200);
  });

  it("提供版本查询 endpoint，供 wrapper 自动刷新", async () => {
    const runtime = createHtmlRuntime();
    const created = await runtime.createSession({ html: "<p>v1</p>" });
    const server = await createRuntimeServer(runtime, { openBrowser: false });
    servers.push(server);
    const versionUrl = `${server.url}/session/${created.sessionId}/version`;

    const first = await fetch(versionUrl);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ pageVersion: 1, pageId: created.pageId });

    const updated = await runtime.updateSession({
      sessionId: created.sessionId,
      html: "<p>v2</p>",
    });
    const second = await fetch(versionUrl);
    expect(await second.json()).toEqual({
      pageVersion: updated.pageVersion,
      pageId: updated.pageId,
    });

    await expect(fetch(versionUrl, { method: "POST" })).resolves.toMatchObject({ status: 405 });
    await expect(fetch(`${server.url}/session/unknown/version`)).resolves.toMatchObject({
      status: 404,
    });
  });

  it("拒绝缺少 token、错误 JSON、旧页面和超大 body", async () => {
    const runtime = createHtmlRuntime();
    const created = await runtime.createSession({ html: "<p>page</p>" });
    const server = await createRuntimeServer(runtime, {
      openBrowser: false,
      maxPayloadBytes: 1_000,
    });
    servers.push(server);
    const endpoint = `${server.url}/session/${created.sessionId}/submit`;
    const envelope = {
      sessionId: created.sessionId,
      pageId: created.pageId,
      pageVersion: 1,
      kind: "ok",
      data: {},
      metadata: {},
      protocolVersion: 1,
    };
    const headers = {
      "content-type": "application/json",
      "x-runtime-token": runtime.getSession(created.sessionId)?.token ?? "",
    };

    await expect(
      fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
      }),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      fetch(endpoint, {
        method: "POST",
        headers: { ...headers, "x-runtime-token": "wrong" },
        body: JSON.stringify(envelope),
      }),
    ).resolves.toMatchObject({ status: 401 });
    await expect(fetch(endpoint, { method: "POST", headers, body: "{" })).resolves.toMatchObject({
      status: 400,
    });
    const malformedEnvelope = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "missing-session" }),
    });
    expect(malformedEnvelope.status).toBe(400);
    expect(await malformedEnvelope.json()).toMatchObject({
      code: "INVALID_ENVELOPE",
      context: "submit",
      action: expect.any(String),
    });
    await expect(
      fetch(endpoint, { method: "POST", headers, body: "x".repeat(1_001) }),
    ).resolves.toMatchObject({ status: 413 });
    await expect(
      fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...envelope, pageVersion: 2 }),
      }),
    ).resolves.toMatchObject({ status: 409 });
  });

  it("为所有路由错误返回稳定 JSON envelope，并校验 authority 和 session/page", async () => {
    const runtime = createHtmlRuntime();
    const created = await runtime.createSession({ html: "<p>page</p>" });
    const server = await createRuntimeServer(runtime, { openBrowser: false });
    servers.push(server);
    const endpoint = `${server.url}/session/${created.sessionId}/submit`;
    const getError = async (url: string, init?: RequestInit) => {
      const response = await fetch(url, init);
      return {
        status: response.status,
        body: (await response.json()) as { code: string; context: string; action: string },
      };
    };
    const validHeaders = {
      "content-type": "application/json",
      "x-runtime-token": runtime.getSession(created.sessionId)?.token ?? "",
    };
    const envelope = {
      sessionId: created.sessionId,
      pageId: created.pageId,
      pageVersion: 1,
      kind: "ok",
      data: {},
      metadata: {},
      protocolVersion: 1,
    };

    await expect(getError(`${server.url}/missing`)).resolves.toMatchObject({
      status: 404,
      body: { code: "ROUTE_NOT_FOUND", context: "route" },
    });
    await expect(getError(endpoint, { method: "GET" })).resolves.toMatchObject({
      status: 405,
      body: { code: "METHOD_NOT_ALLOWED", context: "submit", action: expect.any(String) },
    });
    await expect(
      getError(endpoint, {
        method: "POST",
        headers: { ...validHeaders, host: "127.0.0.1:1" },
        body: JSON.stringify(envelope),
      }),
    ).resolves.toMatchObject({ status: 403, body: { code: "INVALID_AUTHORITY" } });
    // Origin 不再参与校验（访问控制由 x-runtime-token 承担），跨 Origin 请求可正常提交
    await expect(
      getError(endpoint, {
        method: "POST",
        headers: { ...validHeaders, origin: "http://localhost:1234" },
        body: JSON.stringify(envelope),
      }),
    ).resolves.toMatchObject({ status: 200, body: { ok: true } });
    await expect(getError(`${server.url}/session/unknown/page`)).resolves.toMatchObject({
      status: 404,
      body: { code: "SESSION_NOT_FOUND" },
    });
    await expect(
      getError(endpoint, {
        method: "POST",
        headers: validHeaders,
        body: JSON.stringify({ ...envelope, pageId: "old" }),
      }),
    ).resolves.toMatchObject({ status: 409, body: { code: "STALE_PAGE" } });
  });

  it("重复提交只接受一次并返回稳定错误", async () => {
    const runtime = createHtmlRuntime();
    const created = await runtime.createSession({ html: "<p>page</p>" });
    const server = await createRuntimeServer(runtime, { openBrowser: false });
    servers.push(server);
    const endpoint = `${server.url}/session/${created.sessionId}/submit`;
    const headers = {
      "content-type": "application/json",
      "x-runtime-token": runtime.getSession(created.sessionId)?.token ?? "",
    };
    const body = JSON.stringify({
      sessionId: created.sessionId,
      pageId: created.pageId,
      pageVersion: 1,
      kind: "ok",
      data: {},
      metadata: {},
      protocolVersion: 1,
    });
    await expect(fetch(endpoint, { method: "POST", headers, body })).resolves.toMatchObject({
      status: 200,
    });
    const duplicate = await fetch(endpoint, { method: "POST", headers, body });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({
      code: "DUPLICATE_SUBMISSION",
      context: "submit",
    });
  });

  it("GET / 返回中性 404，不暴露任何 session token", async () => {
    const runtime = createHtmlRuntime();
    await runtime.createSession({ html: "<p>a</p>" });
    await runtime.createSession({ html: "<p>b</p>" });
    const server = await createRuntimeServer(runtime, { openBrowser: false });
    servers.push(server);

    const root = await fetch(server.url);
    expect(root.status).toBe(404);
    const body = await root.text();
    for (const session of runtime.listSessions()) {
      expect(body).not.toContain(session.token);
    }
  });

  it("server 启动时没有 session 则跳过浏览器打开", async () => {
    const runtime = createHtmlRuntime();
    let openedCount = 0;
    const server = await createRuntimeServer(runtime, {
      openBrowser: async () => {
        openedCount += 1;
      },
    });
    servers.push(server);
    expect(openedCount).toBe(0);
  });

  it("浏览器打开失败时停止 server", async () => {
    const runtime = createHtmlRuntime();
    const created = await runtime.createSession({ html: "<p>page</p>" });
    let openedUrl = "";
    await expect(
      createRuntimeServer(runtime, {
        openBrowser: async (url) => {
          openedUrl = url;
          throw new Error("browser unavailable");
        },
      }),
    ).rejects.toThrow("browser unavailable");
    expect(openedUrl).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:\\d+/session/${created.sessionId}$`),
    );
    await expect(fetch(openedUrl)).rejects.toThrow();
  });
});
