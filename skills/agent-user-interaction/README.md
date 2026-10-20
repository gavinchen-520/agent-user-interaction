# agent-user-interaction（skill）

模型工作流说明。它告诉 Agent **什么时候**该用 HTML 页面、**怎么写**页面、**怎么走**创建 → 等待 → 更新 → 结束的流程。

> 这个 skill **不能单独工作**。它必须配合插件（[`opencode-v2-aui`](../../opencode-v2-aui/README.md) 或 [`opencode-v1-aui`](../../opencode-v1-aui/README.md)）使用：skill 提供工作流约束，插件提供工具与运行时。

---

## 它解决什么

模型默认倾向于用文字列选项。这个 skill 把「需要人做视觉判断」的时刻显式识别出来，并规定：

- 什么时候值得开页面（视觉选择、复杂参数、表单确认、多步骤输入）；
- 页面必须自包含、无外部依赖；
- 提交必须走唯一入口 `submitToAgent`；
- 提交成功后禁用控件、旧版本提交必须失效；
- 页面里不能出现被沙箱禁止的 API。

它同时是**生成质量的护栏**：`SKILL.md` 里的「生成前自检」列出了历史高发失败（`type="submit"`、超大页面、条件必填缺失等），插件侧还有静态门禁兜底。

---

## 安装

必须**整目录复制**：`SKILL.md` 会在运行时引用同目录的 `references/` 和 `assets/`。

### 项目级（仅当前项目生效）

```bash
mkdir -p .opencode/skills
cp -R skills/agent-user-interaction .opencode/skills/
```

### 全局（所有项目生效）

```bash
mkdir -p ~/.config/opencode/skills
cp -R skills/agent-user-interaction ~/.config/opencode/skills/
```

安装后目录结构应为：

```text
.opencode/skills/agent-user-interaction/
├── SKILL.md
├── README.md
├── assets/
│   └── skeleton.html
└── references/
    ├── examples.md
    └── page-protocol.md
```

---

## 验证

1. 重启 OpenCode；
2. 在 skill 列表中确认出现 `agent-user-interaction`；
3. 发起一个需要视觉交互的任务：

   > 创建一个 HTML 页面让我选择部署环境（staging / production），确认后把结果告诉我。

预期行为：

- 模型先创建骨架页（`assets/skeleton.html`），浏览器立即打开，显示「正在生成」；
- 随后 `update_html_session` 换成真实页面，wrapper 自动刷新；
- 你提交后，模型调用 `wait_html_submission` 拿到 `{ kind, data, metadata }` 并复述你的选择；
- 结束时调用 `end_html_session`。

如果模型没有调用这些工具，先检查插件是否安装并启用。

---

## 目录内容

| 文件 | 作用 |
| --- | --- |
| `SKILL.md` | 主工作流说明：页面要求、提交纪律、自检清单、四步流程 |
| `references/page-protocol.md` | 提交 envelope、生命周期、错误码 |
| `references/examples.md` | 完整页面示例（确认页、两阶段更新） |
| `assets/skeleton.html` | 创建后立即展示的骨架页（无提交入口） |
| `README.md` | 本文件 |

---

## 页面约束速查

这些约束同时被插件静态校验，违反会在 create/update 时返回 `INVALID_HTML`：

| 约束 | 说明 |
| --- | --- |
| 唯一提交入口 | 只能有一个明确的提交动作 |
| 禁止原生表单提交 | 用 `type="button"` + `click` 调 `submitToAgent`；`type="submit"`、`requestSubmit()`、`form.submit()` 全部禁止 |
| 禁止本地存储 | `localStorage` / `sessionStorage` / `indexedDB` / `document.cookie` |
| 禁止弹窗 | `alert` / `confirm` / `prompt` |
| 禁止新窗口 | `window.open` |
| 禁止网络请求 | `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` |
| 禁止外部资源 | CDN、远程字体、远程图片；图片只能用 data URI |
| 自包含 | CSS/JS 全部内联，不依赖构建 |
| 大小分档 | 内联 ≤ 64 KiB；超过改用 `htmlFile`（≤ 3 MiB） |
| 响应式 | 窄屏与桌面都可用 |
| 主题 | 默认浅色；颜色集中为 CSS 变量 |
| 操作区 | 提交控件在文档流内；吸底只能用 `position: sticky`，禁止 `fixed` |
| 条件必填 | 驳回原因等字段提交前必须非空校验 |

完整说明见 [`SKILL.md`](./SKILL.md)。

---

## 常见失败

**`INVALID_HTML`：`NATIVE_FORM_SUBMIT`**

页面用了 `<button type="submit">` 或 `<form>` 的默认提交。改成：

```html
<button id="submit" type="button">提交</button>
<script>
  document.querySelector("#submit").addEventListener("click", () => {
    const sent = submitToAgent({ kind: "confirm", data: {}, metadata: {} });
    if (!sent) return;
    document.querySelector("#submit").disabled = true;
  });
</script>
```

**`INVALID_HTML`：`NETWORK_REQUEST`**

页面里有 `fetch(...)`、`XMLHttpRequest` 或 `EventSource`。页面不能发请求，数据只能通过 `submitToAgent` 回传。

**`HTML_TOO_LARGE_FOR_INLINE`**

内联 HTML 超过 64 KiB。优先压缩（减少重复 CSS、用数据驱动渲染）；仍然超限时把页面写到文件，改用 `htmlFile`。

**`STALE_PAGE`**

用了旧版本的页面提交。`update_html_session` 之后只使用新页面；wrapper 会自动刷新 iframe。

**`WAIT_TIMEOUT`**

页面没有调用 `submitToAgent`，或提交控件被禁用/未绑定事件。检查 `click` 处理函数与 `submitToAgent` 的返回值。

**模型没有创建骨架页**

`SKILL.md` 要求先 `create_html_session({ htmlFile: "<skill目录>/assets/skeleton.html" })` 让用户立即看到反馈。若模型跳过，检查 skill 是否被正确加载、`<本技能目录>` 路径是否可解析。

---

## 调整工作流

想改模型行为，直接编辑 `SKILL.md`：

- **收紧/放宽页面约束**：改「页面要求」小节；注意插件侧静态门禁是硬约束，skill 放宽不会绕过它。
- **调整生成目标大小**：改「页面要求」里的大小建议；内联/文件上限由插件配置（`maxInlineHtmlBytes` / `maxPageFileBytes`）。
- **改主题默认值**：改「页面要求」中的浅色优先条款。
- **改流程**：改「工作流」小节。四个工具的顺序由插件保证，skill 只描述调用策略。

修改后重新复制到 `.opencode/skills/`（或 `~/.config/opencode/skills/`）并重启 OpenCode。

> 仓库内的 `tests/skill-assets.test.ts` 会校验 `SKILL.md` 是否仍包含关键约束（工具名、唯一提交、禁用模式、自动注入等），修改时注意同步。

---

## 与插件的关系

| | skill | 插件 |
| --- | --- | --- |
| 提供什么 | 工作流说明、页面约束、示例、骨架页 | 四个工具、HTML 运行时、bridge 注入、静态门禁、提交服务 |
| 安装位置 | skill 搜索目录 | OpenCode 插件配置 |
| 能否单独工作 | 不能 | 不能（缺 skill 时模型不知道何时该用） |

两者都装好，模型才能在正确的时机生成正确的页面。
