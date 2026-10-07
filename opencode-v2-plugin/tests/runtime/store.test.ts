import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionMeta, StorageDomain } from "../../src/runtime/metaStore";
import { createMetaStore } from "../../src/runtime/metaStore";
import { createPageStore } from "../../src/runtime/pageStore";
import { createHtmlRuntime } from "../../src/runtime/store";
import type { RuntimeOptions } from "../../src/runtime/types";

// 测试用内存 StorageDomain：scan 按 prefix 过滤并排序 backing 的 key
const memoryStorage = (backing: Map<string, unknown>): StorageDomain => ({
  get: async (key) => backing.get(key),
  set: async (key, value) => {
    backing.set(key, value);
  },
  remove: async (key) => {
    backing.delete(key);
  },
  scan: async ({ prefix, after }) => {
    const keys = [...backing.keys()]
      .filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
      .sort();
    return { entries: keys.map((key) => ({ key, value: backing.get(key) })) };
  },
});

const makeStores = () => {
  const storage = memoryStorage(new Map());
  return {
    storage,
    metaStore: createMetaStore(storage),
    pageStore: createPageStore(mkdtempSync(join(tmpdir(), "v2-store-"))),
  };
};

const makeRuntime = (options: Partial<RuntimeOptions> = {}) => {
  const stores = makeStores();
  const runtime = createHtmlRuntime({
    metaStore: stores.metaStore,
    pageStore: stores.pageStore,
    ...options,
  });
  return { ...stores, runtime };
};

const baseMeta = (sessionId: string, overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  schemaVersion: 1,
  sessionId,
  pageId: `page_${sessionId}`,
  pageVersion: 1,
  token: "t",
  status: "created",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  pageFileName: "page-1.html",
  ...overrides,
});

describe("HTML session runtime", () => {
  it("按 TTL 主动清理 session", async () => {
    const { runtime } = makeRuntime({ sessionTtlMs: 5, cleanupIntervalMs: 10 });
    const created = await runtime.createSession({ html: "<p>expire</p>" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runtime.getSession(created.sessionId)).toBeUndefined();
    expect(runtime.countLiveSessions()).toBe(0);
    runtime.dispose();
  });

  it("创建页面为版本 1，更新生成版本 2 和新 pageId", async () => {
    const { runtime } = makeRuntime();
    const created = await runtime.createSession({ html: "<h1>one</h1>" });
    expect(runtime.getSession(created.sessionId)?.status).toBe("created");
    expect(runtime.openSession(created.sessionId).status).toBe("opened");
    const updated = await runtime.updateSession({
      sessionId: created.sessionId,
      html: "<h1>two</h1>",
    });

    expect(created.pageVersion).toBe(1);
    expect(created.pageId).toBeString();
    expect(updated.pageVersion).toBe(2);
    expect(updated.pageId).not.toBe(created.pageId);
    runtime.dispose();
  });

  it("首个有效提交唤醒 waiter，重复提交不再唤醒", async () => {
    const { runtime } = makeRuntime();
    const created = await runtime.createSession({ html: "<button>ok</button>" });
    const envelope = {
      sessionId: created.sessionId,
      pageId: created.pageId,
      pageVersion: created.pageVersion,
      kind: "confirmation",
      data: { ok: true },
      metadata: {},
      protocolVersion: 1 as const,
    };
    const waiting = runtime.waitSubmission({ sessionId: created.sessionId, timeoutMs: 100 });
    expect(await runtime.submitSubmission(envelope)).toEqual({
      ok: true,
      submission: envelope,
    });
    await expect(waiting).resolves.toMatchObject({ kind: "confirmation", pageVersion: 1 });
    expect(runtime.getSession(created.sessionId)?.status).toBe("processing");
    await expect(runtime.submitSubmission(envelope)).rejects.toThrow(
      expect.objectContaining({ code: "DUPLICATE_SUBMISSION" }),
    );
    runtime.dispose();
  });

  it("取消 wait 返回稳定错误并清理 waiter", async () => {
    const { runtime } = makeRuntime();
    const created = await runtime.createSession({ html: "<h1>cancel</h1>" });
    const controller = new AbortController();
    const pending = runtime.waitSubmission({
      sessionId: created.sessionId,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow(expect.objectContaining({ code: "WAIT_CANCELLED" }));
    const next = runtime.waitSubmission({ sessionId: created.sessionId, timeoutMs: 1 });
    await expect(next).rejects.toThrow(expect.objectContaining({ code: "WAIT_TIMEOUT" }));
    runtime.dispose();
  });

  it("提交时清理同一页面的并发 waiter", async () => {
    const { runtime } = makeRuntime();
    const created = await runtime.createSession({ html: "<h1>parallel</h1>" });
    const first = runtime.waitSubmission({ sessionId: created.sessionId, timeoutMs: 1000 });
    const second = runtime.waitSubmission({ sessionId: created.sessionId, timeoutMs: 1000 });
    await runtime.submitSubmission({
      sessionId: created.sessionId,
      pageId: created.pageId,
      pageVersion: created.pageVersion,
      kind: "parallel",
      data: {},
      metadata: {},
      protocolVersion: 1,
    });
    await expect(first).resolves.toMatchObject({ kind: "parallel" });
    await expect(second).rejects.toThrow(expect.objectContaining({ code: "DUPLICATE_SUBMISSION" }));
    runtime.dispose();
  });

  it("拒绝不可序列化 session state，但接受共享普通对象", async () => {
    const { runtime } = makeRuntime();
    const shared = { value: "same" };
    const created = await runtime.createSession({
      html: "<h1>state</h1>",
      initialState: { first: shared, second: shared },
    });
    expect(runtime.getSession(created.sessionId)?.state).toEqual({ first: shared, second: shared });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    await expect(
      runtime.createSession({ html: "<h1>bad</h1>", initialState: cyclic }),
    ).rejects.toThrow(expect.objectContaining({ code: "INVALID_ENVELOPE" }));
    await expect(
      runtime.updateSession({
        sessionId: created.sessionId,
        html: "<h1>bad</h1>",
        state: BigInt(1),
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "INVALID_ENVELOPE" }));
    runtime.dispose();
  });

  it("更新和结束会清理旧 waiter", async () => {
    const { runtime } = makeRuntime();
    const created = await runtime.createSession({ html: "<h1>old</h1>" });
    const oldWaiter = runtime.waitSubmission({ sessionId: created.sessionId, timeoutMs: 1000 });
    const updated = await runtime.updateSession({
      sessionId: created.sessionId,
      html: "<h1>new</h1>",
    });
    await expect(oldWaiter).rejects.toThrow(expect.objectContaining({ code: "STALE_PAGE" }));
    const endedWaiter = runtime.waitSubmission({ sessionId: created.sessionId, timeoutMs: 1000 });
    await runtime.endSession(created.sessionId);
    await expect(endedWaiter).rejects.toThrow(expect.objectContaining({ code: "SESSION_ENDED" }));
    expect(updated.pageVersion).toBe(2);
    runtime.dispose();
  });

  it("拒绝旧页面提交，超时返回 WAIT_TIMEOUT，结束操作幂等", async () => {
    const { runtime } = makeRuntime();
    const created = await runtime.createSession({ html: "<h1>one</h1>" });
    const updated = await runtime.updateSession({
      sessionId: created.sessionId,
      html: "<h1>two</h1>",
    });
    await expect(
      runtime.submitSubmission({
        sessionId: created.sessionId,
        pageId: created.pageId,
        pageVersion: created.pageVersion,
        kind: "stale",
        data: null,
        metadata: null,
        protocolVersion: 1,
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "STALE_PAGE" }));
    await expect(
      runtime.waitSubmission({ sessionId: created.sessionId, timeoutMs: 1 }),
    ).rejects.toThrow(expect.objectContaining({ code: "WAIT_TIMEOUT" }));
    expect(await runtime.endSession(created.sessionId)).toEqual({ ok: true });
    expect(await runtime.endSession(created.sessionId)).toEqual({ ok: false });
    expect(updated.pageVersion).toBe(2);
    runtime.dispose();
  });

  it("wait 超时后的提交会被缓存，下次 wait 立即返回缓存数据", async () => {
    const { runtime } = makeRuntime();
    const created = await runtime.createSession({ html: "<h1>late</h1>" });
    await expect(
      runtime.waitSubmission({ sessionId: created.sessionId, timeoutMs: 1 }),
    ).rejects.toThrow(expect.objectContaining({ code: "WAIT_TIMEOUT" }));

    // 无 waiter 时提交：仍占用本版本唯一提交名额，不产生数据丢失
    await expect(
      runtime.submitSubmission({
        sessionId: created.sessionId,
        pageId: created.pageId,
        pageVersion: created.pageVersion,
        kind: "late-submission",
        data: { value: "kept" },
        metadata: {},
        protocolVersion: 1,
      }),
    ).resolves.toMatchObject({ ok: true });

    const output = await runtime.waitSubmission({
      sessionId: created.sessionId,
      timeoutMs: 30_000,
    });
    expect(output).toMatchObject({
      kind: "late-submission",
      data: { value: "kept" },
      pageVersion: 1,
    });

    // 缓存消费完毕后，同一页面的再次等待属于重复提交
    await expect(
      runtime.waitSubmission({ sessionId: created.sessionId, timeoutMs: 1 }),
    ).rejects.toThrow(expect.objectContaining({ code: "DUPLICATE_SUBMISSION" }));
    runtime.dispose();
  });

  it("页面更新会清除未消费的缓存提交", async () => {
    const { runtime } = makeRuntime();
    const created = await runtime.createSession({ html: "<h1>v1</h1>" });
    await expect(
      runtime.waitSubmission({ sessionId: created.sessionId, timeoutMs: 1 }),
    ).rejects.toThrow(expect.objectContaining({ code: "WAIT_TIMEOUT" }));
    await runtime.submitSubmission({
      sessionId: created.sessionId,
      pageId: created.pageId,
      pageVersion: created.pageVersion,
      kind: "cached",
      data: {},
      metadata: {},
      protocolVersion: 1,
    });

    const updated = await runtime.updateSession({
      sessionId: created.sessionId,
      html: "<h1>v2</h1>",
    });

    await expect(
      runtime.waitSubmission({ sessionId: created.sessionId, timeoutMs: 1 }),
    ).rejects.toThrow(expect.objectContaining({ code: "WAIT_TIMEOUT" }));
    expect(updated.pageVersion).toBe(2);
    runtime.dispose();
  });

  it("endSession 后从 session 表删除条目并收缩 map", async () => {
    const { runtime } = makeRuntime();
    const first = await runtime.createSession({ html: "<h1>a</h1>" });
    const second = await runtime.createSession({ html: "<h1>b</h1>" });
    expect(runtime.listSessions()).toHaveLength(2);

    expect(await runtime.endSession(first.sessionId)).toEqual({ ok: true });
    expect(runtime.getSession(first.sessionId)).toBeUndefined();
    expect(runtime.listSessions()).toHaveLength(1);
    expect(runtime.listSessions()[0]?.sessionId).toBe(second.sessionId);

    expect(await runtime.endSession(first.sessionId)).toEqual({ ok: false });
    runtime.dispose();
  });

  it("createSession 落盘页面与 meta，endSession 清理全部落盘数据", async () => {
    const { runtime, metaStore, pageStore } = makeRuntime();
    const created = await runtime.createSession({ html: "<h1>disk</h1>" });
    expect(created.pageFilePath).toBe(pageStore.path(created.sessionId, 1));
    expect(pageStore.exists(created.pageFilePath ?? "")).toBe(true);
    expect((await metaStore.read(created.sessionId))?.pageFileName).toBe("page-1.html");

    await runtime.endSession(created.sessionId);
    expect(await metaStore.read(created.sessionId)).toBeUndefined();
    expect(pageStore.exists(pageStore.path(created.sessionId, 1))).toBe(false);
    runtime.dispose();
  });

  it("restore 重建索引并清理终态与过期会话", async () => {
    const { metaStore, pageStore } = makeStores();
    await metaStore.write(baseMeta("html_live"));
    await pageStore.write("html_live", 1, "<h1>live</h1>");
    await metaStore.write(baseMeta("html_terminal", { status: "ended" }));
    await pageStore.write("html_terminal", 1, "<h1>ended</h1>");
    await metaStore.write(baseMeta("html_expired", { createdAt: Date.now() - 60_000 }));
    await pageStore.write("html_expired", 1, "<h1>expired</h1>");

    const runtime = createHtmlRuntime({ metaStore, pageStore, sessionTtlMs: 1_000 });
    await runtime.restore();

    expect(runtime.listSessions().map((s) => s.sessionId)).toEqual(["html_live"]);
    expect(runtime.getSession("html_live")?.pageFile).toBe(pageStore.path("html_live", 1));
    expect(await metaStore.read("html_terminal")).toBeUndefined();
    expect(await metaStore.read("html_expired")).toBeUndefined();
    expect(pageStore.exists(pageStore.path("html_expired", 1))).toBe(false);
    runtime.dispose();
  });

  it("restore 清理无元数据的孤儿页面目录", async () => {
    const { metaStore, pageStore } = makeStores();
    const orphan = pageStore.path("html_orphan", 1);
    await pageStore.write("html_orphan", 1, "x");

    const runtime = createHtmlRuntime({ metaStore, pageStore });
    await runtime.restore();

    expect(pageStore.exists(orphan)).toBe(false);
    expect(pageStore.listSessionIds()).not.toContain("html_orphan");
    runtime.dispose();
  });

  it("restore 不因损坏 sessionId 的 meta 误删其他页面目录", async () => {
    const { metaStore, pageStore } = makeStores();
    await metaStore.write(baseMeta("html_a"));
    await pageStore.write("html_a", 1, "<h1>a</h1>");
    // 非磁盘目录的损坏 sessionId（空串）不得触发对 pageStore 根目录的删除
    await metaStore.write(baseMeta(""));

    const runtime = createHtmlRuntime({ metaStore, pageStore });
    await runtime.restore();

    expect(runtime.listSessions().map((s) => s.sessionId)).toEqual(["html_a"]);
    expect(pageStore.exists(pageStore.path("html_a", 1))).toBe(true);
    expect(await metaStore.read("")).toBeUndefined();
    runtime.dispose();
  });

  it("新建 runtime 从存储 restore 后可见会话页面并恢复缓存提交", async () => {
    const { metaStore, pageStore } = makeStores();
    const first = createHtmlRuntime({ metaStore, pageStore });
    const created = await first.createSession({ html: "<h1>persist</h1>" });
    // 无 waiter 时提交，写入 pending
    await first.submitSubmission({
      sessionId: created.sessionId,
      pageId: created.pageId,
      pageVersion: created.pageVersion,
      kind: "persisted",
      data: { value: 7 },
      metadata: {},
      protocolVersion: 1,
    });
    first.dispose();

    const second = createHtmlRuntime({ metaStore, pageStore });
    await second.restore();
    const restored = second.getSession(created.sessionId);
    expect(restored?.pageFile).toBe(created.pageFilePath);
    expect(restored?.pageVersion).toBe(1);
    expect(restored?.submittedPageVersion).toBe(1);
    expect(restored?.pendingSubmission).toMatchObject({ kind: "persisted", data: { value: 7 } });

    // 缓存提交可被下一次 wait 立即消费
    await expect(
      second.waitSubmission({ sessionId: created.sessionId, timeoutMs: 1 }),
    ).resolves.toMatchObject({ kind: "persisted", pageVersion: 1 });
    second.dispose();
  });

  it("cancel 与 timeout 区分", async () => {
    const { runtime } = makeRuntime({ defaultTimeoutMs: 5_000 });
    const a = await runtime.createSession({ html: "<html></html>" });
    const controller = new AbortController();
    const w = runtime.waitSubmission({ sessionId: a.sessionId, signal: controller.signal });
    controller.abort();
    await expect(w).rejects.toMatchObject({ code: "WAIT_CANCELLED" });
    const b = await runtime.createSession({ html: "<html></html>" });
    await expect(
      runtime.waitSubmission({ sessionId: b.sessionId, timeoutMs: 10 }),
    ).rejects.toMatchObject({ code: "WAIT_TIMEOUT" });
    runtime.dispose();
  });
});
