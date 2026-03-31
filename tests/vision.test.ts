import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRun } = vi.hoisted(() => ({
  mockRun: vi.fn(),
}));

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((...args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

vi.mock("../backend/providers/haiku-runner.js", () => ({
  HaikuRunner: class {
    run = mockRun;
    name = "vision";
  },
}));

// Mock fs to avoid actually writing temp files
vi.mock("fs", async () => {
  const actual = await vi.importActual("fs") as object;
  return {
    ...actual,
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
  };
});

import { describeImage } from "../backend/utils/vision.js";

describe("describeImage", () => {
  beforeEach(() => {
    mockRun.mockReset();
  });

  it("returns null for empty buffer", async () => {
    const result = await describeImage(Buffer.alloc(0), "image/jpeg");
    expect(result).toBeNull();
  });

  it("returns null for oversized buffer", async () => {
    const huge = Buffer.alloc(11 * 1024 * 1024); // 11MB
    const result = await describeImage(huge, "image/jpeg");
    expect(result).toBeNull();
  });

  it("returns description on success", async () => {
    mockRun.mockResolvedValue("A photo of a sunset over the ocean with orange and purple clouds.");

    const result = await describeImage(Buffer.from("image data"), "image/jpeg");
    expect(result).toBe("A photo of a sunset over the ocean with orange and purple clouds.");
  });

  it("returns null when runner returns empty", async () => {
    mockRun.mockResolvedValue("");

    const result = await describeImage(Buffer.from("image data"), "image/jpeg");
    expect(result).toBeNull();
  });

  it("returns null when runner returns null", async () => {
    mockRun.mockResolvedValue(null);

    const result = await describeImage(Buffer.from("image data"), "image/jpeg");
    expect(result).toBeNull();
  });

  it("includes caption context when provided", async () => {
    mockRun.mockResolvedValue("A cat sitting on a keyboard.");

    const result = await describeImage(Buffer.from("image data"), "image/jpeg", "My cat");
    expect(result).toBe("A cat sitting on a keyboard.");
  });

  it("handles runner errors gracefully", async () => {
    mockRun.mockRejectedValue(new Error("spawn failed"));

    const result = await describeImage(Buffer.from("image data"), "image/jpeg");
    expect(result).toBeNull();
  });
});
