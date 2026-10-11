import type { MetaStore } from "./metaStore";
import type { PageStore } from "./pageStore";

export type SessionStatus =
  | "created"
  | "opened"
  | "waiting"
  | "submitted"
  | "processing"
  | "expired"
  | "failed"
  | "cancelled"
  | "ended";

export type RuntimeErrorCode =
  | "INVALID_ENVELOPE"
  | "INVALID_PAGE_VERSION"
  | "INVALID_HTML"
  | "HTML_TOO_LARGE_FOR_INLINE"
  | "HTML_TOO_LARGE"
  | "PAYLOAD_TOO_LARGE"
  | "SESSION_NOT_FOUND"
  | "SESSION_ENDED"
  | "STALE_PAGE"
  | "DUPLICATE_SUBMISSION"
  | "WAIT_TIMEOUT"
  | "WAIT_CANCELLED"
  | "BROWSER_OPEN_FAILED"
  | "INVALID_AUTHORITY"
  | "ROUTE_NOT_FOUND"
  | "METHOD_NOT_ALLOWED";

export type RuntimeError = Error & {
  code: RuntimeErrorCode;
  status: number;
  action: string;
};

export type SubmissionEnvelope = {
  sessionId: string;
  pageId: string;
  pageVersion: number;
  kind: string;
  data: unknown;
  metadata: unknown;
  protocolVersion: 1;
};

export type CreateSessionInput = {
  title?: string;
  html: string;
  opencodeSessionId?: string;
  initialState?: unknown;
};

export type CreateSessionOutput = {
  sessionId: string;
  pageId: string;
  pageVersion: number;
  url: string;
  // 页面正文的临时文件路径，供观测日志定位原件
  pageFilePath?: string;
};

export type WaitSubmissionInput = {
  sessionId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type SubmissionOutput = {
  kind: string;
  data: unknown;
  metadata: unknown;
  pageVersion: number;
};

export type UpdateSessionInput = {
  sessionId: string;
  html: string;
  state?: unknown;
};

export type UpdateSessionOutput = {
  pageId: string;
  pageVersion: number;
};

export type EndSessionOutput = { ok: boolean };

export type RuntimeSession = {
  sessionId: string;
  opencodeSessionId?: string;
  title?: string;
  pageId: string;
  pageVersion: number;
  // 页面正文一律落盘，由 pageFile 指向磁盘读穿；不再内存持有 HTML
  pageFile?: string;
  state?: unknown;
  token: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  submittedPageVersion?: number;
  // 无 waiter 时到达的提交缓存，供下一次 waitSubmission 立即消费
  pendingSubmission?: SubmissionOutput;
};

export type RuntimeOptions = {
  maxPayloadBytes?: number;
  defaultTimeoutMs?: number;
  sessionTtlMs?: number;
  cleanupIntervalMs?: number;
  baseUrl?: string;
  metaStore: MetaStore;
  pageStore: PageStore;
};

export type HtmlRuntime = {
  createSession(input: CreateSessionInput): Promise<CreateSessionOutput>;
  waitSubmission(input: WaitSubmissionInput): Promise<SubmissionOutput>;
  updateSession(input: UpdateSessionInput): Promise<UpdateSessionOutput>;
  endSession(sessionId: string): Promise<EndSessionOutput>;
  getSession(sessionId: string): RuntimeSession | undefined;
  openSession(sessionId: string): RuntimeSession;
  processSession(sessionId: string): RuntimeSession;
  submitSubmission(value: unknown): Promise<{ ok: true; submission: SubmissionEnvelope }>;
  listSessions(): RuntimeSession[];
  setBaseUrl(baseUrl: string): void;
  countWaiters(sessionId?: string): number;
  countLiveSessions(): number;
  // 从 metaStore/pageStore 重建内存索引，清理损坏/终态/过期/孤儿项
  restore(): Promise<void>;
  // 释放进程内资源（清内存索引与 waiter、停止周期清理），不删除磁盘文件
  dispose(): void;
};
