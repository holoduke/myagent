import { describe, it, expect, vi } from "vitest";

vi.mock("../backend/utils/file-store.js", () => ({
  safeReadJSON: () => ({}),
  strictReadJSON: () => null,
  atomicWriteJSON: () => {},
  ensureDir: () => {},
}));

vi.mock("../backend/config.js", () => ({
  BRAIN_DIR: "/tmp/test-brain",
  OWNER_NAME: "TestOwner",
}));

import {
  inferContentSalience,
  SALIENCE_SIGNALS,
  pruneOrphans,
  ORPHAN_PRUNE_IMPORTANCE_FLOOR,
} from "../backend/memory/retention.js";
import { MemoryGraph } from "../backend/memory/graph.js";
import { ORPHAN_GRACE_HOURS } from "../backend/memory/types.js";

// ── inferContentSalience ──

describe("inferContentSalience", () => {
  it("returns 0 for plain text with no signals", () => {
    expect(inferContentSalience("Had a nice day at work")).toBe(0);
  });

  it("returns 0 for empty string", () => {
    expect(inferContentSalience("")).toBe(0);
  });

  // ── High salience life events ──

  it("scores hospital/medical high (0.9)", () => {
    const score = inferContentSalience("He was taken to the ziekenhuis for surgery");
    expect(score).toBeGreaterThanOrEqual(0.9);
  });

  it("scores death/funeral very high (0.95)", () => {
    const score = inferContentSalience("Opa is overleden vorige week");
    expect(score).toBeGreaterThanOrEqual(0.95);
  });

  it("scores pregnancy high (0.9)", () => {
    expect(inferContentSalience("She is zwanger!")).toBeGreaterThanOrEqual(0.9);
  });

  it("scores wedding high (0.85)", () => {
    expect(inferContentSalience("We gaan trouwen volgend jaar")).toBeGreaterThanOrEqual(0.85);
  });

  it("scores job loss/promotion (0.8)", () => {
    expect(inferContentSalience("Hij is ontslagen")).toBeGreaterThanOrEqual(0.8);
  });

  // ── English equivalents ──

  it("scores English 'hospital' high", () => {
    expect(inferContentSalience("She is in the hospital")).toBeGreaterThanOrEqual(0.9);
  });

  it("scores English 'died' very high", () => {
    expect(inferContentSalience("His grandfather died yesterday")).toBeGreaterThanOrEqual(0.95);
  });

  it("scores English 'pregnant' high", () => {
    expect(inferContentSalience("They announced she is pregnant")).toBeGreaterThanOrEqual(0.9);
  });

  it("scores English 'wedding' high", () => {
    expect(inferContentSalience("The wedding is in June")).toBeGreaterThanOrEqual(0.85);
  });

  // ── Medium-high salience ──

  it("scores decisions/agreements at 0.7", () => {
    const score = inferContentSalience("We hebben besloten om te verhuizen");
    expect(score).toBeGreaterThanOrEqual(0.65);
  });

  it("scores milestones at 0.7", () => {
    expect(inferContentSalience("It was his first time ever")).toBeGreaterThanOrEqual(0.7);
  });

  it("scores deadline/contract at 0.65", () => {
    expect(inferContentSalience("The contract is getekend")).toBeGreaterThanOrEqual(0.65);
  });

  it("scores moving house at 0.65", () => {
    expect(inferContentSalience("We gaan verhuizen naar een nieuw huis")).toBeGreaterThanOrEqual(0.65);
  });

  // ── Medium salience — emotional ──

  it("scores exclamation marks at 0.4", () => {
    expect(inferContentSalience("This is amazing!! Can't believe it!!")).toBeGreaterThanOrEqual(0.35);
  });

  it("scores emotional keywords", () => {
    expect(inferContentSalience("I feel so sorry for what happened")).toBeGreaterThanOrEqual(0.5);
  });

  it("scores congratulations/celebration", () => {
    expect(inferContentSalience("Gefeliciteerd met je promotie!")).toBeGreaterThanOrEqual(0.45);
  });

  // ── Lower salience ──

  it("scores appointments at 0.3", () => {
    expect(inferContentSalience("We have an afspraak at 3pm")).toBeGreaterThanOrEqual(0.3);
  });

  it("scores time references lower", () => {
    const score = inferContentSalience("Let's discuss this morgen");
    expect(score).toBeGreaterThanOrEqual(0.2);
    expect(score).toBeLessThan(0.5);
  });

  // ── Multi-signal bonus ──

  it("adds bonus for multiple signals", () => {
    // "sorry" (0.5) + "hospital" (0.9) → 0.9 + 0.05 = 0.95
    const multi = inferContentSalience("I'm sorry, she's in the hospital");
    const single = inferContentSalience("She is in the hospital");
    expect(multi).toBeGreaterThan(single);
  });

  it("caps multi-signal bonus at 0.15", () => {
    // Even with many hits, total bonus capped at 0.15
    const text = "hospital emergency surgery doctor spoed ambulance overleden funeral sorry angry crying";
    const score = inferContentSalience(text);
    expect(score).toBeLessThanOrEqual(1.0);
  });

  it("caps total score at 1.0", () => {
    // Very high weight signal (0.95) + many hits should still be ≤ 1.0
    const text = "Opa is overleden in het ziekenhuis na de operatie, de begrafenis is morgen";
    expect(inferContentSalience(text)).toBeLessThanOrEqual(1.0);
  });

  // ── Case insensitivity ──

  it("matches regardless of case", () => {
    expect(inferContentSalience("EMERGENCY")).toBeGreaterThanOrEqual(0.9);
    expect(inferContentSalience("Hospital")).toBeGreaterThanOrEqual(0.9);
    expect(inferContentSalience("OVERLEDEN")).toBeGreaterThanOrEqual(0.95);
  });
});

// ── pruneOrphans importance guard ──

function makeOrphanNode(id: string, opts: { importance?: number; pinned?: boolean } = {}) {
  const ancient = Date.now() - (ORPHAN_GRACE_HOURS + 24) * 3_600_000;
  return {
    id,
    type: "fact" as const,
    content: `Test node ${id}`,
    tags: [],
    strength: 0.5,
    pinned: opts.pinned ?? false,
    importance: opts.importance,
    createdAt: ancient,
    lastAccessedAt: ancient,
    accessCount: 1,
  };
}

describe("pruneOrphans importance guard", () => {
  it("archives a low-importance orphan node beyond grace", () => {
    const g = new MemoryGraph();
    g.addNode(makeOrphanNode("low", { importance: 0.2 }));
    const archived = pruneOrphans(g);
    expect(archived).toBe(1);
    expect(g.getNode("low")).toBeUndefined();
  });

  it("spares a high-importance orphan even though it's edge-free and past grace", () => {
    const g = new MemoryGraph();
    g.addNode(makeOrphanNode("vip", { importance: 0.9 }));
    const archived = pruneOrphans(g);
    expect(archived).toBe(0);
    expect(g.getNode("vip")).toBeDefined();
  });

  it("spares orphans exactly at the importance floor", () => {
    const g = new MemoryGraph();
    g.addNode(makeOrphanNode("edge", { importance: ORPHAN_PRUNE_IMPORTANCE_FLOOR }));
    expect(pruneOrphans(g)).toBe(0);
    expect(g.getNode("edge")).toBeDefined();
  });

  it("archives orphans just below the floor", () => {
    const g = new MemoryGraph();
    g.addNode(makeOrphanNode("almost", { importance: ORPHAN_PRUNE_IMPORTANCE_FLOOR - 0.01 }));
    expect(pruneOrphans(g)).toBe(1);
  });

  it("treats undefined importance as zero (still archives)", () => {
    const g = new MemoryGraph();
    g.addNode(makeOrphanNode("nope", { importance: undefined }));
    expect(pruneOrphans(g)).toBe(1);
  });

  it("pinned nodes are still spared regardless of importance", () => {
    const g = new MemoryGraph();
    g.addNode(makeOrphanNode("pin", { importance: 0.1, pinned: true }));
    expect(pruneOrphans(g)).toBe(0);
    expect(g.getNode("pin")).toBeDefined();
  });
});

// ── SALIENCE_SIGNALS structure ──

describe("SALIENCE_SIGNALS", () => {
  it("has weights between 0 and 1", () => {
    for (const signal of SALIENCE_SIGNALS) {
      expect(signal.weight).toBeGreaterThan(0);
      expect(signal.weight).toBeLessThanOrEqual(1);
    }
  });

  it("has valid regex patterns", () => {
    for (const signal of SALIENCE_SIGNALS) {
      expect(signal.pattern).toBeInstanceOf(RegExp);
      expect(() => signal.pattern.test("test")).not.toThrow();
    }
  });
});
