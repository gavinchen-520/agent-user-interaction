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

将 `skills/html-interaction` 目录复制到 OpenCode 的 skill 目录，并单独启用 `opencode-plugin` 包。插件包可以在其目录中安装和构建：

```bash
cd opencode-plugin
bun install
bun run build
```

运行项目检查：

```bash
bun run check
```

插件当前只提供入口骨架，后续任务会注册 HTML 交互工具。
