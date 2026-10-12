import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StorageDomain } from "../src/runtime/metaStore";
import { createMetaStore } from "../src/runtime/metaStore";
import { createPageStore } from "../src/runtime/pageStore";
import { createHtmlRuntime } from "../src/runtime/store";
import type { ToolConfig } from "../src/tools";
import { createHtmlSessionTools } from "../src/tools";

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

const makeRuntime = () => {
  const pageDir = mkdtempSync(join(tmpdir(), "v2-tools-"));
  const runtime = createHtmlRuntime({
    metaStore: createMetaStore(memoryStorage(new Map())),
    pageStore: createPageStore(pageDir),
  });
  return { runtime, pageDir };
};

const baseConfig = (rootDirectory: string): ToolConfig => ({
  openBrowser: false,
  rootDirectory,
  maxInlineHtmlBytes: 64 * 1024,
  maxPageFileBytes: 3 * 1024 * 1024,
  maxPayloadBytes: 64 * 1024,
});

const makeContext = (signal = new AbortController().signal) => ({
  signal,
  progress: async (_message: unknown) => {},
});

const { runtime, pageDir } = makeRuntime();
const cfg = baseConfig(pageDir);
const ctx = makeContext();

afterAll(() => {
  runtime.dispose();
});

describe("createHtmlSessionTools", () => {
  test("按固定顺序返回四个工具", () => {
    const tools = createHtmlSessionTools(runtime, cfg);
    expect(tools.map((tool) => tool.name)).toEqual([
      "create_html_session",
      "wait_html_submission",
      "update_html_session",
      "end_html_session",
    ]);
  });

  test("create_html_session 返回 url 与 pageVersion", async () => {
    const [create] = createHtmlSessionTools(runtime, cfg);
    const out = JSON.parse((await create.execute({ html: "<html></html>" }, ctx)).content);
    expect(out.sessionId).toStartWith("html_");
    expect(out.url).toContain(`/session/${out.sessionId}`);
    expect(out.pageVersion).toBe(1);
  });

  test("create_html_session 记录 context.sessionID 为 opencodeSessionId", async () => {
    const [create] = createHtmlSessionTools(runtime, cfg);
    const created = JSON.parse(
      (await create.execute({ html: "<html></html>" }, { ...ctx, sessionID: "ses_x" })).content,
    );
    expect(runtime.getSession(created.sessionId)?.opencodeSessionId).toBe("ses_x");
  });

  test("html 与 htmlFile 互斥", async () => {
    const [create] = createHtmlSessionTools(runtime, cfg);
    await expect(
      create.execute({ html: "<html></html>", htmlFile: "a.html" }, ctx),
    ).rejects.toThrow();
  });

  test("内联超限与文件超限返回对应错误码", async () => {
    const [createInline] = createHtmlSessionTools(runtime, { ...cfg, maxInlineHtmlBytes: 10 });
    await expect(
      createInline.execute({ html: "<html>too long</html>" }, ctx),
    ).rejects.toMatchObject({ code: "HTML_TOO_LARGE_FOR_INLINE" });

    writeFileSync(join(pageDir, "big.html"), "x".repeat(100));
    const [createFile] = createHtmlSessionTools(runtime, { ...cfg, maxPageFileBytes: 10 });
    await expect(createFile.execute({ htmlFile: "big.html" }, ctx)).rejects.toMatchObject({
      code: "HTML_TOO_LARGE",
    });
  });

  test("沙箱违例 HTML 被拒（INVALID_HTML）", async () => {
    const [create] = createHtmlSessionTools(runtime, cfg);
    await expect(
      create.execute({ html: '<button type="submit">x</button>' }, ctx),
    ).rejects.toMatchObject({ code: "INVALID_HTML" });
  });

  test("update_html_session 生成新版本并注入页面运行时", async () => {
    const [create, , update] = createHtmlSessionTools(runtime, cfg);
    const created = JSON.parse(
      (await create.execute({ html: "<html></html>", title: "t" }, ctx)).content,
    );
    const updated = JSON.parse(
      (
        await update.execute(
          { sessionId: created.sessionId, html: "<p>next</p>", state: { step: 2 } },
          ctx,
        )
      ).content,
    );
    expect(updated.pageVersion).toBe(2);
    expect(updated.pageId).not.toBe(created.pageId);
  });

  test("end_html_session 返回 ok", async () => {
    const [create, , , end] = createHtmlSessionTools(runtime, cfg);
    const created = JSON.parse((await create.execute({ html: "<html></html>" }, ctx)).content);
    const ended = JSON.parse((await end.execute({ sessionId: created.sessionId }, ctx)).content);
    expect(ended).toEqual({ ok: true });
  });

  test("浏览器打开失败时抛 BROWSER_OPEN_FAILED 并清理会话", async () => {
    const { runtime: isolated } = makeRuntime();
    const [create] = createHtmlSessionTools(isolated, {
      ...cfg,
      openBrowser: async () => {
        throw new Error("no display");
      },
    });
    await expect(create.execute({ html: "<html></html>" }, ctx)).rejects.toMatchObject({
      code: "BROWSER_OPEN_FAILED",
    });
    expect(isolated.countLiveSessions()).toBe(0);
    isolated.dispose();
  });

  test("wait 使用 context.signal 取消", async () => {
    const [create, wait] = createHtmlSessionTools(runtime, cfg);
    const created = JSON.parse((await create.execute({ html: "<html></html>" }, ctx)).content);
    const controller = new AbortController();
    const pending = wait.execute(
      { sessionId: created.sessionId },
      { ...ctx, signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "WAIT_CANCELLED" });
  });
});

describe("createHtmlSessionTools metrics 接线（服务端 TTFP 代理口径）", () => {
  type PageReadyRecord = {
    phase: string;
    sessionId: string;
    opencodeSessionId: string;
    durationMs: number;
    bytes: number;
    at: string;
  };

  const makeMetrics = (startAt: number | null) => {
    const records: PageReadyRecord[] = [];
    return {
      records,
      metrics: {
        getTurnStart: (sessionId?: string) => (sessionId === "ses_t1" ? startAt : null),
        appendTiming: (record: Record<string, unknown>) => {
          records.push(record as unknown as PageReadyRecord);
        },
      },
    };
  };

  test("create 成功后写入 pageReady 记录（含 durationMs/bytes/opencodeSessionId）", async () => {
    const startedAt = Date.now() - 5;
    const { records, metrics } = makeMetrics(startedAt);
    const [create] = createHtmlSessionTools(runtime, cfg, metrics);
    const created = JSON.parse(
      (await create.execute({ html: "<html></html>" }, { ...ctx, sessionID: "ses_t1" })).content,
    );
    expect(records).toHaveLength(1);
    const [rec] = records;
    expect(rec.phase).toBe("pageReady");
    expect(rec.sessionId).toBe(created.sessionId);
    expect(rec.opencodeSessionId).toBe("ses_t1");
    expect(rec.durationMs).toBeGreaterThanOrEqual(0);
    expect(rec.bytes).toBe(byteLengthOf("<html></html>"));
    expect(typeof rec.at).toBe("string");
  });

  test("update 成功同样写入 pageReady 记录", async () => {
    const startedAt = Date.now() - 5;
    const { records, metrics } = makeMetrics(startedAt);
    const [create, , update] = createHtmlSessionTools(runtime, cfg, metrics);
    const created = JSON.parse(
      (await create.execute({ html: "<html></html>" }, { ...ctx, sessionID: "ses_t1" })).content,
    );
    await update.execute(
      { sessionId: created.sessionId, html: "<p>next</p>" },
      { ...ctx, sessionID: "ses_t1" },
    );
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({ phase: "pageReady", opencodeSessionId: "ses_t1" });
  });

  test("无轮次起点或未传 metrics 时不写任何记录", async () => {
    const nullStart = makeMetrics(null);
    const [createA] = createHtmlSessionTools(runtime, cfg, nullStart.metrics);
    await createA.execute({ html: "<html></html>" }, { ...ctx, sessionID: "ses_t1" });
    expect(nullStart.records).toHaveLength(0);

    const [createB] = createHtmlSessionTools(runtime, cfg);
    await createB.execute({ html: "<html></html>" }, { ...ctx, sessionID: "ses_t1" });
  });
});

const byteLengthOf = (value: string): number => new TextEncoder().encode(value).byteLength;
