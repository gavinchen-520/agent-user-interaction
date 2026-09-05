import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const skillDirectory = resolve(import.meta.dir, "../skills/html-interaction");
const skillPath = resolve(skillDirectory, "SKILL.md");
const protocolPath = resolve(skillDirectory, "references/page-protocol.md");
const securityPath = resolve(skillDirectory, "references/security.md");
const examplesPath = resolve(skillDirectory, "references/examples.md");
const bridgePath = resolve(skillDirectory, "assets/submit-bridge.js");

const readAsset = (path: string) => readFile(path, "utf8");

describe("html-interaction skill assets", () => {
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
    expect(skill).toMatch(/OpenCode/i);
    expect(skill).toMatch(/visual|视觉|complex|复杂|form|表单|multi-step|多步骤/i);
    expect(skill).toMatch(/内联/);
    expect(skill).toMatch(/自动打开/);
  });

  it("documents protocol, security restrictions, and complete examples", async () => {
    const [protocol, security, examples] = await Promise.all([
      readAsset(protocolPath),
      readAsset(securityPath),
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
    expect(security).toMatch(/sandbox/i);
    expect(security).toMatch(/CSP/i);
    expect(security).toMatch(/filesystem|文件系统/i);
    expect(security).toMatch(/connect-src[^\n]*none|connect-src.*none/i);
    expect(security).toMatch(/same-origin|同源/i);
    expect(examples).toContain("submitToAgent({ kind, data, metadata })");
    // 示例必须内联 bridge 的关键校验与 postMessage 调用，不能依赖外部脚本引用
    expect(examples).not.toContain('src="assets/submit-bridge.js"');
    expect(examples).toMatch(/function\s+submitToAgent/);
    expect(examples).toContain('type: "html-submit"');
    expect(examples).toContain("window.parent.postMessage");
    expect(examples).toContain('payload.kind.trim() === ""');
    expect(examples).toContain("Number.isFinite");
    expect(examples).toContain("64 * 1024");
    // 提交前检查返回值，只有发送成功才进入已提交状态
    expect(examples).toContain("if (!sent)");
    expect(examples).toMatch(/已提交/);
    expect((examples.match(/submitToAgent\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the bridge browser-local and sends the required envelope", async () => {
    const bridge = await readAsset(bridgePath);

    expect(bridge).toContain("submitToAgent");
    expect(bridge).toContain('type: "html-submit"');
    expect(bridge).toContain("kind");
    expect(bridge).toContain("data");
    expect(bridge).toContain("metadata");
    expect(bridge).toContain("window.parent.postMessage");
    expect(bridge).not.toMatch(/fetch|XMLHttpRequest|localhost|127\.0\.0\.1/i);
    expect(bridge).not.toMatch(/claude/i);
  });

  it("sends JSON-compatible data through the executed bridge", async () => {
    const bridge = await readAsset(bridgePath);
    const { submitToAgent, messages } = executeBridge(bridge);

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
        },
      },
    ]);
  });

  it("rejects invalid bridge input without sending messages", async () => {
    const bridge = await readAsset(bridgePath);
    const { submitToAgent, messages } = executeBridge(bridge);
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
