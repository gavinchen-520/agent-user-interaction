import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

describe("开源发布基线", () => {
  test("包含 MIT 许可证和脱敏配置示例", () => {
    expect(existsSync(join(root, "LICENSE"))).toBe(true);
    const example = readFileSync(join(root, "opencode.json.example"), "utf8");
    expect(example).not.toContain("0.0.0.0");
    expect(example).not.toContain("@latest");
  });

  test("包含 CI 配置和包许可证元数据", () => {
    expect(existsSync(join(root, ".github/workflows/ci.yml"))).toBe(true);
    const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      license?: string;
    };
    const pluginPackage = JSON.parse(
      readFileSync(join(root, "opencode-v1-aui/package.json"), "utf8"),
    ) as { license?: string };
    expect(rootPackage.license).toBe("MIT");
    expect(pluginPackage.license).toBe("MIT");
  });
});
