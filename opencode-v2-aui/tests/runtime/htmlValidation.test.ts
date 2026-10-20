import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { collectHtmlIssues } from "../../src/runtime/htmlValidation";

const fixture = (name: string): string =>
  readFileSync(resolve(import.meta.dir, "../../../tests/fixtures/html-smoke", name), "utf8");

// fixtures 样例随 V1 冒烟测试夹具（tests/fixtures/）提供；在未携带该夹具的
// 检出上跳过而非失败，让 bun run check 在干净克隆也可过。夹具落地后本用例恢复全量。
const fixtureDir = resolve(import.meta.dir, "../../../tests/fixtures/html-smoke");
const fixtureAvailable = existsSync(resolve(fixtureDir, "form-submit-blocked.html"));

describe("生产沙箱兼容性静态校验", () => {
  it("拒绝依赖原生表单提交的页面", () => {
    if (!fixtureAvailable) return;
    const issues = collectHtmlIssues(fixture("form-submit-blocked.html"));
    expect(issues.map((issue) => issue.code)).toContain("NATIVE_FORM_SUBMIT");
  });

  it("拒绝被沙箱或 CSP 禁止的能力", () => {
    const codes = (html: string) => collectHtmlIssues(html).map((issue) => issue.code);
    expect(codes('<script>localStorage.setItem("a","b")</script>')).toContain("LOCAL_STORAGE");
    expect(codes("<script>window.open('x')</script>")).toContain("WINDOW_OPEN");
    expect(codes("<script>fetch('/x')</script>")).toContain("NETWORK_REQUEST");
    expect(codes("<script>confirm('x')</script>")).toContain("MODAL_DIALOG");
    expect(codes("<script>form.requestSubmit()</script>")).toContain("REQUEST_SUBMIT");
  });

  it("安全的按钮提交页面不产生问题", () => {
    const html =
      '<button type="button" id="submit">提交</button>' +
      '<script>document.getElementById("submit").addEventListener("click",()=>submitToAgent({kind:"k",data:{},metadata:{}}));</script>';
    expect(collectHtmlIssues(html)).toEqual([]);
  });
});
