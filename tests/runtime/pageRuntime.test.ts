import { describe, expect, it } from "bun:test";

import { collectHtmlIssues } from "../../opencode-v1-aui/src/runtime/htmlValidation";
import {
  createSubmitBridgeSource,
  injectPageRuntime,
  referencesSubmitToAgent,
  submitBridgeSource,
  tokenStyleSource,
} from "../../opencode-v1-aui/src/runtime/pageRuntime";

const pageCallingSubmit = `<!doctype html>
<html lang="zh-CN">
  <head><title>t</title></head>
  <body>
    <button id="submit" type="button">确认</button>
    <script>submitToAgent({ kind: "k", data: {}, metadata: {} });</script>
  </body>
</html>`;

describe("页面运行时注入", () => {
  it("引用 submitToAgent 时注入规范 bridge 与可选令牌", () => {
    const injected = injectPageRuntime(pageCallingSubmit);

    expect(injected).toContain("data-agent-ui-bridge");
    expect(injected).toContain("data-agent-ui-tokens");
    expect(injected).toContain("function submitToAgent");
    expect(injected).toContain('type: "html-submit"');
    expect(injected).toContain("--accent: #2563eb");
    // bridge 必须定义在 <head> 起始处，先于模型脚本
    expect(injected.indexOf("function submitToAgent")).toBeLessThan(injected.indexOf("确认"));
  });

  it("未引用 submitToAgent 的页面（如骨架页）保持原样", () => {
    const skeleton = `<!doctype html><html><head></head><body><p>正在生成…</p></body></html>`;
    expect(referencesSubmitToAgent(skeleton)).toBe(false);
    expect(injectPageRuntime(skeleton)).toBe(skeleton);
  });

  it("页面已自带桥接实现时跳过注入（兼容旧写法）", () => {
    const legacy = `<html><body><script>function submitToAgent() {}</script><script>submitToAgent();</script></body></html>`;
    const injected = injectPageRuntime(legacy);
    expect(injected).toBe(legacy);
    expect(injected.match(/function submitToAgent/g)).toHaveLength(1);
  });

  it("注入后的文档仍通过沙箱静态门禁", () => {
    expect(collectHtmlIssues(injectPageRuntime(pageCallingSubmit))).toEqual([]);
  });

  it("缺少 head/html 时逐级回退到文档前置", () => {
    const noHead = `<html><body>submitToAgent();</body></html>`;
    const injectedNoHead = injectPageRuntime(noHead);
    expect(injectedNoHead.startsWith("<html>\n<style data-agent-ui-tokens>")).toBe(true);

    const fragment = `submitToAgent();`;
    expect(injectPageRuntime(fragment).startsWith("<style data-agent-ui-tokens>")).toBe(true);
  });

  it("令牌只声明惰性自定义属性，不含 reset 或布局规则", () => {
    expect(tokenStyleSource).toContain(":root");
    expect(tokenStyleSource).toContain("--page-bg");
    expect(tokenStyleSource).toContain("color-scheme: light");
    expect(tokenStyleSource).not.toMatch(/box-sizing|margin|padding|display/);
  });

  it("注入的 bridge 发送标准信封并拒绝非法输入", () => {
    const { submitToAgent, messages } = executeBridge(submitBridgeSource);
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(
      submitToAgent({ kind: "confirm", data: { ok: true }, metadata: { source: "page" } }),
    ).toBe(true);
    expect(messages).toEqual([
      {
        type: "html-submit",
        payload: {
          kind: "confirm",
          data: { ok: true },
          metadata: { source: "page" },
          pageVersion: 1,
        },
      },
    ]);
    expect(submitToAgent({ kind: "", data: {}, metadata: {} })).toBe(false);
    expect(submitToAgent({ kind: "k", data: circular, metadata: {} })).toBe(false);
    expect(submitToAgent(null)).toBe(false);
    expect(messages).toHaveLength(1);
  });

  it("使用调用方传入的 payload 上限", () => {
    const { submitToAgent } = executeBridge(createSubmitBridgeSource(100));
    expect(submitToAgent({ kind: "confirm", data: "x".repeat(200), metadata: {} })).toBe(false);
  });
});

const executeBridge = (
  bridge: string,
): { submitToAgent: (payload: unknown) => boolean; messages: unknown[] } => {
  const messages: unknown[] = [];
  const windowObject: {
    parent: { postMessage: (message: unknown) => void };
    submitToAgent?: (payload: unknown) => boolean;
  } = {
    parent: { postMessage: (message: unknown) => messages.push(message) },
  };
  const evaluator = new Function("window", bridge);
  evaluator(windowObject);
  if (!windowObject.submitToAgent) throw new Error("bridge 未暴露 submitToAgent");
  return { submitToAgent: windowObject.submitToAgent, messages };
};
