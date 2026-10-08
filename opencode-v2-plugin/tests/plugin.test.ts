import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Plugin } from "@opencode/plugin";

import { createPlugin } from "../src/index";

// 真实 ctx 类型过大，测试在边界处用这个别名断言假对象；生产类型不被弱化
type Context = Plugin.Context;

// 与 @opencode/plugin promise StorageDomain 对齐的内存实现：
// scan 返回 readonly entries 且 value 为 Json
const memoryStorage = () => {
  const backing = new Map<string, unknown>();
  return {
    backing,
    get: async (key: string) => backing.get(key),
    set: async (key: string, value: unknown) => {
      backing.set(key, value);
    },
    remove: async (key: string) => {
      backing.delete(key);
    },
    scan: async ({ prefix, after }: { prefix: string; after?: string }) => {
      const keys = [...backing.keys()]
        .filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
        .sort();
      return { entries: keys.map((key) => ({ key, value: backing.get(key) })) };
    },
  };
};

type FakeEvent = { type: string; data: unknown };

// 可控的事件流：push 投递事件，cleanup abort 时唤醒并结束迭代
const makeFakeEvents = () => {
  const queue: FakeEvent[] = [];
  let wake: (() => void) | undefined;
  let signal: AbortSignal | undefined;

  const subscribe = (options?: { signal?: AbortSignal }) => {
    signal = options?.signal;
    return (async function* () {
      while (true) {
        if (signal?.aborted) return;
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          continue;
        }
        yield queue.shift() as FakeEvent;
      }
    })();
  };

  const push = (event: FakeEvent) => {
    queue.push(event);
    wake?.();
    wake = undefined;
  };

  return { subscribe, push, getSignal: () => signal };
};

type FakeTools = Record<string, unknown>[];

const makeFakeContext = (
  overrides: {
    options?: Record<string, unknown>;
    events?: ReturnType<typeof makeFakeEvents>;
    storage?: ReturnType<typeof memoryStorage>;
    tools?: FakeTools;
  } = {},
) => {
  const tools: FakeTools = overrides.tools ?? [];
  const storage = overrides.storage ?? memoryStorage();
  const events = overrides.events ?? makeFakeEvents();
  const directory = mkdtempSync(join(tmpdir(), "v2-plugin-"));
  const ctx = {
    location: {
      directory,
      project: { id: "proj_test", directory, canonical: directory },
    },
    options: overrides.options ?? {
      server: { port: 0 },
      openBrowser: false,
      pageDir: directory,
    },
    storage,
    tool: {
      transform: async (cb: (editor: { add: (tool: unknown) => void }) => void) => {
        cb({ add: (tool) => tools.push(tool as Record<string, unknown>) });
        return { dispose: async () => {} };
      },
    },
    event: { subscribe: events.subscribe },
  };
  return { ctx: ctx as unknown as Context, tools, storage, events };
};

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1000,
): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor 超时");
};

const toolByName = (tools: FakeTools, name: string) =>
  tools.find((tool) => (tool as { name: string }).name === name) as {
    name: string;
    execute(
      input: unknown,
      context: {
        signal: AbortSignal;
        progress: (message: unknown) => Promise<void>;
        sessionID?: string;
      },
    ): Promise<{ content: string }>;
  };

test("setup 按顺序注册 4 个工具并返回可调用 cleanup", async () => {
  const { ctx, tools } = makeFakeContext();
  const plugin = createPlugin();
  expect(plugin.id).toBe("agent-ui-interaction");

  const cleanup = await plugin.setup(ctx);

  expect(tools.map((tool) => (tool as { name: string }).name)).toEqual([
    "create_html_session",
    "wait_html_submission",
    "update_html_session",
    "end_html_session",
  ]);
  expect(typeof cleanup).toBe("function");
  await cleanup?.();
});

test("cleanup 幂等且中止事件订阅", async () => {
  const { ctx, events } = makeFakeContext();
  const cleanup = await createPlugin().setup(ctx);

  const first = await cleanup?.();
  expect(first).toBeUndefined();
  expect(events.getSignal()?.aborted).toBe(true);

  // 再次调用不抛错
  await cleanup?.();
});

test("session.deleted 事件结束匹配 opencodeSessionId 的会话", async () => {
  const { ctx, tools, storage, events } = makeFakeContext();
  const cleanup = await createPlugin().setup(ctx);

  const create = toolByName(tools, "create_html_session");
  const created = JSON.parse(
    (
      await create.execute(
        { html: "<html></html>" },
        {
          sessionID: "ses_x",
          signal: new AbortController().signal,
          progress: async () => {},
        },
      )
    ).content,
  ) as { sessionId: string };
  expect(created.sessionId).toStartWith("html_");

  expect((await storage.scan({ prefix: "session/" })).entries.length).toBe(1);

  events.push({ type: "session.deleted", data: { sessionID: "ses_x" } });
  await waitFor(async () => (await storage.scan({ prefix: "session/" })).entries.length === 0);

  await cleanup?.();
});
