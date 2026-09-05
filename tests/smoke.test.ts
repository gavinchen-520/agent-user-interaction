import { describe, expect, it } from "bun:test";
import packageMetadata from "../opencode-plugin/package.json";

import plugin from "../opencode-plugin/src/index";

describe("OpenCode 插件入口", () => {
  it("导出插件工厂函数", () => {
    expect(typeof plugin).toBe("function");
  });

  it("不声明未由构建脚本生成的类型文件", () => {
    expect(packageMetadata.types).toBeUndefined();
  });
});
