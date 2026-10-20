import { basename } from "node:path";

import {
  cleanupIntervalMs,
  defaultMaxPayloadBytes,
  defaultSessionTtlMs,
  defaultTimeoutMs,
} from "./constants";
import type { SessionMeta } from "./metaStore";
import { createRuntimeError, isJsonSerializable, parseSubmissionWithLimit } from "./protocol";
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

export const createHtmlRuntime = (options: RuntimeOptions): HtmlRuntime => {
  const sessions = new Map<string, RuntimeSession>();
  const sessionOutputs = new Map<string, CreateSessionOutput>();
  const waiters = createWaiterRegistry<string, SubmissionOutput>();
  const maxPayloadBytes = options.maxPayloadBytes ?? defaultMaxPayloadBytes;
  const timeoutMs = options.defaultTimeoutMs ?? defaultTimeoutMs;
  const sessionTtlMs = options.sessionTtlMs ?? defaultSessionTtlMs;
  const sessionCleanupIntervalMs = options.cleanupIntervalMs ?? cleanupIntervalMs;
  const { metaStore, pageStore } = options;
  let baseUrl = options.baseUrl ?? "http://127.0.0.1:0";
  const makeId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

  // 内存 session 与可序列化 meta 的映射：pageFile 是唯一的页面引用
  const toMeta = (session: RuntimeSession): SessionMeta => ({
    schemaVersion: 1,
    sessionId: session.sessionId,
    opencodeSessionId: session.opencodeSessionId,
    title: session.title,
    pageId: session.pageId,
    pageVersion: session.pageVersion,
    token: session.token,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    pageFileName: basename(
      session.pageFile ?? pageStore.path(session.sessionId, session.pageVersion),
    ),
    submittedPageVersion: session.submittedPageVersion,
    state: session.state,
  });

  // 写穿 meta：把内存 session 的可持久化字段落到 ctx.storage
  const persistMeta = async (session: RuntimeSession): Promise<void> => {
    await metaStore.write(toMeta(session));
  };

  // 写 page：把 HTML 正文落盘并返回文件路径（内存不持有正文）
  const persistPage = (session: RuntimeSession, html: string): Promise<string> =>
    pageStore.write(session.sessionId, session.pageVersion, html);

  const persistPending = async (
    sessionId: string,
    pending: SubmissionOutput | undefined,
  ): Promise<void> => {
    if (pending) await metaStore.writePending(sessionId, pending);
    else await metaStore.removePending(sessionId);
  };

  // 会话失效时统一清理三处持久化数据：meta、pending、页面目录
  const removePersisted = async (sessionId: string): Promise<void> => {
    await metaStore.remove(sessionId);
    await metaStore.removePending(sessionId);
    await pageStore.removeSession(sessionId);
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
      // getRequiredSession 保持同步；落盘清理按最优努力进行，周期清理/restore 兜底
      // 清理失败不得在宿主进程中冒泡为 unhandled rejection
      void removePersisted(sessionId).catch(() => {});
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
      state: input.initialState,
      token: makeId("token"),
      status: "created",
      createdAt: now,
      updatedAt: now,
    };
    // 先写 page 再写 meta，meta 存在视为会话有效
    session.pageFile = await persistPage(session, input.html);
    sessions.set(sessionId, session);
    await persistMeta(session);
    const output = {
      sessionId,
      pageId,
      pageVersion: 1,
      url: `${baseUrl}/session/${sessionId}`,
      pageFilePath: session.pageFile,
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
      await persistPending(input.sessionId, undefined);
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
    await persistPending(session.sessionId, session.pendingSubmission);
    processSession(session.sessionId);
    await persistMeta(session);
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
    session.pageFile = await persistPage(session, input.html);
    session.state = input.state;
    session.submittedPageVersion = undefined;
    session.pendingSubmission = undefined;
    await persistPending(input.sessionId, undefined);
    session.status = "waiting";
    session.updatedAt = Date.now();
    await persistMeta(session);
    return { pageId: session.pageId, pageVersion: session.pageVersion };
  };

  const endSession = async (sessionId: string): Promise<EndSessionOutput> => {
    const session = sessions.get(sessionId);
    if (!session || session.status === "ended") return { ok: false };
    await removePersisted(sessionId);
    clearSessionMemory(
      sessionId,
      createRuntimeError("SESSION_ENDED", "session 已结束", 410, "session 已结束"),
    );
    return { ok: true };
  };

  // 启动恢复：从 metaStore 重建内存索引，清理损坏/终态/过期项与无元数据的孤儿页面目录
  const restore = async (): Promise<void> => {
    const metas = await metaStore.scanAll();
    const diskIds = new Set(pageStore.listSessionIds());
    const now = Date.now();
    const validIds = new Set<string>();
    sessions.clear();
    sessionOutputs.clear();
    for (const meta of metas) {
      // sessionId 必须指向真实存在的页面目录，避免损坏 meta 中的任意 id 触发越权删除
      const hasDir = diskIds.has(meta.sessionId);
      if (
        !hasDir ||
        !isSessionStatus(meta.status) ||
        !Number.isInteger(meta.pageVersion) ||
        meta.pageVersion <= 0 ||
        !Number.isFinite(meta.createdAt) ||
        !Number.isFinite(meta.updatedAt) ||
        (meta.state !== undefined && !isJsonSerializable(meta.state)) ||
        isTerminalStatus(meta.status) ||
        now - meta.createdAt > sessionTtlMs ||
        !pageStore.exists(pageStore.path(meta.sessionId, meta.pageVersion))
      ) {
        await metaStore.remove(meta.sessionId);
        await metaStore.removePending(meta.sessionId);
        if (hasDir) await pageStore.removeSession(meta.sessionId);
        continue;
      }
      const pageFilePath = pageStore.path(meta.sessionId, meta.pageVersion);
      const session: RuntimeSession = {
        sessionId: meta.sessionId,
        opencodeSessionId: meta.opencodeSessionId,
        title: meta.title,
        pageId: meta.pageId,
        pageVersion: meta.pageVersion,
        pageFile: pageFilePath,
        state: meta.state,
        token: meta.token,
        status: meta.status,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        submittedPageVersion: meta.submittedPageVersion,
      };
      const pending = await metaStore.readPending(meta.sessionId);
      if (pending) session.pendingSubmission = pending;
      sessions.set(meta.sessionId, session);
      sessionOutputs.set(meta.sessionId, {
        sessionId: meta.sessionId,
        pageId: session.pageId,
        pageVersion: session.pageVersion,
        url: `${baseUrl}/session/${meta.sessionId}`,
        pageFilePath,
      });
      validIds.add(meta.sessionId);
    }
    // 孤儿目录：磁盘存在但无有效 meta 的页面目录
    for (const sessionId of pageStore.listSessionIds()) {
      if (validIds.has(sessionId)) continue;
      await removePersisted(sessionId);
    }
  };

  // 周期清理：统一治理内存与磁盘上无人访问的过期/终态 session
  const cleanupExpiredSessions = async (): Promise<void> => {
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
        clearSessionMemory(sessionId, expired);
        await removePersisted(sessionId);
      }
    }
    for (const sessionId of pageStore.listSessionIds()) {
      const meta = await metaStore.read(sessionId);
      if (
        !meta ||
        isTerminalStatus(meta.status as RuntimeSession["status"]) ||
        now - meta.createdAt > sessionTtlMs
      ) {
        await removePersisted(sessionId);
        if (sessions.has(sessionId)) {
          clearSessionMemory(
            sessionId,
            createRuntimeError("SESSION_ENDED", "session 已过期", 410, "创建新的 session"),
          );
        }
      }
    }
  };
  const cleanupTimer = setInterval(() => {
    // 周期清理按最优努力进行：失败不得在宿主进程中冒泡为 unhandled rejection
    void cleanupExpiredSessions().catch(() => {});
  }, sessionCleanupIntervalMs);

  const dispose = (): void => {
    clearInterval(cleanupTimer);
    for (const sessionId of [...sessions.keys()]) {
      clearSessionMemory(
        sessionId,
        createRuntimeError("SESSION_ENDED", "runtime 已释放", 410, "session 已结束"),
      );
    }
    sessions.clear();
    sessionOutputs.clear();
    // 持久化数据不删除，留给下次启动 restore 恢复
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
        void removePersisted(id).catch(() => {});
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
    restore,
    dispose,
  };
};
