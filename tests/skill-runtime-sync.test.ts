import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const sourceDir = join(import.meta.dir, "../skills/html-interaction");
const runtimeDir = join(import.meta.dir, "../.opencode/skills/html-interaction");

// 递归收集相对路径 → 文件内容的清单
const collectFiles = (root: string, current = ""): Map<string, Buffer> => {
  const entries = new Map<string, Buffer>();
  for (const name of readdirSync(join(root, current))) {
    const relative = current ? `${current}/${name}` : name;
    const absolute = join(root, relative);
    if (statSync(absolute).isDirectory()) {
      for (const [child, content] of collectFiles(root, relative))
        entries.set(child, content);
      continue;
    }
    entries.set(relative, readFileSync(absolute));
  }
  return entries;
};

// docs/manual 约定：.opencode/skills 是 skills/ 的运行副本（.opencode/ 整目录
// 被 gitignore，可能不存在——不存在时本门禁跳过而非失败）
const runtimeCopyExists = existsSync(runtimeDir);

describe("skills source ↔ runtime copy sync", () => {
  test(runtimeCopyExists ? "运行副本与源目录逐字节等同" : "运行副本不存在，跳过", () => {
    if (!runtimeCopyExists) return;
    const source = collectFiles(sourceDir);
    const runtime = collectFiles(runtimeDir);
    const sourceNames = [...source.keys()].sort();
    const runtimeNames = [...runtime.keys()].sort();
    expect(runtimeNames).toEqual(sourceNames);
    for (const name of sourceNames) {
      expect(runtime.get(name)?.equals(source.get(name)!)).toBeTrue();
    }
  });
});
