import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";

import {
  defaultMaxInlineHtmlBytes,
  defaultMaxPageFileBytes,
  defaultMaxPayloadBytes,
  defaultSessionTtlMs,
  defaultTimeoutMs,
} from "./runtime/constants";

export type ResolvedOptions = {
  openBrowser: boolean;
  server: {
    hostname: string;
    port: number;
    publicBaseUrl?: string;
  };
  sessionTtlMs: number;
  defaultTimeoutMs: number;
  maxPayloadBytes: number;
  maxInlineHtmlBytes: number;
  maxPageFileBytes: number;
  pageDir: string;
};

export const defaultPageDir = (): string => join(tmpdir(), "opencode-html-sessions");

const isLoopbackHostname = (hostname: string): boolean =>
  hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";

const isHttpUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

const positiveInteger = v.pipe(
  v.number(),
  v.finite("必须是有限数值"),
  v.integer("必须是整数"),
  v.minValue(1, "必须是正整数"),
);

const serverSchema = v.pipe(
  v.optional(
    v.object({
      hostname: v.optional(
        v.pipe(v.string(), v.nonEmpty("server.hostname 必须是非空字符串")),
        "127.0.0.1",
      ),
      port: v.optional(
        v.pipe(
          v.number(),
          v.finite("server.port 必须是有限数值"),
          v.integer("server.port 必须是整数"),
          v.minValue(0),
          v.maxValue(65535),
          v.check(
            (port) => port === 0 || port >= 10_000,
            "server.port 必须是 0（随机）或 10000-65535 之间的端口",
          ),
        ),
        0,
      ),
      publicBaseUrl: v.optional(
        v.pipe(v.string(), v.nonEmpty("server.publicBaseUrl 必须是非空字符串")),
      ),
    }),
    { hostname: "127.0.0.1", port: 0 },
  ),
  v.check(
    (server) => isLoopbackHostname(server.hostname) || server.publicBaseUrl !== undefined,
    "非 loopback hostname 必须配置 server.publicBaseUrl",
  ),
  v.check(
    (server) => server.publicBaseUrl === undefined || isHttpUrl(server.publicBaseUrl),
    "server.publicBaseUrl 必须使用 http 或 https",
  ),
);

const optionsSchema = v.object({
  openBrowser: v.optional(v.boolean("openBrowser 必须是布尔值"), true),
  server: serverSchema,
  sessionTtlMs: v.optional(positiveInteger, defaultSessionTtlMs),
  defaultTimeoutMs: v.optional(positiveInteger, defaultTimeoutMs),
  maxPayloadBytes: v.optional(positiveInteger, defaultMaxPayloadBytes),
  maxInlineHtmlBytes: v.optional(positiveInteger, defaultMaxInlineHtmlBytes),
  maxPageFileBytes: v.optional(positiveInteger, defaultMaxPageFileBytes),
  pageDir: v.optional(v.pipe(v.string(), v.nonEmpty("pageDir 必须是非空字符串")), defaultPageDir()),
});

export const resolveOptions = (raw: unknown): ResolvedOptions => {
  const input = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return v.parse(optionsSchema, input) as ResolvedOptions;
};
