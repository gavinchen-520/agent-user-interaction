# Agent UI Interaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 OpenCode + octto 提供一个 skill-first 的动态 HTML 交互闭环：模型生成页面，用户在独立浏览器窗口中交互并提交结构化数据，模型收到 tool result 后继续任务并可更新页面。

**Architecture:** 新项目包含一个独立的 OpenCode 插件包和一个 `html-interaction` skill。插件内存管理 HTML session、页面版本、随机 token、waiter 和生命周期，Bun loopback server 提供 wrapper、sandbox iframe 页面和受保护的提交 endpoint；模型 HTML 只通过 `postMessage` bridge 提交，插件工具把提交结果原样作为结构化 tool result 返回 OpenCode。

**Tech Stack:** TypeScript、Bun、`@opencode-ai/plugin`、`valibot`、Bun test、Playwright（浏览器 E2E）。

**Spec:** `docs/superpowers/specs/2026-09-05-agent-ui-interaction-design.md`

## Global Constraints

- 第一版只支持 OpenCode + octto 运行环境，不实现 Claude Code、Pi Agent、Codex 适配器。
- 浏览器打开 wrapper，模型 HTML 必须运行在 `iframe sandbox="allow-scripts"` 中，不启用 `allow-same-origin`。
- runtime 只绑定 `127.0.0.1`，页面不得访问项目文件、OpenCode client、工具列表或外部网络。
- HTML 允许任意页面 JavaScript，但页面只能通过 `postMessage` bridge 输出结构化提交。
- 每个 page version 只消费一次提交，`update_html_session` 递增版本并使旧页面提交失效。
- 所有系统边界使用 `unknown` 后经 Valibot schema 校验，不使用 `any`、`@ts-ignore` 或 `eslint-disable`。
- TypeScript 使用 2 空格缩进、camelCase、双引号、分号和尾逗号；业务逻辑使用工厂函数，不使用 class。
- 所有公开函数和所有错误路径必须有 Bun test；文件系统测试使用唯一 `/tmp` 路径并清理。
- 不修改外部依赖仓库（`octto`、`agent-html-skills`）。

---

### Task 1: 建立项目与插件包骨架

**Files:**
- Create: `package.json`
- Create: `README.md`
- Create: `opencode-plugin/package.json`
- Create: `opencode-plugin/tsconfig.json`
- Create: `opencode-plugin/src/index.ts`
- Create: `opencode-plugin/src/types.ts`
- Create: `tests/smoke.test.ts`

**Interfaces:**
- Produces a root Bun workspace with `bun test`, `bun run typecheck`, and `bun run build` scripts.
- Produces an OpenCode plugin default export placeholder whose public shape is compatible with `Plugin` and can be replaced by the real tool registry in Task 5.

- [ ] **Step 1: Write the failing smoke test**

Create a test that imports the plugin entry and asserts it is a function. Keep the test independent of a running OpenCode server:

```ts
import { describe, expect, it } from "bun:test";

import plugin from "../opencode-plugin/src/index";

describe("OpenCode 插件入口", () => {
  it("导出插件工厂函数", () => {
    expect(typeof plugin).toBe("function");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/smoke.test.ts`

Expected: FAIL because the package files and plugin entry do not exist.

- [ ] **Step 3: Add the minimal workspace and plugin package**

Use the versions already used by octto: `@opencode-ai/plugin` `1.18.15`, `valibot` `^1.2.0`, TypeScript, Bun types, and Playwright as a development dependency. Configure the plugin package with `type: "module"`, `src` as the TypeScript root, strict checking, `bun build` output to `dist`, and the `@/*` path alias. Export a default async plugin function that currently returns an empty `tool` object and an `event` handler that does nothing.

- [ ] **Step 4: Run typecheck and smoke test**

Run: `bun install && bun run typecheck && bun test tests/smoke.test.ts`

Expected: typecheck exits 0 and the smoke test passes.

- [ ] **Step 5: Document local installation**

In `README.md`, document the two installation units, required Bun version, `bun install`, `bun run check`, and that the skill directory must be copied into the OpenCode skill location while the plugin package is enabled separately. Do not mention Claude-specific variables or tools.

- [ ] **Step 6: Commit**

```bash
git add package.json README.md opencode-plugin/package.json opencode-plugin/tsconfig.json opencode-plugin/src tests/smoke.test.ts
git commit -m "chore: scaffold agent ui interaction project"
```

### Task 2: 实现协议 schema 与 session 状态核心

**Files:**
- Create: `opencode-plugin/src/runtime/constants.ts`
- Create: `opencode-plugin/src/runtime/types.ts`
- Create: `opencode-plugin/src/runtime/protocol.ts`
- Create: `opencode-plugin/src/runtime/store.ts`
- Create: `opencode-plugin/src/runtime/waiter.ts`
- Create: `opencode-plugin/src/runtime/index.ts`
- Test: `tests/runtime/protocol.test.ts`
- Test: `tests/runtime/store.test.ts`

**Interfaces:**
- `createHtmlRuntime(options?: RuntimeOptions): HtmlRuntime`
- `HtmlRuntime.createSession(input: CreateSessionInput): Promise<CreateSessionOutput>`
- `HtmlRuntime.waitSubmission(input: WaitSubmissionInput): Promise<SubmissionOutput>`
- `HtmlRuntime.updateSession(input: UpdateSessionInput): Promise<UpdateSessionOutput>`
- `HtmlRuntime.endSession(sessionId: string): Promise<EndSessionOutput>`
- `HtmlRuntime.getSession(sessionId: string): RuntimeSession | undefined`
- `parseSubmission(value: unknown): SubmissionEnvelope`
- `createSubmissionEnvelope(value: unknown): SubmissionEnvelope`

- [ ] **Step 1: Write schema failure tests**

Cover missing session/page IDs, non-positive page versions, empty `kind`, oversized serialized payloads, invalid protocol version, and valid arbitrary JSON `data` and `metadata`. Assert failures expose stable error codes such as `INVALID_ENVELOPE`, `PAYLOAD_TOO_LARGE`, and `INVALID_PAGE_VERSION`.

- [ ] **Step 2: Run the protocol tests**

Run: `bun test tests/runtime/protocol.test.ts`

Expected: FAIL because the protocol module is absent.

- [ ] **Step 3: Define exact protocol types and schemas**

Define `SubmissionEnvelope` with `sessionId`, `pageId`, `pageVersion`, `kind`, `data: unknown`, `metadata: unknown`, and `protocolVersion: 1`. Define `CreateSessionInput` with `title?: string`, `html: string`, and `initialState?: unknown`; define all four tool input/output contracts from the spec. Use Valibot `unknown()` for data boundaries and an explicit JSON-serializability check before accepting values. Define `RuntimeError` as an error value with `code`, `message`, `status`, and `action` fields.

- [ ] **Step 4: Implement waiter primitives**

Implement `createWaiterRegistry<K, T>()` with register, notifyFirst, notifyAll, clear, count, and timeout cleanup. A waiter must be removed on resolve, timeout, cancellation, and session end. Never leave a timer or callback registered after completion.

- [ ] **Step 5: Write state-machine failure tests**

Test creation returns `pageId` and version `1`, update returns a new page ID and version `2`, an old envelope is rejected, the first valid submission resolves the waiter, a second submission returns `DUPLICATE_SUBMISSION` without notifying another waiter, timeout returns `WAIT_TIMEOUT`, and end is idempotent.

- [ ] **Step 6: Run the state tests to verify failure**

Run: `bun test tests/runtime/store.test.ts`

Expected: FAIL because the runtime store is absent.

- [ ] **Step 7: Implement the in-memory runtime store**

Use a factory with maps for sessions and waiters. A session stores `sessionId`, `title`, current `pageId`, `pageVersion`, HTML, optional state, token, status, timestamps, and current submission marker. Enforce `created -> opened -> waiting -> submitted -> processing`; update from a live session creates a fresh page and returns to `waiting`; expired, failed, cancelled, and ended sessions reject later submissions. Use cryptographically random IDs and tokens from Bun crypto APIs.

- [ ] **Step 8: Run protocol and state tests**

Run: `bun test tests/runtime/protocol.test.ts tests/runtime/store.test.ts`

Expected: all tests pass, including duplicate, stale-version, timeout, cancellation, and cleanup cases.

- [ ] **Step 9: Commit**

```bash
git add opencode-plugin/src/runtime tests/runtime
git commit -m "feat: add html session protocol and state runtime"
```

### Task 3: 实现安全 HTTP runtime 与浏览器 wrapper

**Files:**
- Create: `opencode-plugin/src/runtime/server.ts`
- Create: `opencode-plugin/src/browser/wrapper.ts`
- Create: `opencode-plugin/src/browser/browser.ts`
- Create: `opencode-plugin/src/browser/index.ts`
- Test: `tests/runtime/server.test.ts`
- Test: `tests/browser/wrapper.test.ts`

**Interfaces:**
- `createRuntimeServer(runtime: HtmlRuntime, options?: ServerOptions): Promise<RuntimeServer>`
- `RuntimeServer.url: string`
- `RuntimeServer.stop(force?: boolean): Promise<void>`
- `buildWrapperHtml(input: WrapperInput): string`
- `openBrowser(url: string): Promise<void>`

- [ ] **Step 1: Write HTTP security failure tests**

Start a server with `skipBrowser: true` and test: wrapper route returns HTML; page route returns only the current HTML; POST without token, with wrong token, wrong session/page/version, invalid JSON, oversized body, and malformed envelope receive stable 4xx responses; valid POST resolves the runtime waiter; non-loopback host/origin is rejected.

- [ ] **Step 2: Run server tests to verify failure**

Run: `bun test tests/runtime/server.test.ts`

Expected: FAIL because server and wrapper modules are absent.

- [ ] **Step 3: Implement wrapper HTML**

Generate a self-contained wrapper with a title, status area, an iframe using exactly `sandbox="allow-scripts"`, and a message listener. Accept only messages whose `event.source` is the iframe window, whose `type` is `html-submit`, and whose payload is a plain structured object below the message size limit. The wrapper must add session/page/version/protocol fields and send the POST itself. Keep token and endpoint only in wrapper-generated script, never in model HTML. Disable the submit state after the first accepted request and show a failure state without exposing token values.

- [ ] **Step 4: Implement CSP and server routes**

Bind Bun to `127.0.0.1` and an ephemeral port by default. Serve wrapper at `/`, model HTML at a session-scoped page route, and POST at a session-scoped submit route. Add CSP permitting only required inline script/style and `data:`/`blob:` images; set `connect-src 'none'`, `frame-src 'none'`, `object-src 'none'`, `form-action 'none'`, and prevent top-level navigation. Validate request method, loopback host, token, content length/body limit, JSON envelope, current page version, and one-time submission before resolving the waiter.

- [ ] **Step 5: Implement browser opening**

Reuse the platform behavior from octto: `open` on macOS, `cmd /c start` on Windows, and `xdg-open` elsewhere. Return a rejected promise when the process exits unsuccessfully so session creation can clean up the server and waiter state.

- [ ] **Step 6: Write wrapper message tests**

Test messages from another window, wrong type, missing fields, oversized payload, stale page version, and a valid payload. Assert only the valid payload invokes the injected submit callback and that the second valid message is ignored after submission starts.

- [ ] **Step 7: Run all server and wrapper tests**

Run: `bun test tests/runtime/server.test.ts tests/browser/wrapper.test.ts`

Expected: all tests pass and no test opens a real browser.

- [ ] **Step 8: Commit**

```bash
git add opencode-plugin/src/runtime/server.ts opencode-plugin/src/browser tests/runtime/server.test.ts tests/browser/wrapper.test.ts
git commit -m "feat: serve sandboxed html interaction wrapper"
```

### Task 4: 接入四个 OpenCode 工具与 session 删除清理

**Files:**
- Create: `opencode-plugin/src/tools/htmlSession.ts`
- Create: `opencode-plugin/src/tools/index.ts`
- Modify: `opencode-plugin/src/index.ts`
- Modify: `opencode-plugin/src/types.ts`
- Test: `tests/tools/htmlSession.test.ts`
- Test: `tests/plugin-lifecycle.test.ts`

**Interfaces:**
- Tool names: `create_html_session`, `wait_html_submission`, `update_html_session`, `end_html_session`.
- `createHtmlSessionTools(runtime: HtmlRuntime): Record<string, OpenCodeTool>`.
- Plugin event handler ends all sessions tracked under `toolCtx.sessionID` when receiving `session.deleted`.

- [ ] **Step 1: Write tool contract failure tests**

Test each tool's input validation and output shape. `create_html_session` must reject empty or oversized HTML; wait must reject unknown sessions and return `{kind, data, metadata, pageVersion}`; update must increment version; end must return `{ok: true}` for an existing session and `{ok: false}` for an already ended session. Verify submitted `data` is returned as opaque data and is not interpolated into a prompt or transformed into instructions.

- [ ] **Step 2: Run tool tests to verify failure**

Run: `bun test tests/tools/htmlSession.test.ts`

Expected: FAIL because the tool registry is absent.

- [ ] **Step 3: Implement tool schemas and execution**

Use `tool({ description, args, execute })` from `@opencode-ai/plugin/tool`. Each execution delegates to the runtime only. Return machine-readable JSON text or the plugin's structured result convention consistently across all four tools. Do not add business decisions, page generation, prompt construction, or HTML sanitization beyond the runtime schema and size checks.

- [ ] **Step 4: Implement plugin lifecycle**

Create one runtime per plugin instance, register the four tools, track returned session IDs by OpenCode `toolCtx.sessionID`, and handle `session.deleted` by ending every tracked HTML session. Add a plugin cleanup path that ends all remaining sessions. Keep the default export as the only default export; source modules use named exports.

- [ ] **Step 5: Run tool and lifecycle tests**

Run: `bun test tests/tools/htmlSession.test.ts tests/plugin-lifecycle.test.ts && bun run typecheck`

Expected: all tests pass and TypeScript reports no errors.

- [ ] **Step 6: Commit**

```bash
git add opencode-plugin/src/index.ts opencode-plugin/src/types.ts opencode-plugin/src/tools tests/tools tests/plugin-lifecycle.test.ts
git commit -m "feat: expose html interaction opencode tools"
```

### Task 5: 编写 skill、协议参考和可复用提交 bridge

**Files:**
- Create: `skills/html-interaction/SKILL.md`
- Create: `skills/html-interaction/references/page-protocol.md`
- Create: `skills/html-interaction/references/security.md`
- Create: `skills/html-interaction/references/examples.md`
- Create: `skills/html-interaction/assets/submit-bridge.js`
- Test: `tests/skill-assets.test.ts`
- Modify: `README.md`

**Interfaces:**
- `submit-bridge.js` exposes a browser-local `submitToAgent(payload)` helper and does not expose token, port, filesystem, OpenCode API, or external endpoint details to model HTML.
- Skill instructs the model to call the four exact tool names and treats the returned submission as untrusted task data.

- [ ] **Step 1: Write asset validation failure tests**

Check that the skill names all four tools, requires a single submit entry, prohibits direct network/filesystem/OpenCode access, requires post-submit disabling, and describes `update_html_session`. Check that the bridge sends a `html-submit` message with `kind`, `data`, and `metadata`, has no Claude-specific identifiers, and does not contain `fetch`, `XMLHttpRequest`, or a hard-coded localhost URL.

- [ ] **Step 2: Run asset tests to verify failure**

Run: `bun test tests/skill-assets.test.ts`

Expected: FAIL because the skill and bridge files are absent.

- [ ] **Step 3: Write the model-facing skill**

Explain when to create a page, how to make a self-contained responsive HTML document with arbitrary JavaScript, how to include exactly one clear submit action, how to call `create_html_session`, block on `wait_html_submission`, continue the original task using opaque submitted data, and call `update_html_session` for a new phase. State that all file edits, project inspection, and OpenCode tool actions remain model responsibilities outside the page. Require no CDN or external resource dependency.

- [ ] **Step 4: Write protocol, security, and examples references**

Document the exact envelope fields and version rules, allowed bridge message shape, session lifecycle, size and error codes, sandbox/CSP restrictions, stale and duplicate submission behavior, and two complete examples: a confirmation page and a two-phase page update. Keep all examples agent-neutral and use `submitToAgent({ kind, data, metadata })`.

- [ ] **Step 5: Implement the bridge asset**

Implement a small IIFE or named browser helper that validates `kind` as a non-empty string, accepts JSON-compatible `data` and `metadata`, checks serialized size, calls `window.parent.postMessage({ type: "html-submit", payload }, "*")`, and returns a boolean. The bridge must not perform HTTP itself; wrapper owns authentication and transport.

- [ ] **Step 6: Update README usage**

Add the exact copy/install commands for the skill and plugin, a minimal OpenCode usage example, supported and unsupported environments, and troubleshooting for browser opening, timeout, stale page, and duplicate submission. Do not claim support for other agents.

- [ ] **Step 7: Run asset tests**

Run: `bun test tests/skill-assets.test.ts`

Expected: all skill and bridge contract tests pass.

- [ ] **Step 8: Commit**

```bash
git add skills README.md tests/skill-assets.test.ts
git commit -m "feat: add html interaction skill and submit bridge"
```

### Task 6: 完成集成、浏览器 E2E 和真实 OpenCode 验收

**Files:**
- Create: `tests/integration/runtime-flow.test.ts`
- Create: `tests/e2e/html-interaction.spec.ts`
- Create: `playwright.config.ts`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Integration test exercises `createSession -> waitSubmission -> updateSession -> waitSubmission -> endSession` through HTTP routes, not mocked callbacks.
- Playwright test exercises wrapper -> sandbox iframe -> `postMessage` -> POST -> waiter and confirms stale-page rejection after update.

- [ ] **Step 1: Write the integration test**

Use a runtime with browser opening disabled. Create a page, fetch the wrapper, extract the page URL only through the server API used by the test, post a valid envelope with its token, await `waitSubmission`, update to version `2`, submit the second version, and end the session. Assert the server stops, the second end is idempotent, and no waiter remains.

- [ ] **Step 2: Run the integration test to verify failure**

Run: `bun test tests/integration/runtime-flow.test.ts`

Expected: FAIL until the real server/store wiring is complete.

- [ ] **Step 3: Implement integration wiring and cleanup assertions**

Expose only test-safe runtime inspection methods needed to assert no live sessions, waiters, or server remain. Ensure every test uses a unique temporary resource identity and calls cleanup in `afterEach`, including failed requests and timeouts.

- [ ] **Step 4: Add the Playwright E2E test**

Launch the local runtime server from the test fixture, navigate to the wrapper, locate the sandbox iframe, fill a form in the frame, click its submit control, and await the Node/Bun-side submission promise. Then update the page, attempt a stale version submission and assert a stable 409-style response, submit the new page, and end the session. Verify the iframe has sandbox `allow-scripts` without `allow-same-origin`, external network requests are absent, and the page renders nonblank content.

- [ ] **Step 5: Configure and run E2E**

Configure Playwright for a local Chromium executable and a serial fixture that owns the Bun runtime. Run: `bunx playwright test tests/e2e/html-interaction.spec.ts --project=chromium`.

Expected: the complete two-phase browser flow passes without copy/paste and the runtime fixture closes cleanly.

- [ ] **Step 6: Add real OpenCode verification instructions**

Document a manual acceptance sequence in `README.md`: enable plugin and skill, ask for a visual interaction task, verify the model calls `create_html_session`, interact in the separate browser, verify the model receives structured data, request a second phase, submit again, and end the session. Include the exact command for `bun run check` and the known prerequisite that an OpenCode host must provide the plugin API.

- [ ] **Step 7: Run the complete quality gate**

Run: `bun run check && bun run build && bun test tests/integration/runtime-flow.test.ts`.

Expected: Biome, ESLint, TypeScript, unit tests, build, and integration tests all exit 0. Then run the Playwright command from Step 5 and record its result.

- [ ] **Step 8: Commit**

```bash
git add package.json README.md playwright.config.ts tests/integration tests/e2e
git commit -m "test: verify html interaction end to end"
```

## Plan Self-Review

- Spec coverage: Tasks 1 and 5 cover skill-first packaging and documentation; Tasks 2 and 3 cover schema, runtime, wrapper, CSP, token, versioning, and lifecycle; Task 4 covers all four tools and `session.deleted`; Task 6 covers integration, browser E2E, cleanup, and real OpenCode acceptance.
- Placeholder scan: every task step contains a concrete file, interface, command, assertion, or implementation rule; no vague follow-up step is left for the implementer.
- Type consistency: `HtmlRuntime`, `RuntimeOptions`, `RuntimeServer`, tool contracts, and `submitToAgent` are introduced before their consumers; page version and envelope field names match the design spec.
- Scope: the plan stays inside the independent `agent-ui-interaction` repository and does not introduce the deferred embedded OpenCode session view or cross-agent adapter.
