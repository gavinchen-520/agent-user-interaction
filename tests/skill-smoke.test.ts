import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const skillDirectory = resolve(import.meta.dir, "../skills/agent-user-interaction");
const scriptPath = resolve(import.meta.dir, "smoke-test.mjs");
const fixtureDirectory = resolve(import.meta.dir, "fixtures/html-smoke");

const runSmokeTest = (fixture: string, args: string[] = []) => {
  const result = spawnSync("node", [scriptPath, resolve(fixtureDirectory, fixture), ...args], {
    encoding: "utf8",
    cwd: import.meta.dir,
  });
  return {
    exitCode: result.status,
    output: `${result.stdout}\n${result.stderr}`,
  };
};

describe("agent-user-interaction smoke gate", () => {
  it("SKILL.md mandates plugin-side inline validation and the >64KiB fallback", async () => {
    const skill = await readFile(resolve(skillDirectory, "SKILL.md"), "utf8");

    // P2：主链路改为内联 html，静态校验由插件在 create/update 时内联执行
    expect(skill).toMatch(/update_html_session/);
    expect(skill).toMatch(/INVALID_HTML/);
    expect(skill).toMatch(/HTML_TOO_LARGE_FOR_INLINE/);
    expect(skill).toMatch(/htmlFile/);
    expect(skill).toMatch(/3 MiB/);
  });

  it("SKILL.md opens a skeleton page first", async () => {
    const skill = await readFile(resolve(skillDirectory, "SKILL.md"), "utf8");

    expect(skill).toContain("assets/skeleton.html");
    expect(skill).toMatch(/骨架/);
  });

  it("defaults generated pages to a broadly usable light theme", async () => {
    const skill = await readFile(resolve(skillDirectory, "SKILL.md"), "utf8");

    expect(skill).toMatch(/浅色优先/);
    expect(skill).toMatch(/CSS 变量/);
    expect(skill).toMatch(/深色.*明确要求|明确要求.*深色/);
    expect(skill).toMatch(/蓝色.*青色.*绿色.*橙色|蓝、青、绿、橙/);
    expect(skill).toMatch(/对比度/);
  });

  it("sets a compact generation budget without changing the inline hard limit", async () => {
    const skill = await readFile(resolve(skillDirectory, "SKILL.md"), "utf8");

    expect(skill).toMatch(/30\s*KiB/);
    expect(skill).toMatch(/htmlFile/);
    expect(skill).toMatch(/冗余 CSS|重复 CSS/);
    expect(skill).toContain("64KiB");
  });

  it("ships the smoke-test script with required assertions", async () => {
    expect(existsSync(scriptPath)).toBe(true);
    const script = await readFile(scriptPath, "utf8");

    // 必须覆盖历史上的真实故障：提交路径 JS 异常导致 submitToAgent 未被调用
    expect(script).toContain("jsdomError");
    expect(script).toContain("html-submit");
    expect(script).toContain("requestSubmit");
    expect(script).toContain("disabled");
    expect(script).toContain("--click");
  });

  it("catches the regression fixture: submit handler crash blocks submission", () => {
    const { exitCode, output } = runSmokeTest("health-form-bad.html");

    expect(exitCode).toBe(1);
    expect(output).toContain("FAIL");
    expect(output).toContain("classList");
  });

  it("passes the fixed form page with automatic fill", () => {
    const { exitCode, output } = runSmokeTest("health-form-fixed.html");

    expect(exitCode).toBe(0);
    expect(output).toContain("PASS");
    expect(output).toContain("health.checkin.submit");
  });

  it("passes a card-selection page driven by --click", () => {
    const { exitCode, output } = runSmokeTest("env-select.html", [
      "--click",
      ".env-card[data-env=production]",
      "--click",
      "#submit",
    ]);

    expect(exitCode).toBe(0);
    expect(output).toContain("PASS");
    expect(output).toContain("deploy.env.select");
  });

  it("fails clearly when a formless page is tested without --click", () => {
    const { exitCode, output } = runSmokeTest("env-select.html");

    expect(exitCode).toBe(1);
    expect(output).toContain("--click");
  });

  it("keeps the reusable infrastructure skeleton scoped to the protocol base", async () => {
    const skill = await readFile(resolve(skillDirectory, "SKILL.md"), "utf8");

    expect(skill).toMatch(/基础设施骨架/);
    expect(skill).toContain("submitToAgent");
    expect(skill).toMatch(/协议底座|提交纪律/);
    expect(skill).toMatch(/布局.*配色.*控件.*不得套用统一模板/);
  });

  it("pre-moves known high-frequency failure modes into the skill", async () => {
    const skill = await readFile(resolve(skillDirectory, "SKILL.md"), "utf8");

    expect(skill).toMatch(/生成前自检/);
    expect(skill).toMatch(/提交控件|提交入口/);
    expect(skill).toMatch(/驳回原因|未通过原因|需修改意见|条件必填/);
    // jsdom 冒烟脚本已移出 skill，模型不需要为其妥协
    expect(skill).not.toMatch(/scrollTo|--set|input\[type=range\]/);
  });

  it("keeps the submit action area in normal document flow", async () => {
    const skill = await readFile(resolve(skillDirectory, "SKILL.md"), "utf8");

    expect(skill).toMatch(/正常文档流的操作区/);
    expect(skill).toMatch(/position:\s*sticky/);
    expect(skill).toMatch(/禁止用[\s\S]*position:\s*fixed/);
    expect(skill).toMatch(/padding-bottom/);
    expect(skill).toMatch(/输入字段一律留在内容区/);
    expect(skill).toMatch(/操作区只放动作控件/);
    expect(skill).toMatch(/主提交控件默认靠右对齐/);
    expect(skill).toMatch(/justify-content:\s*flex-end/);
    expect(skill).toMatch(/space-between/);
  });
});
