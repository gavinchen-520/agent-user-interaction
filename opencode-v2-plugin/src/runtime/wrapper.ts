import { isJsonSerializable } from "../runtime/protocol";

export type WrapperInput = {
  title?: string;
  sessionId: string;
  pageId: string;
  pageVersion: number;
  pageUrl: string;
  submitUrl: string;
  versionUrl: string;
  token: string;
  maxMessageBytes?: number;
};

export type WrapperMessageEvent = {
  source: unknown;
  data: unknown;
};

type WrapperMessagePayload = {
  kind: string;
  data: unknown;
  metadata: unknown;
};

type WrapperHandlerOptions = {
  source: unknown;
  pageVersion: number;
  maxMessageBytes?: number;
  submit: (payload: WrapperMessagePayload) => Promise<void> | void;
};

const isPayload = (value: unknown, pageVersion: number): value is WrapperMessagePayload => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.kind !== "string" || record.kind.length === 0) return false;
  if (!("data" in record) || !("metadata" in record)) return false;
  if (record.pageVersion !== pageVersion) return false;
  return isJsonSerializable(record.data) && isJsonSerializable(record.metadata);
};

export const createWrapperMessageHandler = (options: WrapperHandlerOptions) => {
  let submitted = false;
  return async (event: WrapperMessageEvent): Promise<void> => {
    if (submitted || event.source !== options.source) return;
    const data = event.data;
    if (data === null || typeof data !== "object" || Array.isArray(data)) return;
    const message = data as Record<string, unknown>;
    if (message.type !== "html-submit" || !isPayload(message.payload, options.pageVersion)) return;
    let serialized: string;
    try {
      serialized = JSON.stringify(message.payload);
    } catch {
      return;
    }
    if (new TextEncoder().encode(serialized).byteLength > (options.maxMessageBytes ?? 64 * 1024))
      return;
    submitted = true;
    await options.submit(message.payload);
  };
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const buildWrapperHtml = (input: WrapperInput): string => {
  const config = JSON.stringify({
    sessionId: input.sessionId,
    pageId: input.pageId,
    pageVersion: input.pageVersion,
    pageUrl: input.pageUrl,
    submitUrl: input.submitUrl,
    versionUrl: input.versionUrl,
    token: input.token,
    maxMessageBytes: input.maxMessageBytes ?? 64 * 1024,
  }).replaceAll("</", "<\\/");
  // 初始 iframe 必须带 ?v=<pageVersion>：页面内 submitToAgent 从 URL 读取版本，
  // 缺失时退回 1，会与 wrapper 的 config.pageVersion 不一致而被静默丢弃。
  const pageSrc = `${input.pageUrl}${input.pageUrl.includes("?") ? "&" : "?"}v=${input.pageVersion}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(input.title ?? "HTML interaction")}</title><style>
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI","PingFang SC",sans-serif;background:#fff}
iframe{display:block;border:0;width:100%;height:100%;background:#fff}
#status{position:fixed;top:10px;left:10px;z-index:10;display:inline-flex;align-items:center;height:16px;border-radius:999px;background:rgba(255,255,255,.92);box-shadow:0 1px 4px rgba(20,35,60,.2);overflow:hidden;white-space:nowrap}
#status .dot{width:8px;height:8px;border-radius:50%;background:#94a3b8;flex:none;margin:4px}
#status .label{font-size:12px;line-height:16px;color:#1b2532;max-width:0;opacity:0;overflow:hidden;transition:max-width .16s ease,opacity .16s ease,margin-right .16s ease}
#status:hover .label{max-width:140px;opacity:1;margin-right:9px}
#status[data-state="updated"] .dot{background:#2563eb}
#status[data-state="submitting"] .dot{background:#e0a94a}
#status[data-state="submitted"] .dot{background:#0f9d68}
#status[data-state="error"] .dot{background:#d94a3d}
</style></head><body><span id="status" role="status" data-state="pending" aria-label="待操作"><span class="dot" aria-hidden="true"></span><span class="label">待操作</span></span><iframe sandbox="allow-scripts" src="${escapeHtml(pageSrc)}"></iframe><script>
const config = ${config};
const statusEl = document.getElementById("status");
const statusLabel = statusEl.querySelector(".label");
const setStatus = (state, text) => { statusEl.dataset.state = state; statusLabel.textContent = text; statusEl.setAttribute("aria-label", text); };
const frame = document.querySelector("iframe");
let submitted = false;
// 自适应轮询：新页面打开后快轮询（250ms）让骨架→真实页的刷新尽快可见，
// 闲置时指数退避到上限 2s，避免常驻标签页空转；版本更新或页面重新可见时回 250ms。
let pollDelay = 250;
let pollTimer;
let currentVersion = config.pageVersion;
const applyVersion = (info) => {
  if (!info || typeof info.pageVersion !== "number" || info.pageVersion === currentVersion) return;
  currentVersion = info.pageVersion;
  config.pageVersion = info.pageVersion;
  if (typeof info.pageId === "string") config.pageId = info.pageId;
  pollDelay = 250;
  submitted = false;
  setStatus("updated", "已更新");
  frame.src = config.pageUrl + (config.pageUrl.includes("?") ? "&" : "?") + "v=" + currentVersion;
};
const schedulePoll = () => {
  pollTimer = setTimeout(pollVersion, pollDelay);
};
const pollVersion = async () => {
  try {
    const response = await fetch(config.versionUrl);
    if (response.status === 404 || response.status === 410) return; // 会话已结束，停轮
    if (response.ok) applyVersion(await response.json());
  } catch {}
  pollDelay = Math.min(pollDelay * 2, 2000);
  schedulePoll();
};
schedulePoll();
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearTimeout(pollTimer);
    return;
  }
  clearTimeout(pollTimer);
  pollDelay = 250;
  schedulePoll();
});
window.addEventListener("pagehide", () => {
  clearTimeout(pollTimer);
});
const isJson = (value, seen = new Set()) => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const result = Array.isArray(value) ? value.every((item) => isJson(item, seen)) : Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every((item) => isJson(item, seen));
  seen.delete(value);
  return result;
};
window.addEventListener("message", async (event) => {
  if (submitted || event.source !== frame.contentWindow || !event.data || event.data.type !== "html-submit") return;
  const payload = event.data.payload;
   if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof payload.kind !== "string" || !payload.kind || !("data" in payload) || !("metadata" in payload) || !isJson(payload.data) || !isJson(payload.metadata) || payload.pageVersion !== config.pageVersion) return;
  let body;
  try { body = JSON.stringify({ sessionId: config.sessionId, pageId: config.pageId, pageVersion: config.pageVersion, kind: payload.kind, data: payload.data, metadata: payload.metadata, protocolVersion: 1 }); } catch { return; }
  if (new TextEncoder().encode(body).byteLength > config.maxMessageBytes) return;
  submitted = true;
  setStatus("submitting", "提交中");
  try {
    const response = await fetch(config.submitUrl, { method: "POST", headers: { "content-type": "application/json", "x-runtime-token": config.token }, body });
    if (!response.ok) throw new Error("submit failed");
    setStatus("submitted", "已提交");
   } catch { submitted = false; setStatus("error", "提交失败"); }
});
</script></body></html>`;
};
