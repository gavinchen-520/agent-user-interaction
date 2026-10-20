# HTML Theme And Generation Performance Implementation Plan

> 状态：Superseded（历史计划）。其中的耗时观测埋点已在后续清理中移除，主题与页面瘦身策略仍然有效。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 HTML interaction 页面默认采用更大众化的浅色主题，并通过测量和低风险优化降低从生成到可交互的体感耗时。

**Architecture:** 主题策略放在 `html-interaction` skill 和参考示例中，由模型生成页面时统一遵守；runtime 保留现有 sandbox、CSP、payload 校验和 session 生命周期。性能部分先在工具和浏览器启动边界增加可测试的耗时观测，再针对占比最高的阶段优化，优先减少页面输出体量和重复初始化，不改变提交协议。

**Tech Stack:** TypeScript、Bun、Bun test、Biome、OpenCode plugin、Markdown skill 文档。

**Spec:** `docs/superpowers/specs/2026-09-05-agent-ui-interaction-design.md`

## Global Constraints

- 默认主题必须是浅色，只有用户明确要求时才使用深色主题。
- 页面颜色必须使用 CSS 变量，文字与背景必须保持可读对比度。
- 不引入 CDN、远程字体、外部图片或新的运行时依赖。
- 不改变 `submitToAgent`、sandbox、CSP、token、page version 和 payload size 安全边界。
- 所有新增 TypeScript 代码使用 2 空格缩进、camelCase、明确类型，不使用 `any`、`@ts-ignore` 或禁用 lint。
- 先建立可重复的耗时基线，再决定是否调整浏览器打开行为。

---

### Task 1: 建立性能基线

**Files:**
- Modify: `opencode-plugin/src/tools/htmlSession.ts`
- Modify: `opencode-plugin/src/browser/browser.ts`
- Test: `tests/tools/htmlSession.test.ts`
- Test: `tests/browser/wrapper.test.ts`

**Interfaces:**
- `openBrowser(url: string): Promise<void>` 保持现有公开接口不变。
- 新增的测量只通过可注入的函数或测试 spy 验证，不把调试日志写入用户页面或提交 payload。

- [ ] **Step 1: 先运行现有检查，记录基线**

Run: `bun run check`

Expected: 当前已有测试通过；若失败，记录为基线问题，不把无关修复混入本任务。

- [ ] **Step 2: 添加可控的耗时观测测试**

用已有的 `openBrowser` 注入能力验证 create 工具在 `runtime.createSession`、浏览器打开和返回结果之间的顺序与耗时边界；测试不得启动真实浏览器。测试只断言调用顺序和结果，不依赖真实毫秒数。

- [ ] **Step 3: 实现最小测量接口**

将测量限制在开发可观测范围，默认不输出日志；若需要日志，使用可选的 typed callback，并确保生产默认关闭。不要改变工具返回 JSON 结构。

- [ ] **Step 4: 运行新增测试**

Run: `bun test tests/tools/htmlSession.test.ts tests/browser/wrapper.test.ts`

Expected: PASS，且现有浏览器失败清理行为保持不变。

### Task 2: 统一浅色主题生成规范

**Files:**
- Modify: `skills/html-interaction/SKILL.md`
- Modify: `skills/html-interaction/references/examples.md`
- Test: `tests/skill-smoke.test.ts`

**Interfaces:**
- skill 文本继续要求生成自包含 HTML 和唯一提交入口。
- 示例页面新增可复用的 CSS 变量主题结构，但不改变 bridge 协议。

- [ ] **Step 1: 增加失败断言**

在 skill smoke 测试中断言 skill 文档包含浅色优先、CSS 变量、深色主题需用户明确要求、常用蓝/青/绿/橙强调色和对比度要求。

- [ ] **Step 2: 运行测试确认缺少规范时失败**

Run: `bun test tests/skill-smoke.test.ts`

Expected: 新增断言在规范尚未补齐前失败。

- [ ] **Step 3: 修改 skill 生成规则**

新增明确规则：默认使用白色或浅灰背景、深色文字和低饱和边框；强调色只用于主要操作、选中态和状态反馈；深色模式只有用户明确要求或业务语义确实需要时启用；所有颜色通过 CSS 变量集中定义；避免大面积渐变、过量阴影和装饰性动画。

- [ ] **Step 4: 更新确认页示例**

给示例增加简洁的浅色 CSS 变量和按钮样式，保持 bridge 完整内联、页面无外部资源、只有一个提交入口。

- [ ] **Step 5: 运行 skill 与全量静态检查**

Run: `bun test tests/skill-smoke.test.ts && bun run check`

Expected: PASS，且没有破坏现有 skill 安全约束。

### Task 3: 降低页面生成和校验体量

**Files:**
- Modify: `skills/html-interaction/SKILL.md`
- Modify: `skills/html-interaction/references/examples.md`
- Modify: `skills/html-interaction/scripts/smoke-test.mjs`
- Test: `tests/skill-assets.test.ts`
- Test: `tests/skill-smoke.test.ts`

**Interfaces:**
- smoke test CLI 参数和 PASS/FAIL 语义保持兼容。
- 页面仍必须在传给 `create_html_session` 或 `update_html_session` 前通过 smoke test。

- [ ] **Step 1: 添加生成体量和重复初始化的回归检查**

测试 skill 规则要求优先使用紧凑 HTML、CSS 变量和原生浏览器能力，不重复实现 HTTP、认证、文件读写或 bridge 校验；测试 smoke 脚本仍能处理表单页和 `--click` 页面。

- [ ] **Step 2: 运行回归测试确认新增要求未满足**

Run: `bun test tests/skill-assets.test.ts tests/skill-smoke.test.ts`

Expected: 新增规范断言失败，既有 smoke fixture 行为不变。

- [ ] **Step 3: 增加轻量页面生成预算**

在 skill 中要求常规页面优先控制在 30KiB 左右，超过时使用 `htmlFile`，并减少冗余 DOM、重复 CSS、复杂动画和不必要的图表数据。该预算作为生成目标，不修改现有 64KiB 内联硬限制。

- [ ] **Step 4: 优化 smoke test 启动路径**

复用已安装的 jsdom，避免文档指导每次重新安装依赖；保留缺少依赖时的清晰错误信息和现有 CLI 行为。不得跳过页面脚本执行、提交按钮验证或多次 click 支持。

- [ ] **Step 5: 运行全部测试**

Run: `bun run check`

Expected: PASS，所有 fixture 仍可通过，页面安全协议没有变化。

### Task 4: 基于基线决定浏览器启动优化

**Files:**
- Modify only if baseline confirms need: `opencode-plugin/src/tools/htmlSession.ts`, `opencode-plugin/src/browser/browser.ts`
- Test: `tests/tools/htmlSession.test.ts`

**Interfaces:**
- 默认情况下保持 `create_html_session` 返回前确认浏览器打开成功的语义。
- 若采用异步打开，必须增加明确的 typed 状态字段或错误路径，并更新 README、测试和 skill 文档，不能静默改变行为。

- [ ] **Step 1: 根据 Task 1 测量结果选择路径**

若页面生成/模型输出占主要时间，不改 runtime，只保留 skill 优化；若浏览器启动占主要时间，才设计异步打开或复用浏览器进程的最小改动。

- [ ] **Step 2: 为选定路径先写失败测试**

覆盖成功、打开失败后的 session 清理、返回值兼容和无显示环境错误提示。

- [ ] **Step 3: 实现最小 runtime 优化**

不得改变 session token、URL、page version、sandbox、CSP 和提交协议；失败必须仍能被模型识别并得到手动打开 URL 或重试建议。

- [ ] **Step 4: 运行定向和全量验证**

Run: `bun test tests/tools/htmlSession.test.ts tests/runtime/server.test.ts && bun run check`

Expected: PASS，并输出优化前后的分段耗时对比。

### Task 5: 更新文档与验收记录

**Files:**
- Modify: `README.md`
- Modify: `docs/manual-test-cases.md`
- Modify: `docs/scenario-test-prompts.md`

- [ ] **Step 1: 补充主题验收场景**

覆盖确认页、复杂表单、双阶段页面，确认默认浅色、控件状态清晰、窄屏不溢出。

- [ ] **Step 2: 补充性能验收记录格式**

记录 HTML 生成、smoke test、session 创建、浏览器打开和页面可交互总耗时，分别记录冷启动与连续创建。

- [ ] **Step 3: 运行最终验证**

Run: `bun run check`

Expected: PASS；真实 OpenCode 验收仍按 README 的现有流程执行，未执行 Git commit、push、merge。
