import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { submitBridgeSource } from "../opencode-v1-aui/src/runtime/pageRuntime";

const skillDirectory = resolve(import.meta.dir, "../skills/agent-user-interaction");
const skillPath = resolve(skillDirectory, "SKILL.md");
const protocolPath = resolve(skillDirectory, "references/page-protocol.md");
const examplesPath = resolve(skillDirectory, "references/examples.md");
const skeletonPath = resolve(skillDirectory, "assets/skeleton.html");

const readAsset = (path: string) => readFile(path, "utf8");

describe("agent-user-interaction skill assets", () => {
  it("defines the exact model workflow and page boundaries", async () => {
    const skill = await readAsset(skillPath);

    for (const toolName of [
      "create_html_session",
      "wait_html_submission",
      "update_html_session",
      "end_html_session",
    ]) {
      expect(skill).toContain(toolName);
    }
    expect(skill).toMatch(/exactly one|single submit|唯一.*提交|一个.*提交/i);
    expect(skill).toMatch(/post-submit.*disabl|提交.*禁用/i);
    expect(skill).toMatch(/untrusted|不可信|不受信任/i);
    expect(skill).toMatch(/no CDN|无 CDN|不依赖.*CDN|不得.*外部|external resource/i);
    expect(skill).toMatch(/network|网络/i);
    expect(skill).toMatch(/filesystem|文件系统/i);
    // 技能定义必须与具体宿主实现无关（后续可能支持 pi agent 等其它智能体插件）
    expect(skill).not.toMatch(/opencode/i);
    expect(skill).toMatch(/宿主智能体/);
    expect(skill).toMatch(/visual|视觉|complex|复杂|form|表单|multi-step|多步骤/i);
    expect(skill).toMatch(/内联/);
    expect(skill).toMatch(/自动打开/);
    expect(skill).toMatch(/浅色优先/);
    expect(skill).toMatch(/CSS 变量/);
    expect(skill).toMatch(/对比度/);
    // P1：bridge 由插件自动注入，模型不自己实现
    expect(skill).toMatch(/自动注入/);
  });

  it("documents protocol, security restrictions, and complete examples", async () => {
    const [protocol, skill, examples] = await Promise.all([
      readAsset(protocolPath),
      readAsset(skillPath),
      readAsset(examplesPath),
    ]);

    for (const field of ["type", "payload", "kind", "data", "metadata"]) {
      expect(protocol).toContain(field);
    }
    expect(protocol).toMatch(/version|版本/i);
    expect(protocol).toMatch(/stale|过期|陈旧/i);
    expect(protocol).toMatch(/duplicate|重复/i);
    expect(protocol).toMatch(/SESSION_NOT_FOUND|WAIT_TIMEOUT|PAYLOAD_TOO_LARGE/);
    expect(protocol).not.toContain("`TIMEOUT`");
    // 安全边界已合并进 SKILL.md
    expect(skill).toMatch(/sandbox/i);
    expect(skill).toMatch(/CSP/i);
    expect(skill).toMatch(/filesystem|文件系统/i);
    expect(skill).toMatch(/connect-src[^\n]*none|connect-src.*none/i);
    expect(skill).toMatch(/same-origin|同源/i);
    expect(examples).toContain("submitToAgent({ kind, data, metadata })");
    // P1：bridge 由插件自动注入，示例不再内联 bridge 实现
    expect(examples).toMatch(/自动注入|插件.*注入/);
    expect(examples).not.toMatch(/function\s+submitToAgent/);
    expect(examples).not.toContain('type: "html-submit"');
    expect(examples).not.toContain("window.parent.postMessage");
    // 提交前检查返回值，只有发送成功才进入已提交状态
    expect(examples).toContain("if (!sent)");
    expect(examples).toMatch(/已提交/);
    expect((examples.match(/submitToAgent\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the injected bridge browser-local and sends the required envelope", async () => {
    const bridge = submitBridgeSource;

    expect(bridge).toContain("submitToAgent");
    expect(bridge).toContain('type: "html-submit"');
    expect(bridge).toContain("kind");
    expect(bridge).toContain("data");
    expect(bridge).toContain("metadata");
    expect(bridge).toContain("window.parent.postMessage");
    expect(bridge).not.toMatch(/fetch|XMLHttpRequest|localhost|127\.0\.0\.1/i);
    expect(bridge).not.toMatch(/claude/i);
  });

  it("sends JSON-compatible data through the executed bridge", () => {
    const { submitToAgent, messages } = executeBridge(submitBridgeSource);

    expect(
      submitToAgent({
        kind: "confirm",
        data: { ok: true, nested: [1, "two"] },
        metadata: { source: "page" },
      }),
    ).toBe(true);
    expect(messages).toEqual([
      {
        type: "html-submit",
        payload: {
          kind: "confirm",
          data: { ok: true, nested: [1, "two"] },
          metadata: { source: "page" },
          pageVersion: 1,
        },
      },
    ]);
  });

  it("rejects invalid bridge input without sending messages", () => {
    const { submitToAgent, messages } = executeBridge(submitBridgeSource);
    const circularData: { self?: unknown } = {};
    circularData.self = circularData;

    expect(submitToAgent({ kind: "", data: {}, metadata: {} })).toBe(false);
    expect(submitToAgent({ kind: "valid", data: circularData, metadata: {} })).toBe(false);
    expect(
      submitToAgent({ kind: "valid", data: { value: Number.POSITIVE_INFINITY }, metadata: {} }),
    ).toBe(false);
    expect(
      submitToAgent({ kind: "valid", data: {}, metadata: { value: "x".repeat(64 * 1024) } }),
    ).toBe(false);
    expect(submitToAgent(null)).toBe(false);
    expect(submitToAgent({ kind: "valid", data: undefined, metadata: {} })).toBe(false);
    expect(submitToAgent({ kind: "valid", data: {}, metadata: undefined })).toBe(false);
    expect(messages).toHaveLength(0);
  });

  it("marks the example bridge as reusable without fixing UI form", async () => {
    const examples = await readAsset(examplesPath);

    expect(examples).toMatch(/基础设施骨架/);
    expect(examples).toMatch(/布局.*配色.*控件.*自由/);
  });

  it("骨架页是自包含展示资源，不含提交入口或外部引用", async () => {
    const skeleton = await readAsset(skeletonPath);

    expect(skeleton).toMatch(/正在生成/);
    // 骨架页只负责展示，冒烟测试豁免的前提是它没有提交入口
    expect(skeleton).not.toContain("submitToAgent");
    expect(skeleton).not.toMatch(/<script[^>]*\ssrc=/i);
    expect(skeleton).not.toMatch(/<link[^>]*\shref=/i);
    expect(skeleton).not.toMatch(/https?:\/\//i);
    // 操作区护栏同样适用于展示资源：不得用 fixed 悬浮
    expect(skeleton).not.toMatch(/position:\s*fixed/i);
  });

  it("示例把提交操作区留在文档流内", async () => {
    const examples = await readAsset(examplesPath);

    expect(examples).toMatch(/操作区护栏/);
    expect(examples).toMatch(/position:\s*sticky/);
    expect(examples).toMatch(/禁止用[\s\S]*position:\s*fixed/);
    expect(examples).toMatch(/输入字段一律留在内容区/);
    // 主提交控件默认靠右对齐
    expect(examples).toMatch(/靠右对齐/);
    expect(examples).toMatch(/class="actions"/);
    expect(examples).toMatch(/justify-content:\s*space-between/);
  });
});

const executeBridge = (
  bridge: string,
): {
  submitToAgent: (payload: unknown) => boolean;
  messages: unknown[];
} => {
  const messages: unknown[] = [];
  const windowObject: {
    parent: { postMessage: (message: unknown) => void };
    submitToAgent?: (payload: unknown) => boolean;
  } = {
    parent: {
      postMessage: (message: unknown) => messages.push(message),
    },
  };
  const evaluator = new Function("window", bridge);
  evaluator(windowObject);
  if (!windowObject.submitToAgent) throw new Error("bridge 未暴露 submitToAgent");
  return { submitToAgent: windowObject.submitToAgent, messages };
};
