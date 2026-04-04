/**
 * Tests for the enhanced brain-api configuration and status.
 * Verifies allowed config keys, goal parsing logic, and ID sanitization.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

describe("BRAIN_CONFIG_ALLOWED_KEYS in source", () => {
  const source = readFileSync(
    new URL("../backend/web/brain-api.ts", import.meta.url).pathname
      .replace("/tests/", "/"),
    "utf-8",
  );

  it("includes self-critique config keys", () => {
    expect(source).toContain('"selfCritiqueEnabled"');
    expect(source).toContain('"selfCritiqueThreshold"');
  });

  it("includes urgency interrupt threshold", () => {
    expect(source).toContain('"urgencyInterruptThreshold"');
  });

  it("includes memory tuning keys", () => {
    expect(source).toContain('"activationSpreadFactor"');
    expect(source).toContain('"archiveRecallMin"');
    expect(source).toContain('"archiveRecallMax"');
    expect(source).toContain('"archiveRecallDivisor"');
    expect(source).toContain('"maxThinkContextNodes"');
  });

  it("includes all original keys in ALLOWED_KEYS array", () => {
    const originals = [
      "enabled", "maxMessagesPerDay", "minMessageInterval",
      "quietStart", "quietEnd", "ownerTimezone",
      "thinkCooldown", "consolidateInterval", "reflectInterval",
      "tickInterval", "preset",
      "selfImproveEnabled", "selfImproveAutoApprove", "selfImproveMaxPerWeek",
      "characterType", "characterCustomPrompt",
      "detectionMode", "detectionPrompt",
    ];
    for (const key of originals) {
      expect(source).toContain(`"${key}"`);
    }
  });
});

describe("getAriaStatus graph data includes extended fields", () => {
  const source = readFileSync(
    new URL("../backend/web/brain-api.ts", import.meta.url).pathname
      .replace("/tests/", "/"),
    "utf-8",
  );

  it("includes archivedCount in graph response", () => {
    expect(source).toContain("archivedCount: graphStats.archivedCount");
  });

  it("includes ghostCount in graph response", () => {
    expect(source).toContain("ghostCount: graphStats.ghostCount");
  });

  it("includes embeddingCount in graph response", () => {
    expect(source).toContain("embeddingCount: getEmbeddingCount()");
  });

  it("includes channelHealth in status response", () => {
    expect(source).toContain("status.channelHealth = getChannelHealth()");
  });

  it("channel health is wrapped in try/catch", () => {
    const healthIdx = source.indexOf("status.channelHealth");
    const nearbySource = source.slice(Math.max(0, healthIdx - 100), healthIdx + 200);
    expect(nearbySource).toContain("try {");
    expect(nearbySource).toContain("catch");
  });

  it("imports getEmbeddingCount from embeddings", () => {
    expect(source).toContain('import { getEmbeddingCount } from "../memory/embeddings.js"');
  });

  it("imports getChannelHealth from channel-adapter", () => {
    expect(source).toContain('import { getChannelHealth } from "../integrations/channel-adapter.js"');
  });

  it("uses single MemoryGraph load (no raw readFileSync for nodes/edges)", () => {
    // After refactor: should use graph.allNodes() and graph.allEdges(), not readFileSync for nodes.json
    const statusFn = source.slice(source.indexOf("function getAriaStatus"), source.indexOf("status.timestamp"));
    expect(statusFn).toContain("graph.allNodes()");
    expect(statusFn).toContain("graph.allEdges()");
    expect(statusFn).not.toContain("nodes.json");
    expect(statusFn).not.toContain("edges.json");
  });
});

describe("Frontend type alignment", () => {
  const typesSource = readFileSync(
    new URL("../frontend/app/types/aria.ts", import.meta.url).pathname
      .replace("/tests/", "/"),
    "utf-8",
  );

  it("GraphData includes retentionTiers", () => {
    expect(typesSource).toContain("retentionTiers?:");
  });

  it("GraphData includes archivedCount", () => {
    expect(typesSource).toContain("archivedCount?:");
  });

  it("GraphData includes ghostCount", () => {
    expect(typesSource).toContain("ghostCount?:");
  });

  it("GraphData includes embeddingCount", () => {
    expect(typesSource).toContain("embeddingCount?:");
  });

  it("AriaStatus includes channelHealth", () => {
    expect(typesSource).toContain("channelHealth?:");
  });

  it("ChannelHealthStatus interface is defined", () => {
    expect(typesSource).toContain("interface ChannelHealthStatus");
  });

  it("BrainConfig includes selfCritiqueEnabled", () => {
    expect(typesSource).toContain("selfCritiqueEnabled:");
  });

  it("BrainConfig includes selfCritiqueThreshold", () => {
    expect(typesSource).toContain("selfCritiqueThreshold:");
  });

  it("BrainConfig includes urgencyInterruptThreshold", () => {
    expect(typesSource).toContain("urgencyInterruptThreshold:");
  });

  it("BrainConfig includes activationSpreadFactor", () => {
    expect(typesSource).toContain("activationSpreadFactor:");
  });

  it("BrainConfig includes maxThinkContextNodes", () => {
    expect(typesSource).toContain("maxThinkContextNodes:");
  });

  it("RetentionTier type is exported", () => {
    expect(typesSource).toContain("export type RetentionTier");
  });
});

describe("parseGoalData pattern", () => {
  function parseGoalData(content: string): unknown | null {
    try {
      const match = content.match(/\[GOAL_DATA\]([\s\S]*)\[\/GOAL_DATA\]/);
      if (!match) return null;
      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  }

  it("parses valid GOAL_DATA block", () => {
    const content = `Some text [GOAL_DATA]{"title":"Test","status":"active"}[/GOAL_DATA] more text`;
    const result = parseGoalData(content) as Record<string, unknown>;
    expect(result).not.toBeNull();
    expect(result.title).toBe("Test");
    expect(result.status).toBe("active");
  });

  it("returns null for missing GOAL_DATA block", () => {
    expect(parseGoalData("just some text")).toBeNull();
  });

  it("returns null for malformed JSON in GOAL_DATA", () => {
    expect(parseGoalData("[GOAL_DATA]{broken json[/GOAL_DATA]")).toBeNull();
  });
});

describe("sanitizeId pattern", () => {
  const sanitize = (id: string) => id.replace(/[^a-zA-Z0-9_\-]/g, "");

  it("strips path traversal characters", () => {
    expect(sanitize("../../etc/passwd")).toBe("etcpasswd");
  });

  it("preserves valid id characters", () => {
    expect(sanitize("valid-id_123")).toBe("valid-id_123");
  });

  it("strips slashes and dots", () => {
    expect(sanitize("some/path/../traversal")).toBe("somepathtraversal");
  });
});
