import { openBrowser } from "../browser/browser";
import { buildWrapperHtml } from "../browser/wrapper";
import { defaultMaxPayloadBytes } from "./constants";
import type { HtmlRuntime, RuntimeError } from "./types";

// 浏览器打开选项：false 表示不打开，函数表示注入自定义打开实现，缺省由调用方决定
export type OpenBrowserOption = boolean | ((url: string) => Promise<void>);

export type ServerOptions = {
  hostname?: string;
  port?: number;
  maxPayloadBytes?: number;
  openBrowser?: OpenBrowserOption;
};

export type RuntimeServer = {
  url: string;
  stop(force?: boolean): Promise<void>;
};

const errorResponse = (
  error: RuntimeError | Error,
  fallbackCode = "INVALID_ENVELOPE",
  status = 400,
  context = "request",
): Response => {
  const value = error as Partial<RuntimeError>;
  return Response.json(
    {
      code: value.code ?? fallbackCode,
      message: error.message,
      context,
      action: value.action ?? "检查请求",
    },
    { status: value.status ?? status },
  );
};

const getSessionId = (pathname: string): string | undefined => {
  const match = pathname.match(/^\/session\/([^/]+)(?:\/page|\/submit)?\/?$/);
  return match?.[1];
};

const isLoopback = (value: string): boolean => {
  try {
    const hostname = new URL(value.includes("://") ? value : `http://${value}`).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
};

export const createRuntimeServer = async (
  runtime: HtmlRuntime,
  options: ServerOptions = {},
): Promise<RuntimeServer> => {
  const hostname = options.hostname ?? "127.0.0.1";
  if (!isLoopback(hostname)) throw new Error("runtime server 只允许绑定 loopback 地址");
  const maxPayloadBytes = options.maxPayloadBytes ?? defaultMaxPayloadBytes;
  let server: ReturnType<typeof Bun.serve>;
  server = Bun.serve({
    hostname,
    port: options.port ?? 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const authority = new URL(server.url).host;
      const host = request.headers.get("host") ?? "";
      const origin = request.headers.get("origin");
      if (host !== authority || (origin !== null && origin !== new URL(server.url).origin))
        return errorResponse(
          new Error("请求 authority 无效"),
          "INVALID_AUTHORITY",
          403,
          "authority",
        );
      const sessionId = getSessionId(url.pathname);
      if (!sessionId)
        return errorResponse(new Error("路由不存在"), "ROUTE_NOT_FOUND", 404, "route");
      const session = runtime.getSession(sessionId);
      if (!session)
        return errorResponse(new Error("session 不存在"), "SESSION_NOT_FOUND", 404, "session");
      const pagePath = `/session/${session.sessionId}/page`;
      const submitPath = `/session/${session.sessionId}/submit`;
      if (url.pathname === `/session/${session.sessionId}`) {
        if (request.method !== "GET")
          return errorResponse(new Error("请求方法不允许"), "METHOD_NOT_ALLOWED", 405, "wrapper");
        return new Response(
          buildWrapperHtml({
            title: session.title,
            sessionId: session.sessionId,
            pageId: session.pageId,
            pageVersion: session.pageVersion,
            pageUrl: new URL(pagePath, server.url).toString(),
            submitUrl: new URL(submitPath, server.url).toString(),
            token: session.token,
            maxMessageBytes: maxPayloadBytes,
          }),
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "content-security-policy":
                "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'self'; frame-src 'self'; object-src 'none'; form-action 'none'; navigate-to 'none'",
            },
          },
        );
      }
      if (url.pathname === pagePath) {
        if (request.method !== "GET")
          return errorResponse(new Error("请求方法不允许"), "METHOD_NOT_ALLOWED", 405, "page");
        return new Response(session.html, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy":
              "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; navigate-to 'none'",
          },
        });
      }
      if (url.pathname !== submitPath)
        return errorResponse(new Error("路由不存在"), "ROUTE_NOT_FOUND", 404, "route");
      if (request.method !== "POST")
        return errorResponse(new Error("请求方法不允许"), "METHOD_NOT_ALLOWED", 405, "submit");
      if (request.headers.get("x-runtime-token") !== session.token)
        return errorResponse(new Error("token 无效"), "INVALID_AUTHORITY", 401, "auth");
      const contentLength = Number(request.headers.get("content-length") ?? "0");
      if (contentLength > maxPayloadBytes)
        return errorResponse(
          new Error("提交 payload 超过大小限制"),
          "PAYLOAD_TOO_LARGE",
          413,
          "body",
        );
      const body = await request.arrayBuffer();
      if (body.byteLength > maxPayloadBytes)
        return errorResponse(
          new Error("提交 payload 超过大小限制"),
          "PAYLOAD_TOO_LARGE",
          413,
          "body",
        );
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder().decode(body)) as unknown;
      } catch {
        return errorResponse(new Error("请求 JSON 无效"), "INVALID_ENVELOPE", 400, "json");
      }
      try {
        await runtime.submitSubmission(value);
        return Response.json({ ok: true });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error : new Error("提交失败"),
          "INVALID_ENVELOPE",
          400,
          "submit",
        );
      }
    },
  });
  const result: RuntimeServer = {
    url: server.url.toString().replace(/\/$/, ""),
    stop: async (force = false) => {
      await server.stop(force);
    },
  };
  runtime.setBaseUrl(result.url);
  // 启动时的浏览器打开只针对已有 session 的专属 URL；无 session 时跳过，由 create 工具负责打开
  const openBrowserOption = options.openBrowser ?? false;
  if (openBrowserOption !== false) {
    const firstSession = runtime.listSessions()[0];
    if (firstSession) {
      const open = typeof openBrowserOption === "function" ? openBrowserOption : openBrowser;
      try {
        await open(`${result.url}/session/${firstSession.sessionId}`);
      } catch (error) {
        await result.stop(true);
        throw error;
      }
    }
  }
  return result;
};
