import { describe, expect, it } from "bun:test";
import type { PluginInput } from "@opencode-ai/plugin";
import type { ToolContext } from "@opencode-ai/plugin/tool";

import plugin from "../opencode-plugin/src";

const createPluginInput = (): PluginInput => ({
  client: {} as PluginInput["client"],
  project: {} as PluginInput["project"],
  directory: "/tmp",
  worktree: "/tmp",
  experimental_workspace: { register: () => {} },
  serverUrl: new URL("http://127.0.0.1:4096"),
  $: {} as PluginInput["$"],
});

const createToolContext = (sessionID: string): ToolContext => ({
  sessionID,
  messageID: "message",
  agent: "agent",
  directory: "/tmp",
  worktree: "/tmp",
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
});

const parseOutput = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "string") throw new Error("工具未返回 JSON 文本");
  const output = JSON.parse(value) as unknown;
  if (typeof output !== "object" || output === null) throw new Error("工具输出不是对象");
  return output as Record<string, unknown>;
};

describe("插件生命周期", () => {
  it("删除 OpenCode session 时结束其创建的所有 HTML session", async () => {
    const hooks = await plugin(createPluginInput());
    const create = hooks.tool?.create_html_session;
    const end = hooks.tool?.end_html_session;
    if (!create || !end || !hooks.event) throw new Error("插件未注册预期 hooks");
    const context = createToolContext("opencode-session");
    const first = parseOutput(await create.execute({ html: "<p>first</p>" }, context));
    const second = parseOutput(await create.execute({ html: "<p>second</p>" }, context));
    if (typeof first.sessionId !== "string" || typeof second.sessionId !== "string") throw new Error("创建工具未返回 sessionId");

    await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "opencode-session" } } } });

    await expect(end.execute({ sessionId: first.sessionId }, context)).resolves.toBe(JSON.stringify({ ok: false }));
    await expect(end.execute({ sessionId: second.sessionId }, context)).resolves.toBe(JSON.stringify({ ok: false }));
    await hooks.dispose?.();
  });

  it("释放插件时结束尚未删除的 HTML session", async () => {
    const hooks = await plugin(createPluginInput());
    const create = hooks.tool?.create_html_session;
    const end = hooks.tool?.end_html_session;
    if (!create || !end || !hooks.dispose) throw new Error("插件未注册预期 hooks");
    const context = createToolContext("opencode-session");
    const created = parseOutput(await create.execute({ html: "<p>active</p>" }, context));
    if (typeof created.sessionId !== "string") throw new Error("创建工具未返回 sessionId");

    await hooks.dispose();

    await expect(end.execute({ sessionId: created.sessionId }, context)).resolves.toBe(JSON.stringify({ ok: false }));
  });
});
