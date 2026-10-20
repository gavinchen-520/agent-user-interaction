# 生成效率加固（交叉验证结论落地）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地已交叉验证的 4 项修正版优化：v2 门禁、skills 同步护栏、文档对齐、服务端 TTFP 埋点、工具输入契约强化、wrapper 自适应轮询。

**Architecture:** 全部改动限于 opencode-v2-plugin（活跃插件）+ 根工程脚本与文档；v1（opencode-plugin）不动（v2 spec 非目标"不修改 V1"）。TTFP 采用服务端代理口径：`session.execution.started` 事件记录每轮起点 → create/update 完成时计算 durationMs → 追加 JSONL；不触浏览器协议（SKILL.md:72 边界不动）。

**Tech Stack:** Bun + bun:test、valibot、原生 JSON Schema（Tool.input，宿主已验证会下发并在 execute 前校验）。

**Spec:** 无独立 spec 文件；本计划直接依据交叉验证轮确认的结论（对话记录）。相关历史文档：`docs/page-generation-performance-optimization.md`（P3 firstPaint<2s 验收、§6.3 实测否决 A2/A3）、`docs/superpowers/specs/2026-10-07-opencode-v2-plugin-design.md`（非目标：不改 V1）。

## Global Constraints

- 不修改 `opencode-plugin/`（V1）任何文件——v2 spec 非目标。
- 不提交工作区里既有的未提交改动（前一会话遗留的 1163 行插入，属用户未落地工作）；每次 commit 只 `git add` 本任务列出的文件。
- 不修改 SKILL.md / skills/（受 `tests/skill-assets.test.ts`、`tests/skill-smoke.test.ts` 钉死的契约区，本计划不需要动）。
- 保持既有错误码/文案兼容：`HTML_TOO_LARGE_FOR_INLINE` 等不动；v2 `tools.test.ts` 现有断言不得变红。
- 每任务收尾跑 `bun run test --path-ignore-patterns "tests/e2e/**"`（根）+ `bun run test:v2`，全绿才 commit。

## Review Focus

1. metrics JSONL 写入失败不得拖垮 create/update 工具执行（fire-and-forget 吞错）。
2. skills 同步测试必须在 `.opencode/skills/html-interaction` 不存在的机器上跳过而非失败。
3. `anyOf` 须仍被宿主 sanitizer 正常投影（branch 结构保持 `[{required:["html"]},{required:["htmlFile"]}]`，无 `not`）。
4. 轮询 backoff 不得在页面隐藏时持续打点（visibilitychange 暂停），404/410 仍要停轮。
5. update 工具新增 context 参数后，所有既有调用点（含测试）签名兼容。

---

### Task 1: v2 纳入 check 门禁

**Files:**
- Modify: `package.json`（scripts.check 一行）

**Interfaces:** Produces: `bun run check` 现在含 `typecheck:v2` 与 `test:v2`；Task 2/5 收尾验证直接复用。

- [ ] Step 1: 修改 `check` 脚本为 `bun run typecheck && bun run typecheck:v2 && biome check . && bun run test && bun run test:v2`
- [ ] Step 2: 运行 `bun run check`，Expected: exit 0，根 220 pass / 0 fail、v2 101 pass / 0 fail、biome 0 error
- [ ] Step 3: Commit（只 add `package.json`）：`chore: run v2 typecheck and tests in the check gate`

### Task 2: skills 双拷贝字节等同门禁

**Files:**
- Create: `tests/skill-runtime-sync.test.ts`

**Interfaces:** Consumes: `skills/html-interaction`（源）与 `.opencode/skills/html-interaction`（运行副本；gitignored，可能不存在）。Produces: 无下游依赖。

- [ ] Step 1: 写测试：若运行副本存在，断言两目录递归字节等同（文件集合一致 + 每文件内容一致）；不存在则 `test.skip`
- [ ] Step 2: 验证 RED——运行副本临时追加一字节再跑测试，Expected: FAIL（drift 被抓到）；随后还原
- [ ] Step 3: 验证 GREEN——`bun test tests/skill-runtime-sync.test.ts`，Expected: PASS；随后根套件全绿
- [ ] Step 4: Commit（add `tests/skill-runtime-sync.test.ts`）：`test: guard byte equality between skills source and runtime copy`

### Task 3: README / 配置样例对齐活跃插件

**Files:**
- Modify: `opencode.json.example`（改为 v2 `plugins` 数组形式，与本地实际 `opencode.json` 一致）
- Modify: `README.md`（安装/加载相关小节：v2 为活跃入口、v1 降为 legacy 说明；评分节不动）

**Interfaces:** Consumes: `opencode.json` 本地形态（`{ plugins: [{ package: "./opencode-v2-plugin", options: ... }] }]`）。

- [ ] Step 1: 更新两文件
- [ ] Step 2: `bun run test`（根），Expected: 全绿（skill-assets 只读 skills/，不涉 README）
- [ ] Step 3: Commit（add 两文件）：`docs: point example config and README at the active v2 plugin`

### Task 4: 服务端 TTFP 埋点

**Files:**
- Create: `opencode-v2-plugin/src/metrics.ts`、`opencode-v2-plugin/tests/metrics.test.ts`
- Modify: `opencode-v2-plugin/src/runtime/index.ts`（导出）、`opencode-v2-plugin/src/index.ts`（事件接线）、`opencode-v2-plugin/src/tools.ts`（第三可选参数 + update 传入 context）、`opencode-v2-plugin/tests/tools.test.ts`（接线用例）

**Interfaces:**
- Produces:
  - `createTurnTracker(): { recordStart(sessionId: string, at: number): void; get(sessionId: string): number | null }`
  - `createTimingLog(filePath: string): { append(record: Record<string, unknown>): Promise<void> }`（缺目录自动建；自身吞写入错误，resolve 不抛）
  - `createHtmlSessionTools(runtime, config, metrics?: { getTurnStart(sessionId?: string): number | null; appendTiming(record: Record<string, unknown>): void })`
- Consumes: 宿主事件 `session.execution.started`（`event.data.sessionID`）；`ToolInfo.execute` 的 `context.sessionID`。

**记录口径**：成功路径 create/update → `{ phase: "pageReady", sessionId, opencodeSessionId, durationMs, bytes, at }`；`durationMs = Date.now() - turnStart`；无起点或无 metrics 时不写。

- [ ] Step 1: RED——metrics.test.ts：tracker 三断言（record/get、未知 null、覆盖）+ timing log 追加两行 JSONL + 追加失败不抛
- [ ] Step 2: 跑 `bun run --cwd opencode-v2-plugin test`，Expected: FAIL（模块不存在）
- [ ] Step 3: GREEN——实现 `metrics.ts` 并导出
- [ ] Step 4: 跑 metrics.test.ts，Expected: PASS
- [ ] Step 5: RED——tools.test.ts 新增"create 写 pageReady 记录"用例（注入 fake metrics 断言 durationMs>0、opencodeSessionId、bytes）
- [ ] Step 6: 实现 tools.ts 可选 metrics 参数（update.execute 补 context 形参）；index.ts 事件循环处理 `session.execution.started` 记起点、组装 metrics 传入；timeoutLog 路径用 `join(opts.pageDir, "timings.jsonl")`
- [ ] Step 7: `bun run test:v2` + `bun run typecheck:v2`，Expected: 全绿
- [ ] Step 8: Commit（add 列出的 5 文件）：`feat(v2-plugin): server-side pageReady timing log per user turn`

### Task 5: 工具输入契约强化

**Files:**
- Modify: `opencode-v2-plugin/src/runtime/types.ts`（RuntimeError code 增补）、`opencode-v2-plugin/src/tools.ts`
- Modify: `opencode-v2-plugin/tests/tools.test.ts`（强化断言）

**Interfaces:**
- Produces: create/update 的 `input.anyOf: [{required:["html"]},{required:["htmlFile"]}]`；`html`/`htmlFile` 属性 description；create/update 工具 description 各加一句提交控件纪律；`INVALID_TOOL_INPUT` 结构化错误（带 code/status/action）替代两处裸 `Error`（tools.ts:82-83/98）。
- 兼容：现有 `HTML_TOO_LARGE_FOR_INLINE`/`INVALID_HTML` 行为与文案不动；tools.test.ts:87 `rejects.toThrow()` 仍过。

- [ ] Step 1: RED——tools.test.ts：断言 anyOf 结构存在；双给/双缺 `rejects.toMatchObject({ code: "INVALID_TOOL_INPUT" })`；description 含 `type="button"` 与 `submitToAgent`、`html` description 含"互斥"
- [ ] Step 2: 跑该测试，Expected: FAIL（当前无 anyOf/结构化码/description）
- [ ] Step 3: GREEN——types.ts 加 code、tools.ts 改 schema/描述/错误
- [ ] Step 4: `bun run test:v2`，Expected: 全绿
- [ ] Step 5: Commit：`feat(v2-plugin): explicit input contracts and structured input errors`

### Task 6: wrapper 自适应轮询

**Files:**
- Modify: `opencode-v2-plugin/src/runtime/wrapper.ts`
- Modify: `opencode-v2-plugin/tests/runtime/wrapper.test.ts`（`"setInterval(pollVersion"` 断言 → 新调度断言）

**Interfaces:** Consumes: 现有 `/session/:id/version` 端点（不动 server）。Produces: 无。

**行为**：初始 250ms；每轮同版本 `delay = min(delay*2, 2000)`；版本变化回 250ms；404/410 停轮；`visibilitychange` hidden 停轮、visible 恢复 250ms。

- [ ] Step 1: RED——wrapper.test.ts 改断言：HTML 含 `schedulePoll` 与 backoff 常量（250/2000），不再含 `setInterval(pollVersion`
- [ ] Step 2: 跑该测试，Expected: FAIL（旧实现 setInterval）
- [ ] Step 3: GREEN——wrapper.ts 实现递归 setTimeout 调度 + visibilitychange
- [ ] Step 4: `bun run test:v2`，Expected: 全绿
- [ ] Step 5: Commit：`perf(v2-plugin): adaptive version polling in the wrapper page`
