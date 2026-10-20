import {
  defaultDataDir,
  defaultMaxPageFileBytes,
  defaultMaxPayloadBytes,
  defaultSessionTtlMs,
  defaultTimeoutMs,
} from "./runtime/constants";
import type { OpenBrowserOption } from "./runtime/server";

export type HtmlInteractionPluginOptions = {
  openBrowser?: OpenBrowserOption;
  storage?: {
    mode?: "memory" | "disk";
    dataDir?: string;
    maxPageFileBytes?: number;
    // 会话结束后保留磁盘上的页面原件（仅 disk 模式有效），默认 false 即交互完删除
    retainPages?: boolean;
  };
  server?: {
    hostname?: string;
    port?: number;
    publicBaseUrl?: string;
  };
  sessionTtlMs?: number;
  defaultTimeoutMs?: number;
  maxPayloadBytes?: number;
};

export type HtmlInteractionConfig = {
  openBrowser?: OpenBrowserOption;
  storage: {
    mode: "memory" | "disk";
    dataDir: string;
    maxPageFileBytes: number;
    retainPages: boolean;
  };
  server: {
    hostname: string;
    port: number;
    publicBaseUrl?: string;
  };
  sessionTtlMs: number;
  defaultTimeoutMs: number;
  maxPayloadBytes: number;
};

const isLoopbackHostname = (hostname: string): boolean =>
  hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";

const isFinitePositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0;

export const resolveConfig = (
  options: HtmlInteractionPluginOptions = {},
): HtmlInteractionConfig => {
  const storage = options.storage ?? {};
  const mode = storage.mode ?? "memory";
  if (mode !== "memory" && mode !== "disk") throw new Error(`storage.mode 无效：${String(mode)}`);
  const dataDir = storage.dataDir ?? defaultDataDir;
  if (typeof dataDir !== "string" || dataDir.length === 0)
    throw new Error("storage.dataDir 必须是非空字符串");
  const maxPageFileBytes = storage.maxPageFileBytes ?? defaultMaxPageFileBytes;
  if (
    typeof maxPageFileBytes !== "number" ||
    !Number.isInteger(maxPageFileBytes) ||
    maxPageFileBytes <= 0
  )
    throw new Error("storage.maxPageFileBytes 必须是正整数");
  const retainPages = storage.retainPages ?? false;
  if (typeof retainPages !== "boolean") throw new Error("storage.retainPages 必须是布尔值");

  const server = options.server ?? {};
  const hostname = server.hostname ?? "127.0.0.1";
  if (typeof hostname !== "string" || hostname.length === 0)
    throw new Error("server.hostname 必须是非空字符串");
  const port = server.port ?? 0;
  const portInvalid =
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535 ||
    (port > 0 && port < 10000);
  if (portInvalid) throw new Error("server.port 必须是 0（随机）或 10000-65535 之间的 5 位数端口");
  const publicBaseUrl = server.publicBaseUrl;
  if (publicBaseUrl !== undefined) {
    if (typeof publicBaseUrl !== "string" || publicBaseUrl.length === 0)
      throw new Error("server.publicBaseUrl 必须是非空字符串");
    try {
      const parsed = new URL(publicBaseUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
    } catch {
      if (publicBaseUrl.startsWith("ftp:"))
        throw new Error("server.publicBaseUrl 必须使用 http 或 https");
      throw new Error(`server.publicBaseUrl 不是合法 URL：${publicBaseUrl}`);
    }
  }
  if (!isLoopbackHostname(hostname) && publicBaseUrl === undefined)
    throw new Error("非 loopback hostname 必须配置 server.publicBaseUrl");

  const sessionTtl = options.sessionTtlMs ?? defaultSessionTtlMs;
  if (!isFinitePositiveInteger(sessionTtl)) throw new Error("sessionTtlMs 必须是有限正整数");
  const timeout = options.defaultTimeoutMs ?? defaultTimeoutMs;
  if (!isFinitePositiveInteger(timeout)) throw new Error("defaultTimeoutMs 必须是有限正整数");
  const payloadBytes = options.maxPayloadBytes ?? defaultMaxPayloadBytes;
  if (!isFinitePositiveInteger(payloadBytes)) throw new Error("maxPayloadBytes 必须是正整数");

  return {
    openBrowser: options.openBrowser,
    storage: { mode, dataDir, maxPageFileBytes, retainPages },
    server: { hostname, port, publicBaseUrl },
    sessionTtlMs: sessionTtl,
    defaultTimeoutMs: timeout,
    maxPayloadBytes: payloadBytes,
  };
};
