// 生成 README 首屏拼图：把两张真实场景截图放进浏览器窗口框，作为项目主视觉。
// 运行：bun run scripts/screenshots/hero.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "@playwright/test";

const imageDir = join(process.cwd(), "docs", "images");
const toDataUri = (file: string): string =>
  `data:image/png;base64,${readFileSync(join(imageDir, file)).toString("base64")}`;

const panel = (src: string, label: string): string => `
  <figure class="panel">
    <div class="chrome">
      <span class="dot red"></span><span class="dot amber"></span><span class="dot green"></span>
      <span class="address">127.0.0.1 · html interaction</span>
    </div>
    <img src="${src}" alt="${label}" />
  </figure>`;

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    width: 1600px;
    padding: 56px 64px 60px;
    background:
      radial-gradient(60rem 32rem at 18% -10%, rgba(37, 99, 235, 0.16), transparent 70%),
      radial-gradient(50rem 30rem at 92% 6%, rgba(14, 165, 233, 0.12), transparent 72%),
      #f2f6fc;
    font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", sans-serif;
    color: #16202f;
  }
  .head { display: flex; align-items: flex-end; justify-content: space-between; margin-bottom: 26px; }
  .title { font-size: 30px; font-weight: 700; letter-spacing: -0.02em; }
  .title span { color: #2563eb; }
  .sub { margin-top: 6px; font-size: 15px; color: #5d6b80; }
  .badge {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 7px 14px; border-radius: 999px;
    background: #fff; border: 1px solid #dde5ef;
    font-size: 13px; color: #4a5871;
    box-shadow: 0 1px 2px rgba(20, 34, 54, 0.05);
  }
  .badge i { width: 7px; height: 7px; border-radius: 50%; background: #0f9d68; }
  .stage { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; align-items: center; }
  .panel { margin: 0; }
    .chrome {
    display: flex; align-items: center; gap: 6px;
    padding: 10px 14px;
    background: #eef3f9;
    border: 1px solid #dde5ef;
    border-bottom: 0;
    border-radius: 14px 14px 0 0;
  }
  .dot { width: 9px; height: 9px; border-radius: 50%; }
  .red { background: #e5705f; } .amber { background: #e5b45f; } .green { background: #6cc08b; }
  .address {
    margin-left: 10px; padding: 3px 10px; border-radius: 6px;
    background: #fff; border: 1px solid #e2e9f2;
    font-size: 11px; color: #7a879b;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .panel img {
    display: block; width: 100%; height: auto;
    border: 1px solid #dde5ef;
    border-top: 0;
    border-radius: 0 0 14px 14px;
    box-shadow: 0 30px 60px -34px rgba(20, 34, 54, 0.45);
  }
</style>
</head>
<body>
  <div class="head">
    <div>
      <div class="title">Agent User Interaction <span>·</span> 用完即弃的交互页面</div>
      <div class="sub">模型现场生成 → 你在浏览器里操作 → 结构化数据回传 → 继续任务</div>
    </div>
    <span class="badge"><i></i>真实插件运行时渲染</span>
  </div>
  <div class="stage">
    ${panel(toDataUri("scenario-env-select.png"), "选择部署环境")}
    ${panel(toDataUri("scenario-review.png"), "代码评审确认")}
  </div>
</body>
</html>`;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1600, height: 900 },
  deviceScaleFactor: 1.5,
});
await page.setContent(html, { waitUntil: "load" });
await page.waitForTimeout(300);
// 只截内容实际高度，避免底部大片留白
const box = await page.locator("body").boundingBox();
const height = Math.ceil(box?.height ?? 900);
await page.setViewportSize({ width: 1600, height });
await page.screenshot({
  path: join(imageDir, "hero.png"),
  clip: { x: 0, y: 0, width: 1600, height },
});
console.log("saved docs/images/hero.png");
await browser.close();
