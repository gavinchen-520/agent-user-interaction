import { describe, expect, it } from "bun:test";

import { createHtmlRuntime } from "../../opencode-v1-aui/src/runtime";

describe("HTML session runtime", () => {
  it("memory 模式按 TTL 主动清理 session", async () => {
    const runtime = createHtmlRuntime({ sessionTtlMs: 5, cleanupIntervalMs: 10 });
    const created = await runtime.createSession({ html: "<p>expire</p>" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runtime.getSession(created.sessionId)).toBeUndefined();
    expect(runtime.countLiveSessions()).toBe(0);
    runtime.dispose();
  });

  it("创建页面为版本 1，更新生成版本 2 和新 pageId", async () => {
    const runtime = createHtmlRuntime();
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
  });

  it("首个有效提交唤醒 waiter，重复提交不再唤醒", async () => {
    const runtime = createHtmlRuntime();
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
  });

  it("取消 wait 返回稳定错误并清理 waiter", async () => {
    const runtime = createHtmlRuntime();
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
  });

  it("提交时清理同一页面的并发 waiter", async () => {
    const runtime = createHtmlRuntime();
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
  });

  it("拒绝不可序列化 session state，但接受共享普通对象", async () => {
    const runtime = createHtmlRuntime();
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
  });

  it("更新和结束会清理旧 waiter", async () => {
    const runtime = createHtmlRuntime();
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
  });

  it("拒绝旧页面提交，超时返回 WAIT_TIMEOUT，结束操作幂等", async () => {
    const runtime = createHtmlRuntime();
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
  });

  it("wait 超时后的提交会被缓存，下次 wait 立即返回缓存数据", async () => {
    const runtime = createHtmlRuntime();
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
  });

  it("页面更新会清除未消费的缓存提交", async () => {
    const runtime = createHtmlRuntime();
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
  });

  it("endSession 后从 session 表删除条目并收缩 map", async () => {
    const runtime = createHtmlRuntime();
    const first = await runtime.createSession({ html: "<h1>a</h1>" });
    const second = await runtime.createSession({ html: "<h1>b</h1>" });
    expect(runtime.listSessions()).toHaveLength(2);

    expect(await runtime.endSession(first.sessionId)).toEqual({ ok: true });
    expect(runtime.getSession(first.sessionId)).toBeUndefined();
    expect(runtime.listSessions()).toHaveLength(1);
    expect(runtime.listSessions()[0]?.sessionId).toBe(second.sessionId);

    expect(await runtime.endSession(first.sessionId)).toEqual({ ok: false });
  });
});
