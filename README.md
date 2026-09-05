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

## 故障排查

- 浏览器未打开：确认 OpenCode 插件已构建并启用，且运行环境允许 wrapper 打开浏览器。
- 等待超时：确认页面调用了 `submitToAgent`，并检查 `wait_html_submission` 的 `sessionId` 与等待时长。
- 页面过期：页面更新后只使用最新 URL 和 `pageVersion`，旧页面提交会被拒绝。
- 重复提交：提交成功后禁用唯一提交控件；同一 session 的后续提交会被拒绝。

运行项目检查：

```bash
bun run check
```
