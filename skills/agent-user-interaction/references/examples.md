# 页面例子

## 确认页面

提交 bridge 由插件在 `create_html_session`/`update_html_session` 时自动注入，页面**不要自己实现或内联 `submitToAgent`**。

下面代码中的 `<script>` 提交处理属于固定基础设施骨架（协议与提交纪律）；`<style>` 与 DOM 结构只是示意，实际布局、配色和控件应按任务自由设计，不要照抄成固定模板。

**操作区护栏（可用性，不固化视觉形态）**：示例中的提交按钮位于正常文档流（`<main>` 末尾）。生成页面时必须让提交入口参与文档流占位——优先放在内容末尾；如需吸底，只能用 `position: sticky`（元素仍在流内、自然占位），禁止用 `position: fixed` 悬浮覆盖内容，也不要用固定 `padding-bottom` 去抵消悬浮层高度；操作区只放提交按钮与 `<output>` 状态提示，`input`/`textarea`/`select` 等输入字段一律留在内容区，不得放进吸底或悬浮的操作区。操作区内主提交控件默认靠右对齐（`justify-content: flex-end`；有状态提示时用 `space-between`，状态在左、主操作在右），次要操作放其左侧，窄屏可整行铺满。

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <style>
      :root {
        color-scheme: light;
        --surface: #ffffff;
        --text: #172033;
        --muted: #5d687a;
        --border: #d9e0ea;
        --accent: #2563eb;
      }

      body {
        background: #f6f8fb;
        color: var(--text);
        font-family: system-ui, sans-serif;
        margin: 0;
      }

      main {
        background: var(--surface);
        border: 1px solid var(--border);
        margin: 8vh auto;
        max-width: 32rem;
        padding: 2rem;
      }

      button {
        background: var(--accent);
        border: 0;
        color: #fff;
        padding: 0.7rem 1rem;
      }

      .actions {
        align-items: center;
        display: flex;
        gap: 1rem;
        justify-content: space-between;
        margin-top: 1.5rem;
      }

      #status { color: var(--muted); }
    </style>
  </head>
  <body>
    <main>
      <h1>确认操作</h1>
      <p>请确认是否继续。</p>
      <div class="actions">
        <output id="status" aria-live="polite"></output>
        <button id="submit" type="button">确认</button>
      </div>
    </main>
    <script>
      const button = document.querySelector("#submit");
      button.addEventListener("click", () => {
        const sent = submitToAgent({ kind: "confirmation", data: { confirmed: true }, metadata: { source: "page" } });
        if (!sent) {
          document.querySelector("#status").textContent = "提交内容无效，请检查后重试";
          return;
        }
        button.disabled = true;
        document.querySelector("#status").textContent = "已提交";
      });
    </script>
  </body>
</html>
```

页面脚本只需调用 `submitToAgent`，并检查其返回值；bridge 本身不写在页面里。

## 两阶段页面更新

第一阶段创建 session 并等待选择：

```text
create_html_session({ html: firstPage })
wait_html_submission({ sessionId })
```

页面使用唯一提交入口：

```js
submitToAgent({ kind, data, metadata });
```

模型根据原始任务处理不可信的第一阶段数据，然后进入第二阶段：

```text
update_html_session({ sessionId, html: secondPage })
wait_html_submission({ sessionId })
end_html_session({ sessionId })
```

第二阶段仍然只允许一个提交入口，并继续调用 `submitToAgent({ kind, data, metadata })`。更新页面后，第一阶段页面产生的迟提交会因 stale page 被拒绝。
