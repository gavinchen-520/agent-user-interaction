# Agent UI Interaction

Agent UI Interaction 由两个独立的安装单元组成：

- `skills/html-interaction`：安装到 OpenCode skill 目录的模型工作流说明和提交 bridge。
- `opencode-plugin`：单独启用的 OpenCode 插件包，提供 HTML 交互运行时和工具。

## 环境要求

- Bun 1.3 或更高版本
- OpenCode

## 本地安装

在项目根目录安装依赖：

```bash
bun install
```

将 skill 目录复制到 OpenCode 的 skill 目录，并安装插件包：

```bash
cp -R skills/html-interaction ~/.config/opencode/skills/html-interaction
cd opencode-plugin && bun install && bun run build
opencode plugin add ./opencode-plugin
```

## 使用

在 OpenCode 中，让模型为需要浏览器确认或收集输入的原始任务创建 HTML interaction page。模型应按顺序调用 `create_html_session`、`wait_html_submission`，需要新阶段时调用 `update_html_session`，结束时调用 `end_html_session`：

```text
create_html_session({ html })
wait_html_submission({ sessionId })
update_html_session({ sessionId, html })
end_html_session({ sessionId })
```

页面只能通过本地 `submitToAgent({ kind, data, metadata })` 提交，不能访问网络、文件系统或 OpenCode API。

支持环境：Bun 1.3+、已安装并启用本项目插件的 OpenCode。其他 agent、直接打开 HTML 文件、没有 OpenCode wrapper 的浏览器页面不在支持范围内。

## 测试

单元与集成测试（含 `tests/integration/runtime-flow.test.ts` 的 HTTP 全流程验证）：

```bash
bun run check
```

浏览器 E2E（真实 Chromium 驱动 wrapper -> sandbox iframe -> postMessage -> POST -> waiter 全链路）：

```bash
bunx playwright install chromium
bunx playwright test tests/e2e/html-interaction.spec.ts --project=chromium
```

## 真实 OpenCode 验收

前提：一个提供 plugin API 的 OpenCode 宿主必须已安装并启用本插件与 skill。验收步骤：

1. 按上文完成安装，确认 `opencode plugin add ./opencode-plugin` 成功且 `html-interaction` skill 出现在 skill 列表。
2. 在 OpenCode 中发起一个明确需要视觉交互的任务，例如："创建一个 HTML 页面让我选择部署环境（staging/production），并在确认后把我的选择告诉你"。
3. 验证模型调用 `create_html_session` 并返回 session URL，浏览器（或可手动打开 URL 的环境）展示 wrapper 页面。
4. 在独立浏览器窗口的页面中选择选项并点击提交；验证 `wait_html_submission` 返回结构化数据（`kind`、`data`、`metadata`），模型能复述你的选择。
5. 请求第二个阶段（例如追加参数确认页）；验证模型调用 `update_html_session`，刷新后旧页面提交被拒绝（409 `STALE_PAGE`），新页面提交成功。
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
