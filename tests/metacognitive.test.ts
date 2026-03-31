import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((...args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

vi.mock("../backend/utils/file-store.js", () => ({
  safeReadJSON: () => ({
    entries: [],
    calibrationScore: 0.5,
  }),
  atomicWriteJSON: vi.fn(),
  ensureDir: vi.fn(),
}));

vi.mock("../backend/config.js", () => ({
  BRAIN_DIR: "/tmp/test-brain",
}));

import {
  assessConfidence,
  recordOutcome,
  getCalibrationSummary,
  resetCalibration,
} from "../backend/metacognitive.js";

beforeEach(() => {
  resetCalibration();
});

describe("assessConfidence", () => {
  it("returns higher confidence with more context", () => {
    const mockGraph = {
      allNodes: vi.fn().mockReturnValue(new Array(100).fill(null)),
    } as any;

    const assessment = assessConfidence(
      "send_message",
      20,
      5,
      true,
      mockGraph,
    );

    expect(assessment.confidence).toBeGreaterThan(0.5);
    expect(assessment.factors.length).toBe(4);
    expect(assessment.action).toBe("send_message");
  });

  it("returns lower confidence with minimal context", () => {
    const mockGraph = {
      allNodes: vi.fn().mockReturnValue([]),
    } as any;

    const assessment = assessConfidence(
      "send_message",
      0,
      0,
      false,
      mockGraph,
    );

    expect(assessment.confidence).toBeLessThan(0.5);
  });

  it("includes reasoning string", () => {
    const mockGraph = {
      allNodes: vi.fn().mockReturnValue(new Array(50).fill(null)),
    } as any;

    const assessment = assessConfidence(
      "test_action",
      10,
      3,
      true,
      mockGraph,
    );

    expect(assessment.reasoning).toContain("information_completeness");
    expect(assessment.reasoning).toContain("%");
  });

  it("clamps confidence to 0-1 range", () => {
    const mockGraph = {
      allNodes: vi.fn().mockReturnValue(new Array(1000).fill(null)),
    } as any;

    const assessment = assessConfidence(
      "test_action",
      100,
      100,
      true,
      mockGraph,
    );

    expect(assessment.confidence).toBeLessThanOrEqual(1);
    expect(assessment.confidence).toBeGreaterThanOrEqual(0);
  });
});

describe("recordOutcome", () => {
  it("records an outcome without throwing", () => {
    expect(() => recordOutcome(0.8, true)).not.toThrow();
  });

  it("records multiple outcomes", () => {
    recordOutcome(0.9, true);
    recordOutcome(0.3, false);
    recordOutcome(0.7, true);
    // No error means success
  });
});

describe("getCalibrationSummary", () => {
  it("returns empty when not enough data", () => {
    expect(getCalibrationSummary()).toBe("");
  });

  it("returns summary after enough outcomes", () => {
    // Record 15 outcomes
    for (let i = 0; i < 15; i++) {
      recordOutcome(0.8, Math.random() > 0.2);
    }

    const summary = getCalibrationSummary();
    expect(summary).toContain("Calibration");
    expect(summary).toContain("%");
  });
});
