import { isJsonSerializable } from "../runtime/protocol";

export type WrapperInput = {
  title?: string;
  sessionId: string;
  pageId: string;
  pageVersion: number;
  pageUrl: string;
  submitUrl: string;
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
  if (record.pageVersion !== undefined && record.pageVersion !== pageVersion) return false;
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
    token: input.token,
    maxMessageBytes: input.maxMessageBytes ?? 64 * 1024,
  }).replaceAll("</", "<\\/");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(input.title ?? "HTML interaction")}</title><style>body{font-family:system-ui,sans-serif;margin:0;color:#222}#status{padding:10px 14px;font-size:14px}iframe{display:block;border:0;width:100%;height:calc(100vh - 42px)}</style></head><body><div id="status" role="status">等待提交</div><iframe sandbox="allow-scripts" src="${escapeHtml(input.pageUrl)}"></iframe><script>
const config = ${config};
const status = document.getElementById("status");
const frame = document.querySelector("iframe");
let submitted = false;
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
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof payload.kind !== "string" || !payload.kind || !("data" in payload) || !("metadata" in payload) || !isJson(payload.data) || !isJson(payload.metadata) || (payload.pageVersion !== undefined && payload.pageVersion !== config.pageVersion)) return;
  let body;
  try { body = JSON.stringify({ sessionId: config.sessionId, pageId: config.pageId, pageVersion: config.pageVersion, kind: payload.kind, data: payload.data, metadata: payload.metadata, protocolVersion: 1 }); } catch { return; }
  if (new TextEncoder().encode(body).byteLength > config.maxMessageBytes) return;
  submitted = true;
  status.textContent = "正在提交...";
  try {
    const response = await fetch(config.submitUrl, { method: "POST", headers: { "content-type": "application/json", "x-runtime-token": config.token }, body });
    if (!response.ok) throw new Error("submit failed");
    status.textContent = "已提交";
  } catch { status.textContent = "提交失败，请刷新页面"; }
});
</script></body></html>`;
};
