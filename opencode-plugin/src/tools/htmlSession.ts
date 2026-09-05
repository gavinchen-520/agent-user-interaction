import { tool } from "@opencode-ai/plugin/tool";
import type { HtmlRuntime } from "../runtime";
import { defaultMaxPayloadBytes } from "../runtime/constants";
import type { OpenCodeTool } from "../types";

type SessionCreatedHandler = (opencodeSessionId: string, htmlSessionId: string) => void;

const maxHtmlBytes = defaultMaxPayloadBytes;

const htmlSchema = tool.schema
  .string()
  .min(1, "HTML 不能为空")
  .refine((html) => new TextEncoder().encode(html).byteLength <= maxHtmlBytes, "HTML 超过大小限制");

const toJson = (value: object): string => JSON.stringify(value);

const validateHtmlSize = (html: string): void => {
  if (new TextEncoder().encode(html).byteLength > maxHtmlBytes)
    throw new Error("HTML 超过大小限制");
};

export const createHtmlSessionTools = (
  runtime: HtmlRuntime,
  onSessionCreated?: SessionCreatedHandler,
): Record<string, OpenCodeTool> => ({
  create_html_session: tool({
    description: "创建一个可交互的 HTML 页面会话。",
    args: {
      title: tool.schema.string().optional(),
      html: htmlSchema,
      initialState: tool.schema.unknown().optional(),
    },
    execute: async (args, toolCtx) => {
      validateHtmlSize(args.html);
      const output = await runtime.createSession(args);
      onSessionCreated?.(toolCtx.sessionID, output.sessionId);
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
      html: htmlSchema,
      state: tool.schema.unknown().optional(),
    },
    execute: async (args) => {
      validateHtmlSize(args.html);
      return toJson(await runtime.updateSession(args));
    },
  }),
  end_html_session: tool({
    description: "结束一个 HTML 页面会话。",
    args: {
      sessionId: tool.schema.string().min(1),
    },
    execute: async (args) => toJson(await runtime.endSession(args.sessionId)),
  }),
});
