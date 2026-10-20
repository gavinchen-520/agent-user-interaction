import { describe, expect, it } from "bun:test";

import { createWaiterRegistry } from "../../opencode-v1-aui/src/runtime/waiter";

describe("waiter registry", () => {
  it("超时后移除 waiter", async () => {
    const registry = createWaiterRegistry<string, string>();
    const pending = registry.register("one", 1);
    await expect(pending).rejects.toThrow("等待超时");
    expect(registry.count("one")).toBe(0);
  });

  it("取消后移除 waiter", async () => {
    const registry = createWaiterRegistry<string, string>();
    const controller = new AbortController();
    const pending = registry.register("one", 1000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("等待已取消");
    expect(registry.count()).toBe(0);
  });

  it("notifyAll 和 clear 会清理所有 waiter", async () => {
    const registry = createWaiterRegistry<string, string>();
    const first = registry.register("one", 1000);
    const second = registry.register("one", 1000);
    expect(registry.notifyAll("one", "value")).toBe(2);
    await expect(first).resolves.toBe("value");
    await expect(second).resolves.toBe("value");
    const third = registry.register("one", 1000);
    expect(registry.clear("one", new Error("closed"))).toBe(1);
    await expect(third).rejects.toThrow("closed");
    expect(registry.count()).toBe(0);
  });
});
