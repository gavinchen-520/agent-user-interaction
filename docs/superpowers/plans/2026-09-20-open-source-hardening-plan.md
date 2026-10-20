# Open Source Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Agent UI Interaction 整理为 MIT 开源项目，并修复发布前确认的请求限制、页面身份、TTL、磁盘恢复和真实插件链路问题。

**Architecture:** 保留当前 runtime/server/store 结构，先通过测试补齐边界，再做最小行为修复。磁盘状态增加 schemaVersion 和版本化页面文件；配置和路径解析在插件入口统一；wrapper bridge 通过显式 page identity 和 payload 上限通信。发布配置、CI 和文档与源码一起验证。

**Tech Stack:** Bun 1.3.14+、TypeScript、Valibot、Bun HTTP server、Playwright Chromium、Biome。

**Spec:** `docs/superpowers/specs/2026-09-20-open-source-hardening-design.md`

## Global Constraints

- 许可证固定为 MIT。
- 默认配置保持 loopback、随机端口、memory 存储。
- 不引入数据库、远程存储或多进程横向扩展。
- 所有行为修复先写失败测试，再写最小生产实现。
- 不使用 `any`、`@ts-ignore` 或 `eslint-disable`。
- 使用 2 空格缩进，代码注释使用中文。
- 以 `skills/html-interaction/` 为 skill 唯一真相源。

---

### Task 1: 建立开源发布基线

**Files:**
- Create: `LICENSE`
- Create: `opencode.json.example`
- Create: `.github/workflows/ci.yml`
- Modify: `.gitignore`
- Modify: `package.json`
- Modify: `opencode-plugin/package.json`
- Delete: `.mcp.json`
- Rename/Delete: `opencode.json` 改为示例配置，不保留本机配置
- Modify: `README.md`

- [ ] **Step 1: 写发布基线检查**

增加 shell/单元级检查，确认 license、示例配置、package 字段、CI 文件存在，且示例不包含 `@latest`、`0.0.0.0`、固定个人路径。

- [ ] **Step 2: 运行检查确认失败**

运行：`bun test tests/release-baseline.test.ts`

预期：在许可证、CI、示例配置尚未存在时失败。

- [ ] **Step 3: 实现 MIT 与发布配置**

添加标准 MIT 文本；根包和插件包添加 `license`、`repository`、`engines` 等必要字段；插件包明确 `private` 语义和 `files` 边界；示例配置使用默认 loopback/memory；删除空 `.mcp.json`；将 lockfile 改为官方 registry；CI 运行 `bun run check`、build 和 Playwright。

- [ ] **Step 4: 修正文档安装路径**

README 使用 `opencode.json.example`，区分本地开发配置和外部监听部署，不再要求复制作者本机配置。

- [ ] **Step 5: 验证并整理 git 文件**

运行：`bun test tests/release-baseline.test.ts`、`bun run typecheck`、`bunx biome check .`

预期：发布基线检查通过；所有新增源码/测试/资产的跟踪取舍明确。

---

### Task 2: 收紧运行时配置和工作区路径

**Files:**
- Modify: `opencode-plugin/src/config.ts`
- Modify: `opencode-plugin/src/index.ts`
- Modify: `opencode-plugin/src/tools/htmlSession.ts`
- Modify: `opencode-plugin/src/logging.ts`
- Modify: `opencode-plugin/src/runtime/store.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/tools/htmlSession.test.ts`

- [ ] **Step 1: 写非法配置和 workspace 路径测试**

覆盖 `NaN`、`Infinity`、小数 TTL、错误布尔值、非 HTTP(S) publicBaseUrl、非 loopback 缺 publicBaseUrl；覆盖相对 htmlFile/dataDir/logging file 相对于 workspace 解析。

- [ ] **Step 2: 运行测试确认失败**

运行：`bun test tests/config.test.ts tests/tools/htmlSession.test.ts`

预期：当前实现接受部分非法值并使用 `process.cwd()`，新增断言失败。

- [ ] **Step 3: 实现配置和路径边界**

增加有限整数/布尔/URL scheme 校验；插件工厂保存 `PluginInput.directory/worktree`，将解析后的根目录传入 tool/runtime/logging；保留绝对路径语义；非 loopback 缺 publicBaseUrl 启动失败。

- [ ] **Step 4: 验证**

运行：`bun test tests/config.test.ts tests/tools/htmlSession.test.ts`、`bun run typecheck`。

预期：新增测试和原测试全部通过。

---

### Task 3: 修复 body 限流、payload 配置和页面身份

**Files:**
- Modify: `opencode-plugin/src/runtime/server.ts`
- Modify: `opencode-plugin/src/runtime/pageRuntime.ts`
- Modify: `opencode-plugin/src/tools/htmlSession.ts`
- Modify: `opencode-plugin/src/browser/wrapper.ts`
- Modify: `tests/runtime/server.test.ts`
- Modify: `tests/runtime/server-external.test.ts`
- Modify: `tests/runtime/pageRuntime.test.ts`
- Modify: `tests/browser/wrapper.test.ts`

- [ ] **Step 1: 写失败测试**

增加带 token 的超大 chunked body 测试；配置上下限贯通 bridge/wrapper/server；模拟 update 后旧 iframe 消息；模拟 submit 500 后重试；模拟 404/410 停止版本轮询。

- [ ] **Step 2: 运行测试确认失败**

运行：`bun test tests/runtime/server.test.ts tests/runtime/server-external.test.ts tests/runtime/pageRuntime.test.ts tests/browser/wrapper.test.ts`

预期：当前 body 完整缓冲、bridge 固定 64 KiB、旧消息身份可选、失败不可重试，测试失败。

- [ ] **Step 3: 实现有上限读取和身份传递**

从 `Request.body` 流式累计字节并在超限时终止；注入 bridge 时生成包含 pageId/pageVersion 或 nonce 的 payload；wrapper 强制校验身份并在提交失败时复位；保存轮询 timer，处理终态和卸载。

- [ ] **Step 4: 验证**

运行同一组测试，再运行 `bun run typecheck`。

预期：边界测试通过，正常提交和旧页面拒绝行为保持通过。

---

### Task 4: 统一 TTL 和 waiter 生命周期

**Files:**
- Modify: `opencode-plugin/src/runtime/store.ts`
- Modify: `opencode-plugin/src/index.ts`
- Modify: `tests/runtime/store.test.ts`
- Modify: `tests/runtime/waiter.test.ts`
- Modify: `tests/plugin-lifecycle.test.ts`

- [ ] **Step 1: 写失败测试**

覆盖 memory 模式主动 TTL、end/TTL/update 清理 ready waiter、dispose 清空所有 waiter，以及 OpenCode session 删除和插件 dispose 清理 `messageCreatedAt`。

- [ ] **Step 2: 运行测试确认失败**

运行：`bun test tests/runtime/store.test.ts tests/runtime/waiter.test.ts tests/plugin-lifecycle.test.ts`

预期：memory session 不会主动消失，ready waiter 和时间 Map 的断言失败。

- [ ] **Step 3: 实现统一清理器**

memory/disk 都创建周期清理；统一 `clearSessionMemory` 清理两个 waiter；server 查询走 TTL-aware 接口；事件删除和 dispose 清理 `messageCreatedAt`；失败启动路径 dispose runtime。

- [ ] **Step 4: 验证**

运行上述测试并重复执行 10 次，确认没有时间竞争。

---

### Task 5: 加固磁盘存储与 retained 语义

**Files:**
- Modify: `opencode-plugin/src/runtime/storage.ts`
- Modify: `opencode-plugin/src/runtime/store.ts`
- Modify: `tests/runtime/storage.test.ts`
- Modify: `tests/tools/htmlSession-file.test.ts`
- Modify: `README.md`
- Modify: `docs/disk-storage-and-external-access-design.md`

- [ ] **Step 1: 写失败测试**

覆盖目录/文件权限、非法 meta/pending、目录名不匹配、schemaVersion、版本化 page 文件、retained 删除 pending/token、跨文件恢复故障 fixture。

- [ ] **Step 2: 运行测试确认失败**

运行：`bun test tests/runtime/storage.test.ts tests/tools/htmlSession-file.test.ts`

预期：当前权限依赖 umask、类型断言恢复、固定 `page.html` 和 retained 全量保留，测试失败。

- [ ] **Step 3: 实现 schema 与安全写入**

引入明确的 meta/pending schema；显式 chmod/mode；增加 schemaVersion；page 使用版本化文件并由 meta 指针选定；恢复拒绝不一致数据；retained 清理 pending 和 token/state，保留页面原件并记录清理边界。

- [ ] **Step 4: 验证**

运行存储测试、`bun run typecheck`，并在 macOS 上检查实际权限；更新文档中的大小、TTL、retained 语义。

---

### Task 6: 增加真实插件装配 E2E

**Files:**
- Modify: `tests/e2e/runtime-host.ts` 或新增真实插件 host
- Modify: `tests/e2e/html-interaction.spec.ts`
- Modify: `tests/plugin-lifecycle.test.ts`
- Modify: `playwright.config.ts`
- Modify: `README.md`

- [ ] **Step 1: 写失败 E2E**

页面只调用注入的 `submitToAgent`；host 通过默认插件导出或等价的 `createHtmlSessionTools` 创建 session，验证 options、静态校验、bridge 注入、sandbox 和提交结果。

- [ ] **Step 2: 运行确认当前链路不满足**

运行：`bunx playwright test tests/e2e/html-interaction.spec.ts --reporter=list`

预期：当前手写 `postMessage` fixture 无法证明真实注入链路，新增用例应先失败或明确缺少装配入口。

- [ ] **Step 3: 实现最小真实 host**

使用生产入口创建 runtime/server/tool，避免复制生产逻辑；测试 fixture 不使用被静态校验拒绝的 `fetch`；断言 `submitToAgent` 成功、旧版本失败、wrapper 状态变化正确。

- [ ] **Step 4: 验证**

运行完整 Chromium E2E，确认 Linux CI 使用 `playwright install --with-deps chromium`。

---

### Task 7: 清理协议、CSP、文档和 skill 同步

**Files:**
- Modify: `opencode-plugin/src/runtime/types.ts`
- Modify: `opencode-plugin/src/runtime/server.ts`
- Modify: `opencode-plugin/src/runtime/htmlValidation.ts`
- Modify: `skills/html-interaction/references/page-protocol.md`
- Modify: `skills/html-interaction/SKILL.md`
- Modify: `skills/html-interaction/references/examples.md`
- Modify: `docs/*.md`
- Modify: `tests/skill-assets.test.ts`
- Modify: `tests/skill-smoke.test.ts`

- [ ] **Step 1: 写协议和行为测试**

覆盖完整错误码、CSP 导航边界、HTML 实体/注释/字符串 bridge fixture，确认 skill 源文件与运行时副本同步。

- [ ] **Step 2: 实现最小修复**

统一 `RuntimeErrorCode`；恢复或明确 `navigate-to` 策略；降低静态校验误判；将历史 docs 标记为 superseded；减少对文案措辞的脆弱断言。

- [ ] **Step 3: 验证**

运行 skill tests、`git grep '/Users/'`、`bunx biome check .` 和完整 `bun run check`。

---

### Task 8: 全量验收与发布快照检查

**Files:**
- Modify as required by prior tasks only

- [ ] **Step 1: 运行全量命令**

运行：`bun install --frozen-lockfile`、`bun run check`、`bun run build`、`bun run test:e2e`。

- [ ] **Step 2: 验证发布边界**

检查 `git status --short`、`git ls-files`、`git diff --check`、`bun pm pack --dry-run --cwd opencode-plugin`；确认无个人绝对路径、空 JSON、无效 external 和未跟踪必需源码。

- [ ] **Step 3: 复核安全行为**

确认默认 loopback、外部监听需要 publicBaseUrl、磁盘权限、retained 清理和错误响应文档一致。

- [ ] **Step 4: 更新文档状态**

在首轮和二次审查清单中勾选已经完成项，保留未完成风险，不声称未验证的能力已经完成。
