# opencode-v1-aui

OpenCode **V1 插件 API** 的 HTML 交互插件，与 [`opencode-v2-aui`](../opencode-v2-aui/README.md) 能力等价。插件 id 同为 `agent-user-interaction`，包名为 `opencode-v1-aui`。

给模型提供四个工具：创建页面、等待提交、更新页面、结束会话。页面由模型现场生成，运行在受限 iframe 中，用户操作后以结构化 JSON 回传。

> 本包**只提供插件，不含 skill**。模型工作流说明是独立的 [`skills/agent-user-interaction`](../skills/agent-user-interaction/README.md) 单元，两者缺一不可。
>
> 新项目优先使用 V2（[`opencode-v2-aui`](../opencode-v2-aui/README.md)）；本包用于仍在使用 V1 插件 API 的宿主。

---

## 环境要求

- **Bun** `>= 1.3.14`
- **OpenCode** 宿主，需提供 V1 插件 API
- 运行时依赖：`@opencode-ai/plugin@1.18.27`（**不打进产物**，由宿主解析）、`valibot@^1.2`

---

## 安装

### 1. 安装依赖并构建

```bash
bun install
bun run build   # 生成 opencode-v1-aui/dist/index.js
```

构建命令把 `@opencode-ai/plugin` 标记为 `external`，不打包进产物；`valibot` 会内联进 `dist/index.js`。

### 2. 声明宿主依赖

V1 插件通过 `import "@opencode-ai/plugin"` 引用宿主 API，运行时由 OpenCode 从配置目录的 `.opencode/node_modules` 解析。因此在**配置目录**的 `.opencode/package.json` 中声明依赖（版本须与 `opencode-v1-aui/package.json` 一致）：

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "1.18.27"
  }
}
```

OpenCode 启动时会自动在该目录执行 `bun install`。缺少这一步插件会因无法解析 import 而加载失败。

### 3. 加载插件

在 `opencode.json` 中用 **`plugin` 元组**形式注册（注意与 V2 的 `plugins` 数组不同）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["./opencode-v1-aui", {}]
  ]
}
```

### 4. 验证

重启 OpenCode 后确认：

1. `create_html_session`、`wait_html_submission`、`update_html_session`、`end_html_session` 出现在工具列表中；
2. 模型能创建页面并返回 URL；
3. 浏览器能打开页面并成功提交。

---

## 工具

| 工具 | 入参 | 返回 |
| --- | --- | --- |
| `create_html_session` | `title?`、`html?`、`htmlFile?`、`initialState?` | `{ sessionId, pageId, pageVersion, url, pageFilePath? }` |
| `wait_html_submission` | `sessionId`、`timeoutMs?` | `{ kind, data, metadata, pageVersion }` |
| `update_html_session` | `sessionId`、`html?`、`htmlFile?`、`state?` | `{ pageId, pageVersion }` |
| `end_html_session` | `sessionId` | `{ ok }` |

- `html` 与 `htmlFile` 互斥；内联上限固定为 64 KiB，`htmlFile` 上限由 `storage.maxPageFileBytes` 配置（默认 3 MiB）。
- `htmlFile` 相对路径按插件启动时的工作目录（`input.directory`）解析。
- `update_html_session` 递增 `pageVersion`，旧页面提交返回 `409 STALE_PAGE`；wrapper 轮询版本端点自动刷新。
- 页面 HTML 在 create/update 时做生产沙箱静态门禁校验，命中返回 `INVALID_HTML`。

---

## 配置

### 默认行为

不配置任何选项即为：内存存储 + loopback + 随机端口 + 自动打开浏览器。

```json
{
  "plugin": [["./opencode-v1-aui", {}]]
}
```

### 完整参数

OpenCode 支持 JSONC，可保存为 `opencode.jsonc`；省略任意字段即使用默认值：

```jsonc
{
  "plugin": [
    ["./opencode-v1-aui", {
      // 创建成功后是否自动打开浏览器，默认 true
      "openBrowser": true,
      "storage": {
        // 会话存储模式："memory"（默认）或 "disk"
        "mode": "disk",
        // 磁盘模式的会话目录，相对路径按项目根解析
        "dataDir": ".opencode/html-sessions",
        // htmlFile 页面大小上限（字节），默认 3145728（3 MiB）
        "maxPageFileBytes": 3145728,
        // 会话结束后保留页面原件（仅 disk 模式），默认 false
        "retainPages": false
      },
      "server": {
        // 监听地址，默认 127.0.0.1
        "hostname": "127.0.0.1",
        // 固定端口（10000-65535），默认 0 即随机端口
        "port": 15073,
        // 对外可访问地址；非 loopback 监听时必须配置
        "publicBaseUrl": "http://127.0.0.1:15073"
      },
      // 会话存活时长（毫秒），默认 1800000（30 分钟）
      "sessionTtlMs": 1800000,
      // wait_html_submission 默认等待时长（毫秒），默认 300000（300 秒）
      "defaultTimeoutMs": 300000,
      // 提交 payload 大小上限（字节），默认 65536（64 KiB）
      "maxPayloadBytes": 65536
    }]
  ]
}
```

### 选项一览

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `openBrowser` | `true` | 创建成功后是否自动打开浏览器 |
| `storage.mode` | `"memory"` | `"memory"` 或 `"disk"` |
| `storage.dataDir` | `.opencode/html-sessions` | 磁盘模式会话目录，相对路径按项目根解析 |
| `storage.maxPageFileBytes` | `3145728` | `htmlFile` 页面上限（3 MiB） |
| `storage.retainPages` | `false` | 仅 `disk` 模式；结束时保留页面原件 |
| `server.hostname` | `"127.0.0.1"` | 监听地址 |
| `server.port` | `0` | `0` 为随机；固定端口须为 `10000–65535` |
| `server.publicBaseUrl` | 无 | 对外可访问地址；非 loopback 监听时必须配置 |
| `sessionTtlMs` | `1800000` | 会话存活时长（30 分钟） |
| `defaultTimeoutMs` | `300000` | `wait_html_submission` 默认等待时长 |
| `maxPayloadBytes` | `65536` | 提交 payload 上限 |

配置非法（端口越界、`storage.mode` 非枚举值、非 loopback 监听缺 `publicBaseUrl` 等）会在插件加载时直接抛错。

---

## 存储模式

### `memory`（默认）

- 页面与元数据只在进程内存中，进程退出即丢失。
- 适合本地开发、CI、单次会话。

### `disk`

- 每个会话落盘到 `storage.dataDir/html_<uuid>/`：
  - `meta.json`：会话元数据
  - `page.html`：当前页面
  - `page-<version>.html`：历史版本
  - `pending.json`：待消费的提交
- 进程重启后自动恢复；**已分发的页面 URL、token、pageId 均不失效**。
- 会话结束（`end_html_session`、删除 OpenCode 会话）时默认删除对应目录。
- TTL 过期与周期清理会删除无人访问的过期目录。

### `storage.retainPages`

仅 `disk` 模式有效，默认 `false`。设为 `true` 时：

- 会话结束后**保留**页面原件；
- 删除 pending 数据并**轮换 token**；
- 目录带 `retained` 标记，重启不会当作活会话恢复，也不参与周期清理；
- 需自行清理，避免磁盘持续增长。

---

## 外部访问

默认只监听 `127.0.0.1`，仅本机可访问。需要从其他设备打开页面时：

```jsonc
{
  "plugin": [["./opencode-v1-aui", {
    "server": {
      "hostname": "0.0.0.0",
      "port": 18000,
      "publicBaseUrl": "http://192.168.1.20:18000"
    }
  }]]
}
```

- `server.hostname`：设为 `0.0.0.0` 对外监听。
- `server.port`：固定端口须为 `10000–65535`。
- `server.publicBaseUrl`：**非 loopback 监听时必须显式配置**，用于改写返回给用户的页面 URL；反向代理必须正确转发 authority。

**安全模型是 capability URL**：知道 URL = 能看页面 = 能提交，没有用户隔离，明文 HTTP。公网部署必须前置 TLS 反向代理，并自行评估暴露风险。

---

## 文件型页面

`htmlFile` 指向的本地文件会被**复制**进 session 目录（校验为常规文件且不超过 `maxPageFileBytes`），不保留源文件引用。

内联与文件内容都会在 create/update 时做生产沙箱兼容性静态校验，禁止：

| 模式 | 错误码 |
| --- | --- |
| `type="submit"` | `NATIVE_FORM_SUBMIT` |
| `form.requestSubmit()` | `REQUEST_SUBMIT` |
| `form.submit()` | `FORM_SUBMIT` |
| `localStorage` / `sessionStorage` / `indexedDB` | `LOCAL_STORAGE` |
| `document.cookie` | `DOCUMENT_COOKIE` |
| `alert` / `confirm` / `prompt` | `MODAL_DIALOG` |
| `window.open` | `WINDOW_OPEN` |
| `fetch` / `XHR` / `WebSocket` / `EventSource` | `NETWORK_REQUEST` |

命中即返回 `INVALID_HTML`。渲染安全仍由 iframe sandbox 与页面 CSP 兜底。

---

## 页面编写约定

页面只需调用：

```js
submitToAgent({ kind: "review-decision", data: { decision: "approve" }, metadata: {} });
```

bridge 由插件在 create/update 时自动注入，**不要自己实现**。提交控件必须是 `type="button"` 并绑定 `click`；提交成功后禁用控件。

---

## 错误码

| 错误码 | 场景 |
| --- | --- |
| `INVALID_TOOL_INPUT` | `html`/`htmlFile` 同时提供或都缺失 |
| `INVALID_HTML` | 命中沙箱禁止模式 |
| `HTML_TOO_LARGE_FOR_INLINE` | 内联 HTML 超 64 KiB |
| `HTML_TOO_LARGE` | `htmlFile` 超上限 |
| `PAYLOAD_TOO_LARGE` | 提交数据超 `maxPayloadBytes` |
| `SESSION_NOT_FOUND` | session 不存在 |
| `SESSION_ENDED` | session 已结束 |
| `STALE_PAGE` | 用旧 `pageVersion` 提交 |
| `DUPLICATE_SUBMISSION` | 重复提交 |
| `WAIT_TIMEOUT` | 等待超时 |
| `WAIT_CANCELLED` | 等待被取消 |
| `BROWSER_OPEN_FAILED` | 自动打开浏览器失败 |
| `INVALID_AUTHORITY` | token 或 authority 无效 |
| `ROUTE_NOT_FOUND` / `METHOD_NOT_ALLOWED` | 路由或方法错误 |

---

## 故障排查

**插件加载失败 / 找不到 `@opencode-ai/plugin`**

1. 确认已执行 `bun run build`，`dist/index.js` 存在；
2. 确认配置目录的 `.opencode/package.json` 声明了 `@opencode-ai/plugin`，版本与 `opencode-v1-aui/package.json` 一致；
3. 重启 OpenCode 触发依赖安装。

**配置没生效**

- 确认写的是 `plugin` 元组（`[["./opencode-v1-aui", { ... }]]`），不是 V2 的 `plugins`；
- 确认 `opencode.json` 位于 OpenCode 实际读取的配置目录。

**浏览器没打开**

无显示环境时会返回 `BROWSER_OPEN_FAILED` 并结束 session；把返回的 `url` 手动给用户，或重新创建。

**重启后页面 404**

- 只有 `storage.mode = "disk"` 才支持重启恢复；
- `memory` 模式进程退出后 session 全部丢失；
- `retained` 目录不会作为活会话恢复。

**提交后模型一直等**

- 页面是否调用 `submitToAgent` 并检查返回值；
- 提交控件是否是 `type="button"`；
- `sessionId` 是否与 `wait_html_submission` 一致。

---

## 发布清单

发布单元为整个 `opencode-v1-aui/` 目录，至少包含：

- `package.json`
- `dist/index.js`
- `README.md`（推荐）

目标机器需在其 `.opencode/package.json` 声明 `@opencode-ai/plugin`，否则插件无法解析该 import。

升级宿主版本后，需同步 `opencode-v1-aui/package.json` 与 `.opencode/package.json` 中的版本号，并重新 `bun run build`。

---

## 测试

```bash
bun run --cwd opencode-v1-aui typecheck
```

仓库根：

```bash
bun run typecheck
bun run check
```

---

## 与 V2 的差异

| | `opencode-v1-aui`（本包） | `opencode-v2-aui` |
| --- | --- | --- |
| 加载方式 | `plugin` 元组 | `plugins` 数组 + 对象 |
| 构建 | 需要 `bun run build` | 无，直接加载 TS |
| 元数据存储 | `memory` / `disk` 可选 | 固定 `ctx.storage` |
| 页面存储 | 随 `storage.mode` | 固定临时目录 |
| 宿主依赖声明 | 需 `.opencode/package.json` | 由 workspace 提供 |
| 状态 | 稳定维护 | 活跃开发 |

两者插件 id 相同，**不要在同一宿主中同时加载**。
