import { describe, expect, it } from "bun:test";

import { resolveConfig } from "../opencode-v1-aui/src/config";

describe("resolveConfig 配置校验", () => {
  it("不传任何选项时返回与现状一致的默认值", () => {
    const config = resolveConfig();
    expect(config.storage.mode).toBe("memory");
    expect(config.storage.dataDir).toBe(".opencode/html-sessions");
    expect(config.storage.maxPageFileBytes).toBe(3 * 1024 * 1024);
    expect(config.storage.retainPages).toBe(false);
    expect(config.server.hostname).toBe("127.0.0.1");
    expect(config.server.port).toBe(0);
    expect(config.server.publicBaseUrl).toBeUndefined();
    expect(config.sessionTtlMs).toBe(30 * 60 * 1000);
    expect(config.defaultTimeoutMs).toBe(300_000);
    expect(config.maxPayloadBytes).toBe(64 * 1024);
  });

  it("接受 0（随机）和 5 位数端口", () => {
    expect(resolveConfig({ server: { port: 0 } }).server.port).toBe(0);
    expect(resolveConfig({ server: { port: 10000 } }).server.port).toBe(10000);
    expect(resolveConfig({ server: { port: 65535 } }).server.port).toBe(65535);
  });

  it("拒绝 4 位数与越界端口", () => {
    expect(() => resolveConfig({ server: { port: 7800 } })).toThrow(
      "server.port 必须是 0（随机）或 10000-65535 之间的 5 位数端口",
    );
    expect(() => resolveConfig({ server: { port: 9999 } })).toThrow("5 位数端口");
    expect(() => resolveConfig({ server: { port: 100000 } })).toThrow("5 位数端口");
    expect(() => resolveConfig({ server: { port: -1 } })).toThrow("5 位数端口");
    expect(() => resolveConfig({ server: { port: 1.5 } })).toThrow("5 位数端口");
  });

  it("拒绝非法 storage.mode", () => {
    expect(() => resolveConfig({ storage: { mode: "db" as never } })).toThrow("storage.mode 无效");
  });

  it("拒绝非法 publicBaseUrl", () => {
    expect(() => resolveConfig({ server: { publicBaseUrl: "" } })).toThrow(
      "server.publicBaseUrl 必须是非空字符串",
    );
    expect(() => resolveConfig({ server: { publicBaseUrl: "not a url" } })).toThrow(
      "server.publicBaseUrl 不是合法 URL",
    );
  });

  it("storage.retainPages 默认 false，可为 true，拒绝非布尔值", () => {
    expect(resolveConfig().storage.retainPages).toBe(false);
    expect(resolveConfig({ storage: { retainPages: true } }).storage.retainPages).toBe(true);
    expect(() => resolveConfig({ storage: { retainPages: "yes" as unknown as boolean } })).toThrow(
      "storage.retainPages 必须是布尔值",
    );
  });

  it("拒绝非法 maxPageFileBytes 与空 dataDir", () => {
    expect(() => resolveConfig({ storage: { maxPageFileBytes: 0 } })).toThrow(
      "storage.maxPageFileBytes 必须是正整数",
    );
    expect(() => resolveConfig({ storage: { maxPageFileBytes: 1.5 } })).toThrow("正整数");
    expect(() => resolveConfig({ storage: { dataDir: "" } })).toThrow(
      "storage.dataDir 必须是非空字符串",
    );
  });

  it("拒绝非法 sessionTtlMs / defaultTimeoutMs / maxPayloadBytes", () => {
    expect(() => resolveConfig({ sessionTtlMs: 0 })).toThrow("sessionTtlMs 必须是有限正整数");
    expect(() => resolveConfig({ defaultTimeoutMs: -1 })).toThrow(
      "defaultTimeoutMs 必须是有限正整数",
    );
    expect(() => resolveConfig({ maxPayloadBytes: 1.5 })).toThrow("maxPayloadBytes 必须是正整数");
    expect(() => resolveConfig({ sessionTtlMs: Number.NaN })).toThrow(
      "sessionTtlMs 必须是有限正整数",
    );
    expect(() => resolveConfig({ defaultTimeoutMs: Number.POSITIVE_INFINITY })).toThrow(
      "defaultTimeoutMs 必须是有限正整数",
    );
  });

  it("拒绝非 HTTP(S) publicBaseUrl", () => {
    expect(() => resolveConfig({ server: { publicBaseUrl: "ftp://example.com" } })).toThrow(
      "server.publicBaseUrl 必须使用 http 或 https",
    );
  });

  it("外部监听时要求显式 publicBaseUrl", () => {
    expect(() => resolveConfig({ server: { hostname: "0.0.0.0" } })).toThrow(
      "非 loopback hostname 必须配置 server.publicBaseUrl",
    );
  });
});
