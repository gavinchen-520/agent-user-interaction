import { Plugin } from "@opencode/plugin";

import { resolveOptions } from "./options";
import type { StorageDomain } from "./runtime";
import {
  createHtmlRuntime,
  createMetaStore,
  createPageStore,
  createRuntimeServer,
} from "./runtime";
import { createHtmlSessionTools } from "./tools";

type PluginContext = Plugin.Context;
type PluginHandle = Plugin.Plugin;
// ctx.tool.transform 回调收到的编辑器类型
type ToolEditor = Parameters<Parameters<PluginContext["tool"]["transform"]>[0]>[0];
type ToolEditorItem = Parameters<ToolEditor["add"]>[0];
// ctx.storage.set 的值类型（effect Schema.Json），无需直接依赖 effect
type StorageValue = Parameters<PluginContext["storage"]["set"]>[1];

// 真实 ctx.storage 的 scan 返回 readonly entries、set 只接受 Json；
// 适配成本地 StorageDomain 所需的可变 entry 数组与 unknown 值（最小映射）
const adaptStorage = (storage: PluginContext["storage"]): StorageDomain => ({
  get: (key) => storage.get(key),
  set: async (key, value) => {
    await storage.set(key, value as StorageValue);
  },
  remove: (key) => storage.remove(key),
  scan: async (options) => {
    const { entries, next } = await storage.scan(options);
    return {
      entries: entries.map((entry) => ({ key: entry.key, value: entry.value })),
      next,
    };
  },
});

const setup = async (ctx: PluginContext): Promise<Plugin.Cleanup> => {
  const opts = resolveOptions(ctx.options);

  const metaStore = createMetaStore(adaptStorage(ctx.storage));
  const pageStore = createPageStore(opts.pageDir);
  const runtime = createHtmlRuntime({
    maxPayloadBytes: opts.maxPayloadBytes,
    defaultTimeoutMs: opts.defaultTimeoutMs,
    sessionTtlMs: opts.sessionTtlMs,
    metaStore,
    pageStore,
  });

  const server = await createRuntimeServer(runtime, {
    hostname: opts.server.hostname,
    port: opts.server.port,
    publicBaseUrl: opts.server.publicBaseUrl,
    maxPayloadBytes: opts.maxPayloadBytes,
    openBrowser: false,
  });

  await runtime.restore();

  await ctx.tool.transform((editor) => {
    const tools = createHtmlSessionTools(runtime, {
      openBrowser: opts.openBrowser,
      rootDirectory: ctx.location.directory,
      maxInlineHtmlBytes: opts.maxInlineHtmlBytes,
      maxPageFileBytes: opts.maxPageFileBytes,
      // 与 runtime 共享同一 maxPayloadBytes，避免两处上限漂移
      maxPayloadBytes: opts.maxPayloadBytes,
    });
    for (const tool of tools) editor.add(tool as unknown as ToolEditorItem);
  });

  // 分离的订阅循环：opencode 会话删除时结束其关联的 html 会话
  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type !== "session.deleted") continue;
        const { sessionID } = event.data;
        for (const session of runtime.listSessions()) {
          if (session.opencodeSessionId === sessionID) await runtime.endSession(session.sessionId);
        }
      }
    } catch {
      // abort 或传输错误都终止循环，无需上抛
    }
  })();

  let cleaned = false;
  return async () => {
    if (cleaned) return;
    cleaned = true;
    controller.abort();
    runtime.dispose();
    await server.stop(true);
  };
};

export function createPlugin(): PluginHandle {
  return Plugin.define({ id: "agent-ui-interaction", setup });
}

export default createPlugin();
