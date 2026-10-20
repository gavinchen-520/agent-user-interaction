# agent-user-interaction 磁盘存储与外部访问改造设计方案

> 状态：Superseded。历史设计记录；当前实现与发布约束以 README、`docs/superpowers/specs/2026-09-20-open-source-hardening-design.md` 和源码为准。

## 1. 背景与需求

当前 agent-user-interaction 插件的运行时是**纯内存 + 强制 loopback** 的形态：

- HTML 内容只保存在进程内存的 `Map` 中，无任何磁盘持久化，服务重启即全部丢失。
- HTTP 服务强制绑定 loopback 地址（`127.0.0.1` / `localhost` / `::1`），仅本机可访问。
- 端口随机分配（`port ?? 0`），每次启动都不同。

改造目标（按用户需求逐条确认）：

1. **磁盘为真相源**：生成的 HTML 页面内容落磁盘，不再依赖内存持有，进程可无状态化重启。
2. **会话结束即删除**：会话终止后删除对应的磁盘文件，不留残留。
3. **固定端口、可对外访问**：服务可绑定非 loopback 地址并配置固定端口，供多用户通过各自 IP 访问。
4. **不配置 `allowedOrigins`**：多用户系统中客户端 IP 不固定，无法预枚举来源，访问控制改由其它机制承担。
5. **文件型 HTML 不限制大小**：模型通过文件路径提供 HTML 时，突破 64KiB 上限；内联字符串模式仍保留 64KiB。

## 2. 设计目标与非目标

### 2.1 目标

- 进程重启后，未终止的会话可恢复，已分发给用户的页面 URL 不失效（固定端口 + 稳定公网地址）。
- 会话结束（`end_html_session`、opencode 会话删除联动、TTL 过期）后磁盘文件被删除。
- 服务可绑定 `0.0.0.0` 并配置固定端口对外提供服务。
- 模型可用文件路径交付任意大小的页面，突破 64KiB 工具参数限制。

### 2.2 非目标

- **不做用户身份认证与多用户隔离**。访问控制退化为 capability URL 模型（见第 9 节），这是本方案的明确边界，不是遗漏。
- **不做 TLS**。HTTP 明文传输，公网部署需前置 TLS 反向代理（nginx/caddy），插件自身不处理。
- **不做多实例横向扩展**。waiter 是进程内 Promise，多实例共享磁盘无法保证提交唤醒到正确的实例，本轮维持单实例。
- **不改提交方向（浏览器→模型）的 64KiB 限制**。该限制保护的是模型上下文，与页面展示方向的限制目的不同。

## 3. 决策记录

以下两项需求在讨论中未获得用户逐字确认，按推导默认拍板，若与预期不符需回退调整：

| 决策 | 结论 | 依据 |
|---|---|---|
| 落盘动机 | **重启恢复**，而非审计留存 | 用户要求「会话结束即删除」，排除了留存目的；落盘唯一价值在于进程无状态化 |
| dispose 语义 | **dispose 不删除非终态 session 的磁盘文件** | 若 dispose 删除全部，重启恢复即失去意义；dispose 只停 server，磁盘留给下次启动恢复 |

## 4. 总体架构

改造保持 `HtmlRuntime` 接口（`src/runtime/types.ts:102-114`）**不变**，把 `store.ts` 内部的双 `Map` 实现替换为「磁盘真相源 + 内存索引缓存」，工具层与 server 层对 runtime 的调用方式零改动。

```
┌─────────────────────────────────────────────────────────┐
│  tools/htmlSession.ts   server.ts（路由/CSP/校验）        │
│              │                        │                 │
│              ▼                        ▼                 │
│           HtmlRuntime 接口（types.ts，接口不变）          │
│              │                                          │
│              ▼                                          │
│   store.ts（内存索引缓存 + waiter 注册表，进程内）        │
│              │                                          │
│              ▼（写穿 / 读穿 / 恢复）                      │
│   storage.ts（磁盘适配器：meta.json / page.html / pending.json）│
└─────────────────────────────────────────────────────────┘
```

**内存里保留什么（澄清「不需要内存」）**：

| 数据 | 位置 | 原因 |
|---|---|---|
| waiter 注册表 | 只能内存 | 它是 `Promise` 事件式阻塞的注册表，无法序列化，是进程内机制 |
| 元数据索引（meta 缓存） | 内存缓存 + 磁盘写穿 | 每次请求都要校验 token/pageVersion/状态，高频小数据，缓存避免每请求读盘 |
| HTML 正文 | **纯磁盘读穿** | 页面可达数 MB，服务时用 `Bun.file()` 流式返回，不驻留内存 |
| pendingSubmission | 磁盘 | 无 waiter 时到达的提交必须落盘，否则重启静默丢失 |

结论：**完全零内存做不到，也不必要**。正确目标是「进程无状态化」——所有可恢复状态落盘，重启后从磁盘重建；仅不可序列化的 waiter 留在进程内。

## 5. 配置设计

### 5.1 PluginOptions 结构

扩展 `src/index.ts:7-9` 的 `HtmlInteractionPluginOptions`：

```ts
export type HtmlInteractionPluginOptions = {
  openBrowser?: OpenBrowserOption; // 已有，保持不变
  storage?: {
    mode?: "memory" | "disk";      // 默认 "memory"，向后兼容
    dataDir?: string;              // 默认 ".opencode/html-sessions"（相对插件进程 cwd）
    maxPageFileBytes?: number;     // 文件型页面大小上限，默认 10 * 1024 * 1024
  };
  server?: {
    hostname?: string;             // 默认 "127.0.0.1"
    port?: number;                 // 默认 0（随机）；固定端口须为 5 位数（10000–65535）
    publicBaseUrl?: string;        // 对外可访问地址，默认取 server.url
  };
  sessionTtlMs?: number;           // 透传给 RuntimeOptions
  defaultTimeoutMs?: number;       // 透传给 RuntimeOptions
  maxPayloadBytes?: number;        // 透传给 RuntimeOptions
};
```

### 5.2 opencode.json 形态

SDK 类型 `Config.plugin?: Array<string | [string, PluginOptions]>`（`@opencode-ai/plugin/dist/index.d.ts:48-50`），支持数组元组传参：

```json
{
  "plugin": [
    ["./opencode-v1-aui", {
      "storage": { "mode": "disk", "dataDir": ".opencode/html-sessions" },
      "server": { "hostname": "0.0.0.0", "port": 18000, "publicBaseUrl": "http://192.168.1.10:18000" }
    }]
  ]
}
```

### 5.3 前置修复：options 管道接线

当前默认导出**丢弃**了 opencode 传入的 options（`src/index.ts:66`）：

```ts
const plugin: Plugin = createHtmlInteractionPlugin(); // options 被吞掉
```

`createHtmlInteractionPlugin` 返回 `(input) => {...}`，opencode 调用 `plugin(input, options)` 时 options 未透传。修复为：

```ts
const plugin: Plugin = (input, options) =>
  createHtmlInteractionPlugin(options as HtmlInteractionPluginOptions)(input);
```

这是所有配置开关生效的前置条件。

### 5.4 配置校验

新增 `src/config.ts`，用 valibot 校验 `PluginOptions` 并填充默认值。校验规则：

- `server.hostname` 为 string；`server.port` 为 `0`（随机）或 `10000 <= n <= 65535`（5 位数，防与常见服务端口冲突）的整数。
- `storage.mode` 为 `"memory" | "disk"`。
- `publicBaseUrl` 若提供必须是合法 URL（`new URL()` 不抛错）。
- 校验失败在插件启动时抛结构化错误，不静默降级。

## 6. 磁盘存储设计

### 6.1 目录结构

```
<dataDir>/
  html_<uuid>/
    meta.json       # 会话元数据，真相源
    page.html       # 当前版本的 HTML 原文
    pending.json    # 无 waiter 时到达的提交缓存（可选，存在即有值）
```

`sessionId` 由服务端 `crypto.randomUUID()` 生成（`store.ts:30`），不含路径分隔符，可直接用作目录名，无路径穿越风险。

### 6.2 文件格式

`meta.json`：

```json
{
  "sessionId": "html_<uuid>",
  "opencodeSessionId": "<创建该会话的 opencode 会话 id>",
  "title": "可选标题",
  "pageId": "page_<uuid>",
  "pageVersion": 1,
  "token": "token_<uuid>",
  "status": "waiting",
  "createdAt": 1720000000000,
  "updatedAt": 1720000000000,
  "submittedPageVersion": 1,
  "state": { "可选的 initial state" }
}
```

`pending.json`：直接序列化 `SubmissionOutput`（`types.ts:59-64`）。

### 6.3 原子写与一致性

- 所有写盘一律 `tmp 文件 + rename` 覆盖，避免崩溃留下半截文件。
- **写入顺序**：先写 `page.html`，再写 `meta.json`。`meta.json` 存在视为会话有效。
- **崩溃窗口容忍**（分析结论，不额外处理）：
  - `create` 崩溃：`page.html` 已写、`meta.json` 未写 → 恢复时该目录无 meta，视为孤儿删除。
  - `update` 崩溃：`page.html` 已覆盖、`meta.json` 仍旧 → 恢复后 wrapper 用旧 pageId/version 配新页面内容，提交仍能通过校验，仅版本号归属轻微不一致，可接受。
- `meta.json` 与 `pending.json` 的更新各为独立原子写。

### 6.4 启动恢复流程

`createHtmlRuntime`（disk 模式）启动时执行：

1. `mkdir -p dataDir`。
2. 扫描 `dataDir/html_*` 子目录。
3. 对每个目录：
   - `meta.json` 缺失或 JSON 损坏 → 删除目录（视为崩溃残留）。
   - `status` 为终态 → 删除目录（防御性清理）。
   - `createdAt + sessionTtlMs` 已过期 → 删除目录。
   - `page.html` 缺失 → 删除目录（状态不完整）。
   - 其余 → 载入内存索引；若 `pending.json` 存在则恢复为 `pendingSubmission`。
4. 依据 `opencodeSessionId` 重建 `sessionsByOpenCodeSession` 映射（见 6.6）。

恢复后 URL 与重启前完全一致（固定端口 + publicBaseUrl），token 与 pageVersion 不变，用户已打开的页面不失效。

### 6.5 删除触发点

共 4 处，满足「会话结束即删除」：

| 触发点 | 动作 | 位置 |
|---|---|---|
| `end_html_session` | 删除 session 目录 | `store.ts:174-187` 改造 |
| opencode 会话删除联动 | 同上 | `index.ts:49-56` 已有钩子 |
| TTL 惰性过期 | 标记 expired 并删除目录 | `store.ts:38-45` 改造 |
| 启动孤儿/残留清理 | 删除损坏、终态、过期目录 | 见 6.4 |

### 6.6 关键发现：重启后联动清理失效

`index.ts:30,42-46` 的 `sessionsByOpenCodeSession` 是纯内存 `Map`，重启即丢。若不处理，重启后 opencode 会话删除事件到来时映射为空，无法联动删除，磁盘文件只能靠 TTL 兜底泄漏。

**方案**：`meta.json` 增加 `opencodeSessionId` 字段，启动恢复时重建映射。代价极小，必须做。

### 6.7 TTL 语义

- 现有惰性检查逻辑（`store.ts:38-45`）保留，命中时改为额外删除目录。
- **TTL 从 `createdAt` 算，重启不重置**：长会话跨重启后可能恢复即过期（直接删除）。保持简单，不额外 `touch`。默认 30 分钟（`constants.ts:4`），可经 `sessionTtlMs` 调整。
- 磁盘模式下存在「无人访问的过期目录永久残留」问题（惰性检查只在该 session 被访问时触发）。新增**周期清理**：`setInterval` 每 5 分钟扫描删除 `createdAt + TTL` 已过的目录。这是现状没有的能力，磁盘残留治理需要。

## 7. HTTP 服务改造

### 7.1 绑定地址

移除 `server.ts:57-58` 的强制 loopback 抛错，改为配置驱动：

- 未配置 `hostname` → 默认 `127.0.0.1`（保持现状）。
- 配置 `hostname: "0.0.0.0"` 或具体内网 IP → 直接绑定。

`isLoopback` 函数（`server.ts:44-51`）删除，不再作为硬约束。

### 7.2 固定端口与端口占用

- `port` 直接透传 `Bun.serve`（`server.ts:63` 已有 `options.port ?? 0`）。
- `Bun.serve` 端口占用会 reject，在 `createRuntimeServer` 捕获并抛出结构化错误（含端口号），避免插件静默失败。

### 7.3 publicBaseUrl

`server.url` 在绑定 `0.0.0.0` 时是 `http://0.0.0.0:<port>`，不可被外部访问，所有返回给用户的 URL 必须改写为 `publicBaseUrl`：

- `server.ts:93-94` 的 `new URL(pagePath, server.url)` 改为基于 `publicBaseUrl ?? server.url` 拼接。
- runtime 的 `baseUrl` 用 `publicBaseUrl` 初始化，复用 `setBaseUrl` 批量改写机制（`store.ts:199-204`）。

### 7.4 Host/Origin 校验放宽

现状（`server.ts:66-75`）：要求 `Host === server.url.host` 且 `Origin` 若存在必须同源，否则 403 `INVALID_AUTHORITY`。绑定 `0.0.0.0` 后，外部以 `192.168.x.x:port` 访问，Host 不匹配，全部 403。用户约束下无法枚举 origins，改为：

- **Host 校验**：放宽为「Host 头端口必须等于监听端口」，hostname 不锁定。
- **Origin 校验**：直接删除。

**安全性论证（为什么可接受）**：

- 提交端点已有 `x-runtime-token` 作为 CSRF 主防线（`server.ts:122-123`）：token 是自定义请求头，跨站攻击者受同源策略限制无法读取 wrapper 页面内容拿到 token，无法伪造提交。
- DNS rebinding 理论上可绕过放宽后的 Host 校验，但 rebinding 需要目标 URL（含 122-bit 随机 `sessionId`），不可枚举，实际风险≈0。
- GET 侧（wrapper / page）本无 token 保护，访问控制靠 `sessionId` 不可猜测，与 Host 校验无关。

### 7.5 CSP 与 iframe sandbox

**不变**。page 的 CSP（`server.ts:111-115`：`connect-src 'none'` 等）与 wrapper 的 `iframe sandbox="allow-scripts"`（`wrapper.ts:80`）保持原样。文件型大页面（如内嵌 base64 图片）仍受 `img-src data: blob:` 约束，渲染与安全边界不因大小放开而改变。

## 8. 工具接口改造：inline / file 双模式

### 8.1 参数形态

采用**平铺字段 + 互斥校验**（对模型填参更友好，schema 更简单），而非 discriminated union：

```
create_html_session: { title?, html?, htmlFile?, initialState? }
update_html_session: { sessionId, html?, htmlFile?, state? }
```

校验规则：`html` 与 `htmlFile` 必须恰好提供一个，否则报 `INVALID_ENVELOPE`。

### 8.2 文件型语义：复制而非引用

模型提供 `htmlFile` 路径后，服务端在 `createSession` / `updateSession` 时**把文件内容复制**进 session 目录的 `page.html`：

- **复制而非引用**：session 目录自包含，恢复逻辑统一（`page.html` 恒为当前页面），与 inline 模式落盘路径完全一致；解耦源文件，避免模型后续修改/删除源文件导致页面内容漂移。
- **校验**（复制前一次）：
  - 解析为绝对路径（相对路径相对进程 cwd）。
  - `stat().isFile()` 必须为常规文件。
  - 字节大小 `<= maxPageFileBytes`（默认 10MB）。
  - 不做后缀/内容类型校验：内容是 HTML 即正常，否则只是渲染乱码，无安全问题（CSP + sandbox 兜底）。
- **不做 dataDir 路径限制**：源文件来自模型用 bash 生成的文件（如 `base64 < img | 拼入 html`），可位于工作区任意位置或 `/tmp`。模型本有 bash 读任意文件的权限，多读一个 HTML 文件不扩大权限面。

### 8.3 大小限制矩阵

| 链路 | 限制 | 依据 |
|---|---|---|
| inline HTML（工具参数） | 64KiB 不变 | 保护模型 token 输出链路（`htmlSession.ts:16-21`） |
| file HTML | `maxPageFileBytes`，默认 10MB，可配置 | 防误传巨型文件，放开到实用量级 |
| 提交 payload（浏览器→模型） | 64KiB 不变 | 保护模型上下文（`protocol.ts:88-96`、`server.ts:124-139`、`wrapper.ts:100` 三层保留） |

### 8.4 大小放开的价值

文件模式不只是放开上限，而是解锁**不消耗模型 token 的页面组装路径**：模型用 shell 命令（`base64 < 图片`）把二进制嵌入 HTML 文件，页面可达数 MB，模型 token 消耗接近零。对多用户系统的富媒体页面（图片对比、多图网格）是质变。

## 9. 安全模型与已知边界

对外开放后，系统访问控制模型退化为 **capability URL**：

> 知道 URL = 能看页面 = 能拿到 token = 能提交。

必须明确告知的边界：

1. **无用户身份隔离**：多用户之间无隔离，隔离靠 URL 保密。用户 A 把 URL 转发给 B，B 即可查看 A 的页面并提交。协作场景是 feature，敏感场景（转账金额等）是风险。
2. **URL 即凭证**：`sessionId` 为 122-bit UUID，不可枚举，但会经用户转发、日志、浏览器历史泄露。
3. **明文 HTTP**：token 与页面内容裸奔，公网部署必须前置 TLS 反代。
4. **页面内容本身受保护**：iframe `sandbox="allow-scripts"`（无 `allow-same-origin`）+ CSP `connect-src 'none'`，页面无法发起网络请求或访问父页面，风险集中在 `/submit` 端点。

这些是产品层面需接受的模型，不是改造的阻塞项。

## 10. 生命周期与 dispose 语义

状态机不变（`types.ts:1-10`）。语义变化仅两处：

- **endSession**：除现有「清 waiter + 删内存条目」外，增加删除 session 目录。
- **dispose**（`index.ts:57-61`）：改为**只 `server.stop(true)`，不 endSession**。理由：endSession 会删磁盘文件，违背持久化目的；进程退出 ≠ 会话结束。磁盘文件留给下次启动恢复（终态/过期由恢复流程清理）。

## 11. 向后兼容

- 不配置任何新选项 = 现有行为完全不变（内存 + loopback + 随机端口）。
- `HtmlRuntime` 接口不变，现有测试（`tests/runtime/server.test.ts` 等）除 loopback 强制断言外无需改动。
- `sessionId`/`pageId`/`token` 生成逻辑不变，磁盘结构只影响实现内部。

## 12. 实施计划

| 任务 | 内容 | 工作量 |
|---|---|---|
| 1. options 管道 + 配置 | 修复 `index.ts:66` 透传；新增 `config.ts` 校验与默认值；扩展 `HtmlInteractionPluginOptions` | 0.5 天 |
| 2. 磁盘存储层 | 新增 `storage.ts` 适配器；改写 `store.ts` 为「索引缓存 + 写穿」；实现原子写、恢复、删除、周期清理 | 1-1.5 天 |
| 3. HTTP 服务改造 | 移除 loopback 硬约束；固定端口 + EADDRINUSE 处理；publicBaseUrl 改写；Host 放宽、Origin 删除 | 0.5-1 天 |
| 4. 工具 file 模式 | `html`/`htmlFile` 互斥；复制语义；大小与 isFile 校验 | 0.5 天 |
| 5. 测试 | 见第 13 节 | 1 天 |

合计约 **3.5-4.5 天**。

## 13. 测试计划

- **config**：默认值填充；非法 hostname/port/mode 拒绝；options 透传生效。
- **storage**：create/update/end 的原子性；恢复（正常 / meta 损坏 / 终态残留 / TTL 过期 / pending）；四个删除触发点；重启后 `opencodeSessionId` 映射重建。
- **file 模式**：复制语义；`isFile` 校验；`maxPageFileBytes` 越界拒绝；`html`/`htmlFile` 互斥。
- **server**：固定端口生效；端口占用结构化报错；publicBaseUrl 改写 URL；非 loopback 绑定；Host 端口校验（hostname 不锁）；Origin 缺失不报 403。
- **回归**：现有 `tests/runtime/server.test.ts` 中 loopback 强制断言改为「默认 loopback，配置后放开」。

## 14. 风险与开放问题

| 风险 | 等级 | 说明 |
|---|---|---|
| capability URL 无用户隔离 | 高 | 产品层面需接受，见第 9 节 |
| 明文 HTTP | 高 | 公网需 TLS 反代 |
| 重启后联动清理失效 | 中 | 已通过 `opencodeSessionId` 落盘解决 |
| 磁盘空间泄漏 | 中 | 异常场景靠 TTL + 周期清理兜底 |
| TTL 从 createdAt 算跨重启不重置 | 低 | 长会话跨重启可能恢复即过期，保持简单 |
| 端口占用 | 低 | 固定端口的固有代价，结构化报错即可 |

开放问题：`dataDir` 默认值 `.opencode/html-sessions`（相对进程 cwd）是否合适，取决于部署形态（是否容器化、工作目录是否稳定），实施时可按需调整为绝对路径配置。
