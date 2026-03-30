import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../backend/utils/file-store.js", () => ({
  safeReadJSON: () => ({}),
  atomicWriteJSON: () => {},
  atomicWriteFile: () => {},
  ensureDir: () => {},
}));

vi.mock("../backend/config.js", () => ({
  BRAIN_DIR: "/tmp/test-brain",
  OWNER_NAME: "TestOwner",
}));

// Mock contact-whitelist — default to allowing all
const mockIsWhitelisted = vi.fn(() => true);
vi.mock("../backend/contact-whitelist.js", () => ({
  isWhitelisted: (...args: unknown[]) => mockIsWhitelisted(...args),
}));

// Mock fs operations used by audit log
vi.mock("fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("fs")>();
  return {
    ...original,
    appendFileSync: vi.fn(),
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ""),
  };
});

import { verify, configureVerifier } from "../backend/action-verifier.js";
import type { ActionContext } from "../backend/action-verifier.js";

function makeAction(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    type: "send_message",
    source: "think",
    targetJid: "alice@s.whatsapp.net",
    messageText: "Hello there!",
    ...overrides,
  };
}

beforeEach(() => {
  mockIsWhitelisted.mockReturnValue(true);
  // Reset verifier config to defaults
  configureVerifier({
    maxOpsPerTick: 100,
    maxRemovesPerTick: 20,
    maxProactiveMessageLength: 4000,
    blockedMessagePatterns: [],
    enforceWhitelist: true,
    maxProposalsPerReflect: 5,
  });
});

// ── Message Verification ──

describe("verify send_message", () => {
  it("allows a valid whitelisted message", () => {
    const result = verify(makeAction());
    expect(result.verdict).toBe("allowed");
    expect(result.reasons).toEqual([]);
  });

  it("blocks non-whitelisted JID", () => {
    mockIsWhitelisted.mockReturnValue(false);
    const result = verify(makeAction({ targetJid: "stranger@s.whatsapp.net" }));
    expect(result.verdict).toBe("blocked");
    expect(result.reasons[0]).toContain("not on whitelist");
  });

  it("blocks empty message body", () => {
    const result = verify(makeAction({ messageText: "   " }));
    expect(result.verdict).toBe("blocked");
    expect(result.reasons[0]).toContain("empty message body");
  });

  it("blocks empty string message", () => {
    const result = verify(makeAction({ messageText: "" }));
    expect(result.verdict).toBe("blocked");
  });

  it("flags long proactive messages", () => {
    const longText = "x".repeat(5000);
    const result = verify(makeAction({ messageText: longText, source: "think" }));
    expect(result.verdict).toBe("flagged");
    expect(result.reasons.some(r => r.includes("message length"))).toBe(true);
  });

  it("does not flag long chat responses", () => {
    const longText = "x".repeat(5000);
    const result = verify(makeAction({ messageText: longText, source: "chat" }));
    expect(result.verdict).toBe("allowed");
  });

  it("flags messages containing potential secrets", () => {
    const result = verify(makeAction({ messageText: "Your api_key is abc123" }));
    expect(result.verdict).toBe("flagged");
    expect(result.reasons.some(r => r.includes("sensitive content"))).toBe(true);
  });

  it("flags 'password' in message", () => {
    const result = verify(makeAction({ messageText: "The password is hunter2" }));
    expect(result.verdict).toBe("flagged");
  });

  it("flags 'bearer ' in message", () => {
    const result = verify(makeAction({ messageText: "bearer xyz123token" }));
    expect(result.verdict).toBe("flagged");
  });

  it("blocks invalid JID format", () => {
    const result = verify(makeAction({ targetJid: "invalid-jid" }));
    expect(result.verdict).toBe("blocked");
    expect(result.reasons.some(r => r.includes("invalid JID format"))).toBe(true);
  });

  it("allows valid individual JID", () => {
    const result = verify(makeAction({ targetJid: "12345@s.whatsapp.net" }));
    expect(result.verdict).toBe("allowed");
  });

  it("allows valid group JID", () => {
    const result = verify(makeAction({ targetJid: "group123@g.us" }));
    expect(result.verdict).toBe("allowed");
  });

  it("blocks with custom blocked patterns", () => {
    configureVerifier({ blockedMessagePatterns: [/forbidden/i] });
    const result = verify(makeAction({ messageText: "This is forbidden content" }));
    expect(result.verdict).toBe("blocked");
    expect(result.reasons.some(r => r.includes("blocked pattern"))).toBe(true);
  });
});

// ── send_scheduled and send_recurring use same verification ──

describe("verify send_scheduled", () => {
  it("verifies scheduled messages the same as regular", () => {
    mockIsWhitelisted.mockReturnValue(false);
    const result = verify(makeAction({ type: "send_scheduled", targetJid: "x@s.whatsapp.net" }));
    expect(result.verdict).toBe("blocked");
  });
});

describe("verify send_recurring", () => {
  it("verifies recurring messages the same as regular", () => {
    const result = verify(makeAction({ type: "send_recurring", messageText: "" }));
    expect(result.verdict).toBe("blocked");
  });
});

// ── Memory Operations Verification ──

describe("verify memory_ops", () => {
  it("allows operations within limits", () => {
    const result = verify({
      type: "memory_ops",
      source: "think",
      operationCount: 10,
      operationTypes: ["add_node", "add_node", "update_node"],
    });
    expect(result.verdict).toBe("allowed");
  });

  it("blocks when operation count exceeds limit", () => {
    const result = verify({
      type: "memory_ops",
      source: "think",
      operationCount: 150,
      operationTypes: [],
    });
    expect(result.verdict).toBe("blocked");
    expect(result.reasons[0]).toContain("exceeds max");
  });

  it("blocks mass deletion", () => {
    const types = Array.from({ length: 25 }, () => "remove_node");
    const result = verify({
      type: "memory_ops",
      source: "consolidate",
      operationCount: 25,
      operationTypes: types,
    });
    expect(result.verdict).toBe("blocked");
    expect(result.reasons.some(r => r.includes("remove_node"))).toBe(true);
  });

  it("flags large batches (>50 ops) even if within limit", () => {
    const result = verify({
      type: "memory_ops",
      source: "think",
      operationCount: 60,
      operationTypes: [],
    });
    expect(result.verdict).toBe("flagged");
    expect(result.reasons.some(r => r.includes("large operation batch"))).toBe(true);
  });

  it("flags at exact limit due to large batch warning", () => {
    const result = verify({
      type: "memory_ops",
      source: "think",
      operationCount: 100,
      operationTypes: Array.from({ length: 20 }, () => "remove_node"),
    });
    // 100 ops > 50 threshold triggers large batch flag, but not blocked
    expect(result.verdict).toBe("flagged");
    expect(result.reasons.some(r => r.includes("large operation batch"))).toBe(true);
  });

  it("allows 50 ops without flag", () => {
    const result = verify({
      type: "memory_ops",
      source: "think",
      operationCount: 50,
      operationTypes: Array.from({ length: 5 }, () => "remove_node"),
    });
    expect(result.verdict).toBe("allowed");
  });
});

// ── Self-Improve Verification ──

describe("verify self_improve", () => {
  it("allows valid proposal", () => {
    const result = verify({
      type: "self_improve",
      source: "reflect",
      proposalDescription: "Improve logging format in observer module",
    });
    expect(result.verdict).toBe("allowed");
  });

  it("blocks empty proposal description", () => {
    const result = verify({
      type: "self_improve",
      source: "reflect",
      proposalDescription: "   ",
    });
    expect(result.verdict).toBe("blocked");
    expect(result.reasons[0]).toContain("empty improvement proposal");
  });

  it("flags proposals touching action-verifier", () => {
    const result = verify({
      type: "self_improve",
      source: "reflect",
      proposalDescription: "Modify action-verifier to allow more ops",
    });
    expect(result.verdict).toBe("flagged");
    expect(result.reasons.some(r => r.includes("sensitive area"))).toBe(true);
  });

  it("flags proposals touching contact-whitelist", () => {
    const result = verify({
      type: "self_improve",
      source: "reflect",
      proposalDescription: "Update contact-whitelist logic",
    });
    expect(result.verdict).toBe("flagged");
  });

  it("flags proposals touching auth", () => {
    const result = verify({
      type: "self_improve",
      source: "reflect",
      proposalDescription: "Change auth flow to be more permissive",
    });
    expect(result.verdict).toBe("flagged");
  });
});

// ── configureVerifier ──

describe("configureVerifier", () => {
  it("allows overriding max ops per tick", () => {
    configureVerifier({ maxOpsPerTick: 10 });
    const result = verify({
      type: "memory_ops",
      source: "think",
      operationCount: 15,
      operationTypes: [],
    });
    expect(result.verdict).toBe("blocked");
  });

  it("allows disabling whitelist enforcement", () => {
    mockIsWhitelisted.mockReturnValue(false);
    configureVerifier({ enforceWhitelist: false });
    const result = verify(makeAction({ targetJid: "anyone@s.whatsapp.net" }));
    // Should not be blocked by whitelist
    expect(result.reasons.every(r => !r.includes("whitelist"))).toBe(true);
  });
});

// ── Verify result structure ──

describe("verify result", () => {
  it("includes timestamp", () => {
    const before = Date.now();
    const result = verify(makeAction());
    expect(result.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.timestamp).toBeLessThanOrEqual(Date.now());
  });

  it("includes the original action", () => {
    const action = makeAction({ messageText: "test" });
    const result = verify(action);
    expect(result.action).toBe(action);
  });
});
