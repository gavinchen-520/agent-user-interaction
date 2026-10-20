import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { collectHtmlIssues } from "../../opencode-v1-aui/src/runtime/htmlValidation";

const fixture = (name: string): string =>
  readFileSync(resolve(import.meta.dir, "../fixtures/html-smoke", name), "utf8");

describe("生产沙箱兼容性静态校验", () => {
  it("拒绝依赖原生表单提交的页面", () => {
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
