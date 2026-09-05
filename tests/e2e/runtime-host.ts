// Bun 子进程宿主：通过 stdin/stdout 的 JSON 行协议驱动 HTML runtime，
// 供 Playwright（Node worker 无法直接使用 Bun.serve）以串行方式控制真实 server。

import { createHtmlRuntime } from "../../opencode-plugin/src/runtime";
import { createRuntimeServer } from "../../opencode-plugin/src/runtime/server";

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
let server: Awaited<ReturnType<typeof createRuntimeServer>> | undefined;

const getActiveSessionId = (): string => runtime.listSessions()[0]?.sessionId ?? "";

const handleCommand = async (command: HostCommand): Promise<void> => {
  switch (command.type) {
    case "create": {
      const created = await runtime.createSession({ title: command.title, html: command.html });
      server = await createRuntimeServer(runtime, { openBrowser: false });
      writeMessage({
        type: "ready",
        url: server.url,
        sessionId: created.sessionId,
        pageId: created.pageId,
        pageVersion: created.pageVersion,
        token: runtime.getSession(created.sessionId)?.token ?? "",
      });
      return;
    }
    case "wait": {
      // 只注册等待，不阻塞后续命令；结果异步写回 stdout
      runtime
        .waitSubmission({ sessionId: getActiveSessionId(), timeoutMs: command.timeoutMs })
        .then(
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
      const updated = await runtime.updateSession({
        sessionId: getActiveSessionId(),
        html: command.html,
      });
      writeMessage({ type: "updated", ...updated });
      return;
    }
    case "end": {
      const result = await runtime.endSession(getActiveSessionId());
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
      await server?.stop(true);
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
      await handleCommand(JSON.parse(line) as HostCommand);
    }
    newlineIndex = pending.indexOf("\n");
  }
}
