import type { Plugin } from "@opencode-ai/plugin";

import { createHtmlRuntime, createRuntimeServer } from "./runtime";
import { createHtmlSessionTools } from "./tools";

const getDeletedSessionId = (event: { type: string; properties: unknown }): string | undefined => {
  if (
    event.type !== "session.deleted" ||
    typeof event.properties !== "object" ||
    event.properties === null
  )
    return undefined;
  const properties = event.properties as Record<string, unknown>;
  const info = properties.info;
  if (typeof info !== "object" || info === null) return undefined;
  const id = (info as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
};

const plugin: Plugin = async () => {
  const runtime = createHtmlRuntime();
  const server = await createRuntimeServer(runtime, { skipBrowser: true });
  const sessionsByOpenCodeSession = new Map<string, Set<string>>();
  const endSessions = async (sessionIds: Iterable<string>): Promise<void> => {
    await Promise.all(
      [...sessionIds].map(async (sessionId) => {
        await runtime.endSession(sessionId);
      }),
    );
  };

  return {
    tool: createHtmlSessionTools(runtime, (opencodeSessionId, htmlSessionId) => {
      const sessionIds = sessionsByOpenCodeSession.get(opencodeSessionId) ?? new Set<string>();
      sessionIds.add(htmlSessionId);
      sessionsByOpenCodeSession.set(opencodeSessionId, sessionIds);
    }),
    event: async ({ event }) => {
      const sessionId = getDeletedSessionId(event);
      if (!sessionId) return;
      const sessionIds = sessionsByOpenCodeSession.get(sessionId);
      if (!sessionIds) return;
      sessionsByOpenCodeSession.delete(sessionId);
      await endSessions(sessionIds);
    },
    dispose: async () => {
      await endSessions(runtime.listSessions().map((session) => session.sessionId));
      sessionsByOpenCodeSession.clear();
      await server.stop(true);
    },
  };
};

export default plugin;
