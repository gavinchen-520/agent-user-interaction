import {
  cleanupIntervalMs,
  defaultDataDir,
  defaultMaxPayloadBytes,
  defaultSessionTtlMs,
  defaultTimeoutMs,
} from "./constants";
import { createRuntimeError, isJsonSerializable, parseSubmissionWithLimit } from "./protocol";
import type { DiskStorage } from "./storage";
import { createDiskStorage } from "./storage";
import type {
  CreateSessionInput,
  CreateSessionOutput,
  EndSessionOutput,
  HtmlRuntime,
  RuntimeOptions,
  RuntimeSession,
  SessionStatus,
  SubmissionOutput,
  UpdateSessionInput,
  UpdateSessionOutput,
  WaitSubmissionInput,
} from "./types";
import { createWaiterRegistry } from "./waiter";

export const terminalStatuses = ["ended", "expired", "failed", "cancelled"] as const;

export const isTerminalStatus = (status: RuntimeSession["status"]): boolean =>
  (terminalStatuses as readonly string[]).includes(status);

const sessionStatuses = [
  "created",
  "opened",
  "waiting",
  "submitted",
  "processing",
  "expired",
  "failed",
  "cancelled",
  "ended",
] as const;

const isSessionStatus = (value: string): value is SessionStatus =>
  (sessionStatuses as readonly string[]).includes(value);

export const createHtmlRuntime = (options: RuntimeOptions = {}): HtmlRuntime => {
  const sessions = new Map<string, RuntimeSession>();
  const sessionOutputs = new Map<string, CreateSessionOutput>();
  const waiters = createWaiterRegistry<string, SubmissionOutput>();
  const maxPayloadBytes = options.maxPayloadBytes ?? defaultMaxPayloadBytes;
  const timeoutMs = options.defaultTimeoutMs ?? defaultTimeoutMs;
  const sessionTtlMs = options.sessionTtlMs ?? defaultSessionTtlMs;
  const sessionCleanupIntervalMs = options.cleanupIntervalMs ?? cleanupIntervalMs;
  const retainPages = options.storage?.retainPages ?? false;
  const storage: DiskStorage | undefined =
    options.storage?.mode === "disk"
      ? createDiskStorage(options.storage.dataDir || defaultDataDir)
      : undefined;
  let baseUrl = options.baseUrl ?? "http://127.0.0.1:0";
  const makeId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

  // 写穿 meta：disk 模式下把内存 session 的可持久化字段落到磁盘
  const persistMeta = (session: RuntimeSession): void => {
    storage?.writeMeta(session);
  };

  // 写 page：disk 模式下把 HTML 正文落盘并返回文件路径，内存正文随之置空
  const persistPage = (session: RuntimeSession): string | undefined => {
    if (!storage) return undefined;
    storage.writePage(session.sessionId, session.pageVersion, session.html);
    return storage.pageFilePath(session.sessionId, session.pageVersion);
  };

  const persistPending = (sessionId: string, pending: SubmissionOutput | undefined): void => {
    if (!storage) return;
    if (pending) storage.writePending(sessionId, pending);
    else storage.deletePending(sessionId);
  };

  const removeFromDisk = (sessionId: string): void => {
    storage?.deleteSession(sessionId);
  };

  const clearSessionMemory = (sessionId: string, reason: unknown): void => {
    waiters.clear(sessionId, reason);
    sessions.delete(sessionId);
    sessionOutputs.delete(sessionId);
  };

  const getRequiredSession = (sessionId: string): RuntimeSession => {
    const session = sessions.get(sessionId);
    if (!session)
      throw createRuntimeError("SESSION_NOT_FOUND", "session 不存在", 404, "检查 sessionId");
    if (isTerminalStatus(session.status)) {
      throw createRuntimeError("SESSION_ENDED", "session 已结束", 410, "创建或使用新的 session");
    }
    if (Date.now() - session.createdAt > sessionTtlMs) {
      const expired = createRuntimeError(
        "SESSION_ENDED",
        "session 已过期",
        410,
        "创建新的 session",
      );
      removeFromDisk(sessionId);
      clearSessionMemory(sessionId, expired);
      throw expired;
    }
    return session;
  };

  const validateState = (state: unknown) => {
    if (state !== undefined && !isJsonSerializable(state)) {
      throw createRuntimeError(
        "INVALID_ENVELOPE",
        "session state 必须是 JSON 数据",
        400,
        "移除不可序列化值",
      );
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
      opencodeSessionId: input.opencodeSessionId,
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
    if (storage) {
      // 先写 page 再写 meta，meta 存在视为会话有效
      session.htmlFile = persistPage(session);
      session.html = "";
    }
    sessions.set(sessionId, session);
    persistMeta(session);
    const output = {
      sessionId,
      pageId,
      pageVersion: 1,
      url: `${baseUrl}/session/${sessionId}`,
      pageFilePath: session.htmlFile,
    };
    sessionOutputs.set(sessionId, output);
    return output;
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
    // 超时后到达的缓存提交：立即返回，避免数据被静默丢弃
    if (session.pendingSubmission) {
      const cached = session.pendingSubmission;
      session.pendingSubmission = undefined;
      persistPending(input.sessionId, undefined);
      return cached;
    }
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
    const output = {
      kind: submission.kind,
      data: submission.data,
      metadata: submission.metadata,
      pageVersion: submission.pageVersion,
    };
    // 无 waiter 时缓存提交，下次 waitSubmission 立即返回；仍占用本版本唯一提交名额
    const notified = waiters.notifyFirstAndClear(
      session.sessionId,
      output,
      createRuntimeError("DUPLICATE_SUBMISSION", "当前页面已提交", 409, "等待新页面"),
    );
    if (!notified) session.pendingSubmission = output;
    persistPending(session.sessionId, session.pendingSubmission);
    processSession(session.sessionId);
    persistMeta(session);
    return { ok: true as const, submission };
  };

  const updateSession = async (input: UpdateSessionInput): Promise<UpdateSessionOutput> => {
    const session = getRequiredSession(input.sessionId);
    if (typeof input.html !== "string" || input.html.length === 0) {
      throw createRuntimeError("INVALID_ENVELOPE", "HTML 不能为空", 400, "提供 HTML");
    }
    validateState(input.state);
    waiters.clear(
      input.sessionId,
      createRuntimeError("STALE_PAGE", "页面已更新", 409, "使用新页面提交"),
    );
    session.pageId = makeId("page");
    session.pageVersion += 1;
    session.html = input.html;
    if (storage) {
      session.htmlFile = persistPage(session);
      session.html = "";
    }
    session.state = input.state;
    session.submittedPageVersion = undefined;
    session.pendingSubmission = undefined;
    persistPending(input.sessionId, undefined);
    session.status = "waiting";
    session.updatedAt = Date.now();
    persistMeta(session);
    return { pageId: session.pageId, pageVersion: session.pageVersion };
  };

  const endSession = async (sessionId: string): Promise<EndSessionOutput> => {
    const session = sessions.get(sessionId);
    if (!session || session.status === "ended") return { ok: false };
    if (retainPages && storage) {
      // 保留模式：写终态与保留标记后仅清内存，磁盘原件留作事后查看（URL 不再可用）
      session.status = "ended";
      session.retained = true;
      session.token = makeId("retained");
      session.state = undefined;
      session.pendingSubmission = undefined;
      session.updatedAt = Date.now();
      persistPending(sessionId, undefined);
      persistMeta(session);
      clearSessionMemory(
        sessionId,
        createRuntimeError("SESSION_ENDED", "session 已结束", 410, "session 已结束"),
      );
      return { ok: true };
    }
    removeFromDisk(sessionId);
    clearSessionMemory(
      sessionId,
      createRuntimeError("SESSION_ENDED", "session 已结束", 410, "session 已结束"),
    );
    return { ok: true };
  };

  // 磁盘模式启动恢复：扫描 dataDir，清理损坏/终态/过期/残缺目录，重建内存索引
  const restoreFromDisk = (): void => {
    if (!storage) return;
    const now = Date.now();
    for (const sessionId of storage.listSessionIds()) {
      const meta = storage.readMeta(sessionId);
      // 保留原件不是活会话：既不恢复也不删除
      if (meta?.retained) continue;
      if (
        !meta ||
        meta.sessionId !== sessionId ||
        !isSessionStatus(meta.status) ||
        !Number.isInteger(meta.pageVersion) ||
        meta.pageVersion <= 0 ||
        !Number.isFinite(meta.createdAt) ||
        !Number.isFinite(meta.updatedAt) ||
        (meta.state !== undefined && !isJsonSerializable(meta.state)) ||
        isTerminalStatus(meta.status) ||
        now - meta.createdAt > sessionTtlMs ||
        !storage.hasPage(sessionId, meta.pageFileName)
      ) {
        storage.deleteSession(sessionId);
        continue;
      }
      const session: RuntimeSession = {
        sessionId: meta.sessionId,
        opencodeSessionId: meta.opencodeSessionId,
        title: meta.title,
        pageId: meta.pageId,
        pageVersion: meta.pageVersion,
        html: "",
        htmlFile: storage.pageFilePath(sessionId, meta.pageVersion),
        state: meta.state,
        token: meta.token,
        status: meta.status,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        submittedPageVersion: meta.submittedPageVersion,
      };
      const pending = storage.readPending(sessionId);
      if (pending) session.pendingSubmission = pending;
      sessions.set(sessionId, session);
      sessionOutputs.set(sessionId, {
        sessionId,
        pageId: session.pageId,
        pageVersion: session.pageVersion,
        url: `${baseUrl}/session/${sessionId}`,
      });
    }
  };

  restoreFromDisk();

  // 周期清理：统一治理 memory/disk 模式下无人访问的过期 session
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  const cleanupExpiredSessions = (): void => {
    const now = Date.now();
    for (const sessionId of [...sessions.keys()]) {
      const session = sessions.get(sessionId);
      if (session && now - session.createdAt > sessionTtlMs) {
        const expired = createRuntimeError(
          "SESSION_ENDED",
          "session 已过期",
          410,
          "创建新的 session",
        );
        removeFromDisk(sessionId);
        clearSessionMemory(sessionId, expired);
      }
    }
    if (storage) {
      for (const sessionId of storage.listSessionIds()) {
        const meta = storage.readMeta(sessionId);
        // 保留的原件不参与周期清理，避免误删事后要查看的页面
        if (meta?.retained) continue;
        if (
          !meta ||
          isTerminalStatus(meta.status as SessionStatus) ||
          now - meta.createdAt > sessionTtlMs
        ) {
          storage.deleteSession(sessionId);
          if (sessions.has(sessionId)) {
            clearSessionMemory(
              sessionId,
              createRuntimeError("SESSION_ENDED", "session 已过期", 410, "创建新的 session"),
            );
          }
        }
      }
    }
  };
  cleanupTimer = setInterval(cleanupExpiredSessions, sessionCleanupIntervalMs);

  const dispose = (): void => {
    if (cleanupTimer) clearInterval(cleanupTimer);
    for (const sessionId of [...sessions.keys()]) {
      clearSessionMemory(
        sessionId,
        createRuntimeError("SESSION_ENDED", "runtime 已释放", 410, "session 已结束"),
      );
    }
    sessions.clear();
    sessionOutputs.clear();
    // 磁盘文件不删除，留给下次启动恢复
  };

  return {
    createSession,
    waitSubmission,
    updateSession,
    endSession,
    getSession: (id) => {
      const session = sessions.get(id);
      if (!session) return undefined;
      if (Date.now() - session.createdAt > sessionTtlMs) {
        const expired = createRuntimeError(
          "SESSION_ENDED",
          "session 已过期",
          410,
          "创建新的 session",
        );
        removeFromDisk(id);
        clearSessionMemory(id, expired);
        return undefined;
      }
      return session;
    },
    openSession,
    processSession,
    submitSubmission,
    listSessions: () => [...sessions.values()],
    setBaseUrl: (value) => {
      baseUrl = value.replace(/\/$/, "");
      sessionOutputs.forEach((output) => {
        output.url = `${baseUrl}/session/${output.sessionId}`;
      });
    },
    countWaiters: (sessionId?: string) => waiters.count(sessionId),
    countLiveSessions: () =>
      [...sessions.values()].filter((session) => !isTerminalStatus(session.status)).length,
    dispose,
  };
};
