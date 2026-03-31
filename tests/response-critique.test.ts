import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRun } = vi.hoisted(() => ({
  mockRun: vi.fn(),
}));

vi.mock("../backend/utils/file-store.js", () => ({
  safeReadJSON: () => ({}),
  atomicWriteJSON: () => {},
  ensureDir: () => {},
}));

vi.mock("../backend/config.js", () => ({
  BRAIN_DIR: "/tmp/test-brain",
  OWNER_NAME: "TestOwner",
}));

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((...args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

vi.mock("../backend/providers/haiku-runner.js", () => ({
  HaikuRunner: class {
    run = mockRun;
    name = "self-critique";
  },
}));

import { critiqueResponse } from "../backend/response-critique.js";

describe("critiqueResponse", () => {
  beforeEach(() => {
    mockRun.mockReset();
  });

  it("bypasses for direct replies (score 10)", async () => {
    const result = await critiqueResponse("Hello owner!", { isDirectReply: true });
    expect(result.shouldSend).toBe(true);
    expect(result.score).toBe(10);
    expect(result.reason).toContain("direct reply");
  });

  it("bypasses for digest messages (score 10)", async () => {
    const result = await critiqueResponse("Morning briefing...", { isDigest: true });
    expect(result.shouldSend).toBe(true);
    expect(result.score).toBe(10);
  });

  it("approves message with score above threshold", async () => {
    mockRun.mockResolvedValue(JSON.stringify({ score: 8, reason: "valuable insight" }));

    const result = await critiqueResponse("I noticed a pattern in your schedule.", {
      recentObservationCount: 10,
      hoursSinceLastMessage: 5,
    });
    expect(result.shouldSend).toBe(true);
    expect(result.score).toBe(8);
  });

  it("suppresses message with score below threshold", async () => {
    mockRun.mockResolvedValue(JSON.stringify({ score: 3, reason: "not warranted" }));

    const result = await critiqueResponse("Just thinking about stuff.", {
      recentObservationCount: 0,
      hoursSinceLastMessage: 0.5,
    });
    expect(result.shouldSend).toBe(false);
    expect(result.score).toBe(3);
  });

  it("fail-open when runner returns null", async () => {
    mockRun.mockResolvedValue(null);

    const result = await critiqueResponse("Some message", {});
    expect(result.shouldSend).toBe(true);
    expect(result.reason).toContain("fail-open");
  });

  it("fail-open when runner throws", async () => {
    mockRun.mockRejectedValue(new Error("timeout"));

    const result = await critiqueResponse("Some message", {});
    expect(result.shouldSend).toBe(true);
    expect(result.reason).toContain("fail-open");
  });

  it("fail-open when response is not valid JSON", async () => {
    mockRun.mockResolvedValue("invalid json here");

    const result = await critiqueResponse("Some message", {});
    expect(result.shouldSend).toBe(true);
  });

  it("clamps score to 1-10 range", async () => {
    mockRun.mockResolvedValue(JSON.stringify({ score: 15, reason: "test" }));

    const result = await critiqueResponse("message", {});
    expect(result.score).toBe(10);

    mockRun.mockResolvedValue(JSON.stringify({ score: -5, reason: "test" }));
    const result2 = await critiqueResponse("message", {});
    expect(result2.score).toBe(1);
  });
});
