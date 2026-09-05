# 页面例子

## 确认页面

```html
<!doctype html>
<html lang="zh-CN">
  <body>
    <main>
      <h1>确认操作</h1>
      <p>请确认是否继续。</p>
      <button id="submit" type="button">确认</button>
      <output id="status" aria-live="polite"></output>
    </main>
    <script src="assets/submit-bridge.js"></script>
    <script>
      const button = document.querySelector("#submit");
      button.addEventListener("click", () => {
        button.disabled = true;
        submitToAgent({ kind: "confirmation", data: { confirmed: true }, metadata: { source: "page" } });
        document.querySelector("#status").textContent = "已提交";
      });
    </script>
  </body>
</html>
```

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
