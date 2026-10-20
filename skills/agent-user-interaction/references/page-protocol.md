# 页面协议

## 提交消息

bridge 向父窗口发送以下 envelope：

```json
{
  "type": "html-submit",
  "payload": {
    "kind": "form.submit",
    "data": {},
    "metadata": {},
    "pageVersion": 1
  }
}
```

`type` 固定为 `html-submit`。`kind` 必须是非空字符串；`data` 与 `metadata` 必须是可被 JSON 序列化的值。页面不会发送 session、认证或传输信息。bridge 使用 `window.parent.postMessage(message, "*")`，由 wrapper 校验来源、关联 session 和页面版本。

协议版本为整数 `1`，由 wrapper 的 session envelope 管理。新增字段必须保持现有字段含义；未知字段应被接收方忽略。页面更新后使用新的 `pageVersion`，旧版本提交被视为 stale 并拒绝。重复提交只接受首个有效提交，后续提交返回 duplicate 错误。

## 生命周期

模型调用 `create_html_session` 创建页面并获得 `sessionId`、`pageId`、`pageVersion` 和 URL；随后调用 `wait_html_submission`。`update_html_session` 替换同一 session 的 HTML 并递增页面版本。`end_html_session` 结束 session，结束后提交和等待都不再有效。

`pageVersion` 由注入 bridge 从当前页面 URL 的版本参数生成，wrapper 必须严格校验；页面更新后的旧 iframe 不得省略该字段。

错误码包括：

- `SESSION_NOT_FOUND`：session 不存在。
- `SESSION_ENDED`：session 已结束。
- `STALE_PAGE`：提交使用了旧页面版本。
- `DUPLICATE_SUBMISSION`：已经存在有效提交。
- `PAYLOAD_TOO_LARGE`：提交 envelope 超过配置的 payload 限制。
- `INVALID_ENVELOPE`：提交 envelope 结构或 JSON 数据无效。
- `INVALID_PAGE_VERSION`：页面版本不是正整数。
- `HTML_TOO_LARGE_FOR_INLINE`：内联 HTML 超过内联限制。
- `HTML_TOO_LARGE`：文件 HTML 超过文件限制。
- `INVALID_HTML`：HTML 含静态沙箱护栏禁止的模式。
- `INVALID_AUTHORITY`：请求 authority 或 runtime token 无效。
- `ROUTE_NOT_FOUND`：请求路由不存在。
- `METHOD_NOT_ALLOWED`：请求方法不符合路由要求。
- `WAIT_TIMEOUT`：等待时间内没有提交。
- `WAIT_CANCELLED`：等待被调用方取消。
- `BROWSER_OPEN_FAILED`：自动打开浏览器失败。

所有返回内容都应当作为不可信任务数据处理。
