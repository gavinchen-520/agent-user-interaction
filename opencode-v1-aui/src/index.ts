import { isAbsolute, resolve } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import type { HtmlInteractionPluginOptions } from "./config";
import { resolveConfig } from "./config";
import { createHtmlRuntime, createRuntimeServer } from "./runtime";
import { createHtmlSessionTools } from "./tools";

export type { HtmlInteractionPluginOptions } from "./config";

const getDeletedSessionId = (event: { type: string; properties: unknown }): string | undefined => {
  if (
    event.type !== "session.deleted" ||
    typeof event.properties !== "object" ||
    event.properties === null
  )
    return undefined;
  const properties = event.properties as Record<string, unknown>;
  const info = properties.info;
  if (typeof info !== "object" || info === null) return undefined;
  const id = (info as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
};

export const createHtmlInteractionPlugin = (options: HtmlInteractionPluginOptions = {}): Plugin => {
  const config = resolveConfig(options);
  return async (input) => {
    const resolveWorkspacePath = (value: string): string =>
      isAbsolute(value) ? value : resolve(input.directory, value);
    const runtime = createHtmlRuntime({
      maxPayloadBytes: config.maxPayloadBytes,
      defaultTimeoutMs: config.defaultTimeoutMs,
      sessionTtlMs: config.sessionTtlMs,
      storage: {
        mode: config.storage.mode,
        dataDir: resolveWorkspacePath(config.storage.dataDir),
        retainPages: config.storage.retainPages,
      },
    });
    // server 先于任何 session 启动，浏览器打开发生在 create_html_session 成功之后
    let server: Awaited<ReturnType<typeof createRuntimeServer>>;
    try {
      server = await createRuntimeServer(runtime, {
        hostname: config.server.hostname,
        port: config.server.port,
        publicBaseUrl: config.server.publicBaseUrl,
        maxPayloadBytes: config.maxPayloadBytes,
        openBrowser: false,
      });
    } catch (error) {
      runtime.dispose();
      throw error;
    }

    return {
      tool: createHtmlSessionTools(runtime, {
        openBrowser: config.openBrowser ?? true,
        rootDirectory: input.directory,
        maxPayloadBytes: config.maxPayloadBytes,
        maxPageFileBytes: config.storage.maxPageFileBytes,
      }),
      event: async ({ event }) => {
        const opencodeSessionId = getDeletedSessionId(event);
        if (!opencodeSessionId) return;
        const sessionIds = runtime
          .listSessions()
          .filter((session) => session.opencodeSessionId === opencodeSessionId)
          .map((session) => session.sessionId);
        await Promise.all(sessionIds.map((sessionId) => runtime.endSession(sessionId)));
      },
      dispose: async () => {
        // 释放进程内资源（内存索引与 waiter），磁盘文件留给下次启动恢复
        runtime.dispose();
        await server.stop(true);
      },
    };
  };
};

// 默认导出透传 opencode 传入的 options（Config.plugin 支持 [path, options] 元组）
const plugin: Plugin = (input, options) =>
  createHtmlInteractionPlugin(options as HtmlInteractionPluginOptions | undefined)(input);

export default plugin;
