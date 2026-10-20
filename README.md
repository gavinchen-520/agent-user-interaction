# Agent UI Interaction

Agent UI Interaction 由两个独立的安装单元组成：

- `skills/html-interaction`：安装到 OpenCode skill 目录的模型工作流说明（提交 bridge 由插件自动注入）。
- `opencode-v2-plugin`：默认插件入口（OpenCode V2 插件 API，插件 id `agent-ui-interaction`），提供 HTML 交互运行时和工具；`opencode-plugin/` 是面向 OpenCode V1 宿主的等价实现，其安装与发布见「OpenCode V1 插件安装」与「构建与发布」。

## 环境要求

- Bun 1.3 或更高版本
- OpenCode

## 安装

两个安装单元缺一不可：**skill**（`skills/html-interaction`，模型工作流说明 + 供 CI/开发自测的 jsdom 冒烟脚本）和**插件**（`opencode-v2-plugin`，HTML 交互运行时 + `create_html_session` 等工具 + 生成时的静态沙箱兼容性校验；提交 bridge 与可选设计令牌在 create/update 时自动注入）。

### 1. 安装 skill

把整个 skill 目录复制到 OpenCode 的 skill 搜索目录之一。必须整目录复制：`SKILL.md` 会在运行时引用同目录的 `references/`、`scripts/`、`assets/`。

项目级（仅当前项目生效）：

```bash
mkdir -p .opencode/skills && cp -R skills/html-interaction .opencode/skills/
```

全局（所有项目生效）：

```bash
mkdir -p ~/.config/opencode/skills && cp -R skills/html-interaction ~/.config/opencode/skills/
```

### 2. 安装插件（默认入口：opencode-v2-plugin）

仓库根执行一次 `bun install`，然后复制 `opencode.json.example` 为本机的 `opencode.json`。v2 插件直接从源码加载、无需构建：

```json
{
  "plugins": [
    { "package": "./opencode-v2-plugin", "options": {} }
  ]
}
```

安装完成后重启 OpenCode：`html-interaction` skill 应出现在 skill 列表中，模型可调用 `create_html_session` 等工具。完整参数见「OpenCode V2 插件」小节与 `opencode-v2-plugin/README.md`。

### 3. OpenCode V1 插件安装（可选，面向 V1 宿主）

以下构建/声明步骤仅适用于 `opencode-plugin`（V1 实现）：

```bash
bun install
bun run build   # 生成 opencode-plugin/dist/index.js
```

在 `opencode.json` 中以 V1 的 `plugin` 元组形式加载：

```json
{
  "plugin": [
    ["./opencode-plugin", {}]
  ]
}
```

#### V1 依赖声明

V1 插件通过 `import "@opencode-ai/plugin"` 引用宿主 API，该 import 不打包进产物，运行时由宿主从 `.opencode/node_modules` 解析。因此需在配置目录的 `.opencode/package.json` 声明依赖（OpenCode 启动时会自动 `bun install`），版本须与 `opencode-plugin/package.json` 一致：

```json
{ "dependencies": { "@opencode-ai/plugin": "1.18.27" } }
```

安装完成后重启 OpenCode：`html-interaction` skill 应出现在 skill 列表中，模型可调用 `create_html_session` 等工具。

## 使用

在 OpenCode 中，让模型为需要浏览器确认或收集输入的原始任务创建 HTML interaction page。模型应按顺序调用 `create_html_session`、`wait_html_submission`，需要新阶段时调用 `update_html_session`，结束时调用 `end_html_session`：

```text
create_html_session({ html })
wait_html_submission({ sessionId })
update_html_session({ sessionId, html })
end_html_session({ sessionId })
```

页面只需调用本地 `submitToAgent({ kind, data, metadata })` 提交（bridge 由插件在 create/update 时自动注入，模型不要自己实现）；不能访问网络、文件系统或 OpenCode API。bridge 会附带当前 `pageVersion`，旧 iframe 的消息会被拒绝。

生成页面默认使用浅色主题：白色或浅灰背景、深色文字和蓝/青/绿/橙强调色。只有用户明确要求或业务语义确实需要时才使用深色主题；常规页面建议控制在约 30KiB，较大的页面使用 `htmlFile`。

`create_html_session` / `update_html_session` 优先内联 `html`（≤ 64KiB，默认快通道）；也可用 `htmlFile` 指定本地文件路径（与 `html` 互斥，上限 `storage.maxPageFileBytes`，默认 3MiB）承载更大页面。内联超限会返回结构化错误 `HTML_TOO_LARGE_FOR_INLINE`，此时应改用 `htmlFile`，或把页面压回 64KiB 以内。

支持环境：Bun 1.3+、已安装并启用本项目插件的 OpenCode。其他 agent、直接打开 HTML 文件、没有 OpenCode wrapper 的浏览器页面不在支持范围内。

## 配置

本节描述 V1 插件（`plugin` 元组）的参数；v2 的具名参数见 `opencode-v2-plugin/README.md`。不配置任何选项即为默认行为（内存模式 + loopback + 随机端口）：

```json
{
  "plugin": [["./opencode-plugin", {}]]
}
```

### 完整参数示例

下面的示例显式写出全部可用参数（磁盘存储 + 固定端口），每个字段都带注释。OpenCode 支持 JSONC，可保存为 `opencode.jsonc`；省略任意字段即使用其默认值：

```jsonc
{
  "plugin": [
    ["./opencode-plugin", {
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

### 存储模式

- `storage.mode`：`"memory"`（默认）或 `"disk"`。
- 磁盘模式把每个会话落盘到 `storage.dataDir/html_<uuid>/`（`meta.json`、`page.html`、版本更新后的 `page-<version>.html`、`pending.json`），进程重启后自动恢复，已分发的页面 URL、token、pageId 均不失效。
- 会话结束（`end_html_session`、删除 opencode 会话）时默认删除对应磁盘目录；TTL 过期与周期清理也会删除无人访问的过期目录。
- `storage.retainPages`：仅 `"disk"` 模式有效，默认 `false`。设为 `true` 时会话结束保留页面原件，但删除 pending 数据并轮换 token；这些目录带 `retained` 标记，重启不会被当作活会话恢复，也不参与周期清理，需自行清理，避免磁盘增长。
- `storage.maxPageFileBytes`：文件型页面大小上限，默认 3 MiB。

### 外部访问

- `server.hostname`：默认 `127.0.0.1`；设为 `0.0.0.0` 可对外监听。
- `server.port`：默认 `0`（随机）；指定为 5 位数（10000-65535）固定端口。
- `server.publicBaseUrl`：对外可访问地址，用于改写返回给用户的页面 URL。非 loopback 监听时必须显式配置，且反向代理必须正确转发 authority。

对外访问的安全模型是 capability URL：知道 URL = 能看页面 = 能提交，无用户隔离，明文 HTTP，公网部署需前置 TLS 反向代理。

### 文件型页面

`htmlFile` 指向的本地文件会被复制进 session 目录（校验为常规文件且不超过 `maxPageFileBytes`），不保留源文件引用。内联与文件内容都会在 `create_html_session` / `update_html_session` 时做生产沙箱兼容性静态校验（禁止 `type=submit`、本地存储、弹窗、网络请求等），命中即返回 `INVALID_HTML`；渲染安全仍由 iframe sandbox 与页面 CSP 兜底。

### 其他参数

- `sessionTtlMs`：会话存活时长，默认 30 分钟。
- `defaultTimeoutMs`：`wait_html_submission` 默认等待时长，默认 300 秒。
- `maxPayloadBytes`：提交 payload（浏览器 → 模型）上限，默认 64KiB。
- `openBrowser`：创建成功后是否自动打开浏览器，默认开启。

## OpenCode V2 插件（默认入口）

`opencode-v2-plugin/` 是当前默认且活跃开发的插件实现（OpenCode V2 插件 API，插件 id 为 `agent-ui-interaction`），工具与 V1 一致，配置改用具名 `plugins` 数组对象形式，元数据存 `ctx.storage`、页面存临时目录。它只提供插件、不含 skill（skill 仍是单独的 `skills/html-interaction` 单元）：

```jsonc
{
  "plugins": [
    { "package": "./opencode-v2-plugin", "options": { "server": { "port": 15073 } } }
  ]
}
```

完整参数与默认值见 `opencode-v2-plugin/README.md`。「配置」小节描述的 `storage.*` 参数属于 V1 插件。V1 `opencode-plugin/` 不受影响，其安装见上文「OpenCode V1 插件安装」。

## 构建与发布

`opencode-plugin` 的构建命令将 `@opencode-ai/plugin` 标记为 external，不打包进产物，运行时由宿主 OpenCode 从 `.opencode/node_modules` 解析；`valibot` 等其他依赖会内联进 `dist/index.js`：

```bash
bun run build
```

发布单元为整个 `opencode-plugin/` 目录（至少包含 `package.json` 与 `dist/index.js`）。目标机器需在其 `.opencode/package.json` 声明 `@opencode-ai/plugin`，否则插件无法解析该 import。

升级宿主版本后，需同步 `opencode-plugin/package.json` 与 `.opencode/package.json` 中的版本号，并重新 `bun run build`。

## 测试

单元与集成测试（含 `tests/integration/runtime-flow.test.ts` 的 HTTP 全流程验证）：

```bash
bun run check
```

浏览器 E2E（真实插件工具、bridge 注入、Chromium sandbox iframe -> postMessage -> POST -> waiter 全链路）：

```bash
bunx playwright install --with-deps chromium
bunx playwright test tests/e2e/html-interaction.spec.ts --project=chromium
```

## 真实 OpenCode 验收

前提：一个提供 plugin API 的 OpenCode 宿主必须已安装并启用本插件与 skill。验收步骤：

1. 按上文完成安装，确认 `html-interaction` skill 出现在 skill 列表、`create_html_session` 等插件工具可供模型调用。
2. 在 OpenCode 中发起一个明确需要视觉交互的任务，例如："创建一个 HTML 页面让我选择部署环境（staging/production），并在确认后把我的选择告诉你"。
3. 验证模型调用 `create_html_session` 并返回 session URL，浏览器（或可手动打开 URL 的环境）展示 wrapper 页面。
4. 在独立浏览器窗口的页面中选择选项并点击提交；验证 `wait_html_submission` 返回结构化数据（`kind`、`data`、`metadata`），模型能复述你的选择。
5. 请求第二个阶段（例如追加参数确认页）；验证模型调用 `update_html_session`，页面自动刷新为新版本（无需手动刷新），旧页面提交被拒绝（409 `STALE_PAGE`），新页面提交成功。
6. 要求模型结束交互；验证 `end_html_session` 返回成功，再次结束不产生副作用。
7. 运行 `bun run check`，确认 TypeScript、单元与集成测试全部通过。

## 故障排查

- 浏览器未打开：`create_html_session` 成功后会自动打开浏览器；若环境不允许（如无显示环境），工具返回 `BROWSER_OPEN_FAILED` 并结束该 session，此时把返回的页面 URL 手动告诉用户打开。
- 等待超时：确认页面调用了 `submitToAgent`，并检查 `wait_html_submission` 的 `sessionId` 与等待时长。
- 页面过期：页面更新后只使用最新 URL 和 `pageVersion`，旧页面提交会被拒绝。
- 重复提交：提交成功后禁用唯一提交控件；同一 session 的后续提交会被拒绝。

运行项目检查：

```bash
bun run check
```

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
