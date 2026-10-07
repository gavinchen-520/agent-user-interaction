import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StorageDomain } from "../../src/runtime/metaStore";
import { createMetaStore } from "../../src/runtime/metaStore";
import { createPageStore } from "../../src/runtime/pageStore";
import { createRuntimeServer } from "../../src/runtime/server";
import { createHtmlRuntime } from "../../src/runtime/store";
import type { HtmlRuntime } from "../../src/runtime/types";

// 测试用内存 StorageDomain：scan 按 prefix 过滤并排序 backing 的 key
const memoryStorage = (backing: Map<string, unknown>): StorageDomain => ({
  get: async (key) => backing.get(key),
  set: async (key, value) => {
    backing.set(key, value);
  },
  remove: async (key) => {
    backing.delete(key);
  },
  scan: async ({ prefix, after }) => {
    const keys = [...backing.keys()]
      .filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
      .sort();
    return { entries: keys.map((key) => ({ key, value: backing.get(key) })) };
  },
});

const makeRuntime = (): HtmlRuntime =>
  createHtmlRuntime({
    metaStore: createMetaStore(memoryStorage(new Map())),
    pageStore: createPageStore(mkdtempSync(join(tmpdir(), "v2-server-external-"))),
  });

describe("外部访问 runtime server", () => {
  const servers: Array<{ stop(force?: boolean): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop(true)));
  });

  const freePort = (): number => 18000 + Math.floor(Math.random() * 20000);

  it("绑定非 loopback 地址 + 固定 5 位数端口", async () => {
    const port = freePort();
    const runtime = makeRuntime();
    const created = await runtime.createSession({ html: "<h1>external</h1>" });
    const server = await createRuntimeServer(runtime, {
      openBrowser: false,
      hostname: "0.0.0.0",
      port,
    });
    servers.push(server);

    expect(new URL(server.url).port).toBe(String(port));
    // 监听 0.0.0.0 的服务可通过 loopback 访问
    const response = await fetch(`http://127.0.0.1:${port}/session/${created.sessionId}`);
    expect(response.status).toBe(200);
  });

  it("publicBaseUrl 改写返回给用户的 URL 与 wrapper 提交地址", async () => {
    const runtime = makeRuntime();
    const server = await createRuntimeServer(runtime, {
      openBrowser: false,
      publicBaseUrl: "http://192.168.1.10:18000",
    });
    servers.push(server);

    const created = await runtime.createSession({ html: "<h1>public</h1>" });
    expect(created.url).toBe(`http://192.168.1.10:18000/session/${created.sessionId}`);

    const wrapper = await fetch(`${server.url}/session/${created.sessionId}`);
    const wrapperText = await wrapper.text();
    expect(wrapperText).toContain(`http://192.168.1.10:18000/session/${created.sessionId}/submit`);
  });

  it("Host 端口与监听端口不一致时返回 403", async () => {
    const runtime = makeRuntime();
    const created = await runtime.createSession({ html: "<p>x</p>" });
    const server = await createRuntimeServer(runtime, { openBrowser: false });
    servers.push(server);

    const response = await fetch(`${server.url}/session/${created.sessionId}`, {
      headers: { host: "evil.example.com:1" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "INVALID_AUTHORITY" });
  });

  it("反向代理使用 publicBaseUrl 端口时允许外部 authority", async () => {
    const runtime = makeRuntime();
    const created = await runtime.createSession({ html: "<p>proxy</p>" });
    const server = await createRuntimeServer(runtime, {
      openBrowser: false,
      publicBaseUrl: "https://proxy.example.com:443",
    });
    servers.push(server);

    const response = await fetch(`${server.url}/session/${created.sessionId}`, {
      headers: { host: "proxy.example.com:443" },
    });
    expect(response.status).toBe(200);
  });

  it("端口占用时抛出结构化启动错误", async () => {
    const port = freePort();
    const runtime1 = makeRuntime();
    const server = await createRuntimeServer(runtime1, { openBrowser: false, port });
    servers.push(server);

    const runtime2 = makeRuntime();
    await expect(createRuntimeServer(runtime2, { openBrowser: false, port })).rejects.toThrow(
      /runtime server 启动失败/,
    );
  });
});
