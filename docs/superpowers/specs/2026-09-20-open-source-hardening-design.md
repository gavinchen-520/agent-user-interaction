# Agent UI Interaction 开源化与运行时加固设计

## 目标

将 Agent UI Interaction 整理为可公开发布的 MIT 开源项目，并修复二次审查确认的运行时安全、会话生命周期、磁盘恢复和真实用户链路问题。完成后，干净 clone 可以安装、构建、测试和运行；外部监听、磁盘存储和页面提交的边界均有明确行为与测试。

## 非目标

- 不把 capability URL 改造成完整的多用户身份认证系统。
- 不在本轮引入数据库、远程存储或多进程横向扩展。
- 不进行与用户流程无关的大规模 UI 重设计。
- 不为了“更漂亮”重写所有 runtime 文件；只有影响正确性、可测试性或发布维护的拆分才实施。

## 安全模型

默认配置保持 loopback、随机端口、memory 存储。session URL 是 bearer capability：知道完整 URL 的持有者拥有该 session 的操作能力。项目必须：

- 不在公开示例中监听 `0.0.0.0`。
- 不在日志、错误消息和 retained 文件中无必要泄露 token。
- 外部监听必须显式配置 `publicBaseUrl`，并在文档中说明 TLS、代理和日志脱敏要求。
- HTML 页面在 sandbox 和 CSP 下运行；静态 HTML 检查是输入护栏，不宣称是完整安全沙箱。

## 设计

### 1. 发布基线

- 添加 MIT `LICENSE`，根包和插件包声明 `license: "MIT"`。
- 将本机 `opencode.json` 改为脱敏的 `opencode.json.example`，忽略实际配置；删除空 `.mcp.json`。
- 统一 package 元数据、Bun/Node/Playwright 版本要求和官方 registry lockfile。
- 新增 GitHub Actions，至少运行 typecheck、Biome、单元测试、构建和 Chromium E2E。
- `skills/html-interaction/` 作为唯一跟踪真相源，运行时副本通过脚本或测试校验同步。

### 2. 配置与路径

- `resolveConfig` 对所有数值执行有限、整数、范围校验，对布尔值严格校验，对 `publicBaseUrl` 限制为 HTTP(S)。
- 插件初始化时使用 OpenCode 的 workspace directory/worktree 解析相对 dataDir、日志和 htmlFile；绝对路径保持不变。
- 非 loopback hostname 在缺少 `publicBaseUrl` 时启动失败，并给出可操作错误。

### 3. 请求与页面身份

- `/submit` 使用有上限的流式 body 读取，禁止依赖 `Content-Length` 作为唯一防线。
- bridge 注入时接收配置的 payload 上限；页面、wrapper、server 对完整 envelope 使用一致的限制。
- 页面更新使用不可复用的 page identity（pageId + pageVersion），旧 iframe 的消息不能继承新页面身份；wrapper 强制校验版本/身份。
- wrapper 提交失败可以重试；版本轮询在 session 终态、404/410、页面卸载时停止，并在页面隐藏时退避或暂停。

### 4. 会话生命周期

- memory 和 disk 模式统一运行 TTL 清理。
- end、TTL、update、dispose 同时清理 submission waiter 和 ready waiter。
- `messageCreatedAt` 在 OpenCode session 删除和插件 dispose 时清理。
- retained 只保留明确允许的页面原件，结束时删除 pending 和可复用 token；retained 清理期限和容量策略写入配置/文档。

### 5. 磁盘持久化

- data/session 目录使用 `0700`，数据和临时文件使用 `0600`。
- `meta.json` 和 `pending.json` 使用运行时 schema 校验；检查目录名、sessionId、状态、版本、时间戳和 JSON 值。
- 引入 `schemaVersion`；无法迁移的旧格式隔离或删除，不得以类型断言进入状态机。
- page 文件按版本写入，meta 原子指向当前页面；恢复只读取 meta 指向的版本。
- 提交状态和 pending 数据使用一致性标记或单一状态文件，恢复时选择完整旧状态或完整新状态。
- 明确同一 dataDir 仅允许单实例使用；本轮至少增加启动锁或可靠的冲突检测。

### 6. 测试与文档

- 所有行为修复遵循“失败测试 -> 最小实现 -> 全量验证”。
- 增加 chunked body、配置非法值、损坏磁盘文件、权限、旧 iframe、TTL、retained、重试和真实 bridge E2E。
- README、page protocol、skill 文档和设计文档以源码类型/配置为准，历史计划标记为 superseded。
- E2E 至少有一条通过插件默认导出、工具创建 session、运行时注入 bridge、Chromium sandbox 页面和提交结果的完整链路。

## 兼容与迁移

- 内存 session 没有持久化兼容问题。
- 磁盘格式新增 `schemaVersion`。当前未发布版本的旧 meta 若无法安全推断，按损坏 session 处理并删除/隔离，不尝试猜测恢复。
- `retainPages` 的语义收紧为“保留 HTML 原件”，不再把 pending、token 和可恢复状态作为默认保留内容。
- capability URL 协议不增加向后兼容的第二套认证方式；变更只收紧错误配置和旧页面身份校验。

## 验收标准

1. `bun install --frozen-lockfile`、`bun run check`、`bun run build` 和 `bun run test:e2e` 在干净 clone 通过。
2. MIT LICENSE、脱敏配置、CI 和 package 元数据可被 GitHub 正确识别。
3. 超大无 `Content-Length` body 不会被完整读入内存。
4. 非法配置、非法 meta/pending、错误权限和过期 memory session 均有确定行为。
5. 旧 iframe、网络失败重试、session 结束后的 waiter/轮询均有回归测试。
6. 真实插件装配和 `submitToAgent` bridge 在 Chromium 中提交成功。
7. 现有正常路径测试保持通过，未引入未记录的行为变更。
