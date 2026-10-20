import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// 服务端 TTFP 代理口径（docs/page-generation-performance-optimization.md §7.1 的收窄版）：
// 以 host 的 session.execution.started 事件为每轮起点，create/update 工具成功返回时
// 计算 durationMs 并追加一行 JSONL。它不需要新的浏览器跨窗口消息（那会触碰
// SKILL.md:72 「跨窗口消息只能通过 submitToAgent」的协议边界），与真实首屏的
// 差距约为 openBrowser+pageReady 的 ~200ms，足以做 P3 与各项优化的 A/B 验收。

// 每轮起点跟踪：opencode 会话 → 最近一次 execution.started 的时间戳
export type TurnTracker = {
  recordStart(sessionId: string, at: number): void;
  get(sessionId: string): number | null;
};

export const createTurnTracker = (): TurnTracker => {
  const starts = new Map<string, number>();
  return {
    recordStart: (sessionId, at) => {
      starts.set(sessionId, at);
    },
    get: (sessionId) => starts.get(sessionId) ?? null,
  };
};

// JSONL 落盘：缺目录自动创建；写入失败必须吞掉——埋点故障不得拖垮工具执行。
// 目录创建放在首次 append 内，保证构造函数本身永不抛出（插件启动安全）。
export type TimingLog = {
  append(record: Record<string, unknown>): Promise<void>;
};

export const createTimingLog = (filePath: string): TimingLog => {
  let directoryReady: Promise<void> | null = null;
  const ensureDirectory = (): Promise<void> => {
    directoryReady ??= mkdir(dirname(filePath), { recursive: true }).then((): void => {});
    return directoryReady;
  };
  return {
    append: async (record) => {
      try {
        await ensureDirectory();
        await appendFile(filePath, `${JSON.stringify(record)}\n`);
      } catch {
        // 埋点是尽力而为：磁盘满、路径不可写等都不上抛
      }
    },
  };
};

// 工具侧消费的最小接口：有起点才需要记录
export type TimingMetrics = {
  getTurnStart(sessionId?: string): number | null;
  appendTiming(record: Record<string, unknown>): void;
};
