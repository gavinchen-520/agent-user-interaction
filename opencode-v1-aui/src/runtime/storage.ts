import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { boolean, literal, number, object, optional, safeParse, string, unknown } from "valibot";
import { isJsonSerializable } from "./protocol";
import type { RuntimeSession, SubmissionOutput } from "./types";

// 磁盘上 meta.json 的可序列化形态，与内存 RuntimeSession 分离，避免耦合运行时类型
export type SessionMetaFile = {
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
  retained?: boolean;
  state?: unknown;
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
  retained: optional(boolean()),
  state: optional(unknown()),
});

const pendingSchema = object({
  kind: string(),
  data: unknown(),
  metadata: unknown(),
  pageVersion: number(),
});

const metaFileName = "meta.json";
const pageFileName = "page.html";
const pendingFileName = "pending.json";

const toMetaFile = (session: RuntimeSession): SessionMetaFile => ({
  schemaVersion,
  sessionId: session.sessionId,
  opencodeSessionId: session.opencodeSessionId,
  title: session.title,
  pageId: session.pageId,
  pageVersion: session.pageVersion,
  token: session.token,
  status: session.status,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  pageFileName: session.htmlFile ? basename(session.htmlFile) : pageFileName,
  submittedPageVersion: session.submittedPageVersion,
  retained: session.retained,
  state: session.state,
});

export type DiskStorage = {
  dataDir: string;
  pageFilePath(sessionId: string, pageVersion?: number): string;
  listSessionIds(): string[];
  readMeta(sessionId: string): SessionMetaFile | undefined;
  writeMeta(session: RuntimeSession): void;
  writePage(sessionId: string, pageVersion: number, html: string): void;
  hasPage(sessionId: string, pageFileName?: string): boolean;
  writePending(sessionId: string, pending: unknown): void;
  readPending(sessionId: string): SubmissionOutput | undefined;
  deletePending(sessionId: string): void;
  deleteSession(sessionId: string): void;
};

export const createDiskStorage = (dataDir: string): DiskStorage => {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const sessionDir = (sessionId: string) => join(dataDir, sessionId);
  const filePath = (sessionId: string, name: string) => join(sessionDir(sessionId), name);

  // 原子写：先写临时文件再 rename，避免崩溃留下半截文件
  const atomicWrite = (path: string, content: string): void => {
    const tmp = `${path}.tmp-${crypto.randomUUID()}`;
    writeFileSync(tmp, content, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  };

  const ensureSessionDir = (sessionId: string): void => {
    mkdirSync(sessionDir(sessionId), { recursive: true, mode: 0o700 });
    chmodSync(sessionDir(sessionId), 0o700);
  };

  return {
    dataDir,
    pageFilePath: (sessionId, pageVersion = 1) =>
      filePath(sessionId, pageVersion === 1 ? pageFileName : `page-${pageVersion}.html`),
    listSessionIds: () =>
      readdirSync(dataDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("html_"))
        .map((entry) => entry.name),
    readMeta: (sessionId) => {
      const path = filePath(sessionId, metaFileName);
      if (!existsSync(path)) return undefined;
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        const result = safeParse(metaSchema, parsed);
        return result.success ? result.output : undefined;
      } catch {
        return undefined;
      }
    },
    writeMeta: (session) => {
      ensureSessionDir(session.sessionId);
      atomicWrite(filePath(session.sessionId, metaFileName), JSON.stringify(toMetaFile(session)));
    },
    writePage: (sessionId, pageVersion, html) => {
      ensureSessionDir(sessionId);
      atomicWrite(
        filePath(sessionId, pageVersion === 1 ? pageFileName : `page-${pageVersion}.html`),
        html,
      );
    },
    hasPage: (sessionId, currentPageFileName = pageFileName) =>
      existsSync(filePath(sessionId, currentPageFileName)),
    writePending: (sessionId, pending) => {
      ensureSessionDir(sessionId);
      atomicWrite(filePath(sessionId, pendingFileName), JSON.stringify(pending));
    },
    readPending: (sessionId): SubmissionOutput | undefined => {
      const path = filePath(sessionId, pendingFileName);
      if (!existsSync(path)) return undefined;
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        const result = safeParse(pendingSchema, parsed);
        if (!result.success || !isJsonSerializable(result.output.data)) return undefined;
        if (!isJsonSerializable(result.output.metadata)) return undefined;
        return result.output;
      } catch {
        return undefined;
      }
    },
    deletePending: (sessionId) => {
      const path = filePath(sessionId, pendingFileName);
      if (existsSync(path)) rmSync(path);
    },
    deleteSession: (sessionId) => {
      const dir = sessionDir(sessionId);
      if (existsSync(dir)) {
        if (lstatSync(dir).isDirectory()) rmSync(dir, { recursive: true, force: true });
        else rmSync(dir, { force: true });
      }
    },
  };
};
