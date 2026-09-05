import { describe, expect, it } from "bun:test";

import { buildWrapperHtml, createWrapperMessageHandler } from "../../opencode-plugin/src/browser/wrapper";

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

    await handler({ source, data: { type: "html-submit", payload: { kind: "large", data: "x".repeat(2_000), metadata: {} } } });

    await handler({ source: {}, data: { type: "html-submit", payload: { kind: "bad", data: {}, metadata: {} } } });
    await handler({ source, data: { type: "wrong", payload: { kind: "bad", data: {}, metadata: {} } } });
    await handler({ source, data: { type: "html-submit", payload: { kind: "bad", data: {} } } });
    await handler({ source, data: { type: "html-submit", payload: { kind: "ok", data: {}, metadata: {}, pageVersion: 1 } } });
    await handler({ source, data: { type: "html-submit", payload: { kind: "ok", data: {}, metadata: {} } } });

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toEqual({ kind: "ok", data: {}, metadata: {} });
  });

  it("生成 wrapper 的 sandbox、POST 和失败后刷新状态行为", () => {
    const html = buildWrapperHtml({ sessionId: "s", pageId: "p", pageVersion: 1, pageUrl: "/page", submitUrl: "/submit", token: "secret" });
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).toContain('method: "POST"');
    expect(html).toContain("提交失败，请刷新页面");
    expect(html).not.toContain("请重试当前页面");
  });
});
