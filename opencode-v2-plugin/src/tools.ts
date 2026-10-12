import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { openBrowser } from "./runtime/browser";
import { collectHtmlIssues, summarizeHtmlIssues } from "./runtime/htmlValidation";
import { injectPageRuntime } from "./runtime/pageRuntime";
import { createRuntimeError } from "./runtime/protocol";
import type { HtmlRuntime } from "./runtime/types";

export type ToolConfig = {
  openBrowser: boolean | ((url: string) => Promise<void>);
  rootDirectory: string;
  maxInlineHtmlBytes: number;
  maxPageFileBytes: number;
  maxPayloadBytes: number;
};

// V2 工具是纯对象：input 为 JSON Schema，execute 返回 { content }。
// 本地定义类型而不导入 @opencode/plugin（避免把 effect 拉进依赖图）；结构与
// ctx.tool.transform 的 editor.add 兼容（R5）。
export type ToolInfo = {
  name: string;
  description: string;
  input: Record<string, unknown>;
  execute(
    // biome-ignore lint/suspicious/noExplicitAny: 宿主 ToolContext 的入参为宽松类型，收紧需要拉入 @opencode/plugin（effect 依赖），得不偿失
    input: any,
    context: {
      signal: AbortSignal;
      // biome-ignore lint/suspicious/noExplicitAny: progress 回调载荷为 opaque metadata，宿主不约束其形状
      progress: (message: any) => Promise<void>;
      // V2 ToolContext 携带发起工具调用的 opencode sessionID；用于把 html 会话关联回 opencode 会话
      sessionID?: string;
    },
  ): Promise<{ content: string }>;
};

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

// html 与 htmlFile 互斥；内联走内联上限，文件走页面文件上限；统一过沙箱门禁
const resolveHtml = (
  html: string | undefined,
  htmlFile: string | undefined,
  config: ToolConfig,
): string => {
  if (html !== undefined && htmlFile !== undefined)
    throw new Error("html 与 htmlFile 不能同时提供");
  let content: string;
  if (html !== undefined) {
    const bytes = byteLength(html);
    if (bytes > config.maxInlineHtmlBytes)
      throw createRuntimeError(
        "HTML_TOO_LARGE_FOR_INLINE",
        `内联 HTML 为 ${bytes} 字节，超过内联上限 ${config.maxInlineHtmlBytes} 字节`,
        413,
        `改用 htmlFile 传入文件路径（上限 ${config.maxPageFileBytes} 字节），或用数据驱动渲染/压缩把页面降到内联上限以内`,
      );
    content = html;
  } else if (htmlFile !== undefined) {
    content = readHtmlFile(htmlFile, config.maxPageFileBytes, config.rootDirectory);
  } else {
    throw new Error("必须提供 html 或 htmlFile 之一");
  }
  assertSandboxCompatible(content);
  return content;
};

const createInput = {
  type: "object",
  properties: {
    title: { type: "string" },
    html: { type: "string", minLength: 1 },
    htmlFile: { type: "string", minLength: 1 },
    initialState: {},
  },
  additionalProperties: false,
};

const waitInput = {
  type: "object",
  properties: {
    sessionId: { type: "string", minLength: 1 },
    timeoutMs: { type: "number", minimum: 1 },
  },
  required: ["sessionId"],
  additionalProperties: false,
};

const updateInput = {
  type: "object",
  properties: {
    sessionId: { type: "string", minLength: 1 },
    html: { type: "string", minLength: 1 },
    htmlFile: { type: "string", minLength: 1 },
    state: {},
  },
  required: ["sessionId"],
  additionalProperties: false,
};

const endInput = {
  type: "object",
  properties: {
    sessionId: { type: "string", minLength: 1 },
  },
  required: ["sessionId"],
  additionalProperties: false,
};

export const createHtmlSessionTools = (runtime: HtmlRuntime, config: ToolConfig): ToolInfo[] => {
  // 打开失败时清理 session，避免留下不可达的会话（沿用 V1 语义）
  const openSessionBrowser = async (url: string, sessionId: string): Promise<void> => {
    if (config.openBrowser === false) return;
    const open = typeof config.openBrowser === "function" ? config.openBrowser : openBrowser;
    try {
      await open(url);
    } catch (error) {
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

  const create: ToolInfo = {
    name: "create_html_session",
    description: "创建一个可交互的 HTML 页面会话。",
    input: createInput,
    execute: async (input, context) => {
      const html = resolveHtml(input.html, input.htmlFile, config);
      const output = await runtime.createSession({
        title: input.title,
        html: injectPageRuntime(html, { maxPayloadBytes: config.maxPayloadBytes }),
        initialState: input.initialState,
        opencodeSessionId: context.sessionID,
      });
      await openSessionBrowser(output.url, output.sessionId);
      return { content: toJson(output) };
    },
  };

  const wait: ToolInfo = {
    name: "wait_html_submission",
    description: "等待 HTML 页面提交结构化数据。",
    input: waitInput,
    execute: async (input, context) => ({
      content: toJson(
        await runtime.waitSubmission({
          sessionId: input.sessionId,
          timeoutMs: input.timeoutMs,
          signal: context.signal,
        }),
      ),
    }),
  };

  const update: ToolInfo = {
    name: "update_html_session",
    description: "更新 HTML 页面内容和可选状态。",
    input: updateInput,
    execute: async (input) => {
      const html = resolveHtml(input.html, input.htmlFile, config);
      return {
        content: toJson(
          await runtime.updateSession({
            sessionId: input.sessionId,
            html: injectPageRuntime(html, { maxPayloadBytes: config.maxPayloadBytes }),
            state: input.state,
          }),
        ),
      };
    },
  };

  const end: ToolInfo = {
    name: "end_html_session",
    description: "结束一个 HTML 页面会话。",
    input: endInput,
    execute: async (input) => ({ content: toJson(await runtime.endSession(input.sessionId)) }),
  };

  return [create, wait, update, end];
};
