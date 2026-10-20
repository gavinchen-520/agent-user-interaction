#!/usr/bin/env node
// agent-user-interaction 页面冒烟测试：在 jsdom 中加载生成的页面，自动填表并触发提交，
// 验证提交链路端到端可用（无 JS 运行错误、发出恰好一条 html-submit、提交控件被禁用）。
//
// 用法：
//   node smoke-test.mjs <page.html> [--click <css>]... [--set <css>=<value>]...
//
// 默认模式（页面含 <form> 且未指定 --click）：自动为所有可交互字段填入合理值，
// 然后点击唯一提交控件（无控件时回退 form.requestSubmit()）。点击而非原生提交，
// 是为了对齐生产环境——真实 wrapper 的 iframe 为 sandbox="allow-scripts" 且 CSP 含
// form-action 'none'，原生表单提交会被拦截且不触发 submit 事件。
// --click <css>：按顺序点击指定元素（适用于无表单的卡片/选择页，可多次传入）。
// --set <css>=<value>：点击前为匹配元素设置值（input/textarea 填 value，radio 填 check）。
//
// 说明：生产沙箱/CSP 的静态兼容性校验已内联进插件（create/update_html_session），
// 本脚本只保留 jsdom 运行时冒烟，作为 CI/开发自测使用。
//
// 优先复用当前项目已安装的 jsdom；缺失时再用 npm 安装到临时目录。

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

function loadJsdom() {
  const candidates = [process.cwd(), path.dirname(new URL(import.meta.url).pathname)];
  for (const base of candidates) {
    try {
      const requireFromBase = createRequire(path.join(base, "noop.js"));
      return requireFromBase("jsdom");
    } catch {
      // 尝试下一个候选目录
    }
  }
  const requireSelf = createRequire(import.meta.url);
  try {
    return requireSelf("jsdom");
  } catch {
    console.error("缺少依赖 jsdom。任选其一：");
    console.error(
      "  1. npm install jsdom --prefix /tmp/html-smoke && cd /tmp/html-smoke && node <脚本路径>/smoke-test.mjs <页面>",
    );
    console.error("  2. 在当前项目安装 jsdom 后重试");
    process.exit(2);
  }
}

const args = process.argv.slice(2);
const htmlPath = args.find((a) => !a.startsWith("--"));
const clicks = [];
const sets = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--click" && args[i + 1]) clicks.push(args[i + 1]);
  if (args[i] === "--set" && args[i + 1]) {
    const separatorIndex = args[i + 1].indexOf("=");
    if (separatorIndex > 0)
      sets.push({
        selector: args[i + 1].slice(0, separatorIndex),
        value: args[i + 1].slice(separatorIndex + 1),
      });
  }
}
if (!htmlPath) {
  console.error(
    "用法: node smoke-test.mjs <page.html> [--click <css>]... [--set <css>=<value>]...",
  );
  process.exit(2);
}

const { JSDOM, VirtualConsole } = loadJsdom();
const html = await readFile(htmlPath, "utf8");

const jsErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (error) =>
  jsErrors.push(
    `${error.message}${error.detail ? `: ${error.detail?.stack ?? error.detail}` : ""}`,
  ),
);
virtualConsole.on("error", (...parts) => jsErrors.push(`console.error: ${parts.join(" ")}`));

const submissions = [];
const dom = new JSDOM(html, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  url: "http://smoke.test/",
  virtualConsole,
  beforeParse(window) {
    // bridge 通过 window.parent.postMessage 发送提交消息；jsdom 中 parent 即自身
    window.postMessage = (message) => {
      if (message && message.type === "html-submit") submissions.push(message.payload);
    };
  },
});

const { window } = dom;
const { document } = window;
const failures = [];
const warnings = [];
let touchedSubmit = false;

function fillAutoValue(element) {
  if (element.disabled || element.readOnly) return;
  if (element.type === "radio" || element.type === "checkbox") {
    element.checked = true;
    element.dispatchEvent(new window.Event("change", { bubbles: true }));
    return;
  }
  let value = "冒烟测试值";
  if (element.type === "email") value = "smoke@example.com";
  if (element.type === "date") value = "2026-09-07";
  if (element.type === "number") {
    const min = element.min === "" ? 0 : Number(element.min);
    const max = element.max === "" ? 100 : Number(element.max);
    value = String(Number(((min + max) / 2).toFixed(1)));
  }
  element.value = value;
  element.dispatchEvent(new window.Event("input", { bubbles: true }));
  element.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function autoFillForm() {
  const fields = document.querySelectorAll("input, select, textarea");
  const filledRadioGroups = new Set();
  for (const element of fields) {
    if (element instanceof window.HTMLSelectElement) {
      const option = Array.from(element.options).find((o) => o.value !== "");
      if (option && !element.disabled) {
        element.value = option.value;
        element.dispatchEvent(new window.Event("change", { bubbles: true }));
      }
      continue;
    }
    if (element.type === "radio") {
      if (filledRadioGroups.has(element.name)) continue;
      filledRadioGroups.add(element.name);
    }
    fillAutoValue(element);
  }
}

function findSubmitControl() {
  const form = document.querySelector("form");
  if (form) {
    const button = form.querySelector('button[type="submit"], input[type="submit"]');
    if (button) return button;
  }
  const byText = Array.from(document.querySelectorAll("button")).find((b) =>
    /提交|确认|submit/i.test(b.textContent ?? ""),
  );
  return byText ?? null;
}

function applySets() {
  for (const { selector, value } of sets) {
    const element = document.querySelector(selector);
    if (!element) {
      failures.push(`--set 选择器未命中: ${selector}`);
      continue;
    }
    if (value === "check") {
      element.checked = true;
      element.dispatchEvent(new window.Event("change", { bubbles: true }));
    } else {
      element.value = value;
      element.dispatchEvent(new window.Event("input", { bubbles: true }));
      element.dispatchEvent(new window.Event("change", { bubbles: true }));
    }
  }
}

function clickSelectors() {
  for (const selector of clicks) {
    const element = document.querySelector(selector);
    if (!element) {
      failures.push(`--click 选择器未命中: ${selector}`);
      continue;
    }
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    if (/提交|确认|submit/i.test(element.textContent ?? "") || element.type === "submit")
      touchedSubmit = true;
  }
}

const form = document.querySelector("form");
const submitControl = findSubmitControl();

try {
  applySets();
  if (clicks.length > 0) {
    clickSelectors();
  } else if (form) {
    autoFillForm();
    touchedSubmit = true;
    if (submitControl) {
      submitControl.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    } else {
      form.requestSubmit();
    }
  } else {
    failures.push(
      "页面没有 <form>，且未提供 --click 指定提交入口；请用 --click <css> 指定要点击的提交元素",
    );
  }
} catch (error) {
  failures.push(`驱动页面时抛异常: ${error.message}`);
}

if (jsErrors.length > 0) failures.push(`页面存在 JS 运行错误:\n    ${jsErrors.join("\n    ")}`);
if (touchedSubmit && submissions.length === 0 && failures.length === 0) {
  failures.push(
    "已触发提交，但未捕获任何 html-submit 消息（submitToAgent 未被调用或提交前被静默拦截）",
  );
}
if (submissions.length > 1)
  failures.push(`发出 ${submissions.length} 条提交消息，超过唯一提交入口约束`);
for (const [index, payload] of submissions.entries()) {
  if (!payload || typeof payload.kind !== "string" || payload.kind.trim() === "") {
    failures.push(`第 ${index + 1} 条提交的 kind 为空`);
  }
}
if (touchedSubmit && submissions.length === 1 && submitControl && !submitControl.disabled) {
  failures.push("提交成功后提交控件未禁用（必须防止重复提交）");
}
if (!submitControl && clicks.length === 0) warnings.push("未找到可识别的提交控件，跳过禁用断言");

console.log(`页面: ${htmlPath}`);
console.log(`提交消息: ${submissions.length} 条`);
for (const payload of submissions) console.log(`  -> ${JSON.stringify(payload)}`);
for (const warning of warnings) console.log(`警告: ${warning}`);
if (failures.length > 0) {
  console.log("结果: FAIL");
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exit(1);
}
console.log("结果: PASS");
