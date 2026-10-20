import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHtmlRuntime } from "../../opencode-v1-aui/src/runtime";
import type { HtmlSessionToolOptions } from "../../opencode-v1-aui/src/tools";
import { createHtmlSessionTools } from "../../opencode-v1-aui/src/tools";

const toolContext = {
  sessionID: "opencode-session",
  messageID: "message",
  agent: "agent",
  directory: "/tmp",
  worktree: "/tmp",
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
};

const executeTool = async (
  name: string,
  args: Record<string, unknown>,
  runtime = createHtmlRuntime(),
  toolOptions: HtmlSessionToolOptions = { openBrowser: false },
) => {
  const result = await createHtmlSessionTools(runtime, toolOptions)[name]?.execute(
    args,
    toolContext,
  );
  if (typeof result !== "string") throw new Error(`工具 ${name} 未返回 JSON 文本`);
  return JSON.parse(result) as {
    sessionId: string;
    pageId: string;
    pageVersion: number;
    url: string;
  };
};

describe("htmlFile 文件模式工具", () => {
  const tempDirs: string[] = [];

  const makeTempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "html-file-"));
    tempDirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("htmlFile 读取文件内容并复制进 session", async () => {
    const dir = makeTempDir();
    const file = join(dir, "page.html");
    writeFileSync(file, "<h1>from file</h1>");
    const runtime = createHtmlRuntime();
    const created = await executeTool("create_html_session", { htmlFile: file }, runtime);
    expect(runtime.getSession(created.sessionId)?.html).toBe("<h1>from file</h1>");
  });

  it("htmlFile 可承载超过内联上限（64 KiB）的页面", async () => {
    const dir = makeTempDir();
    const file = join(dir, "big.html");
    const content = `<p>${"x".repeat(70 * 1024)}</p>`;
    writeFileSync(file, content);
    const runtime = createHtmlRuntime();
    const created = await executeTool("create_html_session", { htmlFile: file }, runtime);
    expect(runtime.getSession(created.sessionId)?.html).toBe(content);
  });

  it("update_html_session 同样支持 htmlFile", async () => {
    const dir = makeTempDir();
    const file = join(dir, "next.html");
    writeFileSync(file, "<h1>updated from file</h1>");
    const runtime = createHtmlRuntime();
    const created = await executeTool("create_html_session", { html: "<h1>v1</h1>" }, runtime);
    const updated = await executeTool(
      "update_html_session",
      { sessionId: created.sessionId, htmlFile: file },
      runtime,
    );
    expect(updated.pageVersion).toBe(2);
    expect(runtime.getSession(created.sessionId)?.html).toBe("<h1>updated from file</h1>");
  });

  it("html 与 htmlFile 同时提供时拒绝", async () => {
    const dir = makeTempDir();
    const file = join(dir, "page.html");
    writeFileSync(file, "<h1>x</h1>");
    const runtime = createHtmlRuntime();
    await expect(
      executeTool("create_html_session", { html: "<p>x</p>", htmlFile: file }, runtime),
    ).rejects.toThrow("html 与 htmlFile 不能同时提供");
  });

  it("两者都缺时拒绝", async () => {
    const runtime = createHtmlRuntime();
    await expect(executeTool("create_html_session", {}, runtime)).rejects.toThrow(
      "必须提供 html 或 htmlFile 之一",
    );
  });

  it("超过 maxPageFileBytes 的文件被拒绝", async () => {
    const dir = makeTempDir();
    const file = join(dir, "big.html");
    writeFileSync(file, "x".repeat(1000));
    const runtime = createHtmlRuntime();
    await expect(
      executeTool("create_html_session", { htmlFile: file }, runtime, {
        openBrowser: false,
        maxPageFileBytes: 100,
      }),
    ).rejects.toThrow("htmlFile 超过大小限制（100 字节）");
  });

  it("目录与不存在的文件被拒绝", async () => {
    const dir = makeTempDir();
    const subdir = join(dir, "subdir");
    mkdirSync(subdir);
    const runtime = createHtmlRuntime();
    await expect(executeTool("create_html_session", { htmlFile: subdir }, runtime)).rejects.toThrow(
      "htmlFile 不是常规文件",
    );
    await expect(
      executeTool("create_html_session", { htmlFile: join(dir, "nope.html") }, runtime),
    ).rejects.toThrow("htmlFile 不存在或不可读");
  });
});
