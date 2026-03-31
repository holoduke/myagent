import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((...args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

vi.mock("../backend/utils/file-store.js", () => ({
  safeReadJSON: () => ({
    probes: {},
    circuitBreakers: {},
    overallStatus: "healthy",
    lastUpdated: Date.now(),
  }),
  atomicWriteJSON: vi.fn(),
  ensureDir: vi.fn(),
}));

vi.mock("../backend/config.js", () => ({
  BRAIN_DIR: "/tmp/test-brain",
}));

import {
  recordProbe,
  probeMemoryHealth,
  isCircuitClosed,
  circuitSuccess,
  circuitFailure,
  getHealthSummary,
  getOverallStatus,
  resetHealthState,
} from "../backend/health-monitor.js";

beforeEach(() => {
  resetHealthState();
});

describe("recordProbe", () => {
  it("records a healthy probe", () => {
    expect(() => recordProbe("test", "healthy", "all good")).not.toThrow();
  });

  it("records a degraded probe", () => {
    expect(() => recordProbe("test", "degraded", "something wrong")).not.toThrow();
  });
});

describe("probeMemoryHealth", () => {
  it("returns healthy for normal graph", () => {
    const probes = probeMemoryHealth(200, 150, 50, 0.6);
    expect(probes.length).toBe(3);
    expect(probes.every(p => p.status === "healthy")).toBe(true);
  });

  it("flags degraded for high node count", () => {
    const probes = probeMemoryHealth(1600, 1000, 50, 0.6);
    const sizeProbe = probes.find(p => p.name === "graph_size");
    expect(sizeProbe?.status).toBe("degraded");
  });

  it("flags critical for very high node count", () => {
    const probes = probeMemoryHealth(1900, 1000, 50, 0.6);
    const sizeProbe = probes.find(p => p.name === "graph_size");
    expect(sizeProbe?.status).toBe("critical");
  });

  it("flags degraded for low average strength", () => {
    const probes = probeMemoryHealth(200, 150, 50, 0.15);
    const strengthProbe = probes.find(p => p.name === "avg_strength");
    expect(strengthProbe?.status).toBe("degraded");
  });

  it("flags degraded for low connectivity", () => {
    const probes = probeMemoryHealth(200, 50, 50, 0.6);
    const connectivityProbe = probes.find(p => p.name === "connectivity");
    expect(connectivityProbe?.status).toBe("degraded");
  });
});

describe("circuit breakers", () => {
  it("starts closed (allows operations)", () => {
    expect(isCircuitClosed("test_service")).toBe(true);
  });

  it("remains closed after success", () => {
    circuitSuccess("test_service");
    expect(isCircuitClosed("test_service")).toBe(true);
  });

  it("opens after threshold failures", () => {
    circuitFailure("test_service");
    circuitFailure("test_service");
    circuitFailure("test_service");
    expect(isCircuitClosed("test_service")).toBe(false);
  });

  it("resets to closed after success", () => {
    circuitFailure("test_service2");
    circuitFailure("test_service2");
    circuitSuccess("test_service2");
    expect(isCircuitClosed("test_service2")).toBe(true);
  });
});

describe("getHealthSummary", () => {
  it("returns a summary string", () => {
    const summary = getHealthSummary();
    expect(summary).toContain("System:");
  });
});

describe("getOverallStatus", () => {
  it("returns healthy by default", () => {
    expect(getOverallStatus()).toBe("healthy");
  });
});
