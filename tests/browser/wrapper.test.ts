import { describe, expect, it } from "bun:test";

import { createWrapperMessageHandler } from "../../opencode-plugin/src/browser/wrapper";

describe("browser wrapper message bridge", () => {
  it("只接受 iframe 发来的首个有效 html-submit 消息", async () => {
    const source = {};
    const submitted: unknown[] = [];
    const handler = createWrapperMessageHandler({
      source,
      pageVersion: 2,
      maxMessageBytes: 1024,
      submit: async (payload) => submitted.push(payload),
    });

    await handler({ source: {}, data: { type: "html-submit", payload: { kind: "bad", data: {}, metadata: {} } } });
    await handler({ source, data: { type: "wrong", payload: { kind: "bad", data: {}, metadata: {} } } });
    await handler({ source, data: { type: "html-submit", payload: { kind: "bad", data: {} } } });
    await handler({ source, data: { type: "html-submit", payload: { kind: "ok", data: {}, metadata: {}, pageVersion: 1 } } });
    await handler({ source, data: { type: "html-submit", payload: { kind: "ok", data: {}, metadata: {} } } });

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toEqual({ kind: "ok", data: {}, metadata: {} });
  });
});
