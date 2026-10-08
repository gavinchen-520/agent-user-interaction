# @agent-ui-interaction/opencode-v2-plugin

面向 OpenCode V2 插件 API 的 HTML 交互插件。插件 id 为 `agent-ui-interaction`，包名为 `@agent-ui-interaction/opencode-v2-plugin`。

它是 `opencode-plugin/`（V1）的 **V2 原生精简版**：工具名与语义对等，但改用 V2 的 `Plugin.define`、`ctx.tool.transform`、`ctx.storage` 与 `ctx.event.subscribe`。**V1 `opencode-plugin/` 未被改动**，两者并行存在、互不影响。

## 环境要求

- Bun `>=1.3.14`
- 提供 V2 插件 API 的 OpenCode 宿主

## 安装

在仓库根目录（Bun workspace 已包含本包）：

```bash
bun install
```

本包无独立构建步骤：`package.json` 的 `exports` 直接指向 `src/index.ts`，由 Bun 从 TypeScript 源加载。依赖 `@opencode/plugin@2.0.24` 与 `valibot`，由 workspace 的 `node_modules` 提供；作为独立发布单元时，需保证这两个依赖可被解析。

## 加载

V2 使用 `plugins` **数组 + 对象形式**（区别于 V1 的 `plugin` 元组形式）：

```jsonc
{
  "plugins": [
    {
      "package": "./opencode-v2-plugin",
      "options": { "server": { "port": 15073 } }
    }
  ]
}
```

省略 `options` 即使用全部默认值。安装后重启 OpenCode，`html-interaction` skill 与 `create_html_session` 等工具即可用。

## 工具

| 工具 | 入参 | 返回 |
| --- | --- | --- |
| `create_html_session` | `title?`、`html?`、`htmlFile?`、`initialState?` | `{ sessionId, pageId, pageVersion, url, pageFilePath? }` |
| `wait_html_submission` | `sessionId`、`timeoutMs?` | `{ kind, data, metadata, pageVersion }` |
| `update_html_session` | `sessionId`、`html?`、`htmlFile?`、`state?` | `{ pageId, pageVersion }` |
| `end_html_session` | `sessionId` | `{ ok }` |

- `html` 与 `htmlFile` 二选一（互斥）：`html` 走内联上限（`maxInlineHtmlBytes`，默认 64KiB），超限返回 `HTML_TOO_LARGE_FOR_INLINE`；`htmlFile` 走页面文件上限（`maxPageFileBytes`，默认 3MiB）。`htmlFile` 相对路径按 `ctx.location.directory` 解析。
- 提交 bridge 由插件在 `create`/`update` 时自动注入，页面只需调用 `submitToAgent({ kind, data, metadata })`。
- `update_html_session` 递增 `pageVersion` 并让旧页面提交失效（`STALE_PAGE`）；wrapper 轮询版本端点自动刷新 iframe。
- 页面 HTML 通过生产沙箱静态门禁校验（禁止 `type=submit`、本地存储、弹窗、网络请求等），命中返回 `INVALID_HTML`。

## 存储

采用混合存储，与 V1 的 `storage.mode` 配置无关：

- **元数据与待处理提交**：存于 `ctx.storage`，键为 `session/<sessionId>/meta` 与 `session/<sessionId>/pending`。读取时用 schema 校验，损坏值按缺失处理并清除。启动 `setup` 时扫描 `session/` 前缀重建内存索引并清理终态/过期/损坏项。
- **页面正文**：写入临时目录 `pageDir`（默认 `os.tmpdir()/opencode-html-sessions`），目录权限 `0700`、文件 `0600`，写入走「临时名 + rename」保证原子性。HTTP 页面路由用 `Bun.file(path)` 流式返回，正文不驻留内存。
- **生命周期**：`end_html_session`、TTL 过期、周期清理都会删除对应的 `ctx.storage` 键与页面临时目录；OpenCode 会话被删除时，会结束其关联的 HTML 会话。

## 选项与默认值

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `openBrowser` | `true` | 创建成功后是否自动打开浏览器 |
| `server.hostname` | `"127.0.0.1"` | 监听地址 |
| `server.port` | `0` | `0` 为随机端口；固定端口须为 10000–65535 |
| `server.publicBaseUrl` | 无 | 对外可访问地址；非 loopback 监听时必须配置 |
| `sessionTtlMs` | `1800000` | 会话存活时长（30 分钟） |
| `defaultTimeoutMs` | `300000` | `wait_html_submission` 默认等待时长（300 秒） |
| `maxPayloadBytes` | `65536` | 提交 payload（浏览器 → 模型）上限（64 KiB） |
| `maxInlineHtmlBytes` | `65536` | 内联 `html` 上限（64 KiB） |
| `maxPageFileBytes` | `3145728` | `htmlFile` 页面上限（3 MiB） |
| `pageDir` | `os.tmpdir()/opencode-html-sessions` | 页面正文临时目录 |

## 测试

```bash
bun run --cwd opencode-v2-plugin typecheck
bun run --cwd opencode-v2-plugin test
```

或在仓库根目录运行 `bun run test:v2`。

## 与 V1 的关系

- V1 `opencode-plugin/` 保持原样，未被本包改动。
- V2 是本项目在 OpenCode V2 上的并行、精简实现，二者可独立选用，但不应在同一宿主中同时加载。
