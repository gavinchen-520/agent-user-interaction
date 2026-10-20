# opencode-v2-aui

OpenCode **V2 插件 API** 的 HTML 交互插件，是本项目的**默认入口**。插件 id 为 `agent-user-interaction`，包名为 `opencode-v2-aui`。

它给模型提供四个工具：创建页面、等待提交、更新页面、结束会话。页面由模型现场生成，运行在受限 iframe 中，用户操作后以结构化 JSON 回传。

> 本包**只提供插件，不含 skill**。模型工作流说明是独立的 [`skills/agent-user-interaction`](../skills/agent-user-interaction/README.md) 单元，两者缺一不可。

![选择部署环境](../docs/images/scenario-env-select.png)

---

## 环境要求

- **Bun** `>= 1.3.14`（依赖 `Bun.serve` 与 `Bun.file`）
- **OpenCode** 宿主，需提供 V2 插件 API
- 运行时依赖：`@opencode/plugin@2.0.26`、`valibot@^1.2`

---

## 安装

### 方式一：在本仓库内使用

仓库根是 Bun workspace，本包已在 `workspaces` 中：

```bash
bun install
```

本包**没有独立构建步骤**：`package.json` 的 `exports` 直接指向 `src/index.ts`，由 Bun 从 TypeScript 源码加载。

### 方式二：作为独立目录分发

复制整个 `opencode-v2-aui/` 目录到目标机器（至少包含 `package.json`、`src/`），并保证 `@opencode/plugin` 与 `valibot` 能被解析：

```bash
cd <目标目录>/opencode-v2-aui
bun install
```

---

## 加载

在 OpenCode 配置（`opencode.json` / `opencode.jsonc`）里用 **`plugins` 数组 + 对象**形式注册：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./opencode-v2-aui",
      "options": {}
    }
  ]
}
```

`package` 可以是相对路径或包名；`options` 省略即全部使用默认值。

安装后重启 OpenCode，确认：

1. `create_html_session`、`wait_html_submission`、`update_html_session`、`end_html_session` 出现在工具列表中；
2. 模型能成功创建一个页面并返回 URL。

> 注意：V2 用的是 `plugins`（数组、对象元素），V1 用的是 `plugin`（元组）。写错位置插件不会加载。

---

## 工具

| 工具 | 入参 | 返回 |
| --- | --- | --- |
| `create_html_session` | `title?`、`html?`、`htmlFile?`、`initialState?` | `{ sessionId, pageId, pageVersion, url, pageFilePath? }` |
| `wait_html_submission` | `sessionId`、`timeoutMs?` | `{ kind, data, metadata, pageVersion }` |
| `update_html_session` | `sessionId`、`html?`、`htmlFile?`、`state?` | `{ pageId, pageVersion }` |
| `end_html_session` | `sessionId` | `{ ok }` |

### `create_html_session`

- `html` 与 `htmlFile` **二选一**，都不传返回 `INVALID_TOOL_INPUT`。
- `html` 走内联快通道，上限 `maxInlineHtmlBytes`（默认 64 KiB），超限返回 `HTML_TOO_LARGE_FOR_INLINE`。
- `htmlFile` 读取本地文件并**复制**进 session（不保留源文件引用），相对路径按 `ctx.location.directory` 解析，上限 `maxPageFileBytes`（默认 3 MiB）。
- 返回的 `url` 是 wrapper 页面地址；`openBrowser` 为 `true` 时会自动打开。

### `wait_html_submission`

阻塞等待一次提交。超时抛 `WAIT_TIMEOUT`，调用方取消抛 `WAIT_CANCELLED`。若提交在 wait 之前已到达，会立即消费缓存。

### `update_html_session`

替换同一 session 的页面内容，`pageVersion` 递增。wrapper 轮询版本端点，检测到递增后**自动刷新 iframe**，不需要用户手动刷新。旧版本页面的提交返回 `409 STALE_PAGE`。

### `end_html_session`

结束会话并清理元数据与页面临时目录。重复调用返回 `{ ok: false }`，无副作用。

---

## 页面编写约定

页面里只需要调用：

```js
submitToAgent({ kind: "deploy-target", data: { environment: "production" }, metadata: {} });
```

**不要自己实现 bridge**——插件在 create/update 时会注入唯一实现（含 JSON 校验、大小限制、`postMessage`）。

生产沙箱下必须遵守：

| 禁止 | 原因 |
| --- | --- |
| `type="submit"`、`form.requestSubmit()`、`form.submit()` | iframe 未授予 `allow-forms`，且 CSP 为 `form-action 'none'` |
| `localStorage` / `sessionStorage` / `indexedDB` / `document.cookie` | opaque origin，访问抛 `SecurityError` |
| `alert` / `confirm` / `prompt` | 无 `allow-modals` |
| `window.open` | 无 `allow-popups` |
| `fetch` / `XHR` / `WebSocket` / `EventSource` | CSP `connect-src 'none'` |
| 任何外部资源（CDN、字体、图片） | CSP `default-src 'none'` |

提交控件必须是 `type="button"` 并绑定 `click`。命中上述模式会在 create/update 时被静态拒绝（`INVALID_HTML`）。

---

## 配置

完整示例（OpenCode 支持 JSONC，可存为 `opencode.jsonc`）：

```jsonc
{
  "plugins": [
    {
      "package": "./opencode-v2-aui",
      "options": {
        "openBrowser": true,
        "pageDir": ".opencode/v2-html-pages",
        "server": {
          "hostname": "127.0.0.1",
          "port": 15073,
          "publicBaseUrl": "http://127.0.0.1:15073"
        },
        "sessionTtlMs": 1800000,
        "defaultTimeoutMs": 300000,
        "maxPayloadBytes": 65536,
        "maxInlineHtmlBytes": 65536,
        "maxPageFileBytes": 3145728
      }
    }
  ]
}
```

### 选项与默认值

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `openBrowser` | `true` | 创建成功后是否自动打开浏览器 |
| `pageDir` | `os.tmpdir()/opencode-html-sessions` | 页面正文存放目录，目录 `0700`、文件 `0600` |
| `server.hostname` | `"127.0.0.1"` | 监听地址 |
| `server.port` | `0` | `0` 为随机端口；固定端口须为 `10000–65535` |
| `server.publicBaseUrl` | 无 | 对外可访问地址；**非 loopback 监听时必须配置** |
| `sessionTtlMs` | `1800000` | 会话存活时长（30 分钟） |
| `defaultTimeoutMs` | `300000` | `wait_html_submission` 默认等待时长（300 秒） |
| `maxPayloadBytes` | `65536` | 提交 payload（浏览器 → 模型）上限 |
| `maxInlineHtmlBytes` | `65536` | 内联 `html` 上限 |
| `maxPageFileBytes` | `3145728` | `htmlFile` 页面上限 |

配置非法（端口越界、`publicBaseUrl` 非 http(s)、非 loopback 监听缺 `publicBaseUrl` 等）会在插件启动时直接抛错，OpenCode 会显示加载失败。

### 相对路径

`htmlFile` 的相对路径按 `ctx.location.directory` 解析；`pageDir` 的相对路径按插件进程的工作目录解析（建议写绝对路径或项目内路径，避免宿主工作目录变化导致页面目录漂移）。

---

## 存储模型

采用**混合存储**：

| 数据 | 位置 | 说明 |
| --- | --- | --- |
| 元数据 | `ctx.storage` | 键 `session/<sessionId>/meta`，读取时 schema 校验 |
| 待处理提交 | `ctx.storage` | 键 `session/<sessionId>/pending` |
| 页面正文 | `pageDir` | 文件 `page-<version>.html`，临时名 + rename 原子写入 |
| 计时埋点 | `pageDir/timings.jsonl` | 每轮 `pageReady` 一行 JSONL |

- 启动时扫描 `session/` 前缀重建内存索引，清理终态、过期与损坏项。
- 页面正文通过 `Bun.file(path)` 流式返回，不驻留内存。
- `end_html_session`、TTL 过期、周期清理都会删除 `ctx.storage` 键与页面临时目录。
- OpenCode 会话被删除时，会结束其关联的 HTML 会话。

**与 V1 的差异**：没有 `storage.mode`（memory/disk）开关；元数据固定存 `ctx.storage`，页面正文固定落盘到 `pageDir`。

---

## 错误码

| 错误码 | 场景 | 处理建议 |
| --- | --- | --- |
| `INVALID_TOOL_INPUT` | `html`/`htmlFile` 同时提供或都缺失 | 二选一 |
| `INVALID_HTML` | 命中沙箱禁止模式 | 按返回的 `[CODE]` 逐条修正 |
| `HTML_TOO_LARGE_FOR_INLINE` | 内联 HTML 超 64 KiB | 改用 `htmlFile` 或压缩页面 |
| `HTML_TOO_LARGE` | `htmlFile` 超 `maxPageFileBytes` | 压缩页面 |
| `PAYLOAD_TOO_LARGE` | 提交数据超 `maxPayloadBytes` | 减少提交字段 |
| `SESSION_NOT_FOUND` | session 不存在 | 检查 `sessionId` |
| `SESSION_ENDED` | session 已结束 | 重新创建 |
| `STALE_PAGE` | 用旧 `pageVersion` 提交 | 只使用最新页面 |
| `DUPLICATE_SUBMISSION` | 同一 session 重复提交 | 一次交互只提交一次 |
| `WAIT_TIMEOUT` | 等待超时 | 确认页面调用了 `submitToAgent` |
| `WAIT_CANCELLED` | 等待被取消 | — |
| `BROWSER_OPEN_FAILED` | 自动打开浏览器失败 | 手动把 URL 给用户；该 session 已被清理 |
| `INVALID_AUTHORITY` | token 或 authority 无效 | 使用返回的完整 URL |
| `ROUTE_NOT_FOUND` / `METHOD_NOT_ALLOWED` | 路由或方法错误 | 检查请求 |

错误对象形如：

```json
{
  "code": "INVALID_HTML",
  "message": "HTML 含生产沙箱不允许的模式：NATIVE_FORM_SUBMIT",
  "context": "request",
  "action": "提交控件必须用 type=\"button\" 并在 click 里调用 submitToAgent"
}
```

---

## 故障排查

**工具没有出现在列表里**

1. 确认配置在 `plugins`（不是 `plugin`）下；
2. 确认 `package` 路径相对配置文件可解析；
3. 重启 OpenCode，查看宿主日志中的插件加载错误（配置非法会在启动时抛错）。

**浏览器没有自动打开**

`create_html_session` 会尝试打开浏览器；无显示环境时返回 `BROWSER_OPEN_FAILED` 并结束该 session。此时把 `url` 手动给用户，或重新创建。

**页面空白 / 一直是骨架**

- 确认 `update_html_session` 返回了递增的 `pageVersion`；
- 确认页面 HTML 是完整文档且脚本内联；
- 检查是否用了被 CSP 禁止的外部资源。

**提交后模型一直等**

- 页面是否调用了 `submitToAgent` 并检查返回值；
- 提交控件是否是 `type="button"`（`type="submit"` 会被沙箱拦截，且静态门禁会先拒绝）；
- `sessionId` 是否与 `wait_html_submission` 一致。

**页面刷新后旧标签页还能提交**

`update_html_session` 后旧版本提交会返回 `STALE_PAGE`，这是预期行为；让用户使用最新页面。

---

## 测试

```bash
bun run --cwd opencode-v2-aui typecheck
bun run --cwd opencode-v2-aui test
```

或在仓库根：

```bash
bun run typecheck:v2
bun run test:v2
```

---

## 与 V1 的关系

- `opencode-v1-aui/` 是同一套能力在 OpenCode V1 插件 API 上的实现，接口语义对齐。
- 两者插件 id 相同（`agent-user-interaction`），面向不同宿主，**不应在同一宿主中同时加载**。
- V2 是当前活跃开发版本；V1 保持稳定维护，详见 [opencode-v1-aui/README.md](../opencode-v1-aui/README.md)。
