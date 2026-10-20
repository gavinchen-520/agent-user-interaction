import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { tool } from "@opencode-ai/plugin/tool";

import { openBrowser } from "../browser/browser";
import type { HtmlRuntime } from "../runtime";
import { defaultMaxInlineHtmlBytes, defaultMaxPageFileBytes } from "../runtime/constants";
import { collectHtmlIssues, summarizeHtmlIssues } from "../runtime/htmlValidation";
import { injectPageRuntime } from "../runtime/pageRuntime";
import { createRuntimeError } from "../runtime/protocol";
import type { OpenBrowserOption } from "../runtime/server";
import type { OpenCodeTool } from "../types";

export type HtmlSessionToolOptions = {
  rootDirectory?: string;
  maxPayloadBytes?: number;
  openBrowser?: OpenBrowserOption;
  maxInlineHtmlBytes?: number;
  maxPageFileBytes?: number;
};

const htmlSchema = tool.schema.string().min(1, "HTML 不能为空");

const toJson = (value: object): string => JSON.stringify(value);

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

// 读取 htmlFile 指向的本地文件内容，复制进 session（不保留源文件引用）
const readHtmlFile = (
  htmlFile: string,
  maxPageFileBytes: number,
  rootDirectory: string,
): string => {
  const absolute = isAbsolute(htmlFile) ? htmlFile : resolve(rootDirectory, htmlFile);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(absolute);
  } catch {
    throw new Error(`htmlFile 不存在或不可读：${absolute}`);
  }
  if (!stat.isFile()) throw new Error(`htmlFile 不是常规文件：${absolute}`);
  if (stat.size > maxPageFileBytes)
    throw createRuntimeError(
      "HTML_TOO_LARGE",
      `htmlFile 超过大小限制（${maxPageFileBytes} 字节）`,
      413,
      "压缩页面大小后重试",
    );
  return readFileSync(absolute, "utf8");
};

type HtmlLimits = {
  maxInlineHtmlBytes: number;
  maxPageFileBytes: number;
};

// 生产沙箱兼容性硬门禁：jsdom 不执行 sandbox/CSP，这里静态拦截必然失效的模式
const assertSandboxCompatible = (html: string): void => {
  const issues = collectHtmlIssues(html);
  if (issues.length === 0) return;
  throw createRuntimeError(
    "INVALID_HTML",
    `HTML 含生产沙箱不允许的模式：${issues.map((issue) => issue.code).join("、")}`,
    400,
    summarizeHtmlIssues(issues),
  );
};

const resolveHtml = (
  html: string | undefined,
  htmlFile: string | undefined,
  limits: HtmlLimits,
  rootDirectory: string,
): string => {
  if (html !== undefined && htmlFile !== undefined)
    throw new Error("html 与 htmlFile 不能同时提供");
  let content: string;
  if (html !== undefined) {
    const bytes = byteLength(html);
    if (bytes > limits.maxInlineHtmlBytes)
      throw createRuntimeError(
        "HTML_TOO_LARGE_FOR_INLINE",
        `内联 HTML 为 ${bytes} 字节，超过内联上限 ${limits.maxInlineHtmlBytes} 字节`,
        413,
        `改用 htmlFile 传入文件路径（上限 ${limits.maxPageFileBytes} 字节），或用数据驱动渲染/压缩把页面降到内联上限以内`,
      );
    content = html;
  } else if (htmlFile !== undefined) {
    content = readHtmlFile(htmlFile, limits.maxPageFileBytes, rootDirectory);
  } else {
    throw new Error("必须提供 html 或 htmlFile 之一");
  }
  assertSandboxCompatible(content);
  return content;
};

export const createHtmlSessionTools = (
  runtime: HtmlRuntime,
  options: HtmlSessionToolOptions = {},
): Record<string, OpenCodeTool> => {
  // 默认在 create 成功后自动打开浏览器；测试或无显示环境可传 false 或注入自定义实现
  const openBrowserOption = options.openBrowser ?? true;
  const rootDirectory = options.rootDirectory ?? process.cwd();
  const limits: HtmlLimits = {
    maxInlineHtmlBytes: options.maxInlineHtmlBytes ?? defaultMaxInlineHtmlBytes,
    maxPageFileBytes: options.maxPageFileBytes ?? defaultMaxPageFileBytes,
  };
  const maxPayloadBytes = options.maxPayloadBytes;
  const openSessionBrowser = async (url: string, sessionId: string): Promise<void> => {
    if (openBrowserOption === false) return;
    const open = typeof openBrowserOption === "function" ? openBrowserOption : openBrowser;
    try {
      await open(url);
    } catch (error) {
      // 打开失败按 plan 语义清理 session 与 waiter，避免留下不可达的会话
      await runtime.endSession(sessionId);
      const reason = error instanceof Error ? error.message : String(error);
      throw createRuntimeError(
        "BROWSER_OPEN_FAILED",
        `打开浏览器失败：${reason}`,
        500,
        "把页面 URL 手动告诉用户，或创建新的 session",
      );
    }
  };
  return {
    create_html_session: tool({
      description: "创建一个可交互的 HTML 页面会话。",
      args: {
        title: tool.schema.string().optional(),
        html: htmlSchema.optional(),
        htmlFile: tool.schema.string().min(1, "htmlFile 不能为空").optional(),
        initialState: tool.schema.unknown().optional(),
      },
      execute: async (args, toolCtx) => {
        const html = resolveHtml(
          args.html,
          args.htmlFile,
          limits,
          toolCtx.directory || rootDirectory,
        );
        const output = await runtime.createSession({
          title: args.title,
          html: injectPageRuntime(html, { maxPayloadBytes }),
          initialState: args.initialState,
          opencodeSessionId: toolCtx.sessionID,
        });
        await openSessionBrowser(output.url, output.sessionId);
        return toJson(output);
      },
    }),
    wait_html_submission: tool({
      description: "等待 HTML 页面提交结构化数据。",
      args: {
        sessionId: tool.schema.string().min(1),
        timeoutMs: tool.schema.number().int().positive().optional(),
      },
      execute: async (args) => toJson(await runtime.waitSubmission(args)),
    }),
    update_html_session: tool({
      description: "更新 HTML 页面内容和可选状态。",
      args: {
        sessionId: tool.schema.string().min(1),
        html: htmlSchema.optional(),
        htmlFile: tool.schema.string().min(1, "htmlFile 不能为空").optional(),
        state: tool.schema.unknown().optional(),
      },
      execute: async (args, toolCtx) => {
        const html = resolveHtml(
          args.html,
          args.htmlFile,
          limits,
          toolCtx.directory || rootDirectory,
        );
        return toJson(
          await runtime.updateSession({
            sessionId: args.sessionId,
            html: injectPageRuntime(html, { maxPayloadBytes }),
            state: args.state,
          }),
        );
      },
    }),
    end_html_session: tool({
      description: "结束一个 HTML 页面会话。",
      args: {
        sessionId: tool.schema.string().min(1),
      },
      execute: async (args) => toJson(await runtime.endSession(args.sessionId)),
    }),
  };
};
