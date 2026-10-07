import { describe, expect, it } from "bun:test";

import {
  createSubmissionEnvelope,
  parseSubmission,
} from "../../src/runtime/protocol";
import type { SubmissionEnvelope } from "../../src/runtime/types";

describe("提交协议", () => {
  const validEnvelope: SubmissionEnvelope = {
    sessionId: "session-1",
    pageId: "page-1",
    pageVersion: 1,
    kind: "confirmation",
    data: { approved: true, values: [1, null, "ok"] },
    metadata: { source: "user" },
    protocolVersion: 1,
  };

  it("接受任意 JSON data 和 metadata", () => {
    expect(parseSubmission(validEnvelope)).toEqual(validEnvelope);
  });

  it("拒绝缺少 sessionId 或 pageId 的 envelope", () => {
    expect(() => parseSubmission({ ...validEnvelope, sessionId: "" })).toThrow(
      expect.objectContaining({ code: "INVALID_ENVELOPE" }),
    );
    expect(() => parseSubmission({ ...validEnvelope, pageId: undefined })).toThrow(
      expect.objectContaining({ code: "INVALID_ENVELOPE" }),
    );
  });

  it("拒绝非正页面版本和空 kind", () => {
    expect(() => parseSubmission({ ...validEnvelope, pageVersion: 0 })).toThrow(
      expect.objectContaining({ code: "INVALID_PAGE_VERSION" }),
    );
    expect(() => parseSubmission({ ...validEnvelope, kind: "" })).toThrow(
      expect.objectContaining({ code: "INVALID_ENVELOPE" }),
    );
  });

  it("拒绝错误协议版本和不可序列化数据", () => {
    expect(() => parseSubmission({ ...validEnvelope, protocolVersion: 2 })).toThrow(
      expect.objectContaining({ code: "INVALID_ENVELOPE" }),
    );
    expect(() => parseSubmission({ ...validEnvelope, data: BigInt(1) })).toThrow(
      expect.objectContaining({ code: "INVALID_ENVELOPE" }),
    );
  });

  it("拒绝超出序列化大小限制的 envelope", () => {
    expect(() => createSubmissionEnvelope({ ...validEnvelope, data: "x".repeat(70_000) })).toThrow(
      expect.objectContaining({ code: "PAYLOAD_TOO_LARGE" }),
    );
  });
});
