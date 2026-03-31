import { describe, it, expect, vi } from "vitest";

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

// Mock embeddings to prevent real API calls
vi.mock("../backend/memory/embeddings.js", () => ({
  embedNode: vi.fn().mockResolvedValue(null),
  removeEmbedding: vi.fn(),
}));

import type { MemoryNode, MemoryOperation } from "../backend/memory/types.js";

describe("temporal fact validity", () => {
  it("MemoryNode type supports validFrom and validUntil fields", () => {
    const node: MemoryNode = {
      id: "test_1",
      type: "fact",
      content: "Lucas is 8 years old",
      tags: ["lucas", "age"],
      strength: 0.8,
      pinned: false,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 1,
      validFrom: Date.now(),
      validUntil: Date.now() + 365 * 86400000, // 1 year from now
    };

    expect(node.validFrom).toBeDefined();
    expect(node.validUntil).toBeDefined();
    expect(node.validUntil!).toBeGreaterThan(node.validFrom!);
  });

  it("MemoryOperation add_node supports validUntil", () => {
    const op: MemoryOperation = {
      op: "add_node",
      id: "n_test",
      type: "fact",
      content: "Lucas is 8 years old",
      tags: ["lucas", "age"],
      validUntil: Date.now() + 365 * 86400000,
    };

    expect(op.op).toBe("add_node");
    if (op.op === "add_node") {
      expect(op.validUntil).toBeDefined();
    }
  });

  it("expired facts have validUntil in the past", () => {
    const now = Date.now();
    const expiredNode: MemoryNode = {
      id: "test_expired",
      type: "fact",
      content: "Meeting at 3pm",
      tags: ["meeting"],
      strength: 0.5,
      pinned: false,
      createdAt: now - 86400000, // yesterday
      lastAccessedAt: now - 86400000,
      accessCount: 1,
      validUntil: now - 3600000, // expired 1 hour ago
    };

    expect(expiredNode.validUntil!).toBeLessThan(now);
  });

  it("preference is a valid NodeType", () => {
    const prefNode: MemoryNode = {
      id: "pref_test",
      type: "preference",
      content: "[message_length] prefers short messages",
      tags: ["preference", "message_length"],
      strength: 0.6,
      pinned: false,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 1,
    };

    expect(prefNode.type).toBe("preference");
  });
});

describe("DECAY_LAMBDA", () => {
  it("includes preference type with slow decay", async () => {
    const { DECAY_LAMBDA } = await import("../backend/memory/types.js");
    expect(DECAY_LAMBDA.preference).toBeDefined();
    expect(DECAY_LAMBDA.preference).toBe(0.001); // Very slow, like goals/concepts
  });

  it("includes all 13 node types", async () => {
    const { DECAY_LAMBDA } = await import("../backend/memory/types.js");
    const types = Object.keys(DECAY_LAMBDA);
    expect(types).toHaveLength(13);
    expect(types).toContain("preference");
    expect(types).toContain("person");
    expect(types).toContain("concept");
    expect(types).toContain("belief");
    expect(types).toContain("procedure");
    expect(types).toContain("reflection");
  });
});
