import { openBrowser } from "./browser";
import { defaultMaxPayloadBytes } from "./constants";
import { createRuntimeError } from "./protocol";
import type { HtmlRuntime, RuntimeError } from "./types";
import { buildWrapperHtml } from "./wrapper";

// 浏览器打开选项：false 表示不打开，函数表示注入自定义打开实现，缺省由调用方决定
export type OpenBrowserOption = boolean | ((url: string) => Promise<void>);

export type ServerOptions = {
  hostname?: string;
  port?: number;
  publicBaseUrl?: string;
  maxPayloadBytes?: number;
  openBrowser?: OpenBrowserOption;
};

export type RuntimeServer = {
  url: string;
  stop(force?: boolean): Promise<void>;
};

const errorResponse = (
  error: RuntimeError | Error,
  fallbackCode: RuntimeError["code"] = "INVALID_ENVELOPE",
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
  const match = pathname.match(/^\/session\/([^/]+)(?:\/page|\/submit|\/version)?\/?$/);
  return match?.[1];
};

const parseHostPort = (host: string, defaultPort = "80"): string | undefined => {
  try {
    const url = new URL(host.includes("://") ? host : `http://${host}`);
    return url.port || defaultPort;
  } catch {
    return undefined;
  }
};

export const readRequestBodyWithLimit = async (
  request: Request,
  maxPayloadBytes: number,
): Promise<ArrayBuffer> => {
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxPayloadBytes) {
        await reader.cancel();
        throw createRuntimeError(
          "PAYLOAD_TOO_LARGE",
          "提交 payload 超过大小限制",
          413,
          "减少提交数据",
        );
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
};

export const createRuntimeServer = async (
  runtime: HtmlRuntime,
  options: ServerOptions = {},
): Promise<RuntimeServer> => {
  const hostname = options.hostname ?? "127.0.0.1";
  const maxPayloadBytes = options.maxPayloadBytes ?? defaultMaxPayloadBytes;
  const publicBaseUrl = (options.publicBaseUrl ?? "").replace(/\/$/, "");
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname,
      port: options.port ?? 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        // 放宽后的 authority 校验：只校验 Host 端口与监听端口一致，不锁定 hostname，也不校验 Origin
        const hostPort = parseHostPort(request.headers.get("host") ?? "");
        const listenPort = new URL(server.url).port || "80";
        const publicPort = publicBaseUrl
          ? parseHostPort(publicBaseUrl, publicBaseUrl.startsWith("https:") ? "443" : "80")
          : undefined;
        if (hostPort !== listenPort && hostPort !== publicPort)
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
        const versionPath = `/session/${session.sessionId}/version`;
        if (url.pathname === `/session/${session.sessionId}`) {
          if (request.method !== "GET")
            return errorResponse(new Error("请求方法不允许"), "METHOD_NOT_ALLOWED", 405, "wrapper");
          return new Response(
            buildWrapperHtml({
              title: session.title,
              sessionId: session.sessionId,
              pageId: session.pageId,
              pageVersion: session.pageVersion,
              pageUrl: new URL(pagePath, publicBaseUrl || server.url).toString(),
              submitUrl: new URL(submitPath, publicBaseUrl || server.url).toString(),
              versionUrl: new URL(versionPath, publicBaseUrl || server.url).toString(),
              token: session.token,
              maxMessageBytes: maxPayloadBytes,
            }),
            {
              headers: {
                "content-type": "text/html; charset=utf-8",
                "content-security-policy":
                  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'self'; frame-src 'self'; object-src 'none'; form-action 'none'",
              },
            },
          );
        }
        if (url.pathname === pagePath) {
          if (request.method !== "GET")
            return errorResponse(new Error("请求方法不允许"), "METHOD_NOT_ALLOWED", 405, "page");
          if (!session.pageFile)
            return errorResponse(new Error("页面文件不存在"), "SESSION_NOT_FOUND", 404, "page");
          const pageHeaders = {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy":
              "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; navigate-to 'none'",
          };
          // 页面正文一律从磁盘流式读取，不在内存驻留
          return new Response(Bun.file(session.pageFile), { headers: pageHeaders });
        }
        // 版本查询：wrapper 轮询此端点，发现 pageVersion 递增时自动刷新 iframe
        if (url.pathname === versionPath) {
          if (request.method !== "GET")
            return errorResponse(new Error("请求方法不允许"), "METHOD_NOT_ALLOWED", 405, "version");
          return Response.json({ pageVersion: session.pageVersion, pageId: session.pageId });
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
        let body: ArrayBuffer;
        try {
          body = await readRequestBodyWithLimit(request, maxPayloadBytes);
        } catch (error) {
          return errorResponse(
            error instanceof Error ? error : new Error("提交 payload 超过大小限制"),
            "PAYLOAD_TOO_LARGE",
            413,
            "body",
          );
        }
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
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`runtime server 启动失败（${hostname}:${options.port ?? 0}）：${reason}`);
  }
  const result: RuntimeServer = {
    url: server.url.toString().replace(/\/$/, ""),
    stop: async (force = false) => {
      await server.stop(force);
    },
  };
  const baseUrl = publicBaseUrl || result.url;
  runtime.setBaseUrl(baseUrl);
  // 启动时的浏览器打开只针对已有 session 的专属 URL；无 session 时跳过，由 create 工具负责打开
  const openBrowserOption = options.openBrowser ?? false;
  if (openBrowserOption !== false) {
    const firstSession = runtime.listSessions()[0];
    if (firstSession) {
      const open = typeof openBrowserOption === "function" ? openBrowserOption : openBrowser;
      try {
        await open(`${baseUrl}/session/${firstSession.sessionId}`);
      } catch (error) {
        await result.stop(true);
        throw error;
      }
    }
  }
  return result;
};
