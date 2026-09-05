import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { expect, test } from "@playwright/test";

// 两阶段页面：渲染表单、探测 CSP 外联限制、通过 postMessage 提交（等价于 submit bridge 的行为）
const buildPhaseHtml = (phase: 1 | 2): string => {
  const field =
    phase === 1
      ? '<label for="name">名字</label><input id="name" value="">'
      : '<label for="choice">方案</label><input id="choice" value="">';
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:system-ui;padding:16px}</style></head><body>
<h1 id="phase">阶段 ${phase}</h1>
${field}
<button id="submit" type="button">提交</button>
<script>
  window.__violation = "";
  document.addEventListener("securitypolicyviolation", (event) => { window.__violation = event.violatedDirective; });
  fetch("https://external-probe.invalid/probe").catch(() => undefined);
  document.getElementById("submit").addEventListener("click", () => {
    const value = document.querySelector("input").value;
    window.parent.postMessage({ type: "html-submit", payload: { kind: "phase-${phase}", data: { phase: ${phase}, value }, metadata: {} } }, "*");
  });
</script>
</body></html>`;
};

type HostMessage =
  | {
      type: "ready";
      url: string;
      sessionId: string;
      pageId: string;
      pageVersion: number;
      token: string;
    }
  | { type: "waiting"; sessionId: string }
  | { type: "submission"; kind: string; data: unknown; metadata: unknown; pageVersion: number }
  | { type: "wait-error"; code: string; message: string }
  | { type: "updated"; pageId: string; pageVersion: number }
  | { type: "ended"; ok: boolean }
  | { type: "inspected"; liveSessions: number; waiters: number };

type ReadyMessage = Extract<HostMessage, { type: "ready" }>;
type SubmissionMessage = Extract<HostMessage, { type: "submission" | "wait-error" }>;

// 串行 fixture：独占一个 Bun 运行时子进程，通过 JSON 行协议通信
class RuntimeHostAgent {
  private readonly host: ChildProcess;
  private readonly messages: HostMessage[] = [];
  private readonly pending: Array<{
    matches: (message: HostMessage) => boolean;
    resolve: (message: HostMessage) => void;
  }> = [];

  constructor() {
    this.host = spawn("bun", ["tests/e2e/runtime-host.ts"], { stdio: ["pipe", "pipe", "inherit"] });
    const lines = createInterface({ input: this.host.stdout });
    lines.on("line", (line: string) => {
      const message = JSON.parse(line) as HostMessage;
      const index = this.pending.findIndex((entry) => entry.matches(message));
      if (index >= 0) this.pending.splice(index, 1)[0].resolve(message);
      else this.messages.push(message);
    });
  }

  private waitFor(matches: (message: HostMessage) => boolean): Promise<HostMessage> {
    const index = this.messages.findIndex(matches);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return new Promise((resolve) => {
      this.pending.push({ matches, resolve });
    });
  }

  private send(command: Record<string, unknown>): void {
    this.host.stdin?.write(`${JSON.stringify(command)}\n`);
  }

  async createSession(html: string, title: string): Promise<ReadyMessage> {
    this.send({ type: "create", html, title });
    return (await this.waitFor((message) => message.type === "ready")) as ReadyMessage;
  }

  // acked 在 host 确认 waiter 注册完成后 resolve；测试必须等 acked 再驱动页面点击
  waitSubmission(timeoutMs: number): {
    acked: Promise<string>;
    result: Promise<SubmissionMessage>;
  } {
    this.send({ type: "wait", timeoutMs });
    const acked = this.waitFor((message) => message.type === "waiting").then(
      (message) => (message as { sessionId: string }).sessionId,
    );
    const result = this.waitFor(
      (message) => message.type === "submission" || message.type === "wait-error",
    ) as Promise<SubmissionMessage>;
    return { acked, result };
  }

  async update(html: string): Promise<Extract<HostMessage, { type: "updated" }>> {
    this.send({ type: "update", html });
    return (await this.waitFor((message) => message.type === "updated")) as Extract<
      HostMessage,
      { type: "updated" }
    >;
  }

  async end(): Promise<Extract<HostMessage, { type: "ended" }>> {
    this.send({ type: "end" });
    return (await this.waitFor((message) => message.type === "ended")) as Extract<
      HostMessage,
      { type: "ended" }
    >;
  }

  async inspect(): Promise<Extract<HostMessage, { type: "inspected" }>> {
    this.send({ type: "inspect" });
    return (await this.waitFor((message) => message.type === "inspected")) as Extract<
      HostMessage,
      { type: "inspected" }
    >;
  }

  async shutdown(): Promise<void> {
    if (this.host.exitCode !== null) return;
    this.send({ type: "shutdown" });
    const exited = new Promise<boolean>((resolve) => {
      this.host.once("exit", () => resolve(true));
    });
    const timeout = new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), 5_000);
    });
    if (!(await Promise.race([exited, timeout]))) this.host.kill("SIGKILL");
    await exited;
  }
}

test.describe.configure({ mode: "serial" });

let host: RuntimeHostAgent;

test.beforeAll(async () => {
  host = new RuntimeHostAgent();
});

test.afterAll(async () => {
  await host.shutdown();
});

test("浏览器完成两阶段交互并拒绝旧页面提交", async ({ browser }) => {
  const ready = await host.createSession(buildPhaseHtml(1), `e2e ${crypto.randomUUID()}`);
  const sessionId = ready.sessionId;

  const context = await browser.newContext();
  const serverHost = new URL(ready.url).host;
  const externalRequests: string[] = [];
  context.on("requestfinished", (request) => {
    if (new URL(request.url()).host !== serverHost) externalRequests.push(request.url());
  });
  const page = await context.newPage();

  // sandbox iframe 只授予 allow-scripts，不含 allow-same-origin
  await page.goto(`${ready.url}/session/${sessionId}`);
  await expect(page.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");

  // 页面在 sandbox iframe 中渲染非空内容，且外联被 CSP 阻止
  const frame =
    page.frames().find((candidate) => candidate.url().endsWith("/page")) ?? page.mainFrame();
  await expect(frame.locator("#phase")).toHaveText("阶段 1");
  await frame.waitForFunction(
    () => (window as { __violation?: string }).__violation === "connect-src",
  );

  // 第一阶段：填写表单、等 host 确认 waiter 注册后再点击提交
  await frame.locator("#name").fill("Ada");
  const firstWait = host.waitSubmission(10_000);
  await expect(firstWait.acked).resolves.toBe(sessionId);
  await frame.locator("#submit").click();
  await expect(firstWait.result).resolves.toMatchObject({
    type: "submission",
    kind: "phase-1",
    pageVersion: 1,
    data: { phase: 1, value: "Ada" },
  });
  await expect(page.locator("#status")).toHaveText("已提交");

  // 更新到 version 2
  const updated = await host.update(buildPhaseHtml(2));
  expect(updated.pageVersion).toBe(2);

  // 旧页面版本的提交被稳定拒绝（409 STALE_PAGE）
  const stale = await page.evaluate(
    async ({ url, token, pageId, sessionValue }) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-runtime-token": token },
        body: JSON.stringify({
          sessionId: sessionValue,
          pageId,
          pageVersion: 1,
          kind: "stale",
          data: {},
          metadata: {},
          protocolVersion: 1,
        }),
      });
      const body = (await response.json()) as { code?: string };
      return { status: response.status, code: body.code };
    },
    {
      url: `${ready.url}/session/${sessionId}/submit`,
      token: ready.token,
      pageId: ready.pageId,
      sessionValue: sessionId,
    },
  );
  expect(stale).toEqual({ status: 409, code: "STALE_PAGE" });

  // 刷新 wrapper 获取 version 2 页面并再次提交
  await page.reload();
  const secondFrame =
    page.frames().find((candidate) => candidate.url().endsWith("/page")) ?? page.mainFrame();
  await expect(secondFrame.locator("#phase")).toHaveText("阶段 2");
  await secondFrame.locator("#choice").fill("方案 B");
  const secondWait = host.waitSubmission(10_000);
  await expect(secondWait.acked).resolves.toBe(sessionId);
  await secondFrame.locator("#submit").click();
  await expect(secondWait.result).resolves.toMatchObject({
    type: "submission",
    kind: "phase-2",
    pageVersion: 2,
    data: { phase: 2, value: "方案 B" },
  });

  // 结束 session 幂等且无残留 session 或 waiter
  await expect(host.end()).resolves.toEqual({ type: "ended", ok: true });
  await expect(host.end()).resolves.toEqual({ type: "ended", ok: false });
  await expect(host.inspect()).resolves.toEqual({ type: "inspected", liveSessions: 0, waiters: 0 });

  // 整个交互没有产生离开 loopback server 的网络请求
  expect(externalRequests).toEqual([]);

  await context.close();
});
