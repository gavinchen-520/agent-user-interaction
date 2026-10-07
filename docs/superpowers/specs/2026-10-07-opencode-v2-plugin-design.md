# OpenCode V2 插件重构设计（opencode-v2-plugin）

## 背景与目标

V1 插件实现无法在 OpenCode V2 中运行，V2 使用全新的插件 API（`Plugin.define({ id, setup })` + 域化 `transform`/`hook`/`subscribe`）。本设计基于现有 `opencode-plugin/`（V1）代码，在 `opencode-v2-plugin/` 下产出一套 **V2 原生精简版** 插件，行为与 V1 对等：模型可创建可交互 HTML 页面会话、等待页面提交结构化数据、更新页面、结束会话；页面在 wrapper + iframe 沙箱中运行，提交经 postMessage bridge 回传到内置 HTTP server。

“精简”的含义：存储与配置按 V2 惯例收敛（元数据/待消费提交走 `ctx.storage`，页面正文走临时文件；去掉 V1 的 `storage.mode`/`dataDir`/`retainPages` 与自研磁盘恢复配置面），平台无关的运行时（server/wrapper/protocol/htmlValidation/waiter/browser）沿用 V1 实现。

## 非目标

- 不修改 V1 的 `opencode-plugin/`，V2 作为并列新包存在。
- 不自动改写根 `opencode.json`（接入方式留待后续单独确认）。
- 不引入新的提交协议或改变 V1 的前端契约（`html-submit` 信封、pageVersion、stale/duplicate 语义保持不变）。
- 不实现多进程横向扩展；页面存储使用本机临时目录。
- 不追求像素级 UI；本设计只涉及插件与运行时，不涉及技能页面模板。

## V1 → V2 映射

| V1 形态 | V2 形态 |
| --- | --- |
| `export const createHtmlInteractionPlugin(): Plugin` 工厂 + 默认导出 | `export default Plugin.define({ id: "agent-ui-interaction", setup })` |
| `async (input, options) => ({ tool, event, dispose })` | `setup(ctx)` 内注册，返回 cleanup 函数 |
| `tool: { create_html_session: tool({...}) }`，`tool.schema` + `execute(args)` | `ctx.tool.transform(editor => editor.add({ name, description, input: <JSON Schema>, execute(input, context) }))`，返回 `{ content }` |
| `event: async ({ event }) => {}` | `ctx.event.subscribe({ signal })` 异步迭代 + cleanup `controller.abort()` |
| 插件 options 由配置元组第二项传入 | `ctx.options`（opencode.json 用 `{ package, options }` 对象形式） |
| `input.directory` | `ctx.location.directory` |
| 自研 disk/memory 存储 + 启动恢复 | 元数据/pending 走 `ctx.storage`；页面走临时文件；启动用 `scan` 重建 |
| `dispose()` | setup 返回的 cleanup |

## 目录结构

```text
opencode-v2-plugin/
  package.json          # type:module；exports "." -> ./src/index.ts；deps：@opencode/plugin、valibot
  tsconfig.json
  README.md
  src/
    index.ts            # Plugin.define：装配 runtime + server + tools + event + cleanup
    options.ts          # ctx.options 解析与校验（valibot）
    tools.ts            # 4 个工具定义（JSON Schema + execute）
    runtime/
      index.ts            # 运行时导出
      constants.ts        # 默认上限与 TTL/清理间隔
      types.ts            # RuntimeSession / HtmlRuntime / 错误码等
      protocol.ts         # envelope 校验、createRuntimeError、isJsonSerializable（复用）
      waiter.ts           # waiter 注册表（复用）
      htmlValidation.ts   # 沙箱静态门禁（复用）
      pageRuntime.ts      # bridge/设计令牌注入（复用）
      wrapper.ts          # wrapper HTML（复用）
      browser.ts          # openBrowser（复用）
      server.ts           # Bun.serve：wrapper/page/version/submit 路由（复用，裁剪配置）
      pageStore.ts        # 页面正文临时文件读写 + 流式路径
      metaStore.ts        # ctx.storage 适配：meta/pending 读写与扫描
      store.ts            # 会话状态机 + 生命周期（改写为 async 持久化）
```

## 组件设计

### 1. 入口 `src/index.ts`

```ts
export default Plugin.define({
  id: "agent-ui-interaction",
  async setup(ctx) {
    const options = resolveOptions(ctx.options);
    const runtime = createHtmlRuntime({ ..., storage: createCtxStorage(ctx.storage), pageStore });
    const server = await createRuntimeServer(runtime, { ...options.server, openBrowser: false });
    await runtime.restore(); // scan(ctx.storage) 重建内存索引
    await ctx.tool.transform((editor) => {
      for (const tool of createHtmlSessionTools(runtime, options, ctx)) editor.add(tool);
    });
    const controller = new AbortController();
    void subscribeSessionCleanup(ctx, runtime, controller.signal);
    return async () => {
      controller.abort();
      await runtime.dispose();
      await server.stop(true);
    };
  },
});
```

要点：

- runtime 与 server 在 setup 期启动一次；`openBrowser` 由 `create_html_session` 成功后按需触发。
- 工具注册是同步的 transform；所有外部数据（cli/服务）在注册前准备好。
- `ctx.options` 为宽松 `Record<string, any>`，由 `resolveOptions` 严格校验并在非法时抛出可操作错误。

### 2. 工具 `src/tools.ts`

保留 V1 工具名与语义：`create_html_session`、`wait_html_submission`、`update_html_session`、`end_html_session`。

- `input` 使用 JSON Schema（object + properties + required + additionalProperties:false）：
  - create：`title?`、`html?`、`htmlFile?`、`initialState?`（`html`/`htmlFile` 二选一）。
  - wait：`sessionId`、`timeoutMs?`。
  - update：`sessionId`、`html?`、`htmlFile?`、`state?`。
  - end：`sessionId`。
- `execute(input, context)` 返回 `{ content: JSON.stringify(result) }`（与 V1 返回 JSON 字符串一致），失败时抛出 `Tool.Error` 语义的异常并带可操作信息。
- `wait_html_submission` 把 `context.signal` 传给 `runtime.waitSubmission`；可选用 `context.progress({ status })` 反馈等待状态。
- 页面大小门禁沿用：内联 HTML 上限（`maxInlineHtmlBytes`，默认 64KiB），`htmlFile` 上限（`maxPageFileBytes`，默认 3MiB）；`htmlFile` 相对路径按 `ctx.location.directory` 解析。
- HTML 继续经过 `injectPageRuntime`（注入 bridge + 令牌）与 `collectHtmlIssues`（沙箱硬门禁）。

### 3. 存储 `metaStore.ts` + `pageStore.ts`

**元数据与 pending（`ctx.storage`）**

- key 约定：`session/<sessionId>/meta`、`session/<sessionId>/pending`。
- 值为 JSON 兼容对象，字段与 V1 `SessionMetaFile` 对齐：`sessionId`、`opencodeSessionId?`、`title?`、`pageId`、`pageVersion`、`token`、`status`、`createdAt`、`updatedAt`、`pageFileName`、`submittedPageVersion?`、`state?`。
- 读取用 valibot schema 校验（含 `schemaVersion`），非法值视为损坏并删除，不以类型断言进入状态机。
- 启动恢复：`scan({ prefix: "session/" })` 逐条校验，跳过终态/过期/损坏项并清理；重建内存索引。
- TTL 清理：周期任务按 `scan` 遍历，删除过期会话的 `ctx.storage` 键与页面临时文件。

**页面正文（临时文件）**

- 目录：默认 `os.tmpdir()/opencode-html-sessions/`，可用 `pageDir` 覆盖；目录 `0700`，文件 `0600`。
- 写入原子化：先写临时名再 rename，避免半截文件。
- server 的 page 路由使用 `Bun.file(path)` 流式返回，页面正文不驻留内存。
- 会话结束/过期/清理时删除对应页面文件；进程异常退出遗留的目录在下次启动按元数据缺失情况回收。

**store 改为异步持久化**

- `createSession`/`updateSession`/`submitSubmission`/`endSession` 已为 async；`persistMeta`/`persistPending`/`persistPage` 变为 await。
- 周期清理与启动恢复为 async，在 setup 中 await `restore()`，清理定时器在 dispose 时清除。

### 4. 运行时复用面

直接复用（仅做导入/命名/类型适配，不改语义）：`protocol.ts`、`waiter.ts`、`htmlValidation.ts`、`pageRuntime.ts`、`wrapper.ts`、`browser.ts`；`server.ts` 复用路由与 authority/token/限流逻辑，去掉 disk/memory 配置分支，页面统一从 `pageStore` 取文件流。

### 5. 事件与清理

- `ctx.event.subscribe({ signal })` 监听会话删除事件，匹配 `opencodeSessionId` 后结束对应 html 会话。
- V2 事件形状为 `{ type, data, ... }`（以 `@opencode/schema` 类型为准）；实现时按实际字段读取，不照搬 V1 的 `properties.info.id`。
- cleanup：abort 订阅、`runtime.dispose()`（清 waiter/定时器）、`server.stop(true)`。

### 6. 选项 `src/options.ts`

保留：`openBrowser`（默认 true）、`server.{hostname,port,publicBaseUrl}`（默认 `127.0.0.1` / 随机端口；非 loopback 必须配 `publicBaseUrl`）、`sessionTtlMs`、`defaultTimeoutMs`、`maxPayloadBytes`、`maxPageFileBytes`、`maxInlineHtmlBytes`、`pageDir?`。

删除：`storage.mode`、`storage.dataDir`、`storage.retainPages`（由混合存储替代）。

opencode.json 对象形式：

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

## 数据流

1. 模型调用 `create_html_session` → 校验 HTML（大小 + 沙箱）→ 注入 bridge → 写 `session/<id>/meta` 与页面文件 → 启 server → 打开浏览器 → 返回 `{ sessionId, pageId, pageVersion, url, pageFilePath? }`。
2. wrapper（`/session/:id`）加载 iframe；页面调用 `submitToAgent` → postMessage → wrapper 带 token POST `/session/:id/submit`。
3. server 校验 authority/token/大小 → `runtime.submitSubmission` → 校验 pageId/pageVersion/重复 → 存 pending → 唤醒 waiter。
4. 模型调用 `wait_html_submission` → 返回 `{ kind, data, metadata, pageVersion }`。
5. `update_html_session` 递增 pageVersion 并使旧版本失效；wrapper 轮询 `/version` 自动刷新。
6. `end_html_session` 或 TTL/会话删除 → 清 waiter、删除 `ctx.storage` 键与页面文件。

## 错误处理

沿用 V1 错误码与语义：`INVALID_ENVELOPE`、`INVALID_PAGE_VERSION`、`INVALID_HTML`、`HTML_TOO_LARGE_FOR_INLINE`、`HTML_TOO_LARGE`、`PAYLOAD_TOO_LARGE`、`SESSION_NOT_FOUND`、`SESSION_ENDED`、`STALE_PAGE`、`DUPLICATE_SUBMISSION`、`WAIT_TIMEOUT`、`WAIT_CANCELLED`、`BROWSER_OPEN_FAILED`、`INVALID_AUTHORITY`、`ROUTE_NOT_FOUND`、`METHOD_NOT_ALLOWED`。HTTP 层返回结构化 `{ code, message, context, action }`。工具层把运行时错误转成带可操作信息的失败结果。

## 测试与验证

- `bun install`（在 `opencode-v2-plugin/` 安装 `@opencode/plugin@2.0.24`、`valibot`）。
- `bun run typecheck`（以真实 `@opencode/plugin` 类型为准）。
- 移植运行时单测到新包：`store`/`server`/`protocol`/`htmlValidation`/`pageRuntime`/`wrapper`（沿用现有用例，替换存储适配）。
- 新增 smoke：加载默认导出的 `Plugin.define` 定义，用假 `ctx`（内存 storage、临时 pageDir）驱动 setup，create → 取 page → POST submit → wait 拿到结果 → end → cleanup。
- 根 `package.json`：把 `opencode-v2-plugin` 加入 `workspaces`，新增 `typecheck:v2` 脚本；现有 V1 测试保持通过。

## 风险与开放项

- `ctx.storage` 的持久性/单值大小上限未公开；页面正文走文件已规避大值，元数据保持小对象。
- V2 事件字段需以实现时 `@opencode/schema` 类型为准（尤其 `session.deleted`）。
- `ctx.tool.transform` 注册的 `input` 需为 JSON Schema；`htmlFile` 的路径解析依赖 `ctx.location.directory`。
- 临时目录在进程异常退出后可能残留；依赖下次启动按 `ctx.storage` 元数据回收，无元数据的孤儿目录按前缀清理。

## 验收标准

1. `opencode-v2-plugin/` 内 `bun run typecheck` 通过。
2. 默认导出为合法 `Plugin.define` 定义，setup 注册 4 个工具、1 个事件订阅，并返回可释放 server/runtime 的 cleanup。
3. 移植的运行时单测与新增 smoke 全部通过。
4. 页面提交链路（create → submit → wait）在 smoke 中跑通，错误码与 V1 一致。
5. 根仓库既有 V1 测试不被破坏。
