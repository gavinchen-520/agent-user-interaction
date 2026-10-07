import { describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPageStore } from "../../src/runtime/pageStore";

const makeDir = (): Promise<string> => mkdtemp(join(tmpdir(), "pstore-"));

describe("pageStore", () => {
  it("写入后可读、路径存在、removeSession 删除目录", async () => {
    const dir = await makeDir();
    const store = createPageStore(dir);
    const path = await store.write("html_a", 1, "<html>1</html>");
    expect(store.exists(path)).toBe(true);
    expect(await readFile(path, "utf8")).toBe("<html>1</html>");
    expect(store.listSessionIds()).toContain("html_a");
    await store.removeSession("html_a");
    expect(store.listSessionIds()).not.toContain("html_a");
    expect(store.exists(path)).toBe(false);
  });

  it("多版本路径不同且文件名带版本号", async () => {
    const dir = await makeDir();
    const store = createPageStore(dir);
    expect(store.path("html_a", 1)).not.toBe(store.path("html_a", 2));
    expect(store.path("html_a", 1).endsWith("page-1.html")).toBe(true);
    expect(store.path("html_a", 2).endsWith("page-2.html")).toBe(true);
    const first = await store.write("html_a", 1, "one");
    const second = await store.write("html_a", 2, "two");
    expect(first).not.toBe(second);
    expect(await readFile(first, "utf8")).toBe("one");
    expect(await readFile(second, "utf8")).toBe("two");
  });

  it("目录以 0700 创建，listSessionIds 只返回 html_ 前缀目录", async () => {
    const dir = await makeDir();
    const store = createPageStore(dir);
    await store.write("html_a", 1, "x");
    await store.write("other", 1, "y");
    expect(store.listSessionIds()).toEqual(["html_a"]);
    const sessionMode = (await stat(join(dir, "html_a"))).mode & 0o777;
    expect(sessionMode).toBe(0o700);
  });

  it("原子写不残留临时文件", async () => {
    const dir = await makeDir();
    const store = createPageStore(dir);
    await store.write("html_a", 1, "body");
    expect(await readdir(join(dir, "html_a"))).toEqual(["page-1.html"]);
  });

  it("removeSession 对不存在的会话不抛错", async () => {
    const dir = await makeDir();
    const store = createPageStore(dir);
    await expect(store.removeSession("html_missing")).resolves.toBeUndefined();
  });
});
