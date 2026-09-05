import { describe, expect, it } from "bun:test";

import plugin from "../opencode-plugin/src/index";

describe("OpenCode 插件入口", () => {
  it("导出插件工厂函数", () => {
    expect(typeof plugin).toBe("function");
  });
});
