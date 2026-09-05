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
  | "PAYLOAD_TOO_LARGE"
  | "SESSION_NOT_FOUND"
  | "SESSION_ENDED"
  | "STALE_PAGE"
  | "DUPLICATE_SUBMISSION"
  | "WAIT_TIMEOUT";

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
  initialState?: unknown;
};

export type CreateSessionOutput = {
  sessionId: string;
  pageId: string;
  pageVersion: number;
  url: string;
};

export type WaitSubmissionInput = {
  sessionId: string;
  timeoutMs?: number;
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
  title?: string;
  pageId: string;
  pageVersion: number;
  html: string;
  state?: unknown;
  token: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  submittedPageVersion?: number;
};

export type RuntimeOptions = {
  maxPayloadBytes?: number;
  defaultTimeoutMs?: number;
  sessionTtlMs?: number;
  baseUrl?: string;
  openBrowser?: boolean;
};

export type HtmlRuntime = {
  createSession(input: CreateSessionInput): Promise<CreateSessionOutput>;
  waitSubmission(input: WaitSubmissionInput): Promise<SubmissionOutput>;
  updateSession(input: UpdateSessionInput): Promise<UpdateSessionOutput>;
  endSession(sessionId: string): Promise<EndSessionOutput>;
  getSession(sessionId: string): RuntimeSession | undefined;
  submitSubmission(value: unknown): Promise<{ ok: true; submission: SubmissionEnvelope }>;
};
