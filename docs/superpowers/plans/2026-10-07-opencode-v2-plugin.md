# OpenCode V2 插件重构（opencode-v2-plugin）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `opencode-v2-plugin/` 下产出一套 OpenCode V2 原生插件，提供与 V1 对等的 HTML 交互会话工具（create/wait/update/end），采用 `Plugin.define`、`ctx.tool.transform`、`ctx.storage`、`ctx.event.subscribe` 与混合存储（元数据走 ctx.storage，页面走临时文件）。

**Architecture:** 平台无关运行时（protocol/waiter/htmlValidation/pageRuntime/wrapper/browser/server）从 V1 复用并去配置分支；存储层替换为两个适配器：`metaStore`（ctx.storage）与 `pageStore`（临时文件）；`store.ts` 会话状态机改为异步持久化并新增 `restore()`；入口 `index.ts` 用 `Plugin.define` 装配 runtime + server + 4 个工具 + 会话删除事件订阅，setup 返回 cleanup。

**Tech Stack:** TypeScript、Bun（`Bun.serve` / `Bun.file` / `Bun.spawn`）、valibot、`@opencode/plugin@2.0.24`、`bun test`。

**Spec:** `docs/superpowers/specs/2026-10-07-opencode-v2-plugin-design.md`

## Global Constraints

- 目标包目录固定为 `opencode-v2-plugin/`；V1 的 `opencode-plugin/` 不改动。
- 插件 id 固定为 `"agent-ui-interaction"`。
- 包名 `@agent-ui-interaction/opencode-v2-plugin`，`"type": "module"`，`"exports": { ".": "./src/index.ts" }`。
- 依赖：`@opencode/plugin@2.0.24`、`valibot@^1.2.0`；运行时用 Bun API。
- 工具名保持：`create_html_session`、`wait_html_submission`、`update_html_session`、`end_html_session`。
- 默认值：`server.hostname="127.0.0.1"`、`server.port=0`、`sessionTtlMs=1800000`、`defaultTimeoutMs=300000`、`maxPayloadBytes=65536`、`maxInlineHtmlBytes=65536`、`maxPageFileBytes=3145728`、`pageDir=os.tmpdir()/opencode-html-sessions`、`openBrowser=true`。
- 非 loopback `server.hostname` 且未配置 `server.publicBaseUrl` 时启动失败。
- 提交协议不变：`html-submit` 信封、pageId+pageVersion 校验、stale/duplicate 拒绝、错误码与 V1 一致。
- 代码风格沿用 Biome：2 空格、双引号、分号、末尾逗号、行宽 100。
- 每个任务结束必须 `bun test` 通过并 commit。

## Review Focus

- **孤儿页面临时文件**：进程异常退出后，`pageDir` 下无对应 `ctx.storage` 元数据的 `html_*` 目录会在下次 `restore()` 时清理，而不是永久残留。
- **损坏的存储值**：`session/<id>/meta` 为非法 JSON 或缺字段时，运行时丢弃该会话并继续启动，不抛异常、不把脏值当有效会话。
- **等待的取消与超时区分**：`context.signal` abort 返回 `WAIT_CANCELLED`，定时器到期返回 `WAIT_TIMEOUT`，二者不可混淆。
- **旧版本提交**：`update_html_session` 后，旧 pageVersion 的提交必须被 `STALE_PAGE` 拒绝，且不覆盖或污染新页面状态。
- **htmlFile 路径与大小**：相对 `htmlFile` 按 `ctx.location.directory` 解析；超过 `maxInlineHtmlBytes`/`maxPageFileBytes` 分别返回 `HTML_TOO_LARGE_FOR_INLINE`/`HTML_TOO_LARGE`。

---

### Task 1: 包脚手架与选项解析

**Files:**

- Create: `opencode-v2-plugin/package.json`
- Create: `opencode-v2-plugin/tsconfig.json`
- Create: `opencode-v2-plugin/src/options.ts`
- Create: `opencode-v2-plugin/tests/options.test.ts`
- Modify: `package.json`（根，`workspaces` 增加 `opencode-v2-plugin`，新增 `typecheck:v2` 脚本）

**Interfaces:**

- Produces: `resolveOptions(raw: unknown): ResolvedOptions`
  - `ResolvedOptions = { openBrowser: boolean; server: { hostname: string; port: number; publicBaseUrl?: string }; sessionTtlMs: number; defaultTimeoutMs: number; maxPayloadBytes: number; maxInlineHtmlBytes: number; maxPageFileBytes: number; pageDir: string }`
- Produces: `defaultPageDir(): string`（`join(tmpdir(), "opencode-html-sessions")`）

- [ ] **Step 1: 写失败测试** `opencode-v2-plugin/tests/options.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { resolveOptions } from "../src/options";

test("默认值", () => {
  const o = resolveOptions(undefined);
  expect(o.server).toEqual({ hostname: "127.0.0.1", port: 0 });
  expect(o.sessionTtlMs).toBe(1_800_000);
  expect(o.defaultTimeoutMs).toBe(300_000);
  expect(o.maxPayloadBytes).toBe(65_536);
  expect(o.maxPageFileBytes).toBe(3_145_728);
  expect(o.openBrowser).toBe(true);
  expect(o.pageDir.endsWith("opencode-html-sessions")).toBe(true);
});

test("非 loopback 缺 publicBaseUrl 抛错", () => {
  expect(() => resolveOptions({ server: { hostname: "0.0.0.0" } })).toThrow();
});

test("非法端口抛错", () => {
  expect(() => resolveOptions({ server: { port: 80 } })).toThrow();
});

test("对象形式覆盖", () => {
  const o = resolveOptions({ server: { port: 15073, hostname: "127.0.0.1" }, pageDir: "/tmp/x" });
  expect(o.server.port).toBe(15073);
  expect(o.pageDir).toBe("/tmp/x");
});
```

- [ ] **Step 2: 运行验证失败**

Run: `bun run --cwd opencode-v2-plugin test tests/options.test.ts`
Expected: FAIL，`Cannot find module '../src/options'`

- [ ] **Step 3: 实现** `opencode-v2-plugin/src/options.ts`

用 valibot（或等价手写校验）实现 `resolveOptions`：非对象输入按默认值；`server.port` 允许 `0` 或 `10000-65535`；`publicBaseUrl` 仅 http/https；非 loopback 且无 `publicBaseUrl` 抛错；所有数值为有限正整数。`pageDir` 默认 `defaultPageDir()`。

同时创建 `package.json`（依赖见 Global Constraints，`"scripts": { "test": "bun test", "typecheck": "tsc --noEmit" }`）与 `tsconfig.json`（照抄 `opencode-plugin/tsconfig.json`，`rootDir` 可为 `.`、`include: ["src/**/*", "tests/**/*"]`、`types: ["bun-types"]`）。

修改根 `package.json`：`workspaces` 加入 `"opencode-v2-plugin"`；`scripts` 加入 `"typecheck:v2": "bun run --cwd opencode-v2-plugin typecheck"`。

- [ ] **Step 4: 安装依赖并运行**

Run: `bun install && bun run --cwd opencode-v2-plugin test tests/options.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add opencode-v2-plugin/package.json opencode-v2-plugin/tsconfig.json opencode-v2-plugin/src/options.ts opencode-v2-plugin/tests/options.test.ts package.json bun.lock
git commit -m "feat(v2-plugin): scaffold package and options resolver"
```

---

### Task 2: 协议与等待器

**Files:**

- Create: `opencode-v2-plugin/src/runtime/constants.ts`（复制 `opencode-plugin/src/runtime/constants.ts`）
- Create: `opencode-v2-plugin/src/runtime/types.ts`（基于 V1 `types.ts`，见 Interfaces）
- Create: `opencode-v2-plugin/src/runtime/protocol.ts`（复制 V1）
- Create: `opencode-v2-plugin/src/runtime/waiter.ts`（复制 V1）
- Create: `opencode-v2-plugin/tests/runtime/protocol.test.ts`（移植 `tests/runtime/protocol.test.ts`）
- Create: `opencode-v2-plugin/tests/runtime/waiter.test.ts`（移植 `tests/runtime/waiter.test.ts`）

**Interfaces:**

- Produces（与 V1 同名同签名）：`createRuntimeError`、`isJsonSerializable`、`parseSubmissionWithLimit`、`createWaiterRegistry`、`RuntimeError`、`RuntimeErrorCode`、`SubmissionEnvelope`、`SubmissionOutput`。
- Produces `RuntimeSession`：把 V1 的 `html`/`htmlFile` 换成 `pageFile?: string`（页面正文一律落盘；不再内存持有 HTML），其余字段保持：`sessionId`、`opencodeSessionId?`、`title?`、`pageId`、`pageVersion`、`state?`、`token`、`status`、`createdAt`、`updatedAt`、`submittedPageVersion?`、`pendingSubmission?`。

- [ ] **Step 1: 移植测试**：把 V1 的 `tests/runtime/protocol.test.ts`、`tests/runtime/waiter.test.ts` 复制到新包，仅改相对导入路径为 `../../src/runtime/...`。
- [ ] **Step 2: 运行验证失败**

Run: `bun run --cwd opencode-v2-plugin test tests/runtime`
Expected: FAIL（模块缺失）

- [ ] **Step 3: 实现四个模块**：`constants.ts`、`protocol.ts`、`waiter.ts` 原样复制；`types.ts` 按 Interfaces 调整 `RuntimeSession`（去掉 `html`、加 `pageFile`）与 `RuntimeOptions`（见 Task 6）。
- [ ] **Step 4: 运行验证通过**

Run: `bun run --cwd opencode-v2-plugin test tests/runtime/protocol.test.ts tests/runtime/waiter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add opencode-v2-plugin/src/runtime/constants.ts opencode-v2-plugin/src/runtime/types.ts opencode-v2-plugin/src/runtime/protocol.ts opencode-v2-plugin/src/runtime/waiter.ts opencode-v2-plugin/tests/runtime/protocol.test.ts opencode-v2-plugin/tests/runtime/waiter.test.ts
git commit -m "feat(v2-plugin): port protocol and waiter runtime"
```

---

### Task 3: 沙箱门禁与页面注入

**Files:**

- Create: `opencode-v2-plugin/src/runtime/htmlValidation.ts`（复制 V1）
- Create: `opencode-v2-plugin/src/runtime/pageRuntime.ts`（复制 V1）
- Create: `opencode-v2-plugin/tests/runtime/htmlValidation.test.ts`（移植）
- Create: `opencode-v2-plugin/tests/runtime/pageRuntime.test.ts`（移植）

**Interfaces:**

- Produces（与 V1 同名同签名）：`collectHtmlIssues`、`summarizeHtmlIssues`、`injectPageRuntime(html, { maxPayloadBytes? })`、`createSubmitBridgeSource`、`tokenStyleSource`、`hasSubmitBridgeDefinition`、`referencesSubmitToAgent`。

- [ ] **Step 1: 移植测试**：复制 V1 两个测试文件，改导入路径。
- [ ] **Step 2: 运行验证失败**

Run: `bun run --cwd opencode-v2-plugin test tests/runtime/htmlValidation.test.ts tests/runtime/pageRuntime.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**：原样复制两个源文件。
- [ ] **Step 4: 运行验证通过**

Run: `bun run --cwd opencode-v2-plugin test tests/runtime/htmlValidation.test.ts tests/runtime/pageRuntime.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add opencode-v2-plugin/src/runtime/htmlValidation.ts opencode-v2-plugin/src/runtime/pageRuntime.ts opencode-v2-plugin/tests/runtime/htmlValidation.test.ts opencode-v2-plugin/tests/runtime/pageRuntime.test.ts
git commit -m "feat(v2-plugin): port sandbox guardrails and page runtime injection"
```

---

### Task 4: Wrapper 与浏览器打开

**Files:**

- Create: `opencode-v2-plugin/src/runtime/wrapper.ts`（复制 V1）
- Create: `opencode-v2-plugin/src/runtime/browser.ts`（复制 V1）
- Create: `opencode-v2-plugin/tests/runtime/wrapper.test.ts`（移植 `tests/browser/wrapper.test.ts`）

**Interfaces:**

- Produces：`buildWrapperHtml(input: WrapperInput): string`、`createWrapperMessageHandler`、`WrapperInput`；`openBrowser(url: string): Promise<void>`。

- [ ] **Step 1: 移植测试**：复制 `tests/browser/wrapper.test.ts` 到 `tests/runtime/wrapper.test.ts`，改导入路径。
- [ ] **Step 2: 运行验证失败**

Run: `bun run --cwd opencode-v2-plugin test tests/runtime/wrapper.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**：原样复制 `wrapper.ts`、`browser.ts`（`browser.ts` 依赖 `Bun.spawn`）。
- [ ] **Step 4: 运行验证通过**

Run: `bun run --cwd opencode-v2-plugin test tests/runtime/wrapper.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add opencode-v2-plugin/src/runtime/wrapper.ts opencode-v2-plugin/src/runtime/browser.ts opencode-v2-plugin/tests/runtime/wrapper.test.ts
git commit -m "feat(v2-plugin): port wrapper and browser launcher"
```

---

### Task 5: 存储适配器（pageStore + metaStore）

**Files:**

- Create: `opencode-v2-plugin/src/runtime/pageStore.ts`
- Create: `opencode-v2-plugin/src/runtime/metaStore.ts`
- Create: `opencode-v2-plugin/tests/runtime/pageStore.test.ts`
- Create: `opencode-v2-plugin/tests/runtime/metaStore.test.ts`

**Interfaces:**

- Produces：`createPageStore(dir: string): PageStore`
  - `PageStore = { dir: string; path(sessionId: string, pageVersion: number): string; write(sessionId: string, pageVersion: number, html: string): Promise<string>; exists(path: string): boolean; listSessionIds(): string[]; removeSession(sessionId: string): Promise<void> }`
- Produces：`createMetaStore(storage: StorageDomain): MetaStore`，其中 `StorageDomain` 结构为 `{ get(key): Promise<unknown>; set(key, value): Promise<void>; remove(key): Promise<void>; scan({ prefix, limit?, after? }): Promise<{ entries: { key: string; value: unknown }[]; next?: string }> }`
  - `MetaStore = { read(sessionId): Promise<SessionMeta | undefined>; write(meta: SessionMeta): Promise<void>; remove(sessionId): Promise<void>; scanAll(): Promise<SessionMeta[]>; readPending(sessionId): Promise<PendingSubmission | undefined>; writePending(sessionId, p: PendingSubmission): Promise<void>; removePending(sessionId): Promise<void> }`
  - key 约定：`session/<sessionId>/meta`、`session/<sessionId>/pending`。
  - `SessionMeta` 字段：`schemaVersion: 1; sessionId; opencodeSessionId?; title?; pageId; pageVersion; token; status; createdAt; updatedAt; pageFileName; submittedPageVersion?; state?`，读取时用 valibot 校验，非法返回 `undefined`。
  - `PendingSubmission = { kind: string; data: unknown; metadata: unknown; pageVersion: number }`。

- [ ] **Step 1: 写 pageStore 失败测试**

```ts
test("写入后可读、路径存在、removeSession 删除目录", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pstore-"));
  const store = createPageStore(dir);
  const p = await store.write("html_a", 1, "<html>1</html>");
  expect(store.exists(p)).toBe(true);
  expect(store.listSessionIds()).toContain("html_a");
  await store.removeSession("html_a");
  expect(store.listSessionIds()).not.toContain("html_a");
});
test("多版本路径不同", () => {
  const store = createPageStore(dir);
  expect(store.path("html_a", 1)).not.toBe(store.path("html_a", 2));
});
```

- [ ] **Step 2: 写 metaStore 失败测试**

```ts
test("meta 往返 + schema 校验丢弃损坏值", async () => {
  const backing = new Map<string, unknown>();
  const storage = memoryStorage(backing);
  const store = createMetaStore(storage);
  const meta = { schemaVersion: 1, sessionId: "html_a", pageId: "page_a", pageVersion: 1, token: "t", status: "created", createdAt: 1, updatedAt: 1, pageFileName: "page.html" };
  await store.write(meta);
  expect((await store.read("html_a"))?.sessionId).toBe("html_a");
  await storage.set("session/html_b/meta", { nope: true });
  expect(await store.read("html_b")).toBeUndefined();
  expect((await store.scanAll()).map((m) => m.sessionId)).toEqual(["html_a"]);
});
test("pending 往返", async () => {
  await store.writePending("html_a", { kind: "k", data: { a: 1 }, metadata: {}, pageVersion: 1 });
  expect(await store.readPending("html_a")).toEqual({ kind: "k", data: { a: 1 }, metadata: {}, pageVersion: 1 });
});
```

`memoryStorage` 为实现 `StorageDomain` 的测试内小工具（`scan` 按 `prefix` 过滤 `backing` 的 key）。

- [ ] **Step 3: 运行验证失败**

Run: `bun run --cwd opencode-v2-plugin test tests/runtime/pageStore.test.ts tests/runtime/metaStore.test.ts`
Expected: FAIL

- [ ] **Step 4: 实现**
  - `pageStore.ts`：`mkdirSync(dir, { recursive: true, mode: 0o700 })`；`write` 先写 `page-<version>.html.tmp-<uuid>` 再 `renameSync`，返回最终路径；文件名规则 `page-<version>.html`（v1 也用它，简单起见统一带版本号）；`removeSession` 递归删 `dir/<sessionId>`。
  - `metaStore.ts`：valibot schema 校验 meta 与 pending；`scanAll` 用 `scan({ prefix: "session/" })` 翻页收集 `*/meta` 键；`state` 与 `data`/`metadata` 仅接受 JSON 兼容值。

- [ ] **Step 5: 运行验证通过**

Run: `bun run --cwd opencode-v2-plugin test tests/runtime/pageStore.test.ts tests/runtime/metaStore.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add opencode-v2-plugin/src/runtime/pageStore.ts opencode-v2-plugin/src/runtime/metaStore.ts opencode-v2-plugin/tests/runtime/pageStore.test.ts opencode-v2-plugin/tests/runtime/metaStore.test.ts
git commit -m "feat(v2-plugin): add page and ctx.storage backed session stores"
```

---

### Task 6: 会话运行时（异步持久化 + restore + TTL）

**Files:**

- Create: `opencode-v2-plugin/src/runtime/store.ts`（基于 V1 `store.ts` 改写）
- Create: `opencode-v2-plugin/src/runtime/index.ts`
- Create: `opencode-v2-plugin/tests/runtime/store.test.ts`（移植并改造 `tests/runtime/store.test.ts`）

**Interfaces:**

- Consumes: `createMetaStore`/`createPageStore`（Task 5）、`createWaiterRegistry`/`parseSubmissionWithLimit`（Task 2）。
- Produces：`createHtmlRuntime(options: RuntimeOptions): HtmlRuntime`
  - `RuntimeOptions = { maxPayloadBytes?: number; defaultTimeoutMs?: number; sessionTtlMs?: number; cleanupIntervalMs?: number; baseUrl?: string; metaStore: MetaStore; pageStore: PageStore }`
  - `HtmlRuntime` 在 V1 基础上：`createSession` 写入 `pageFile`；新增 `restore(): Promise<void>`；`dispose()` 保持同步（清定时器与 waiter）。
  - 行为与 V1 一致：`createSession`、`waitSubmission`、`updateSession`、`endSession`、`getSession`、`listSessions`、`setBaseUrl`、`submitSubmission`、`countWaiters`、`countLiveSessions`。
  - `CreateSessionOutput` 继续返回 `{ sessionId, pageId, pageVersion, url, pageFilePath? }`。

- [ ] **Step 1: 移植测试**：复制 V1 `tests/runtime/store.test.ts`，把构造 runtime 的入参从 `storage` 改为 `metaStore`/`pageStore`（测试内用内存 `StorageDomain` + `mkdtemp` 目录）。
- [ ] **Step 2: 附加 restore/TTL 测试**

```ts
test("restore 重建索引并清理终态与过期会话", async () => {
  // 预写：活跃 meta + 终态 meta + createdAt 超 TTL meta
  const runtime = createHtmlRuntime({ metaStore, pageStore });
  await runtime.restore();
  expect(runtime.listSessions().map((s) => s.sessionId)).toEqual(["html_live"]);
});

test("restore 清理无元数据的孤儿页面目录", async () => {
  const orphan = pageStore.path("html_orphan", 1);
  await pageStore.write("html_orphan", 1, "x");
  const runtime = createHtmlRuntime({ metaStore, pageStore });
  await runtime.restore();
  expect(pageStore.exists(orphan)).toBe(false);
});

test("cancel 与 timeout 区分", async () => {
  const runtime = createHtmlRuntime({ metaStore, pageStore, defaultTimeoutMs: 5_000 });
  const a = runtime.createSession({ html: "<html></html>" });
  const controller = new AbortController();
  const w = runtime.waitSubmission({ sessionId: (await a).sessionId, signal: controller.signal });
  controller.abort();
  await expect(w).rejects.toMatchObject({ code: "WAIT_CANCELLED" });
  const b = await runtime.createSession({ html: "<html></html>" });
  await expect(runtime.waitSubmission({ sessionId: b.sessionId, timeoutMs: 10 })).rejects.toMatchObject({ code: "WAIT_TIMEOUT" });
});
```

- [ ] **Step 3: 运行验证失败**

Run: `bun run --cwd opencode-v2-plugin test tests/runtime/store.test.ts`
Expected: FAIL

- [ ] **Step 4: 实现**：
  - 把 V1 `persistMeta`/`persistPage`/`persistPending` 改为 async 并调用 `metaStore`/`pageStore`；`RuntimeSession` 用 `pageFile`。
  - 新增 `restore()`：`pageStore.listSessionIds()` 得到磁盘会话集合；`metaStore.scanAll()` 得到元数据；对每条 meta 校验（字段/终态/TTL/页面文件存在），合法则重建内存索引，非法则删除 meta 与对应页面目录；对无 meta 的孤儿目录 `removeSession`。
  - TTL 周期清理同时删除 meta、pending 与页面目录；`dispose()` 清定时器、清 waiter。
  - `runtime/index.ts` 汇总导出（参照 V1 `runtime/index.ts`）。

- [ ] **Step 5: 运行验证通过**

Run: `bun run --cwd opencode-v2-plugin test tests/runtime/store.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add opencode-v2-plugin/src/runtime/store.ts opencode-v2-plugin/src/runtime/index.ts opencode-v2-plugin/tests/runtime/store.test.ts
git commit -m "feat(v2-plugin): session runtime with async persistence and restore"
```

---

### Task 7: HTTP 运行时服务

**Files:**

- Create: `opencode-v2-plugin/src/runtime/server.ts`（基于 V1 改写）
- Create: `opencode-v2-plugin/tests/runtime/server.test.ts`（移植 `tests/runtime/server.test.ts`）
- Create: `opencode-v2-plugin/tests/runtime/server-external.test.ts`（移植 `tests/runtime/server-external.test.ts`，如无外网依赖可保留）

**Interfaces:**

- Consumes: `HtmlRuntime`（Task 6）。
- Produces：`createRuntimeServer(runtime, options: ServerOptions): Promise<RuntimeServer>`
  - `ServerOptions = { hostname?: string; port?: number; publicBaseUrl?: string; maxPayloadBytes?: number; openBrowser?: boolean | ((url: string) => Promise<void>) }`
  - `RuntimeServer = { url: string; stop(force?: boolean): Promise<void> }`
  - 路由不变：`GET /session/:id`（wrapper）、`GET /session/:id/page`（`Bun.file(session.pageFile)` 流式）、`GET /session/:id/version`、`POST /session/:id/submit`；authority/token/限流逻辑保持。
- 从 `server.ts` 去掉 disk/memory 分支：页面统一 `Bun.file(session.pageFile)`。

- [ ] **Step 1: 移植测试**：复制两个 server 测试，构造 runtime 处改为 `metaStore`/`pageStore`。
- [ ] **Step 2: 运行验证失败**

Run: `bun run --cwd opencode-v2-plugin test tests/runtime/server.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**：改写 V1 `server.ts` 的 page 分支为 `Bun.file(session.pageFile)`；其余保持。
- [ ] **Step 4: 运行验证通过**

Run: `bun run --cwd opencode-v2-plugin test tests/runtime/server.test.ts tests/runtime/server-external.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add opencode-v2-plugin/src/runtime/server.ts opencode-v2-plugin/tests/runtime/server.test.ts opencode-v2-plugin/tests/runtime/server-external.test.ts
git commit -m "feat(v2-plugin): http runtime server serving session pages"
```

---

### Task 8: V2 工具定义

**Files:**

- Create: `opencode-v2-plugin/src/tools.ts`（取代 V1 `tools/htmlSession.ts`）
- Create: `opencode-v2-plugin/tests/tools.test.ts`（改造 `tests/tools/htmlSession.test.ts` / `htmlSession-file.test.ts`）

**Interfaces:**

- Consumes: `HtmlRuntime`（Task 6）、`injectPageRuntime`/`collectHtmlIssues`/`summarizeHtmlIssues`（Task 3）、`openBrowser`（Task 4）、`createRuntimeError`（Task 2）。
- Produces：`createHtmlSessionTools(runtime: HtmlRuntime, config: ToolConfig): ToolInfo[]`
  - `ToolConfig = { openBrowser: boolean; rootDirectory: string; maxInlineHtmlBytes: number; maxPageFileBytes: number; maxPayloadBytes: number }`
  - `ToolInfo = { name: string; description: string; input: JsonSchema; execute(input: any, context: { signal: AbortSignal; progress: (m: any) => Promise<void> }): Promise<{ content: string }> }`
  - 四个工具名与入参见 Global Constraints；`html`/`htmlFile` 互斥；相对 `htmlFile` 按 `rootDirectory` 解析；`execute` 返回 `{ content: JSON.stringify(result) }`。

- [ ] **Step 1: 写失败测试**（用 Task 6 的内存 storage + 临时 pageDir + 一个真实 runtime）

```ts
test("create_html_session 返回 url 与 pageVersion", async () => {
  const [create] = createHtmlSessionTools(runtime, cfg);
  const out = JSON.parse((await create.execute({ html: "<html></html>" }, ctx)).content);
  expect(out.sessionId).toStartWith("html_");
  expect(out.url).toContain(`/session/${out.sessionId}`);
});

test("html 与 htmlFile 互斥", async () => {
  const [create] = createHtmlSessionTools(runtime, cfg);
  await expect(create.execute({ html: "<html></html>", htmlFile: "a.html" }, ctx)).rejects.toThrow();
});

test("内联超限与文件超限返回对应错误码", async () => {
  const [create] = createHtmlSessionTools(runtime, { ...cfg, maxInlineHtmlBytes: 10 });
  await expect(create.execute({ html: "<html>too long</html>" }, ctx)).rejects.toMatchObject({ code: "HTML_TOO_LARGE_FOR_INLINE" });
});

test("沙箱违例 HTML 被拒（INVALID_HTML）", async () => {
  const [create] = createHtmlSessionTools(runtime, cfg);
  await expect(create.execute({ html: '<button type="submit">x</button>' }, ctx)).rejects.toMatchObject({ code: "INVALID_HTML" });
});

test("wait 使用 context.signal 取消", async () => {
  const [, wait] = createHtmlSessionTools(runtime, cfg);
  const created = JSON.parse((await create.execute({ html: "<html></html>" }, ctx)).content);
  const controller = new AbortController();
  const p = wait.execute({ sessionId: created.sessionId }, { ...ctx, signal: controller.signal });
  controller.abort();
  await expect(p).rejects.toMatchObject({ code: "WAIT_CANCELLED" });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `bun run --cwd opencode-v2-plugin test tests/tools.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**：用 JSON Schema 定义 `input`；`create` 走 `resolveHtml`（互斥、大小、沙箱校验、`injectPageRuntime`）→ `runtime.createSession` → 若 `openBrowser` 则 `openBrowser(url)`；`wait` 调 `runtime.waitSubmission({ sessionId, timeoutMs, signal: context.signal })`；`update`/`end` 直接映射。错误统一以抛异常形式返回（带 `code` 字段），`content` 为 JSON 字符串。

- [ ] **Step 4: 运行验证通过**

Run: `bun run --cwd opencode-v2-plugin test tests/tools.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add opencode-v2-plugin/src/tools.ts opencode-v2-plugin/tests/tools.test.ts
git commit -m "feat(v2-plugin): v2 tool definitions for html interaction sessions"
```

---

### Task 9: 插件入口（Plugin.define + 事件 + cleanup）

**Files:**

- Create: `opencode-v2-plugin/src/index.ts`
- Create: `opencode-v2-plugin/tests/plugin.test.ts`

**Interfaces:**

- Consumes: `resolveOptions`（Task 1）、`createHtmlRuntime`（Task 6）、`createRuntimeServer`（Task 7）、`createHtmlSessionTools`（Task 8）、`createMetaStore`/`createPageStore`（Task 5）。
- Produces：`default export Plugin.define({ id: "agent-ui-interaction", setup })`；另导出 `createPlugin(): Plugin` 供测试。
- setup 行为：`resolveOptions(ctx.options)` → `createMetaStore(ctx.storage)` + `createPageStore(opts.pageDir)` → `createHtmlRuntime` → `createRuntimeServer`（`openBrowser: false`）→ `await runtime.restore()` → `ctx.tool.transform(editor => tools 逐个 add)` → `ctx.event.subscribe({ signal })` 监听 `session.deleted` 结束对应会话 → 返回 cleanup（abort 订阅、`runtime.dispose()`、`server.stop(true)`）。

- [ ] **Step 1: 写失败测试**（假 ctx）

```ts
test("setup 注册 4 个工具并返回可调用 cleanup", async () => {
  const tools: any[] = [];
  const ctx = makeFakeContext({
    options: { server: { port: 0 } },
    tool: { transform: async (cb: any) => cb({ add: (t: any) => tools.push(t) }) },
    event: { subscribe: async function* () {} },
  });
  const cleanup = await createPlugin().setup(ctx);
  expect(tools.map((t) => t.name).sort()).toEqual([
    "create_html_session", "end_html_session", "update_html_session", "wait_html_submission",
  ]);
  await cleanup?.();
});

test("会话删除事件结束对应 html 会话", async () => {
  // 假 event.subscribe 推送 { type: "session.deleted", data: { sessionID: "ses_x" } }
  // 预置一个 opencodeSessionId 匹配的 runtime 会话，断言 cleanup 后 listSessions 为空或该会话 ended
});
```

`makeFakeContext` 返回 `{ location: { directory: tmpdir(), project: { id: "p", directory, canonical } }, options, storage: memoryStorage(), tool, event } as unknown as Context`。

- [ ] **Step 2: 运行验证失败**

Run: `bun run --cwd opencode-v2-plugin test tests/plugin.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现** `src/index.ts`。事件字段以 `@opencode/schema` 类型为准；用 `event.type === "session.deleted"` 与事件数据中的 session 标识匹配 `RuntimeSession.opencodeSessionId`，调用 `runtime.endSession`。cleanup 必须幂等。
- [ ] **Step 4: 运行验证通过**

Run: `bun run --cwd opencode-v2-plugin test tests/plugin.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add opencode-v2-plugin/src/index.ts opencode-v2-plugin/tests/plugin.test.ts
git commit -m "feat(v2-plugin): plugin entrypoint wiring tools events and cleanup"
```

---

### Task 10: 文档、全量验证与根仓库接线

**Files:**

- Create: `opencode-v2-plugin/README.md`
- Modify: `README.md`（根，简述 V2 包用法，如已提及插件加载方式）
- Modify: `package.json`（若 Task 1 未加 `test:v2`，补 `"test:v2": "bun run --cwd opencode-v2-plugin test"`）

**Interfaces:**

- Produces: 可发布的 V2 包说明（安装、opencode.json 对象形式配置、工具列表、存储/临时目录行为、已知限制）。

- [ ] **Step 1: 写 README**：包含 `plugins` 配置示例（对象形式）、4 个工具、`ctx.storage` + 临时文件存储说明、`pageDir`/`server`/超时与大小默认值、以及「不改动 V1 包」的说明。
- [ ] **Step 2: 全量类型检查**

Run: `bun run --cwd opencode-v2-plugin typecheck`
Expected: 0 errors（基于真实 `@opencode/plugin@2.0.24` 类型）

- [ ] **Step 3: 全量测试**

Run: `bun run --cwd opencode-v2-plugin test`
Expected: 全部 PASS

- [ ] **Step 4: 确认 V1 未被破坏**

Run: `bun run typecheck && bun test --path-ignore-patterns "tests/e2e/**"`
Expected: V1 typecheck 与单测保持 PASS

- [ ] **Step 5: Commit**

```bash
git add opencode-v2-plugin/README.md README.md package.json
git commit -m "docs(v2-plugin): document v2 package and verify full suite"
```

---

## Self-Review

**Spec coverage：** 入口映射→Task 9；工具→Task 8；存储（metaStore/pageStore）→Task 5、store 异步化/restore→Task 6；运行时复用面→Task 2/3/4/7；事件与 cleanup→Task 9；选项→Task 1；验证→Task 10；错误码→Task 2/8。无遗漏。
**Review Focus 覆盖：** 孤儿目录→Task 6 Step 2；损坏存储值→Task 5 Step 2；取消/超时→Task 6 Step 2 与 Task 8 Step 1；旧版本提交→沿用 V1 server/store 测试（Task 6/7 移植用例）；htmlFile 路径/大小→Task 8 Step 1。
**命名一致性：** `createHtmlRuntime`、`createRuntimeServer`、`createHtmlSessionTools`、`createMetaStore`、`createPageStore`、`resolveOptions` 在各任务间一致；`RuntimeSession.pageFile` 为唯一页面引用字段。
**比例：** 计划以文件/签名/测试名为主，未转录实现体；复用模块只给「移植 + 改导入」指令。
