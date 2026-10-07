import { literal, number, object, optional, safeParse, string, unknown } from "valibot";

import { isJsonSerializable } from "./protocol";

// ctx.storage 的最小结构约束（Task 9 用真实 ctx.storage 适配实现）
export type StorageDomain = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  scan(options: {
    prefix: string;
    limit?: number;
    after?: string;
  }): Promise<{ entries: { key: string; value: unknown }[]; next?: string }>;
};

// 与 V1 SessionMetaFile 对齐的可序列化元数据形态
export type SessionMeta = {
  schemaVersion: 1;
  sessionId: string;
  opencodeSessionId?: string;
  title?: string;
  pageId: string;
  pageVersion: number;
  token: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  pageFileName: string;
  submittedPageVersion?: number;
  state?: unknown;
};

export type PendingSubmission = {
  kind: string;
  data: unknown;
  metadata: unknown;
  pageVersion: number;
};

export type MetaStore = {
  read(sessionId: string): Promise<SessionMeta | undefined>;
  write(meta: SessionMeta): Promise<void>;
  remove(sessionId: string): Promise<void>;
  scanAll(): Promise<SessionMeta[]>;
  readPending(sessionId: string): Promise<PendingSubmission | undefined>;
  writePending(sessionId: string, pending: PendingSubmission): Promise<void>;
  removePending(sessionId: string): Promise<void>;
};

const schemaVersion = 1 as const;

const metaSchema = object({
  schemaVersion: literal(schemaVersion),
  sessionId: string(),
  opencodeSessionId: optional(string()),
  title: optional(string()),
  pageId: string(),
  pageVersion: number(),
  token: string(),
  status: string(),
  createdAt: number(),
  updatedAt: number(),
  pageFileName: string(),
  submittedPageVersion: optional(number()),
  state: optional(unknown()),
});

const pendingSchema = object({
  kind: string(),
  data: unknown(),
  metadata: unknown(),
  pageVersion: number(),
});

const metaKey = (sessionId: string): string => `session/${sessionId}/meta`;
const pendingKey = (sessionId: string): string => `session/${sessionId}/pending`;
const metaSuffix = "/meta";
const scanPrefix = "session/";

// 损坏值一律返回 undefined，绝不让非法数据以类型断言进入状态机
const parseMeta = (value: unknown): SessionMeta | undefined => {
  const result = safeParse(metaSchema, value);
  if (!result.success) return undefined;
  if (result.output.state !== undefined && !isJsonSerializable(result.output.state))
    return undefined;
  return result.output;
};

const parsePending = (value: unknown): PendingSubmission | undefined => {
  const result = safeParse(pendingSchema, value);
  if (!result.success) return undefined;
  if (!isJsonSerializable(result.output.data) || !isJsonSerializable(result.output.metadata)) {
    return undefined;
  }
  return result.output;
};

export const createMetaStore = (storage: StorageDomain): MetaStore => ({
  read: async (sessionId) => parseMeta(await storage.get(metaKey(sessionId))),
  write: async (meta) => {
    await storage.set(metaKey(meta.sessionId), meta);
  },
  remove: async (sessionId) => {
    await storage.remove(metaKey(sessionId));
  },
  scanAll: async () => {
    const metas: SessionMeta[] = [];
    let after: string | undefined;
    do {
      const page = await storage.scan(
        after === undefined ? { prefix: scanPrefix } : { prefix: scanPrefix, after },
      );
      for (const entry of page.entries) {
        if (!entry.key.endsWith(metaSuffix)) continue;
        const meta = parseMeta(entry.value);
        if (meta) metas.push(meta);
      }
      after = page.next;
    } while (after);
    return metas;
  },
  readPending: async (sessionId) => parsePending(await storage.get(pendingKey(sessionId))),
  writePending: async (sessionId, pending) => {
    await storage.set(pendingKey(sessionId), pending);
  },
  removePending: async (sessionId) => {
    await storage.remove(pendingKey(sessionId));
  },
});
