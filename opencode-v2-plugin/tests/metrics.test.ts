import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTimingLog, createTurnTracker } from "../src/metrics";

describe("createTurnTracker", () => {
  test("记录起点后可读取；未知会话为 null；新起点覆盖旧值", () => {
    const tracker = createTurnTracker();
    expect(tracker.get("ses_a")).toBeNull();

    const t1 = 1_000;
    tracker.recordStart("ses_a", t1);
    expect(tracker.get("ses_a")).toBe(t1);

    const t2 = 2_000;
    tracker.recordStart("ses_a", t2);
    expect(tracker.get("ses_a")).toBe(t2);
    expect(tracker.get("ses_b")).toBeNull();
  });
});

describe("createTimingLog", () => {
  test("追加两行 JSONL 并自动创建缺失目录", async () => {
    const root = mkdtempSync(join(tmpdir(), "v2-metrics-"));
    const logPath = join(root, "nested", "dir", "timings.jsonl");
    const log = createTimingLog(logPath);

    await log.append({ phase: "pageReady", durationMs: 12, bytes: 100 });
    await log.append({ phase: "pageReady", durationMs: 34, bytes: 200 });

    expect(existsSync(logPath)).toBeTrue();
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ phase: "pageReady", durationMs: 12, bytes: 100 });
    expect(JSON.parse(lines[1])).toMatchObject({ phase: "pageReady", durationMs: 34, bytes: 200 });
    rmSync(root, { recursive: true, force: true });
  });

  test("写入失败必须吞掉而非上抛（不得拖垮工具执行）", async () => {
    const root = mkdtempSync(join(tmpdir(), "v2-metrics-"));
    mkdirSync(join(root, "sub"));
    // 用一个常规文件占住父目录路径，让内部的 mkdir 必然失败
    writeFileSync(join(root, "blocker"), "not a directory");
    const log = createTimingLog(join(root, "blocker", "child", "timings.jsonl"));
    await expect(log.append({ phase: "pageReady" })).resolves.toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });
});
