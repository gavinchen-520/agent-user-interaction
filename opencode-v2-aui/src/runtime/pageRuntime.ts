import { defaultMaxPayloadBytes } from "./constants";

// 页面运行时注入：模型只调用 submitToAgent，规范 bridge 与可选设计令牌由插件在 create/update 时注入。
// 本模块是 bridge 的唯一真源；技能侧不再保留 submit-bridge.js 资产，避免双副本漂移。
export const createSubmitBridgeSource = (
  maxPayloadBytes = defaultMaxPayloadBytes,
): string => `(function exposeSubmitBridge(globalWindow) {
  "use strict";

  var maxPayloadBytes = ${maxPayloadBytes};

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
        if (Object.prototype.hasOwnProperty.call(value, key) && !isJsonCompatible(value[key], seen))
          return false;
      }
    }
    seen.delete(value);
    return true;
  }

  function submitToAgent(payload) {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
    if (typeof payload.kind !== "string" || payload.kind.trim() === "") return false;
    if (
      !isJsonCompatible(payload.data, new WeakSet()) ||
      !isJsonCompatible(payload.metadata, new WeakSet())
    )
      return false;
    var message = {
      type: "html-submit",
      payload: {
        kind: payload.kind,
        data: payload.data,
        metadata: payload.metadata,
        pageVersion: Number(new URLSearchParams(globalWindow.location?.search || "").get("v") || "1"),
      },
    };
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
})(window);`;

export const submitBridgeSource = createSubmitBridgeSource();

// 只声明惰性 CSS 自定义属性，不包含任何 reset/布局：不引用即完全无副作用，模型可用可覆盖可无视。
export const tokenStyleSource = `:root {
  color-scheme: light;
  --page-bg: #f6f8fb;
  --surface: #ffffff;
  --text: #172033;
  --muted: #5d687a;
  --border: #d9e0ea;
  --accent: #2563eb;
  --accent-hover: #1d4ed8;
}`;

const headOpenPattern = /<head\b[^>]*>/i;
const htmlOpenPattern = /<html\b[^>]*>/i;
const bridgeDefinitionPattern = /function\s+submitToAgent\b|submitToAgent\s*=/;

// 页面已自带桥接实现时视为旧写法，跳过注入以保证兼容
export const hasSubmitBridgeDefinition = (html: string): boolean =>
  bridgeDefinitionPattern.test(html);

// 判定是否为交互页：只有引用 submitToAgent 的页面才需要注入运行时，骨架页据此保持原样
export const referencesSubmitToAgent = (html: string): boolean => html.includes("submitToAgent");

export const injectPageRuntime = (
  html: string,
  options: { maxPayloadBytes?: number } = {},
): string => {
  if (!referencesSubmitToAgent(html)) return html;
  if (hasSubmitBridgeDefinition(html)) return html;
  const runtime = `<style data-agent-ui-tokens>${tokenStyleSource}</style>\n<script data-agent-ui-bridge>${createSubmitBridgeSource(options.maxPayloadBytes)}</script>`;
  // 注入到 <head> 起始处，保证 bridge 先于任何模型脚本定义；缺失 head/html 时逐级回退
  if (headOpenPattern.test(html))
    return html.replace(headOpenPattern, (match) => `${match}\n${runtime}`);
  if (htmlOpenPattern.test(html))
    return html.replace(htmlOpenPattern, (match) => `${match}\n${runtime}`);
  return `${runtime}\n${html}`;
};
