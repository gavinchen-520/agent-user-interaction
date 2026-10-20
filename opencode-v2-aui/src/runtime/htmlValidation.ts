// 生产沙箱兼容性校验的唯一实现：真实 wrapper 的 iframe 为 sandbox="allow-scripts"
// 且页面 CSP 含 form-action 'none' / connect-src 'none'，jsdom 不执行这些约束。
// 命中以下模式在 jsdom 能过、到生产必然失效，因此在 create/update 时作为硬门禁拒绝。
export type HtmlIssue = {
  code: HtmlIssueCode;
  message: string;
};

export type HtmlIssueCode =
  | "NATIVE_FORM_SUBMIT"
  | "REQUEST_SUBMIT"
  | "FORM_SUBMIT"
  | "LOCAL_STORAGE"
  | "DOCUMENT_COOKIE"
  | "MODAL_DIALOG"
  | "WINDOW_OPEN"
  | "NETWORK_REQUEST";

type HtmlRule = {
  code: HtmlIssueCode;
  pattern: RegExp;
  message: string;
};

const htmlRules: HtmlRule[] = [
  {
    code: "NATIVE_FORM_SUBMIT",
    pattern: /type\s*=\s*["']?submit["']?/i,
    message:
      '禁止依赖原生表单提交（type=submit）：生产 iframe 为 sandbox="allow-scripts" 且 CSP 含 form-action \'none\'，提交会被拦截且不触发 submit 事件；请改用 type="button" 并绑定 click 调用 submitToAgent。',
  },
  {
    code: "REQUEST_SUBMIT",
    pattern: /requestSubmit\s*\(/,
    message:
      "禁止使用 form.requestSubmit()：生产沙箱不允许原生表单提交，请用按钮 click 触发 submitToAgent。",
  },
  {
    code: "FORM_SUBMIT",
    pattern: /\.submit\s*\(/,
    message: "禁止使用 form.submit()：生产沙箱不允许原生表单提交。",
  },
  {
    code: "LOCAL_STORAGE",
    pattern: /\b(localStorage|sessionStorage|indexedDB)\b/,
    message:
      "禁止使用 localStorage/sessionStorage/indexedDB：沙箱不含 allow-same-origin（opaque origin），访问会抛 SecurityError。",
  },
  {
    code: "DOCUMENT_COOKIE",
    pattern: /document\s*\.\s*cookie/,
    message: "禁止读写 document.cookie：opaque origin 下不可用。",
  },
  {
    code: "MODAL_DIALOG",
    pattern: /(^|[^.\w$])(alert|confirm|prompt)\s*\(/,
    message: "禁止使用 alert/confirm/prompt：iframe 未授予 allow-modals，调用被静默忽略。",
  },
  {
    code: "WINDOW_OPEN",
    pattern: /window\s*\.\s*open\s*\(/,
    message: "禁止使用 window.open：iframe 未授予 allow-popups。",
  },
  {
    code: "NETWORK_REQUEST",
    pattern:
      /(?<![\w.])fetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|navigator\s*\.\s*sendBeacon/,
    message: "禁止发起网络请求：页面 CSP 为 connect-src 'none'，请求会被拦截。",
  },
];

export const collectHtmlIssues = (html: string): HtmlIssue[] =>
  htmlRules
    .filter((rule) => rule.pattern.test(html))
    .map((rule) => ({ code: rule.code, message: rule.message }));

export const summarizeHtmlIssues = (issues: HtmlIssue[]): string =>
  issues.map((issue) => `[${issue.code}] ${issue.message}`).join("；");
