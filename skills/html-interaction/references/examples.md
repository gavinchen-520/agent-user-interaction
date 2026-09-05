# 页面例子

## 确认页面

bridge 逻辑必须完整内联在页面脚本中（页面 CSP 只允许内联脚本，`<script src>` 引用外部文件会加载失败）：

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
    <script>
      (function exposeSubmitBridge(globalWindow) {
        "use strict";

        var maxPayloadBytes = 64 * 1024;

        function isJsonCompatible(value, seen) {
          if (value === null || typeof value === "string" || typeof value === "boolean") return true;
          if (typeof value === "number") return Number.isFinite(value);
          if (typeof value !== "object") return false;
          if (seen.has(value)) return false;
          seen.add(value);
          if (Array.isArray(value)) {
            for (var index = 0; index < value.length; index += 1) {
              if (!isJsonCompatible(value[index], seen)) return false;
            }
          } else {
            for (var key in value) {
              if (Object.prototype.hasOwnProperty.call(value, key) && !isJsonCompatible(value[key], seen)) return false;
            }
          }
          seen.delete(value);
          return true;
        }

        function submitToAgent(payload) {
          if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
          if (typeof payload.kind !== "string" || payload.kind.trim() === "") return false;
          if (!isJsonCompatible(payload.data, new WeakSet()) || !isJsonCompatible(payload.metadata, new WeakSet())) return false;
          var message = { type: "html-submit", payload: { kind: payload.kind, data: payload.data, metadata: payload.metadata } };
          var serialized;
          try {
            serialized = JSON.stringify(message);
          } catch (_error) {
            return false;
          }
          if (new TextEncoder().encode(serialized).length > maxPayloadBytes) return false;
          window.parent.postMessage(message, "*");
          return true;
        }

        globalWindow.submitToAgent = submitToAgent;
      })(window);

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
