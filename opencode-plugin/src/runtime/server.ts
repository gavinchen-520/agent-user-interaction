import { openBrowser } from "../browser/browser";
import { buildWrapperHtml } from "../browser/wrapper";
import { defaultMaxPayloadBytes } from "./constants";
import type { HtmlRuntime, RuntimeError } from "./types";

export type ServerOptions = {
  hostname?: string;
  port?: number;
  maxPayloadBytes?: number;
  skipBrowser?: boolean;
  sessionId?: string;
};

export type RuntimeServer = {
  url: string;
  stop(force?: boolean): Promise<void>;
};

const errorResponse = (error: RuntimeError | Error, fallbackCode = "INVALID_ENVELOPE", status = 400): Response => {
  const value = error as Partial<RuntimeError>;
  return Response.json({ code: value.code ?? fallbackCode, message: error.message, action: value.action ?? "检查请求" }, { status: value.status ?? status });
};

const getSessionId = (pathname: string, url: URL, fallback?: string): string | undefined => {
  const match = pathname.match(/^\/session\/([^/]+)(?:\/page|\/submit)?\/?$/);
  return match?.[1] ?? url.searchParams.get("sessionId") ?? fallback;
};

const isLoopback = (value: string): boolean => {
  try {
    const hostname = new URL(value.includes("://") ? value : `http://${value}`).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
};

export const createRuntimeServer = async (runtime: HtmlRuntime, options: ServerOptions = {}): Promise<RuntimeServer> => {
  const hostname = options.hostname ?? "127.0.0.1";
  if (!isLoopback(hostname)) throw new Error("runtime server 只允许绑定 loopback 地址");
  const maxPayloadBytes = options.maxPayloadBytes ?? defaultMaxPayloadBytes;
  let server: ReturnType<typeof Bun.serve>;
  server = Bun.serve({
    hostname,
    port: options.port ?? 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const host = request.headers.get("host") ?? "";
      const origin = request.headers.get("origin");
      if (!isLoopback(host) || (origin !== null && !isLoopback(origin))) return errorResponse(new Error("仅允许 loopback 请求"), "INVALID_ENVELOPE", 403);
      const sessionId = getSessionId(url.pathname, url, options.sessionId);
      const session = sessionId ? runtime.getSession(sessionId) : undefined;
      if (!session) return errorResponse(new Error("session 不存在"), "SESSION_NOT_FOUND", 404);
      const pagePath = `/session/${session.sessionId}/page`;
      const submitPath = `/session/${session.sessionId}/submit`;
      if (url.pathname === "/" || url.pathname === `/session/${session.sessionId}`) {
        if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
        return new Response(buildWrapperHtml({ title: session.title, sessionId: session.sessionId, pageId: session.pageId, pageVersion: session.pageVersion, pageUrl: new URL(pagePath, server.url).toString(), submitUrl: new URL(submitPath, server.url).toString(), token: session.token, maxMessageBytes: maxPayloadBytes }), { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame-src 'self'; object-src 'none'; form-action 'none'; navigate-to 'none'" } });
      }
      if (url.pathname === pagePath) {
        if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
        return new Response(session.html, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; img-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; navigate-to 'none'" } });
      }
      if (url.pathname !== submitPath) return new Response("Not Found", { status: 404 });
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      if (request.headers.get("x-runtime-token") !== session.token) return errorResponse(new Error("token 无效"), "INVALID_ENVELOPE", 401);
      const contentLength = Number(request.headers.get("content-length") ?? "0");
      if (contentLength > maxPayloadBytes) return errorResponse(new Error("提交 payload 超过大小限制"), "PAYLOAD_TOO_LARGE", 413);
      const body = await request.arrayBuffer();
      if (body.byteLength > maxPayloadBytes) return errorResponse(new Error("提交 payload 超过大小限制"), "PAYLOAD_TOO_LARGE", 413);
      let value: unknown;
      try { value = JSON.parse(new TextDecoder().decode(body)) as unknown; } catch { return errorResponse(new Error("请求 JSON 无效")); }
      try {
        await runtime.submitSubmission(value);
        return Response.json({ ok: true });
      } catch (error) {
        return errorResponse(error instanceof Error ? error : new Error("提交失败"));
      }
    },
  });
  const result: RuntimeServer = { url: server.url.toString().replace(/\/$/, ""), stop: async (force = false) => { server.stop(force); } };
  if (!options.skipBrowser) {
    try {
      await openBrowser(result.url);
    } catch (error) {
      await result.stop(true);
      throw error;
    }
  }
  return result;
};
