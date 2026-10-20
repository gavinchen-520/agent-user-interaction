export const protocolVersion = 1 as const;
// 提交回传数据（页面 → wrapper）大小上限，与页面本身大小无关
export const defaultMaxPayloadBytes = 64 * 1024;
// 内联传入的 HTML 大小上限（快通道）；超过时回退用 htmlFile
export const defaultMaxInlineHtmlBytes = 64 * 1024;
export const defaultTimeoutMs = 300_000;
export const defaultSessionTtlMs = 30 * 60 * 1000;
// 回退通道（htmlFile）能承载的页面大小上限，按用户确认收紧到 3 MiB
export const defaultMaxPageFileBytes = 3 * 1024 * 1024;
export const cleanupIntervalMs = 5 * 60 * 1000;
