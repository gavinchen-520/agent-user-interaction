import { describe, expect, it } from "bun:test";

import type { SessionMeta, StorageDomain } from "../../src/runtime/metaStore";
import { createMetaStore } from "../../src/runtime/metaStore";

// 测试用内存 StorageDomain：scan 按 prefix 过滤 backing 的 key，可选 pageSize 验证翻页
const memoryStorage = (backing: Map<string, unknown>, pageSize?: number): StorageDomain => ({
  get: async (key) => backing.get(key),
  set: async (key, value) => {
    backing.set(key, value);
  },
  remove: async (key) => {
    backing.delete(key);
  },
  scan: async ({ prefix, after }) => {
    const keys = [...backing.keys()]
      .filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
      .sort();
    const page = pageSize === undefined ? keys : keys.slice(0, pageSize);
    const next =
      pageSize !== undefined && keys.length > pageSize ? page[page.length - 1] : undefined;
    return { entries: page.map((key) => ({ key, value: backing.get(key) })), next };
  },
});

const baseMeta = (sessionId: string): SessionMeta => ({
  schemaVersion: 1,
  sessionId,
  pageId: `page_${sessionId}`,
  pageVersion: 1,
  token: "t",
  status: "created",
  createdAt: 1,
  updatedAt: 1,
  pageFileName: "page-1.html",
});

describe("metaStore read/write", () => {
  it("meta 往返 + schema 校验丢弃损坏值", async () => {
    const backing = new Map<string, unknown>();
    const storage = memoryStorage(backing);
    const store = createMetaStore(storage);
    const meta = baseMeta("html_a");
    await store.write(meta);
    expect((await store.read("html_a"))?.sessionId).toBe("html_a");
    expect(backing.has("session/html_a/meta")).toBe(true);
    await storage.set("session/html_b/meta", { nope: true });
    expect(await store.read("html_b")).toBeUndefined();
    expect((await store.scanAll()).map((m) => m.sessionId)).toEqual(["html_a"]);
  });

  it("读取缺失 meta 返回 undefined", async () => {
    const store = createMetaStore(memoryStorage(new Map()));
    expect(await store.read("html_missing")).toBeUndefined();
  });

  it("丢弃 state 非 JSON 兼容的 meta", async () => {
    const backing = new Map<string, unknown>();
    const store = createMetaStore(memoryStorage(backing));
    await backing.set("session/html_a/meta", { ...baseMeta("html_a"), state: 1n });
    expect(await store.read("html_a")).toBeUndefined();
  });

  it("接受 JSON 兼容的 state", async () => {
    const backing = new Map<string, unknown>();
    const store = createMetaStore(memoryStorage(backing));
    await store.write({ ...baseMeta("html_a"), state: { step: 2, done: false } });
    expect((await store.read("html_a"))?.state).toEqual({ step: 2, done: false });
  });

  it("remove 删除 meta", async () => {
    const backing = new Map<string, unknown>();
    const store = createMetaStore(memoryStorage(backing));
    await store.write(baseMeta("html_a"));
    await store.remove("html_a");
    expect(await store.read("html_a")).toBeUndefined();
  });

  it("scanAll 翻页收集全部有效 meta，忽略 pending 与损坏项", async () => {
    const backing = new Map<string, unknown>();
    const storage = memoryStorage(backing, 2);
    const store = createMetaStore(storage);
    for (const id of ["html_a", "html_b", "html_c", "html_d", "html_e"]) {
      await store.write(baseMeta(id));
    }
    await storage.set("session/html_a/pending", {
      kind: "k",
      data: {},
      metadata: {},
      pageVersion: 1,
    });
    await storage.set("session/html_b/meta", { broken: true });
    const ids = (await store.scanAll()).map((m) => m.sessionId);
    expect(ids).toEqual(["html_a", "html_c", "html_d", "html_e"]);
  });
});

describe("metaStore pending", () => {
  it("pending 往返", async () => {
    const store = createMetaStore(memoryStorage(new Map()));
    await store.writePending("html_a", { kind: "k", data: { a: 1 }, metadata: {}, pageVersion: 1 });
    expect(await store.readPending("html_a")).toEqual({
      kind: "k",
      data: { a: 1 },
      metadata: {},
      pageVersion: 1,
    });
  });

  it("读取缺失 pending 返回 undefined", async () => {
    const store = createMetaStore(memoryStorage(new Map()));
    expect(await store.readPending("html_a")).toBeUndefined();
  });

  it("丢弃非 JSON 兼容 data/metadata 的 pending", async () => {
    const backing = new Map<string, unknown>();
    const store = createMetaStore(memoryStorage(backing));
    await backing.set("session/html_a/pending", {
      kind: "k",
      data: () => 1,
      metadata: {},
      pageVersion: 1,
    });
    expect(await store.readPending("html_a")).toBeUndefined();
  });

  it("removePending 删除 pending 且不影响 meta", async () => {
    const backing = new Map<string, unknown>();
    const store = createMetaStore(memoryStorage(backing));
    await store.write(baseMeta("html_a"));
    await store.writePending("html_a", { kind: "k", data: {}, metadata: {}, pageVersion: 1 });
    await store.removePending("html_a");
    expect(await store.readPending("html_a")).toBeUndefined();
    expect((await store.read("html_a"))?.sessionId).toBe("html_a");
  });
});

describe("metaStore corrupt purge", () => {
  it("read 校验失败时从 backing 删除损坏 meta", async () => {
    const backing = new Map<string, unknown>();
    const store = createMetaStore(memoryStorage(backing));
    await backing.set("session/html_bad/meta", { nope: true });
    expect(await store.read("html_bad")).toBeUndefined();
    expect(backing.has("session/html_bad/meta")).toBe(false);
  });

  it("read 对缺失 meta 不误删 backing", async () => {
    const backing = new Map<string, unknown>();
    const store = createMetaStore(memoryStorage(backing));
    expect(await store.read("html_missing")).toBeUndefined();
    expect(backing.size).toBe(0);
  });

  it("scanAll 删除损坏 meta 及 sibling pending，保留有效项", async () => {
    const backing = new Map<string, unknown>();
    const store = createMetaStore(memoryStorage(backing));
    await store.write(baseMeta("html_good"));
    await backing.set("session/html_bad/meta", { broken: true });
    await backing.set("session/html_bad/pending", {
      kind: "k",
      data: {},
      metadata: {},
      pageVersion: 1,
    });
    const ids = (await store.scanAll()).map((m) => m.sessionId);
    expect(ids).toEqual(["html_good"]);
    expect(backing.has("session/html_bad/meta")).toBe(false);
    expect(backing.has("session/html_bad/pending")).toBe(false);
    expect(backing.has("session/html_good/meta")).toBe(true);
  });

  it("storage.remove 拒绝时 read 与 scanAll 仍不抛且保持 total", async () => {
    const backing = new Map<string, unknown>();
    const base = memoryStorage(backing);
    const storage: StorageDomain = {
      ...base,
      remove: async () => {
        throw new Error("remove failed");
      },
    };
    const store = createMetaStore(storage);
    await store.write(baseMeta("html_good"));
    await backing.set("session/html_bad/meta", { broken: true });
    expect(await store.read("html_bad")).toBeUndefined();
    expect((await store.scanAll()).map((m) => m.sessionId)).toEqual(["html_good"]);
  });
});
