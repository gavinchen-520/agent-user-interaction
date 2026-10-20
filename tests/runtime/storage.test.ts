import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HtmlRuntime, RuntimeOptions } from "../../opencode-v1-aui/src/runtime";
import { createHtmlRuntime } from "../../opencode-v1-aui/src/runtime";

describe("磁盘存储 runtime", () => {
  const tempDirs: string[] = [];
  const runtimes: HtmlRuntime[] = [];

  const makeTempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "html-sessions-"));
    tempDirs.push(dir);
    return dir;
  };

  const diskRuntime = (dir: string, options: RuntimeOptions = {}): HtmlRuntime => {
    const runtime = createHtmlRuntime({ storage: { mode: "disk", dataDir: dir }, ...options });
    runtimes.push(runtime);
    return runtime;
  };

  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.dispose();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("磁盘模式把 meta 与 page 落盘，重启后恢复 token、pageId 与 opencodeSessionId", async () => {
    const dir = makeTempDir();
    const r1 = diskRuntime(dir);
    const created = await r1.createSession({
      html: "<h1>persisted</h1>",
      opencodeSessionId: "oc-1",
    });
    const token = r1.getSession(created.sessionId)?.token;
    expect(existsSync(join(dir, created.sessionId, "meta.json"))).toBe(true);
    expect(existsSync(join(dir, created.sessionId, "page.html"))).toBe(true);
    expect(created.pageFilePath).toBe(join(dir, created.sessionId, "page.html"));
    r1.dispose();

    const r2 = diskRuntime(dir);
    const restored = r2.getSession(created.sessionId);
    expect(restored).toBeDefined();
    expect(restored?.token).toBe(token);
    expect(restored?.pageId).toBe(created.pageId);
    expect(restored?.pageVersion).toBe(1);
    expect(restored?.opencodeSessionId).toBe("oc-1");
    expect(restored?.htmlFile).toBe(join(dir, created.sessionId, "page.html"));
    expect(restored?.html).toBe("");
  });

  it("磁盘文件使用仅 owner 可读写的权限", async () => {
    const dir = makeTempDir();
    const runtime = diskRuntime(dir);
    const created = await runtime.createSession({ html: "<h1>private</h1>" });
    expect(statSync(join(dir, created.sessionId)).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, created.sessionId, "meta.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, created.sessionId, "page.html")).mode & 0o777).toBe(0o600);
  });

  it("endSession 删除磁盘目录", async () => {
    const dir = makeTempDir();
    const runtime = diskRuntime(dir);
    const created = await runtime.createSession({ html: "<h1>x</h1>" });
    expect(existsSync(join(dir, created.sessionId))).toBe(true);
    expect(await runtime.endSession(created.sessionId)).toEqual({ ok: true });
    expect(existsSync(join(dir, created.sessionId))).toBe(false);
    expect(runtime.getSession(created.sessionId)).toBeUndefined();
  });

  it("retainPages 为 true 时 endSession 保留页面原件且重启不复活", async () => {
    const dir = makeTempDir();
    const retainOptions: RuntimeOptions = {
      storage: { mode: "disk", dataDir: dir, retainPages: true },
    };
    const r1 = diskRuntime(dir, retainOptions);
    const created = await r1.createSession({ html: "<h1>keep</h1>", title: "保留页" });
    const token = r1.getSession(created.sessionId)?.token ?? "";
    await expect(
      r1.waitSubmission({ sessionId: created.sessionId, timeoutMs: 1 }),
    ).rejects.toThrow();
    await r1.submitSubmission({
      sessionId: created.sessionId,
      pageId: created.pageId,
      pageVersion: created.pageVersion,
      kind: "private",
      data: { secret: true },
      metadata: {},
      protocolVersion: 1,
    });
    expect(await r1.endSession(created.sessionId)).toEqual({ ok: true });
    expect(existsSync(join(dir, created.sessionId, "page.html"))).toBe(true);
    expect(existsSync(join(dir, created.sessionId, "pending.json"))).toBe(false);
    expect(readFileSync(join(dir, created.sessionId, "meta.json"), "utf8")).not.toContain(token);

    const r2 = diskRuntime(dir, retainOptions);
    expect(r2.getSession(created.sessionId)).toBeUndefined();
    expect(existsSync(join(dir, created.sessionId, "page.html"))).toBe(true);
  });

  it("TTL 过期惰性删除磁盘目录", async () => {
    const dir = makeTempDir();
    const runtime = diskRuntime(dir, { sessionTtlMs: 1 });
    const created = await runtime.createSession({ html: "<h1>x</h1>" });
    expect(existsSync(join(dir, created.sessionId))).toBe(true);
    await Bun.sleep(10);
    await expect(
      runtime.waitSubmission({ sessionId: created.sessionId, timeoutMs: 100 }),
    ).rejects.toThrow(expect.objectContaining({ code: "SESSION_ENDED" }));
    expect(existsSync(join(dir, created.sessionId))).toBe(false);
  });

  it("恢复 pendingSubmission，避免无 waiter 提交在重启后丢失", async () => {
    const dir = makeTempDir();
    const r1 = diskRuntime(dir);
    const created = await r1.createSession({ html: "<h1>x</h1>" });
    await expect(r1.waitSubmission({ sessionId: created.sessionId, timeoutMs: 1 })).rejects.toThrow(
      expect.objectContaining({ code: "WAIT_TIMEOUT" }),
    );
    await r1.submitSubmission({
      sessionId: created.sessionId,
      pageId: created.pageId,
      pageVersion: created.pageVersion,
      kind: "late",
      data: { value: "kept" },
      metadata: {},
      protocolVersion: 1,
    });
    r1.dispose();

    const r2 = diskRuntime(dir);
    const output = await r2.waitSubmission({ sessionId: created.sessionId, timeoutMs: 1000 });
    expect(output).toMatchObject({ kind: "late", data: { value: "kept" }, pageVersion: 1 });
  });

  it("启动恢复清理损坏（缺 meta）与终态目录", async () => {
    const dir = makeTempDir();
    const r1 = diskRuntime(dir);
    const good = await r1.createSession({ html: "<h1>good</h1>" });
    r1.dispose();

    mkdirSync(join(dir, "html_corrupt"), { recursive: true });
    writeFileSync(join(dir, "html_corrupt", "page.html"), "<h1>corrupt</h1>");
    mkdirSync(join(dir, "html_ended"), { recursive: true });
    writeFileSync(join(dir, "html_ended", "page.html"), "<h1>ended</h1>");
    writeFileSync(
      join(dir, "html_ended", "meta.json"),
      JSON.stringify({
        sessionId: "html_ended",
        pageId: "page_x",
        pageVersion: 1,
        token: "token_x",
        status: "ended",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    const r2 = diskRuntime(dir);
    expect(r2.getSession(good.sessionId)).toBeDefined();
    expect(r2.getSession("html_corrupt")).toBeUndefined();
    expect(r2.getSession("html_ended")).toBeUndefined();
    expect(existsSync(join(dir, "html_corrupt"))).toBe(false);
    expect(existsSync(join(dir, "html_ended"))).toBe(false);
  });

  it("启动恢复拒绝字段类型错误和目录 sessionId 不一致", async () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "html_invalid"), { recursive: true });
    writeFileSync(join(dir, "html_invalid", "page.html"), "<p>bad</p>");
    writeFileSync(
      join(dir, "html_invalid", "meta.json"),
      JSON.stringify({
        schemaVersion: 1,
        sessionId: "other",
        pageId: "page",
        pageVersion: "1",
        token: "token",
        status: "waiting",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const runtime = diskRuntime(dir);
    expect(runtime.getSession("html_invalid")).toBeUndefined();
    expect(existsSync(join(dir, "html_invalid"))).toBe(false);
  });

  it("启动恢复清理过期目录", async () => {
    const dir = makeTempDir();
    const r1 = diskRuntime(dir);
    const created = await r1.createSession({ html: "<h1>x</h1>" });
    r1.dispose();

    await Bun.sleep(5);
    const r2 = diskRuntime(dir, { sessionTtlMs: 1 });
    expect(r2.getSession(created.sessionId)).toBeUndefined();
    expect(existsSync(join(dir, created.sessionId))).toBe(false);
  });

  it("更新会话写穿新版本到磁盘", async () => {
    const dir = makeTempDir();
    const r1 = diskRuntime(dir);
    const created = await r1.createSession({ html: "<h1>v1</h1>" });
    await r1.updateSession({ sessionId: created.sessionId, html: "<h1>v2</h1>" });
    expect(existsSync(join(dir, created.sessionId, "page-2.html"))).toBe(true);
    expect(existsSync(join(dir, created.sessionId, "page.html"))).toBe(true);
    r1.dispose();

    const r2 = diskRuntime(dir);
    const restored = r2.getSession(created.sessionId);
    expect(restored?.pageVersion).toBe(2);
    expect(restored?.pageId).not.toBe(created.pageId);
  });
});
