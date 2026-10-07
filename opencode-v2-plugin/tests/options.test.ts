import { expect, test } from "bun:test";
import { resolveOptions } from "../src/options";

test("默认值", () => {
  const o = resolveOptions(undefined);
  expect(o.server).toEqual({ hostname: "127.0.0.1", port: 0 });
  expect(o.sessionTtlMs).toBe(1_800_000);
  expect(o.defaultTimeoutMs).toBe(300_000);
  expect(o.maxPayloadBytes).toBe(65_536);
  expect(o.maxInlineHtmlBytes).toBe(65_536);
  expect(o.maxPageFileBytes).toBe(3_145_728);
  expect(o.openBrowser).toBe(true);
  expect(o.pageDir.endsWith("opencode-html-sessions")).toBe(true);
});

test("非对象输入按默认值", () => {
  expect(resolveOptions(null).server).toEqual({ hostname: "127.0.0.1", port: 0 });
  expect(resolveOptions(42).sessionTtlMs).toBe(1_800_000);
  expect(resolveOptions("x").openBrowser).toBe(true);
});

test("非 loopback 缺 publicBaseUrl 抛错", () => {
  expect(() => resolveOptions({ server: { hostname: "0.0.0.0" } })).toThrow();
});

test("非法端口抛错", () => {
  expect(() => resolveOptions({ server: { port: 80 } })).toThrow();
});

test("端口边界", () => {
  expect(resolveOptions({ server: { port: 0 } }).server.port).toBe(0);
  expect(resolveOptions({ server: { port: 10000 } }).server.port).toBe(10_000);
  expect(resolveOptions({ server: { port: 65535 } }).server.port).toBe(65_535);
  expect(() => resolveOptions({ server: { port: 9999 } })).toThrow();
  expect(() => resolveOptions({ server: { port: 65536 } })).toThrow();
  expect(() => resolveOptions({ server: { port: 1.5 } })).toThrow();
});

test("publicBaseUrl 仅 http/https", () => {
  expect(() =>
    resolveOptions({ server: { hostname: "0.0.0.0", publicBaseUrl: "ftp://x.example" } }),
  ).toThrow();
  const o = resolveOptions({
    server: { hostname: "0.0.0.0", publicBaseUrl: "https://x.example" },
  });
  expect(o.server.publicBaseUrl).toBe("https://x.example");
});

test("对象形式覆盖", () => {
  const o = resolveOptions({ server: { port: 15073, hostname: "127.0.0.1" }, pageDir: "/tmp/x" });
  expect(o.server.port).toBe(15073);
  expect(o.pageDir).toBe("/tmp/x");
});

test("非法数值抛错", () => {
  expect(() => resolveOptions({ sessionTtlMs: -1 })).toThrow();
  expect(() => resolveOptions({ defaultTimeoutMs: 1.2 })).toThrow();
  expect(() => resolveOptions({ maxPayloadBytes: Number.NaN })).toThrow();
  expect(() => resolveOptions({ maxInlineHtmlBytes: 0 })).toThrow();
  expect(() => resolveOptions({ openBrowser: "yes" })).toThrow();
  expect(() => resolveOptions({ pageDir: "" })).toThrow();
});
