import {
  defaultMaxPayloadBytes,
  defaultSessionTtlMs,
  defaultTimeoutMs,
} from "./constants";
import {
  createRuntimeError,
  isJsonSerializable,
  parseSubmissionWithLimit,
} from "./protocol";
import { createWaiterRegistry } from "./waiter";
import type {
  CreateSessionInput,
  CreateSessionOutput,
  EndSessionOutput,
  HtmlRuntime,
  RuntimeOptions,
  RuntimeSession,
  SubmissionEnvelope,
  SubmissionOutput,
  UpdateSessionInput,
  UpdateSessionOutput,
  WaitSubmissionInput,
} from "./types";

export const createHtmlRuntime = (options: RuntimeOptions = {}): HtmlRuntime => {
  const sessions = new Map<string, RuntimeSession>();
  const waiters = createWaiterRegistry<string, SubmissionOutput>();
  const maxPayloadBytes = options.maxPayloadBytes ?? defaultMaxPayloadBytes;
  const timeoutMs = options.defaultTimeoutMs ?? defaultTimeoutMs;
  const sessionTtlMs = options.sessionTtlMs ?? defaultSessionTtlMs;
  let baseUrl = options.baseUrl ?? "http://127.0.0.1:0";
  const makeId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
  const getRequiredSession = (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) throw createRuntimeError("SESSION_NOT_FOUND", "session 不存在", 404, "检查 sessionId");
    if (["ended", "expired", "failed", "cancelled"].includes(session.status)) {
      throw createRuntimeError("SESSION_ENDED", "session 已结束", 410, "创建或使用新的 session");
    }
    if (Date.now() - session.createdAt > sessionTtlMs) {
      session.status = "expired";
      waiters.clear(sessionId, createRuntimeError("SESSION_ENDED", "session 已过期", 410, "创建新的 session"));
      throw createRuntimeError("SESSION_ENDED", "session 已过期", 410, "创建新的 session");
    }
    return session;
  };

  const validateState = (state: unknown) => {
    if (state !== undefined && !isJsonSerializable(state)) {
      throw createRuntimeError("INVALID_ENVELOPE", "session state 必须是 JSON 数据", 400, "移除不可序列化值");
    }
  };

  const createSession = async (input: CreateSessionInput): Promise<CreateSessionOutput> => {
    if (typeof input.html !== "string" || input.html.length === 0) {
      throw createRuntimeError("INVALID_ENVELOPE", "HTML 不能为空", 400, "提供 HTML");
    }
    validateState(input.initialState);
    const now = Date.now();
    const sessionId = makeId("html");
    const pageId = makeId("page");
    const session: RuntimeSession = {
      sessionId,
      title: input.title,
      pageId,
      pageVersion: 1,
      html: input.html,
      state: input.initialState,
      token: makeId("token"),
      status: "created",
      createdAt: now,
      updatedAt: now,
    };
    sessions.set(sessionId, session);
    return { sessionId, pageId, pageVersion: 1, url: `${baseUrl}/session/${sessionId}` };
  };

  const openSession = (sessionId: string): RuntimeSession => {
    const session = getRequiredSession(sessionId);
    if (session.status === "created") session.status = "opened";
    return session;
  };

  const processSession = (sessionId: string): RuntimeSession => {
    const session = getRequiredSession(sessionId);
    if (session.status === "submitted") session.status = "processing";
    return session;
  };

  const waitSubmission = async (input: WaitSubmissionInput): Promise<SubmissionOutput> => {
    const session = getRequiredSession(input.sessionId);
    if (session.submittedPageVersion === session.pageVersion) {
      throw createRuntimeError("DUPLICATE_SUBMISSION", "当前页面已提交", 409, "等待新页面");
    }
    if (session.status === "created") session.status = "opened";
    if (session.status === "opened") session.status = "waiting";
    try {
      return await waiters.register(input.sessionId, input.timeoutMs ?? timeoutMs, input.signal);
    } catch (error) {
      if (error instanceof Error && error.message === "等待超时") {
        throw createRuntimeError("WAIT_TIMEOUT", "等待提交超时", 408, "继续等待或更新页面");
      }
      if (error instanceof Error && error.message === "等待已取消") {
        throw createRuntimeError("WAIT_CANCELLED", "等待提交已取消", 499, "重新等待或结束 session");
      }
      throw error;
    }
  };

  const submitSubmission = async (value: unknown) => {
    const submission = parseSubmissionWithLimit(value, maxPayloadBytes);
    const session = getRequiredSession(submission.sessionId);
    if (submission.pageId !== session.pageId || submission.pageVersion !== session.pageVersion) {
      throw createRuntimeError("STALE_PAGE", "提交来自旧页面", 409, "使用当前页面提交");
    }
    if (session.submittedPageVersion === session.pageVersion) {
      throw createRuntimeError("DUPLICATE_SUBMISSION", "当前页面已提交", 409, "等待新页面");
    }
    session.submittedPageVersion = session.pageVersion;
    session.status = "submitted";
    session.updatedAt = Date.now();
    const output = { kind: submission.kind, data: submission.data, metadata: submission.metadata, pageVersion: submission.pageVersion };
    waiters.notifyFirstAndClear(
      session.sessionId,
      output,
      createRuntimeError("DUPLICATE_SUBMISSION", "当前页面已提交", 409, "等待新页面"),
    );
    processSession(session.sessionId);
    return { ok: true as const, submission };
  };

  const updateSession = async (input: UpdateSessionInput): Promise<UpdateSessionOutput> => {
    const session = getRequiredSession(input.sessionId);
    if (typeof input.html !== "string" || input.html.length === 0) {
      throw createRuntimeError("INVALID_ENVELOPE", "HTML 不能为空", 400, "提供 HTML");
    }
    validateState(input.state);
    waiters.clear(input.sessionId, createRuntimeError("STALE_PAGE", "页面已更新", 409, "使用新页面提交"));
    session.pageId = makeId("page");
    session.pageVersion += 1;
    session.html = input.html;
    session.state = input.state;
    session.submittedPageVersion = undefined;
    session.status = "waiting";
    session.updatedAt = Date.now();
    return { pageId: session.pageId, pageVersion: session.pageVersion };
  };

  const endSession = async (sessionId: string): Promise<EndSessionOutput> => {
    const session = sessions.get(sessionId);
    if (!session || session.status === "ended") return { ok: false };
    session.status = "ended";
    session.updatedAt = Date.now();
    waiters.clear(sessionId, createRuntimeError("SESSION_ENDED", "session 已结束", 410, "session 已结束"));
    return { ok: true };
  };

  return {
    createSession,
    waitSubmission,
    updateSession,
    endSession,
    getSession: (id) => sessions.get(id),
    openSession,
    processSession,
    submitSubmission,
    listSessions: () => [...sessions.values()],
    setBaseUrl: (value) => { baseUrl = value.replace(/\/$/, ""); },
  };
};
