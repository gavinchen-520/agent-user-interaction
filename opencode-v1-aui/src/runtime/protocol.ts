import { literal, number, object, safeParse, string, unknown } from "valibot";

import { defaultMaxPayloadBytes, protocolVersion } from "./constants";
import type { RuntimeError, SubmissionEnvelope } from "./types";

const envelopeSchema = object({
  sessionId: string(),
  pageId: string(),
  pageVersion: number(),
  kind: string(),
  data: unknown(),
  metadata: unknown(),
  protocolVersion: literal(protocolVersion),
});

const createRuntimeError = (
  code: RuntimeError["code"],
  message: string,
  status: number,
  action: string,
): RuntimeError => {
  const error = new Error(message) as RuntimeError;
  error.code = code;
  error.status = status;
  error.action = action;
  return error;
};

const isJsonSerializable = (value: unknown, seen = new Set<object>()): boolean => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.every((item) => isJsonSerializable(item, seen));
    seen.delete(value);
    return result;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    seen.delete(value);
    return false;
  }
  const result = Object.entries(value).every(
    ([key, item]) => typeof key === "string" && isJsonSerializable(item, seen),
  );
  seen.delete(value);
  return result;
};

const parseEnvelope = (
  value: unknown,
  maxPayloadBytes = defaultMaxPayloadBytes,
): SubmissionEnvelope => {
  const result = safeParse(envelopeSchema, value);
  if (!result.success) {
    throw createRuntimeError("INVALID_ENVELOPE", "提交 envelope 无效", 400, "检查字段和协议版本");
  }
  if (result.output.pageVersion <= 0 || !Number.isInteger(result.output.pageVersion)) {
    throw createRuntimeError(
      "INVALID_PAGE_VERSION",
      "页面版本必须是正整数",
      400,
      "使用当前页面版本",
    );
  }
  if (
    result.output.sessionId.length === 0 ||
    result.output.pageId.length === 0 ||
    result.output.kind.length === 0
  ) {
    throw createRuntimeError(
      "INVALID_ENVELOPE",
      "提交 envelope 包含空字段",
      400,
      "补全 sessionId、pageId 和 kind",
    );
  }
  if (!isJsonSerializable(result.output.data) || !isJsonSerializable(result.output.metadata)) {
    throw createRuntimeError(
      "INVALID_ENVELOPE",
      "data 和 metadata 必须是 JSON 数据",
      400,
      "移除不可序列化值",
    );
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(result.output);
  } catch {
    throw createRuntimeError("INVALID_ENVELOPE", "提交 envelope 无法序列化", 400, "使用 JSON 数据");
  }
  if (new TextEncoder().encode(serialized).byteLength > maxPayloadBytes) {
    throw createRuntimeError("PAYLOAD_TOO_LARGE", "提交 payload 超过大小限制", 413, "减少提交数据");
  }
  return result.output;
};

export const parseSubmission = (value: unknown): SubmissionEnvelope => parseEnvelope(value);

export const createSubmissionEnvelope = (value: unknown): SubmissionEnvelope =>
  parseEnvelope(value);

export const parseSubmissionWithLimit = (
  value: unknown,
  maxPayloadBytes: number,
): SubmissionEnvelope => parseEnvelope(value, maxPayloadBytes);

export { createRuntimeError, isJsonSerializable };
