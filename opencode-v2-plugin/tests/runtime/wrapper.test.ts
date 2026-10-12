import { describe, expect, it } from "bun:test";

import { buildWrapperHtml, createWrapperMessageHandler } from "../../src/runtime/wrapper";

describe("browser wrapper message bridge", () => {
  it("只接受 iframe 发来的首个有效 html-submit 消息", async () => {
    const source = {};
    const submitted: unknown[] = [];
    const handler = createWrapperMessageHandler({
      source,
      pageVersion: 2,
      maxMessageBytes: 1024,
      submit: async (payload) => {
        submitted.push(payload);
      },
    });

    await handler({
      source,
      data: {
        type: "html-submit",
        payload: { kind: "large", data: "x".repeat(2_000), metadata: {} },
      },
    });

    await handler({
      source: {},
      data: { type: "html-submit", payload: { kind: "bad", data: {}, metadata: {} } },
    });
    await handler({
      source,
      data: { type: "wrong", payload: { kind: "bad", data: {}, metadata: {} } },
    });
    await handler({ source, data: { type: "html-submit", payload: { kind: "bad", data: {} } } });
    await handler({
      source,
      data: {
        type: "html-submit",
        payload: { kind: "ok", data: {}, metadata: {}, pageVersion: 1 },
      },
    });
    await handler({
      source,
      data: {
        type: "html-submit",
        payload: { kind: "ok", data: {}, metadata: {}, pageVersion: 2 },
      },
    });

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toEqual({ kind: "ok", data: {}, metadata: {}, pageVersion: 2 });
  });

  it("生成 wrapper 的 sandbox、POST 和失败后刷新状态行为", () => {
    const html = buildWrapperHtml({
      sessionId: "s",
      pageId: "p",
      pageVersion: 1,
      pageUrl: "/page",
      submitUrl: "/submit",
      versionUrl: "/version",
      token: "secret",
    });
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).toContain('method: "POST"');
    expect(html).toContain('setStatus("error"');
    expect(html).toContain("提交失败");
    expect(html).not.toContain("请重试当前页面");
  });

  it("状态区极简角标：左上角悬浮小圆点，hover 才显示文案，不占布局", () => {
    const html = buildWrapperHtml({
      sessionId: "s",
      pageId: "p",
      pageVersion: 1,
      pageUrl: "/page",
      submitUrl: "/submit",
      versionUrl: "/version",
      token: "secret",
    });
    // 悬浮固定在左上角，不参与布局；iframe 占满整个视口，无空白带
    expect(html).toContain("position:fixed");
    expect(html).toContain("top:10px;left:10px");
    expect(html).toContain("iframe{display:block;border:0;width:100%;height:100%");
    expect(html).not.toContain("calc(100vh");
    expect(html).not.toContain("display:flex;flex-direction:column");
    expect(html).not.toContain('class="hint"');
    // 角标 = 小圆点 + 默认隐藏的文案，hover 才展开显示
    expect(html).toContain('id="status" role="status" data-state="pending"');
    expect(html).toContain('aria-label="待操作"');
    expect(html).toContain('class="dot"');
    expect(html).toContain('class="label"');
    expect(html).toContain("#status:hover .label");
    // 状态通过 data-state 驱动圆点颜色
    expect(html).toContain('#status[data-state="submitted"] .dot{background:');
    expect(html).toContain('#status[data-state="error"] .dot{background:');
    expect(html).toContain('setStatus("updated"');
    expect(html).toContain('setStatus("submitting"');
    expect(html).toContain('setStatus("submitted"');
    expect(html).toContain("statusEl.dataset.state = state");
    expect(html).toContain('statusEl.setAttribute("aria-label", text)');
    expect(html).not.toContain("status.textContent");
  });

  it("自适应轮询版本端点并在版本递增时自动刷新 iframe", () => {
    const html = buildWrapperHtml({
      sessionId: "s",
      pageId: "p",
      pageVersion: 1,
      pageUrl: "/page",
      submitUrl: "/submit",
      versionUrl: "/version",
      token: "secret",
    });
    expect(html).toContain("config.versionUrl");
    // 递归 setTimeout 自适应轮询：快启动（250ms）、闲置指数退避（上限 2s）
    expect(html).toContain("let pollDelay = 250;");
    expect(html).toContain("schedulePoll()");
    expect(html).toContain("pollDelay = Math.min(pollDelay * 2, 2000);");
    expect(html).not.toContain("setInterval(");
    expect(html).not.toContain("clearInterval(versionTimer)");
    // 页面隐藏时停轮、重新可见时恢复快轮询
    expect(html).toContain('document.addEventListener("visibilitychange"');
    expect(html).toContain("if (document.hidden)");
    // 隐藏竞态防护：fetch 在飞期间页面被隐藏，poll 完成后不得再续订调度
    expect(html).toContain("if (document.hidden) return;");
    // 会话结束（404/410）必须停轮，不再重新调度
    expect(html).toContain("response.status === 404 || response.status === 410");
    // 刷新后必须同步最新 pageVersion/pageId，否则新页面提交会被 STALE_PAGE 拒绝
    expect(html).toContain("config.pageVersion = info.pageVersion");
    expect(html).toContain("config.pageId = info.pageId");
    // 新页面允许再次提交
    expect(html).toContain("submitted = false");
    expect(html).toContain("pageVersion !== config.pageVersion");
  });

  it("初始 iframe src 携带 v=<pageVersion>，避免首屏版本不一致导致提交被丢弃", () => {
    // 若初始 iframe 不带 ?v，页面内 submitToAgent 会退回 pageVersion=1，
    // 与 wrapper 的 config.pageVersion 不一致而被静默丢弃（提交丢失）。
    const html = buildWrapperHtml({
      sessionId: "s",
      pageId: "p",
      pageVersion: 3,
      pageUrl: "/session/s/page",
      submitUrl: "/submit",
      versionUrl: "/version",
      token: "secret",
    });
    expect(html).toContain('src="/session/s/page?v=3"');

    const withQuery = buildWrapperHtml({
      sessionId: "s",
      pageId: "p",
      pageVersion: 2,
      pageUrl: "/session/s/page?x=1",
      submitUrl: "/submit",
      versionUrl: "/version",
      token: "secret",
    });
    expect(withQuery).toContain('src="/session/s/page?x=1&amp;v=2"');
  });
});
