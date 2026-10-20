// 用真实插件 runtime + wrapper 渲染 README 场景图。
// 运行：bun run scripts/screenshots/capture.ts
//
// 截图链路与生产一致：create_html_session -> 真实 Bun.serve wrapper ->
// sandbox iframe -> Playwright 打开 wrapper URL 截图。

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { chromium } from "@playwright/test";

type HostMessage =
  | { type: "ready"; sessionId: string; url: string; pageVersion: number }
  | { type: "updated"; pageId: string; pageVersion: number }
  | { type: "ended"; ok: boolean }
  | { type: "error"; message: string };

class ScreenshotHost {
  private readonly host: ChildProcess;
  private readonly messages: HostMessage[] = [];
  private readonly pending: Array<(message: HostMessage) => void> = [];

  constructor() {
    this.host = spawn("bun", [join(import.meta.dir, "host.ts")], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const lines = createInterface({ input: this.host.stdout });
    lines.on("line", (line: string) => {
      const message = JSON.parse(line) as HostMessage;
      if (message.type === "error") throw new Error(message.message);
      const waiter = this.pending.shift();
      if (waiter) waiter(message);
      else this.messages.push(message);
    });
  }

  private send(command: Record<string, unknown>): void {
    this.host.stdin?.write(`${JSON.stringify(command)}\n`);
  }

  private next(): Promise<HostMessage> {
    const buffered = this.messages.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve) => this.pending.push(resolve));
  }

  async create(scenario: string, title: string): Promise<Extract<HostMessage, { type: "ready" }>> {
    this.send({ type: "create", scenario, title });
    return (await this.next()) as Extract<HostMessage, { type: "ready" }>;
  }

  async update(scenario: string): Promise<Extract<HostMessage, { type: "updated" }>> {
    this.send({ type: "update", scenario });
    return (await this.next()) as Extract<HostMessage, { type: "updated" }>;
  }

  async shutdown(): Promise<void> {
    if (this.host.exitCode !== null) return;
    this.send({ type: "shutdown" });
    await new Promise<void>((resolve) => this.host.once("exit", () => resolve()));
  }
}

const outputDir = join(process.cwd(), "docs", "images");
mkdirSync(outputDir, { recursive: true });

const host = new ScreenshotHost();
const browser = await chromium.launch();

const shoot = async (options: {
  scenario: string;
  title: string;
  file: string;
  width?: number;
  height?: number;
  fullPage?: boolean;
  updateTo?: string;
  waitFor?: string;
  clipToMain?: boolean;
}): Promise<void> => {
  const created = await host.create(options.scenario, options.title);
  const page = await browser.newPage({
    viewport: { width: options.width ?? 1280, height: options.height ?? 960 },
    deviceScaleFactor: 2,
  });
  await page.goto(created.url);
  const frame = () =>
    page.frames().find((candidate) => candidate.url().includes("/page")) ?? page.mainFrame();
  await frame().waitForLoadState("domcontentloaded");

  if (options.updateTo) {
    // 走真实的 update_html_session：wrapper 轮询到新版本后自动刷新 iframe
    await host.update(options.updateTo);
    await page
      .waitForFunction(
        (version) =>
          [...document.querySelectorAll("iframe")].some((element) =>
            (element as HTMLIFrameElement).src.includes(`v=${version}`),
          ),
        created.pageVersion + 1,
        { timeout: 10_000 },
      )
      .catch(() => undefined);
    await frame().waitForLoadState("domcontentloaded");
  }

  if (options.waitFor) await frame().locator(options.waitFor).waitFor();

  // 等字体与布局稳定，避免截到动画中间态
  await page.waitForTimeout(400);
  // 只截内容区 + 均匀留白，避免大块空白进入 README
  const box = options.clipToMain ? await frame().locator("main").boundingBox() : null;
  const clip = box
    ? {
        x: Math.max(0, box.x - 48),
        y: Math.max(0, box.y - 48),
        width: Math.min(1280 - Math.max(0, box.x - 48), box.width + 96),
        height: box.height + 96,
      }
    : undefined;
  await page.screenshot({
    path: join(outputDir, options.file),
    fullPage: options.fullPage,
    clip,
  });
  console.log(`saved docs/images/${options.file}`);
  await page.close();
};

await shoot({
  scenario: "env-select",
  title: "选择部署环境",
  file: "scenario-env-select.png",
  clipToMain: true,
});

await shoot({
  scenario: "config-form",
  title: "配置运行参数",
  file: "scenario-config-form.png",
  clipToMain: true,
});

await shoot({
  scenario: "review",
  title: "代码评审确认",
  file: "scenario-review.png",
  clipToMain: true,
});

await shoot({
  scenario: "multistep-1",
  title: "数据库迁移：选择方案",
  file: "scenario-multistep-1.png",
  clipToMain: true,
});

await shoot({
  scenario: "multistep-1",
  title: "数据库迁移：确认参数",
  file: "scenario-multistep-2.png",
  updateTo: "multistep-2",
  waitFor: "#batch",
  clipToMain: true,
});

await browser.close();
await host.shutdown();
