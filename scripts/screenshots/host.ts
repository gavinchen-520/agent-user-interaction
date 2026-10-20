// 截图专用宿主：用真实 V2 runtime + wrapper 渲染场景页面，供 Playwright 截图。
// 通过 stdin/stdout 的 JSON 行协议接受命令，避免 Node 侧无法直接使用 Bun.serve。

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createHtmlRuntime,
  createMetaStore,
  createPageStore,
} from "../../opencode-v2-aui/src/runtime";
import { createRuntimeServer } from "../../opencode-v2-aui/src/runtime/server";
import { createHtmlSessionTools } from "../../opencode-v2-aui/src/tools";

type HostCommand =
  | { type: "create"; scenario: string; title: string }
  | { type: "update"; scenario: string }
  | { type: "end" }
  | { type: "shutdown" };

const scenarioDir = join(import.meta.dir, "scenarios");
const pageDir = mkdtempSync(join(tmpdir(), "aui-screenshots-"));

const storage = new Map<string, unknown>();
const metaStore = createMetaStore({
  get: async (key) => storage.get(key),
  set: async (key, value) => {
    storage.set(key, value);
  },
  remove: async (key) => {
    storage.delete(key);
  },
  scan: async ({ prefix, after }) => {
    const keys = [...storage.keys()]
      .filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
      .sort();
    return { entries: keys.map((key) => ({ key, value: storage.get(key) })) };
  },
});

const runtime = createHtmlRuntime({
  metaStore,
  pageStore: createPageStore(pageDir),
});
const server = await createRuntimeServer(runtime, { openBrowser: false });
const tools = createHtmlSessionTools(runtime, {
  openBrowser: false,
  rootDirectory: process.cwd(),
  maxInlineHtmlBytes: 64 * 1024,
  maxPageFileBytes: 3 * 1024 * 1024,
  maxPayloadBytes: 64 * 1024,
});

const toolContext = {
  sessionID: "screenshot-host",
  messageID: "screenshot-message",
  agent: "screenshot-agent",
  directory: process.cwd(),
  worktree: process.cwd(),
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
};

const readScenario = (scenario: string): string =>
  readFileSync(join(scenarioDir, `${scenario}.html`), "utf8");

let activeSessionId = "";
const getActiveSessionId = (): string => activeSessionId;

const tool = (name: string) => {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`工具不存在：${name}`);
  return found;
};

const writeMessage = (message: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const handleCommand = async (command: HostCommand): Promise<void> => {
  switch (command.type) {
    case "create": {
      const result = JSON.parse(
        (
          await tool("create_html_session").execute(
            { title: command.title, html: readScenario(command.scenario) },
            toolContext,
          )
        ).content,
      ) as { sessionId: string; url: string; pageVersion: number };
      activeSessionId = result.sessionId;
      writeMessage({ type: "ready", ...result });
      return;
    }
    case "update": {
      const result = JSON.parse(
        (
          await tool("update_html_session").execute(
            { sessionId: getActiveSessionId(), html: readScenario(command.scenario) },
            toolContext,
          )
        ).content,
      ) as { pageId: string; pageVersion: number };
      writeMessage({ type: "updated", ...result });
      return;
    }
    case "end": {
      writeMessage({
        type: "ended",
        ...JSON.parse(
          (await tool("end_html_session").execute({ sessionId: getActiveSessionId() }, toolContext))
            .content,
        ),
      });
      return;
    }
    case "shutdown": {
      for (const session of runtime.listSessions()) await runtime.endSession(session.sessionId);
      await server.stop(true);
      process.exit(0);
    }
  }
};

let pending = "";
for await (const chunk of process.stdin) {
  pending += chunk.toString();
  let newlineIndex = pending.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = pending.slice(0, newlineIndex);
    pending = pending.slice(newlineIndex + 1);
    if (line.trim().length > 0) {
      try {
        await handleCommand(JSON.parse(line) as HostCommand);
      } catch (error) {
        writeMessage({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    newlineIndex = pending.indexOf("\n");
  }
}
