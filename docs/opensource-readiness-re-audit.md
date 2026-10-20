# 开源化与全库二次审查报告

> 审查目的：针对项目开源诉求，对上一份 `docs/opensource-readiness-todo.md` 的改动范围逐项复核，并寻找新的安全、生命周期、发布和工程化问题。
>
> 审查范围：当前工作树的 `opencode-v1-aui/src`、`tests`、`skills/agent-user-interaction`、根配置、README、docs，以及相对于 HEAD `634d33a` 的全部未提交改动和未跟踪文件。
>
> 审查结论：当前源码的正常闭环测试通过，但仍不适合直接公开发布。上一份清单中的 P0/P1 项仍然有效；本次新增 17 项，其中 8 项应在公开发布前处理。

## 一、验证基线

本轮实际执行：

- `bun run typecheck`：通过。
- `bun run test`：127 pass，0 fail，19 个文件。
- `bun run build`：通过，生成 `opencode-v1-aui/dist/index.js`。
- `bun run test:e2e`：1 pass，0 fail。
- `git diff --check 634d33a`：通过。
- `bun run check`：仍失败，原因是未跟踪的空文件 `.mcp.json` 被 Biome 扫描；测试阶段未被执行。

重要判断：现有测试证明了正常路径，不等于证明了发布快照、外部监听、损坏磁盘状态、异常网络和多工作区场景。以下问题均以生产代码路径为依据，未把单纯的风格偏好列为缺陷。

---

## 二、必须在公开发布前处理

### R-01 提交 body 可以在大小检查前被完整读入

- **级别：High，安全/可用性问题**
- **位置：** `opencode-v1-aui/src/runtime/server.ts` 的 `/submit` 路由，约 `147-162` 行。
- **事实：** 代码只在 `Content-Length` 已知且大于限制时提前拒绝；随后无条件执行 `await request.arrayBuffer()`，读完全部请求体后才检查 `body.byteLength`。
- **触发条件：** 外部监听模式下，持有 capability URL 的客户端发送没有 `Content-Length`、非法 `Content-Length`，或伪造较小 `Content-Length` 的 chunked 超大请求。
- **影响：** `maxPayloadBytes` 不是实际内存上限，攻击者可以让服务为单个请求分配远大于配置限制的内存，产生内存峰值甚至 OOM。
- **现有测试缺口：** 测试通过 `fetch` 发送请求，通常自动生成正确的 `Content-Length`，没有 chunked/缺失长度请求。
- **改动方向：** 使用带上限的流式读取，累计字节超过限制立即中止；对缺失、非法、负数长度采用保守策略；同时考虑请求读取超时和服务端最大硬上限。
- **验收：** 无 `Content-Length` 的超限请求在达到上限时被拒绝，进程内存不会随完整 body 增长；正常小请求仍可提交。

### R-02 页面更新存在旧 iframe 提交冒充新版本的窗口

- **级别：High，页面版本校验缺陷**
- **位置：** `opencode-v1-aui/src/browser/wrapper.ts` 的 `applyVersion`、message handler；`opencode-v1-aui/src/runtime/pageRuntime.ts` 的 bridge。
- **事实：** `applyVersion` 在新 iframe 完成加载前就更新 `config.pageVersion` 和 `config.pageId`；bridge 发出的 payload 不含 `pageVersion`；wrapper 对 `payload.pageVersion` 的校验是可选的。旧 iframe 在导航切换窗口内发送的消息可能被 wrapper 用新的 pageId/pageVersion 组装成提交 envelope。
- **影响：** 旧页面产生的数据可能绕过预期的 `STALE_PAGE` 保护，被服务端当作新页面提交。该问题依赖消息排队和更新时序，当前测试没有覆盖。
- **改动方向：** 每次页面版本注入不可复用的页面 nonce，bridge 必须携带版本或 nonce；wrapper 必须强制校验来源页面身份，不能接受缺失版本的 payload；在新 iframe load 完成前不要切换可提交配置。
- **验收：** update 后旧 iframe 延迟发送消息始终返回 stale/被 wrapper 丢弃；只有新 iframe 的消息能提交。

### R-03 磁盘 session 文件未显式限制权限

- **级别：High，本地敏感数据暴露**
- **位置：** `opencode-v1-aui/src/runtime/storage.ts` 的 `mkdirSync`、`writeFileSync`、`atomicWrite`。
- **事实：** data directory、session directory、`meta.json`、`page.html`、`pending.json` 和临时文件均未指定权限，实际权限由系统默认值和 umask 决定。当前审查环境观察到目录为 `0755`、文件为 `0644`。
- **影响：** 同一机器上的其他本地用户或低权限进程可能读取 `meta.json` 中的 bearer token、页面 HTML 和 pending 用户数据，进而提交或读取 session。
- **改动方向：** data/session 目录显式使用 `0700`，文件和临时文件使用 `0600`；确认 `rename` 后权限仍然受限；文档说明 dataDir 是敏感目录。
- **验收：** Linux/macOS 下新建目录和文件的权限均符合预期；已有宽权限目录不会被静默当作安全目录继续使用，或启动时给出明确诊断。

### R-04 磁盘恢复直接信任 `meta.json` 与 `pending.json`

- **级别：High，持久化完整性问题**
- **位置：** `storage.ts` 的 `readMeta/readPending`；`store.ts` 的 `restoreFromDisk`，约 `299-333` 行。
- **事实：** JSON 解析后通过类型断言转为 `SessionMetaFile` 或 `SubmissionOutput`，没有运行时 schema 校验；没有验证目录名与 `meta.sessionId` 一致，也没有严格验证 pageId、pageVersion、token、时间戳、status 和 pending envelope。
- **触发条件：** dataDir 中存在损坏文件、旧版本文件、手工修改文件，或具有 dataDir 写权限的本地进程伪造文件。
- **影响：** 恢复出不可访问或错误关联的 session，使用错误 token/pageVersion，或者 `waitSubmission` 原样返回非法 pending 数据。损坏数据还可能污染后续清理和路由行为。
- **改动方向：** 使用 Valibot 或等价 schema 校验 meta/pending；要求 `meta.sessionId === 目录名`、关键字符串非空、pageVersion 为正整数、时间戳有限、状态属于受支持集合；非法目录隔离/删除并写诊断日志。
- **验收：** 对缺字段、错误类型、目录不匹配、非法状态、非法 pending 的 fixture 均不恢复为活 session，且启动过程不中断。

### R-05 页面、pending 和 meta 的多文件写入不是事务

- **级别：High，崩溃恢复一致性问题**
- **位置：** `opencode-v1-aui/src/runtime/store.ts` 的 `submitSubmission/updateSession`；`storage.ts` 的各个原子写函数。
- **事实：** 单个文件通过临时文件 + rename 写入，但相关文件之间不是一个事务：
  - `submitSubmission` 先写 `pending.json`，再写 `meta.json`；
  - `updateSession` 先写新的 `page.html`，再写 `meta.json`；
  - `createSession` 先写 page，再写 meta。
- **影响：** 进程在两次写入之间崩溃时，可能恢复为旧 meta + 新页面、已写 pending + 未标记 submitted，或已标记 submitted + 缺失提交数据。页面版本保护和唯一提交语义会失真。
- **改动方向：** 页面按版本写入 `page-<version>.html`，meta 最后原子指向当前文件；提交状态和 pending 放入同一个版本化状态文件，或使用 WAL/提交标记；恢复时按一致性规则回滚或重放。
- **验收：** 对每个写入步骤注入故障后重启，恢复结果只能是旧状态或新状态之一，不得出现跨版本组合。

### R-06 内存模式没有主动 TTL 清理

- **级别：High，长期运行内存泄漏**
- **位置：** `opencode-v1-aui/src/runtime/store.ts` 的 cleanup timer 与 `getRequiredSession`；`server.ts` 的 `runtime.getSession`。
- **事实：** cleanup timer 只在 `storage` 存在时创建。内存模式没有后台清理；HTTP server 直接调用 `runtime.getSession`，不会经过带 TTL 检查的 `getRequiredSession`。
- **触发条件：** 默认 memory 模式创建 session 后，用户不再调用工具，也没有后续 HTTP 请求触发其他清理路径。
- **影响：** session、HTML、token 和状态会一直保留，`countLiveSessions()` 也不会自动下降，长时间运行的 OpenCode 进程内存持续增长。
- **改动方向：** memory/disk 两种模式统一启动清理器；或让 server 使用经过 TTL 检查的查询接口；清理时同时唤醒 submission/ready waiter。
- **验收：** 使用短 TTL 创建 session，等待清理周期后内存和磁盘模式都删除过期 session，waiter 收到稳定的终止错误。

### R-07 配置运行时校验允许非法数值和错误类型

- **级别：High，配置边界缺陷**
- **位置：** `opencode-v1-aui/src/config.ts:99-110`。
- **事实：** `sessionTtlMs` 和 `defaultTimeoutMs` 只检查 `typeof number` 和 `> 0`，因此 `NaN`、`Infinity` 可能通过；`logging.enabled` 没有检查是否为 boolean；`publicBaseUrl` 只检查能否被 `URL` 解析，`ftp://...` 等非 HTTP(S) scheme 也会通过。
- **影响：** 非法配置可能让 TTL 永不过期、超时逻辑异常，或生成浏览器无法使用的 URL；由于配置来自 JSON，入口的 TypeScript 类型不能提供运行时保护。
- **改动方向：** 所有时长使用 `Number.isFinite` + 正整数校验；明确 `logging.enabled`、`openBrowser`、嵌套配置类型；public URL 只允许 `http:`/`https:`，并校验 origin/路径规则。
- **验收：** `NaN`、`Infinity`、小数、错误布尔值、`ftp://` 配置均在启动时返回明确错误。

### R-08 retained 页面会长期保留 token 和用户提交数据

- **级别：High，数据留存/隐私问题**
- **位置：** `opencode-v1-aui/src/runtime/store.ts:276-289`、`storage.ts`。
- **事实：** `retainPages: true` 时，结束 session 只写入终态和 retained 标记，不删除 session 目录；目录内仍可能包含 `meta.json`（token、状态、state）和 `pending.json`（用户提交数据）。当前 retained 目录又跳过 TTL 清理。
- **影响：** “保留页面原件”实际变成长期保留 bearer token 和交互数据；磁盘增长无自动上限，敏感数据生命周期超过用户预期。
- **改动方向：** retained 模式只保留明确需要的 HTML 原件；结束时删除 pending、清理或轮换 token/state；增加 retained TTL、容量上限和显式清理命令；README 明确保留内容和保留期限。
- **验收：** retain 后目录内容只包含公开允许保留的文件；token 不再可用于访问已结束 session；清理策略可测试并可被用户观察。

---

## 三、部署与运行边界问题

### R-09 `publicBaseUrl` 与反向代理 Host 校验冲突

- **级别：Medium，部署可用性问题**
- **位置：** `server.ts:68-76` 的 authority 校验；`config.ts:88-97` 的 public URL 配置。
- **事实：** server 将请求 `Host` 的端口强制要求等于内部监听端口。典型 TLS 反向代理场景是外部 `https://host:443` 转发到内部 `127.0.0.1:18000`，若代理保留外部 Host，请求会被 `INVALID_AUTHORITY` 拒绝。README 同时建议使用 TLS 反向代理，但没有说明必须改写 Host。
- **另一个事实：** `hostname: "0.0.0.0"` 且缺少 `publicBaseUrl` 时，返回 URL 可能使用 `http://0.0.0.0:<port>`，用户无法从远端访问。
- **改动方向：** 明确定义 trusted proxy 模式；按配置的 public authority 校验，或提供允许的外部 authority 列表；非 loopback 监听时要求显式 publicBaseUrl；文档给出代理的 Host/forwarded 配置。
- **验收：** direct access、TLS reverse proxy、局域网直连三种场景分别有集成测试，错误配置在启动时而不是首次请求时失败。

### R-10 bridge 的 payload 上限没有使用插件配置

- **级别：Medium，配置行为不一致**
- **位置：** `pageRuntime.ts:6`、`index.ts:28-44`、`htmlSession.ts` 的注入调用、`wrapper.ts:82/140`。
- **事实：** 页面注入 bridge 固定使用 `64 * 1024`；wrapper 和 server 使用配置传入的 `maxPayloadBytes`。当配置大于 64KiB 时页面先拒绝，当配置小于 64KiB 时 bridge 可能返回 `true` 但 wrapper/server 静默拒绝。
- **影响：** 用户配置的上限没有贯穿页面、wrapper、HTTP 和 runtime，提交失败原因难以诊断。
- **改动方向：** 注入 bridge 时传入配置上限；统一计算完整 envelope 的字节数和 JSON 兼容语义；失败时给页面可见状态。
- **验收：** 自定义上限下，页面 bridge、wrapper、server 对同一边界给出一致结果。

### R-11 资源路径绑定进程 CWD，可能跨工作区读写错误目录

- **级别：Medium，多工作区部署问题**
- **位置：** `opencode-v1-aui/src/index.ts` 未使用插件输入的 directory/worktree；`tools/htmlSession.ts`、`storage.ts`、`logging.ts` 使用相对路径。
- **事实：** 相对 `htmlFile`、dataDir 和日志路径最终依赖 `process.cwd()`，而不是 OpenCode 当前工作区。
- **影响：** 从不同目录启动 OpenCode 或同时管理多个项目时，HTML 文件、session 数据和日志可能落到错误项目或被多个项目共享。
- **改动方向：** 在插件初始化阶段以 `PluginInput.directory` 或 `worktree` 解析项目相对路径；工具输入的 htmlFile 按工具上下文目录解析；绝对路径保持不变。
- **验收：** 在两个不同工作区启动 runtime，确认各自数据目录、日志和 htmlFile 隔离。

### R-12 runtime 销毁没有清理所有 ready waiter

- **级别：Medium，资源生命周期问题**
- **位置：** `store.ts:84-88`、`276-296`、`345-367`。
- **事实：** `clearSessionMemory` 只清 `waiters`，不清 `readyWaiters`；只有 `dispose` 才清理 ready waiter。end session 和 TTL 清理时，浏览器迟到的 `/ready` 仍可能唤醒原 waiter。
- **影响：** 结束 session 后 `waitReady` 仍可等待完整超时；大量打开但未就绪的页面会积累无意义 waiter。
- **改动方向：** 统一 session 清理函数，同时清理 submission/ready waiter，并使用结构化的 `SESSION_ENDED` 错误。
- **验收：** end、TTL、update、dispose 四种路径都能立即结束对应 ready waiter。

### R-13 wrapper 提交失败后永久禁止重试，并且轮询不会停止

- **级别：Medium，用户体验与资源问题**
- **位置：** `wrapper.ts:103-124`、`134-148`。
- **事实：** POST 前设置 `submitted = true`，失败分支只显示“提交失败”而不恢复；`setInterval(pollVersion, 700)` 没有保存 timer，也不因 404/410、页面关闭或 session 结束停止。
- **影响：** 一次瞬时网络错误会让用户只能重建页面；关闭 tab 后仍持续请求已删除 session，多个历史 tab 会产生持续低速负载。
- **改动方向：** 失败后恢复可提交状态并提供明确重试；保存并清理 timer；session 终态/404/410 停止轮询；页面隐藏时暂停或退避。
- **验收：** 模拟一次 500 后第二次提交成功；session 结束后轮询停止；页面卸载不留下 timer。

### R-14 `messageCreatedAt` 是无界 Map

- **级别：Medium，长期运行内存增长**
- **位置：** `opencode-v1-aui/src/index.ts:47-70`。
- **事实：** assistant 消息事件持续写入 `messageCreatedAt`；`session.deleted` 只结束 HTML session，没有删除对应的 OpenCode session ID；dispose 也没有清空该 Map。
- **影响：** 长时间运行的 OpenCode 进程会保留所有历史 session ID 和时间戳。
- **改动方向：** session 删除事件中删除对应 key；dispose 清空；或使用带 TTL/容量上限的缓存。
- **验收：** 删除 OpenCode session 后 Map 不再保留对应项，dispose 后无残留。

---

## 四、安全边界与测试补强项

### R-15 页面 CSP 未明确禁止导航

- **级别：Medium，需验证的安全边界**
- **位置：** `server.ts` wrapper/page CSP，约 `107-120` 行。
- **事实：** 页面 CSP 包含 `connect-src 'none'`，但没有 `navigate-to 'none'`。sandbox 只使用 `allow-scripts`，对链接、`location` 和表单导航的最终行为没有 Chromium E2E 断言。
- **影响：** 生成页面可能通过导航把用户输入带到外部 URL，违反技能文档中“不访问外部资源”的预期；是否能在当前 sandbox/CSP 组合下成功导航需要浏览器验证。
- **改动方向：** 若产品边界要求禁止页面导航，补 `navigate-to 'none'` 或等效限制，并增加外部请求监测 E2E；不要只依赖静态正则。
- **验收：** 链接、location、表单导航均不会产生外部请求；若允许导航，则必须更新安全文档和威胁模型。

### R-16 HTML 静态校验可被实体/动态构造绕过，也可能误判 bridge

- **级别：Medium，校验可靠性问题**
- **位置：** `runtime/htmlValidation.ts`；`pageRuntime.ts:66-80`。
- **事实：** HTML 校验主要使用正则；例如实体编码的 `type=&#x73;ubmit` 在 DOM 中语义等于 submit，但源码正则可能不命中。`hasSubmitBridgeDefinition` 和 `referencesSubmitToAgent` 也直接扫全文，注释或字符串中的 `submitToAgent` 可能让注入被跳过。
- **影响：** 静态门禁可能误报或漏报；bridge 误判会导致页面实际没有可用的 `submitToAgent`。
- **改动方向：** 使用 HTML parser 检查元素属性；对 script 使用明确的运行时检测或 AST；至少新增实体编码、注释、字符串、动态属性访问的 fixture，并在文档中声明静态校验不是安全沙箱。
- **验收：** 生产校验与浏览器解析后的 DOM 语义一致，bridge 注入不受注释/字符串干扰。

### R-17 持久化格式缺少 schema version 和单实例约束

- **级别：Low/Medium，发布后演进风险**
- **位置：** `storage.ts` 的 `SessionMetaFile`；`store.ts` 的 restore；dataDir 配置。
- **事实：** `meta.json` 没有 schema version；多个 runtime/进程可以同时打开同一个 dataDir，没有锁、租约或实例 ID。
- **影响：** 未来字段/状态演进无法可靠迁移；多个 OpenCode 进程共享目录时可能互相恢复、覆盖或清理 session。
- **改动方向：** 增加 `schemaVersion` 和迁移策略；启动时对 dataDir 加锁或明确拒绝第二实例；README 把“单实例 dataDir”写成硬约束。
- **验收：** 新旧 meta fixture 可迁移；第二个 runtime 使用相同 dataDir 时得到明确错误，而不是静默互相覆盖。

---

## 五、上一份清单的复核结论

### 仍然确认有效，优先级不下调

- 无 `LICENSE` 和 package license 字段。
- 空 `.mcp.json` 导致 `bun run check` 失败。
- 当前工作树不是可发布快照，新增源码/测试/资产尚未全部跟踪。
- 无 GitHub Actions CI。
- `opencode.json` 是未脱敏的本机配置，且 README 示例存在 `0.0.0.0` + `127.0.0.1` 矛盾。
- `bun.lock` 使用 `registry.npmmirror.com`。
- `page-protocol.md` 错误码不完整且 `PAYLOAD_TOO_LARGE` 描述错误。
- `retainPages`、历史 docs、个人绝对路径和构建元数据需要修正。
- e2e 绕过插件装配和真实注入 bridge。
- wrapper 的 `createWrapperMessageHandler` 是生产未使用的死代码，需决定删除还是让生产路径复用。

### 需要调整表述或优先级

- “文件写入原子”只能描述单文件 rename，不能描述 session 状态事务；应增加本报告 R-05。
- “retained 页面只保留原件”不符合当前实现，应按 R-08 重新定义留存内容和清理策略。
- “TTL 有清理”只对 disk 模式成立，memory 模式需按 R-06 修复。
- “配置已校验”不够精确，必须补有限数值、布尔值、URL scheme 等运行时校验。

---

## 六、建议的实际改动分组

### 发布前阻断组

1. LICENSE、脱敏配置、`.mcp.json`、lockfile、未跟踪文件和 CI。
2. R-01 body 流式限流。
3. R-03 磁盘权限。
4. R-04 恢复 schema 校验。
5. R-06 memory TTL。
6. R-07 配置运行时校验。
7. R-08 retained 数据清理与生命周期定义。
8. R-10 bridge payload 配置贯通。

### 发布前强烈建议组

1. R-02 页面版本/旧 iframe 身份校验。
2. R-05 跨文件持久化一致性。
3. R-09 反向代理与 publicBaseUrl 行为。
4. R-11 工作区路径解析。
5. R-12 ready waiter 清理。
6. R-13 wrapper 重试与轮询退避。
7. 真实插件装配 + 注入 bridge 的 Chromium E2E。
8. 损坏 meta/pending、chunked body、磁盘权限、崩溃窗口专项测试。

### 发布后重构组

1. R-15 页面导航边界和 CSP E2E。
2. R-16 HTML parser/AST 校验。
3. R-17 持久化 schema migration 与 dataDir 单实例锁。
4. `store.ts` 的生命周期、持久化、清理职责拆分。
5. 异步化磁盘存储接口，降低同步文件 API 对事件循环的阻塞。

## 七、当前结论

当前状态不是“逻辑不可用”，而是“正常路径可用、异常边界和公开发布治理尚未完成”。

在公开 GitHub 仓库前，至少应完成上一份清单的 P0，加上本报告 R-01、R-03、R-04、R-06、R-07、R-08、R-10，并补真实插件装配 E2E。否则会同时存在发布快照不完整、外部请求可造成内存压力、磁盘敏感数据暴露、损坏状态可污染恢复、默认 memory session 不清理和配置行为不一致等问题。

二次审查阶段未修改源码；随后按本报告实施改动，仍未执行 commit、push 或 merge。

## 八、本轮实施状态

本轮后已实际完成：

- MIT LICENSE、脱敏 `opencode.json.example`、CI、package license/engine 元数据和官方 npm registry lockfile。
- 配置有限数值、布尔值、HTTP(S) URL 和非 loopback public URL 校验。
- workspace 相对路径解析、流式 request body 限流、payload 上限贯通 bridge/wrapper/server。
- bridge 强制携带 `pageVersion`，旧 iframe 提交被拒绝；提交失败可重试，轮询支持终止清理。
- memory/disk TTL 清理、ready waiter 清理、OpenCode session 时间缓存清理。
- 磁盘权限、`schemaVersion`、meta/pending 基础 schema 校验、目录 sessionId 校验、版本化页面文件。
- retained 模式删除 pending、清理 state 并轮换 token。
- 真实生产工具、注入 bridge、sandbox iframe、Chromium 提交的 E2E 链路。
- 错误码、CSP 导航策略、README、page protocol 和历史文档状态修正。

仍未在本轮实现、需单独立项：

- `pending.json` 与 `meta.json` 的统一事务日志；当前版本化 page 文件已避免 page/meta 的旧页面错配，但提交状态仍依赖恢复时的文件组合。
- dataDir 的跨进程锁/租约；当前仍应按单实例部署。
- 基于 HTML parser/AST 的完整静态校验；当前仍是启发式校验，sandbox/CSP 是最终边界。
- retained 目录的自动 TTL、容量上限和专用清理命令；当前需要人工清理。

本轮验证：`bun run check` 139 pass、`bun run build` 通过、Chromium E2E 1 pass、`bun install --frozen-lockfile` 通过、`bun pm pack --dry-run --cwd opencode-v1-aui` 仅包含 `package.json` 与 `dist/index.js`。本轮未执行 commit、push 或 merge。
