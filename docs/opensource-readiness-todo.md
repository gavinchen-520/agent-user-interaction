# 开源化与代码优化待办清单

> 来源：全工程只读扫描（源码、测试、配置、文档）与交叉复核。
> 状态：**待办**。本文件是首轮扫描的基线清单；二次复核与新增问题见 [`opensource-readiness-re-audit.md`](./opensource-readiness-re-audit.md)。完成后请勾选并在"验收"列记录结果。
> 优先级：P0 = 开源阻断（不处理不能公开）；P1 = 强烈建议；P2 = 可选优化。
> 说明：证据中的行号为扫描时（HEAD `634d33a` + 未提交改动）的位置，重构后可能漂移，定位以符号/片段为准。

---

## P0 开源阻断项

### P0-1 补齐开源许可证

- [ ] 添加 `LICENSE` 文件，并在 `package.json` / `opencode-v1-aui/package.json` 增加 `license` 字段
  - 问题：仓库无 `LICENSE`，两个 `package.json` 也无 `license` 字段。公开仓库无许可证 = 法律默认 all rights reserved，第三方使用即侵权，不构成开源项目。
  - 证据：`git ls-files` 无 `LICENSE`；`package.json`、`opencode-v1-aui/package.json` 均无 `license`。
  - 改法：与用户确认选型（MIT 或 Apache-2.0）后落盘 `LICENSE`，并写入 `license` 字段。
  - 验收：`LICENSE` 存在；两个 `package.json` 均含 `license`；GitHub 仓库页显示许可证。

### P0-2 清理会入库的个人配置

- [ ] 处理 `opencode.json`（本机个人配置，未被忽略）
  - 问题：含 `hostname: "0.0.0.0"`、`port: 15073`、`publicBaseUrl: "http://127.0.0.1:15073"`，且 `mcp.chrome-devtools` 使用未固定版本的 `npx -y chrome-devtools-mcp@latest`（供应链风险）。
  - 证据：`opencode.json:19-23`；`git status` 为 `??`；`git check-ignore opencode.json` 未命中。
  - 改法：改为 `opencode.json.example`（用最小默认 `[["./opencode-v1-aui", {}]]`），并把 `opencode.json` 加入 `.gitignore`；`mcp` 段固定版本或移除。
  - 验收：`git check-ignore opencode.json` 命中；仓库内只有示例文件。

- [ ] 删除 0 字节空文件 `.mcp.json`
  - 问题：空 JSON 使 `biome check .` 解析失败，直接导致 `bun run check` 失败。
  - 证据：`wc -c .mcp.json` = 0；实跑 `bun run check` 在 `biome check .` 阶段 exit 1。
  - 改法：删除文件；并在 `biome.json` 或 `.gitignore` 中排除此类本机配置文件。
  - 验收：`bun run check` 通过。

### P0-3 修正 `bun run check` 失败

- [ ] 让 README 指定的验收命令真正可用
  - 问题：`check` = `bun run typecheck && biome check . && bun run test`，被 `.mcp.json` 阻断，`test` 从未执行。
  - 证据：`package.json:13`；实跑输出。
  - 改法：先完成 P0-2；可同时让 `check` 只扫描受版本控制的路径，避免本机杂散文件污染。
  - 验收：干净 clone 后 `bun install && bun run check` 全绿。

### P0-4 整理工作树，确保可发布

- [ ] 一次性完成"提交 / 删除 / 忽略"取舍，保证提交可独立构建
  - 问题：23 个已修改 + 20 余个未跟踪文件；`opencode-v1-aui/src/index.ts` 已依赖未跟踪的新模块（`config.ts`、`logging.ts`、`observation.ts`、`runtime/htmlValidation.ts`、`runtime/pageRuntime.ts`、`runtime/storage.ts`），部分 `git add` 会得到无法构建的提交。
  - 证据：`git status --porcelain`。
  - 改法：全量纳入本轮提交；确认新增测试与被测资产一并入库（见 P0-5）。
  - 验收：干净 clone 后可直接 `bun install && bun run build`。

- [ ] 删除已废弃但被 git 跟踪的 `skills/agent-user-interaction/assets/submit-bridge.js`
  - 问题：bridge 已收敛为 `opencode-v1-aui/src/runtime/pageRuntime.ts` 单一真源，该文件已从工作树删除但仍被 git 跟踪。
  - 证据：`git status` 显示 `D skills/agent-user-interaction/assets/submit-bridge.js`；`docs/page-generation-performance-optimization.md` 说明该资产已删除。
  - 现状：工作树已删除（`D`），需随本轮提交落实。
  - 验收：`git ls-files` 中不再出现该路径。

### P0-5 确保新增测试与资产入库

- [ ] 将下列未跟踪的测试与被测资产纳入提交（否则他人 clone 后测试 ENOENT）
  - 未跟踪测试：`tests/config.test.ts`、`tests/runtime/htmlValidation.test.ts`、`tests/runtime/pageRuntime.test.ts`、`tests/runtime/server-external.test.ts`、`tests/runtime/storage.test.ts`、`tests/skill-smoke.test.ts`、`tests/tools/htmlSession-file.test.ts`、`tests/smoke-test.mjs`
  - 未跟踪资产：`skills/agent-user-interaction/assets/skeleton.html`、`tests/fixtures/html-smoke/*.html`（4 个）
  - 已删除：`tests/logging.test.ts`、`tests/observation.test.ts`（耗时日志体系移除）；`skills/agent-user-interaction/scripts/smoke-test.mjs` 已移至 `tests/smoke-test.mjs`。
  - 证据：`git status` 均为 `??`；`skill-smoke.test.ts` / `skill-assets.test.ts` 会读取这些路径。
  - 事实澄清：这些文件**未被** `.gitignore` 忽略，问题是"未跟踪"。
  - 验收：`git ls-files` 包含上述全部路径。

### P0-6 清理 lockfile 的区域镜像

- [ ] 用官方源重新生成 `bun.lock`
  - 问题：lockfile 全量锁定 `registry.npmmirror.com`（87 处，官方源 0 处），外部贡献者 `--frozen-lockfile` 被迫走区域镜像，影响可复现性与信任。
  - 证据：`rg -c npmmirror bun.lock` = 87；`rg -c registry.npmjs.org bun.lock` = 0。
  - 改法：切换 registry 后重新 `bun install` 生成 lockfile，并确认依赖解析结果一致。
  - 验收：lockfile 中无 `npmmirror`；`bun install --frozen-lockfile` 无变更。

### P0-7 建立 CI

- [ ] 增加 `.github/workflows/ci.yml`
  - 问题：无任何 CI，push/PR 无 typecheck + lint + test 门禁。
  - 证据：无 `.github/`。
  - 改法：两个 job——`check`（`bun install && bun run check`）与 `e2e`（`bunx playwright install --with-deps chromium && bunx playwright test`）；固定 Bun 版本。
  - 验收：PR 上两个 job 均运行。

---

## P1 强烈建议

### P1-1 README 安装/配置示例改为最小默认

- [ ] 修正误导性示例
  - 问题：README 示例与作者本机 `opencode.json` 逐字段相同（`0.0.0.0` / `15073` / `http://127.0.0.1:15073`），且自相矛盾——`hostname: 0.0.0.0` 配 loopback 的 `publicBaseUrl`，照抄后外部设备拿到的 URL 打不开（README 自己也写明该约束）。
  - 证据：`README.md:44-65`、`README.md:100-107`、`README.md:119-121`。
  - 改法：安装示例改为 `[["./opencode-v1-aui", {}]]`（内存 + loopback + 随机端口）；外部访问单列可选章节。
  - 验收：新用户照抄示例即可跑通。

### P1-2 修正 `page-protocol.md` 错误码

- [ ] 以 `runtime/types.ts` 的 `RuntimeErrorCode` 为唯一真源补全错误码表
  - 问题：文档只列 6 个错误码，实际联合类型有 13 个；server 另有 `INVALID_AUTHORITY` / `ROUTE_NOT_FOUND` / `METHOD_NOT_ALLOWED` 未纳入类型与文档；且 `PAYLOAD_TOO_LARGE` 被错误描述为"HTML 或 payload 超 64KiB"。
  - 证据：`skills/agent-user-interaction/references/page-protocol.md:26-33`；`opencode-v1-aui/src/runtime/types.ts:12-25`；`opencode-v1-aui/src/runtime/server.ts:74,137,146`。
  - 改法：补全错误码；修正 `PAYLOAD_TOO_LARGE` 仅用于提交 payload，HTML 超限为 `HTML_TOO_LARGE_FOR_INLINE`（内联）/`HTML_TOO_LARGE`（文件）。
  - 验收：错误码表与 `types.ts` 一一对应。

### P1-3 修正 README 中 `retainPages` 的 TTL 描述

- [ ] 删除或改写矛盾句
  - 问题：README 称 retained 目录"TTL 过期仍会删除"，但代码对 `retained` 直接 `continue`，永不自动删除。
  - 证据：`README.md:114`；`opencode-v1-aui/src/runtime/store.ts:306,353`。
  - 改法：明确"retained 目录永不自动删除，需手动清理"。
  - 验收：描述与代码一致。

### P1-4 清理 docs 过期内容与个人路径

- [ ] 给 docs 统一加状态标记（`Current` / `Superseded` / `Plan`），归档历史计划
  - 问题：`disk-storage-and-external-access-design.md` 写 `maxPageFileBytes` 10MB（实际 3MiB）、"文件型 HTML 不限制大小"（实际封顶 3MiB）、恢复流程未含 retainPages；`superpowers/specs`、`plans` 描述 loopback-only + 纯内存，与现状（`0.0.0.0` + disk）相反且无标记；`manual-test-cases.md` 仍把 smoke test 当生成主链路计时项。
  - 证据：`docs/disk-storage-and-external-access-design.md`；`docs/superpowers/specs/2026-09-05-agent-user-interaction-design.md`；`docs/superpowers/plans/2026-09-05-agent-user-interaction-implementation.md`；`docs/manual-test-cases.md`；`opencode-v1-aui/src/runtime/constants.ts:11`。
  - 改法：过期设计合并进 README/架构说明，历史计划移入 `docs/archive/` 并标注。
  - 验收：新贡献者读 docs 不会得到与代码相反的结论。

- [ ] 移除被跟踪文档中的个人绝对路径
  - 证据：`docs/superpowers/plans/2026-09-05-agent-user-interaction-implementation.md:23`（`/Users/gavin/workspace-ai/agent-ui-generator/...`）。
  - 验收：`git grep '/Users/'` 无结果。

### P1-5 构建产物元数据与版本约束

- [ ] 补全 `opencode-v1-aui/package.json`
  - 问题：只有 `main`，无 `types` / `exports` / `files` / `repository` / `engines` / `packageManager`；`private: true` 与 README"发布单元为整个目录"的表述不一致。
  - 证据：`opencode-v1-aui/package.json:4,6`。
  - 改法：补 `types`（如 `./dist/index.d.ts` 或声明无需类型）、`files`、`engines.bun`；README 的 Bun 版本要求落到 `engines`。
  - 验收：元数据完整，`private` 语义与文档一致。

- [ ] 删除无效的 `--external @opencode-ai/sdk`
  - 问题：全仓无 `@opencode-ai/sdk` import，依赖中也未声明，external 配置与 README 描述均误导。
  - 证据：`opencode-v1-aui/package.json:9`；`README.md:144`；`rg '@opencode-ai/sdk' opencode-v1-aui/src` 无结果。
  - 验收：构建命令只保留真实 external（`@opencode-ai/plugin`）。

- [ ] 对齐 Biome 版本
  - 问题：`biome.json` `$schema` 固定 2.5.12，devDependency 为 caret `^2.3.10`，caret 漂移会造成 schema 与 CLI 错配。
  - 证据：`biome.json:2`；`package.json` devDependencies。
  - 验收：schema 版本与安装版本一致或改为受控更新。

### P1-6 删除死代码与冗余导出

- [ ] 删除 `createWrapperMessageHandler`
  - 问题：生产从不调用；`server.ts` 只 import `buildWrapperHtml`，该函数唯一调用方是测试自身。真实消息处理是 `wrapper.ts` 内联脚本。
  - 证据：`opencode-v1-aui/src/browser/wrapper.ts:43`；`opencode-v1-aui/src/browser/index.ts:3`；`opencode-v1-aui/src/runtime/server.ts:2`。
  - 验收：删除后测试相应调整，`bun run check` 通过。

- [ ] 删除冗余别名 `createSubmissionEnvelope` 与 `parseSubmission`
  - 问题：两者都是 `parseEnvelope` 的等价别名，生产只用 `parseSubmissionWithLimit`，前两者仅测试引用。
  - 证据：`opencode-v1-aui/src/runtime/protocol.ts:100-103`；`opencode-v1-aui/src/runtime/index.ts:1`。
  - 验收：仅保留单一入口，测试改用该入口。

### P1-7 统一 payload 上限与 JSON 校验

- [ ] 抽取共享常量与校验实现
  - 问题：`64 * 1024` 在 `protocol.ts`、`wrapper.ts`、`pageRuntime.ts` 各写一遍；JSON 兼容校验有三份实现（`protocol.ts` 的 `isJsonSerializable`、`wrapper.ts` 内联脚本的 `isJson`、`pageRuntime.ts` bridge 的 `isJsonCompatible`）。
  - 证据：`opencode-v1-aui/src/runtime/protocol.ts`；`opencode-v1-aui/src/browser/wrapper.ts`；`opencode-v1-aui/src/runtime/pageRuntime.ts`。
  - 改法：至少让 TS 侧共用 `defaultMaxPayloadBytes` 与同一校验函数；bridge 因运行在页面内需独立，但应注释说明并保证语义一致。
  - 验收：常量与校验无重复漂移。

### P1-8 补全错误码类型

- [ ] 让 server 错误码纳入 `RuntimeErrorCode`
  - 问题：`INVALID_AUTHORITY` / `ROUTE_NOT_FOUND` / `METHOD_NOT_ALLOWED` 未在联合类型中，因 `errorResponse` 的 `fallbackCode` 是裸 `string` 而绕过类型检查。
  - 证据：`opencode-v1-aui/src/runtime/types.ts:12-25`；`opencode-v1-aui/src/runtime/server.ts:24,31,74`。
  - 改法：把 server 错误码并入联合类型，`fallbackCode` 收窄为 `RuntimeErrorCode`。
  - 验收：typecheck 能捕获非法错误码。

### P1-9 明确 skill 副本真相源

- [ ] README 声明 `skills/agent-user-interaction/` 为唯一真相源
  - 问题：git 跟踪 `skills/agent-user-interaction/`（测试读取此份），运行时安装 `.opencode/skills/agent-user-interaction/`（被忽略）；当前无漂移，但靠手动 `cp` 同步，无一致性断言。
  - 证据：`tests/skill-assets.test.ts`、`tests/skill-smoke.test.ts` 读取 `skills/`；`.gitignore:3` 忽略 `.opencode/`。
  - 改法：README 说明；增加 `sync-skill` 脚本或一致性测试。
  - 验收：不存在"改了运行时副本但 CI 仍绿"的情况。

### P1-10 测试质量修正

- [ ] 让 e2e 覆盖生产链路（含注入的 `submitToAgent` bridge）
  - 问题：`tests/e2e/runtime-host.ts` 直接调用 `createHtmlRuntime` / `createRuntimeServer`，绕过插件装配与 `tools/htmlSession.ts`；spec 手写 `window.parent.postMessage`，从未验证 `pageRuntime.ts` 的注入 bridge 在真实 Chromium + sandbox + CSP 下可用。
  - 证据：`tests/e2e/agent-user-interaction.spec.ts`、`tests/e2e/runtime-host.ts`。
  - 验收：e2e 至少一条用例走注入 bridge 并提交成功。

- [ ] 消除对文档措辞的弱断言
  - 问题：`tests/skill-smoke.test.ts`、`tests/skill-assets.test.ts` 大量对 `SKILL.md` 正文做正则断言，改文案即红，对贡献者不友好；`tests/smoke.test.ts` 仅 2 条低价值断言。
  - 证据：`tests/skill-smoke.test.ts`、`tests/skill-assets.test.ts`、`tests/smoke.test.ts`。
  - 改法：断言收敛到"护栏语义"（如必须存在 sticky/flex-end 规则），或引入覆盖率阈值替代文案匹配。
  - 验收：合理改文案不再误报。

- [ ] 修复随机端口 flaky 风险
  - 问题：`tests/runtime/server-external.test.ts` 随机取 18000-37999，端口被占用会导致假失败；`bun test` 默认并发。
  - 证据：`tests/runtime/server-external.test.ts`。
  - 改法：用系统分配端口（`:0`）后读取实际端口，或加重试。
  - 验收：连续多次运行稳定。

- [ ] 消除 skill-smoke 对 `node` 命令的隐式依赖
  - 问题：`tests/skill-smoke.test.ts` 用 `spawnSync("node", ...)`，但工具链只声明 Bun；无 Node 的环境会失败。
  - 改法：改用 `process.execPath` 或在文档声明 Node 前置。
  - 验收：仅有 Bun 的环境也能跑 `check`。

---

## P2 可选优化

### P2-1 拆分 `runtime/store.ts`

- [ ] 按职责拆文件
  - 问题：`runtime/store.ts`（约 408 行）把会话状态机、持久化编排、TTL 清理、启动恢复、pending 缓存揉在一个闭包工厂里，扩展新存储模式成本高。
  - 改法：拆为 `sessionLifecycle` / `persistence` / `cleanup` / `store`（编排）。
  - 验收：单文件行数下降，测试全绿。

### P2-2 重构 `runtime/server.ts` 路由

- [ ] 用小型路由表替代 if-else 长链
  - 问题：`url.pathname === ...` 逐条判断，method/token 校验在各分支重复，`getSessionId` 正则与后续精确匹配重复。
  - 改法：路由表 + 统一鉴权中间层。
  - 验收：行为不变，重复校验消除。

### P2-3 声明静态沙箱校验的边界

- [ ] 明确 `runtime/htmlValidation.ts` 是启发式正则
  - 问题：正则无法真正解析 HTML/JS，会误报（注释、字符串中的 `fetch(`）也会漏报（动态拼接）。这是设计权衡，但需在文档中说明。
  - 改法：在 `SKILL.md` 注明其启发式性质（`security.md` 已合并进 `SKILL.md`）；如需精确可引入解析器（成本高）。
  - 验收：文档明确边界，避免被误解为强保证。

### P2-4 文档精度与约束补全

- [ ] 补全 README 遗漏
  - `README.md:115` "3MB" 应为 "3 MiB"。
  - 未提 `storage.dataDir` 非空、`publicBaseUrl` 必须为合法 URL 两条校验（`opencode-v1-aui/src/config.ts:64-65,89-97`）。
  - `openBrowser` 支持传入自定义函数（`OpenBrowserOption`），README 只写布尔语义。
  - 验收：文档与 `config.ts` 一致。

### P2-5 测试类型检查与覆盖率

- [ ] 让 `tests/` 参与 typecheck
  - 问题：唯一 tsconfig `include: ["src/**/*"]`，测试代码类型错误不被 `check` 拦截。
  - 改法：增加覆盖 `tests/` 的 tsconfig 或调整 include。
  - 验收：测试类型错误能让 `check` 失败。

- [ ] 引入覆盖率统计与阈值
  - 问题：当前无覆盖率度量，存在未被测试的模块（如 `browser/browser.ts` 的 `openBrowser`、`wrapper.ts` 的 `escapeHtml`）。
  - 改法：`bun test --coverage` 并在 CI 设阈值。
  - 验收：覆盖率随 CI 报告。

### P2-6 一键化开发体验

- [ ] 提供最小可运行配置与一键脚本
  - 问题：从 clone 到跑通需 clone → `bun install` → `bun run build` → `cp` skill → 改 `opencode.json` → 手写 `.opencode/package.json` → 重启 OpenCode，步骤多。
  - 改法：提供 `opencode.json.example`、`scripts/setup.sh` 或 Makefile；补 `engines`。
  - 验收：新用户按脚本一次跑通。

### P2-7 社区治理文件

- [ ] 补充 `CONTRIBUTING.md` / `SECURITY.md` / `CHANGELOG.md` / issue、PR 模板
  - 证据：仓库均无。
  - 验收：GitHub 社区健康度提示消失。

---

## 执行顺序建议

1. P0 全部（发布整理 + CI），完成后打第一个公开 tag。
2. P1-1 ~ P1-3（文档一致性，成本低、收益直观）。
3. P1-5 ~ P1-8（构建元数据 + 删死代码 + 类型收紧）。
4. P1-9 ~ P1-10（skill 真相源 + 测试质量）。
5. P2（重构），须有测试兜底后再动。

## 事实与推测说明

- 本文所有"问题/证据"均来自源码、配置、文档或实跑命令，属**事实**。
- 唯一**推测**项：`bun-types@1.4.1` 面向 Bun 1.4 类型，而 README 要求 Bun 1.3+，在 Bun 1.3 环境 typecheck 是否引用不存在的 API，需实测确认（本机 Bun 1.3.14 当前通过）。
- 未执行任何 git 提交、推送或合并；本文件仅为待办记录。
