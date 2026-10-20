// Bun 子进程宿主：通过 stdin/stdout 的 JSON 行协议驱动 HTML runtime，
// 供 Playwright（Node worker 无法直接使用 Bun.serve）以串行方式控制真实 server。

import { createHtmlRuntime } from "../../opencode-v1-aui/src/runtime";
import { createRuntimeServer } from "../../opencode-v1-aui/src/runtime/server";
import { createHtmlSessionTools } from "../../opencode-v1-aui/src/tools";

type HostCommand =
  | { type: "create"; html: string; title?: string }
  | { type: "wait"; timeoutMs: number }
  | { type: "update"; html: string }
  | { type: "end" }
  | { type: "inspect" }
  | { type: "shutdown" };

const writeMessage = (message: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const runtime = createHtmlRuntime();
const server = await createRuntimeServer(runtime, { openBrowser: false });
const tools = createHtmlSessionTools(runtime, { openBrowser: false, rootDirectory: process.cwd() });
const toolContext = {
  sessionID: "e2e-opencode-session",
  messageID: "e2e-message",
  agent: "e2e-agent",
  directory: process.cwd(),
  worktree: process.cwd(),
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
};

const getActiveSessionId = (): string => runtime.listSessions()[0]?.sessionId ?? "";

const handleCommand = async (command: HostCommand): Promise<void> => {
  switch (command.type) {
    case "create": {
      const result = await tools.create_html_session.execute(
        { title: command.title, html: command.html },
        toolContext,
      );
      const created = JSON.parse(result as string) as {
        sessionId: string;
        pageId: string;
        pageVersion: number;
        url: string;
      };
      writeMessage({
        type: "ready",
        url: created.url,
        sessionId: created.sessionId,
        pageId: created.pageId,
        pageVersion: created.pageVersion,
        token: runtime.getSession(created.sessionId)?.token ?? "",
      });
      return;
    }
    case "wait": {
      const sessionId = getActiveSessionId();
      // waitSubmission 的同步段完成 waiter 注册，注册后回写 ack，供测试确认后再驱动页面点击
      const pendingWait = runtime.waitSubmission({ sessionId, timeoutMs: command.timeoutMs });
      writeMessage({ type: "waiting", sessionId });
      pendingWait.then(
        (submission) => writeMessage({ type: "submission", ...submission }),
        (error: unknown) =>
          writeMessage({
            type: "wait-error",
            code: (error as { code?: string }).code ?? "UNKNOWN",
            message: error instanceof Error ? error.message : String(error),
          }),
      );
      return;
    }
    case "update": {
      const updated = JSON.parse(
        (await tools.update_html_session.execute(
          { sessionId: getActiveSessionId(), html: command.html },
          toolContext,
        )) as string,
      ) as { pageId: string; pageVersion: number };
      writeMessage({ type: "updated", ...updated });
      return;
    }
    case "end": {
      const result = JSON.parse(
        (await tools.end_html_session.execute(
          { sessionId: getActiveSessionId() },
          toolContext,
        )) as string,
      ) as { ok: boolean };
      writeMessage({ type: "ended", ...result });
      return;
    }
    case "inspect": {
      writeMessage({
        type: "inspected",
        liveSessions: runtime.countLiveSessions(),
        waiters: runtime.countWaiters(),
      });
      return;
    }
    case "shutdown": {
      for (const session of runtime.listSessions()) {
        await runtime.endSession(session.sessionId);
      }
      await server.stop(true);
      process.exit(0);
    }
  }
};

let pending = "";
for await (const chunk of process.stdin) {
  pending += chunk.toString();
  let newlineIndex = pending.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = pending.slice(0, newlineIndex);
    pending = pending.slice(newlineIndex + 1);
    if (line.trim().length > 0) {
      // 命令异常也回写结构化 wait-error，避免测试进程悬挂等待永远不会到达的响应
      try {
        await handleCommand(JSON.parse(line) as HostCommand);
      } catch (error) {
        writeMessage({
          type: "wait-error",
          code: "HOST_ERROR",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    newlineIndex = pending.indexOf("\n");
  }
}
