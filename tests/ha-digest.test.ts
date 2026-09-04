import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../backend/brain-config.js", () => ({
  getBrainConfig: () => ({ ownerTimezone: "UTC", enabled: true, models: { haDigest: "haiku" } }),
  getOwnerLocalTime: (_tz: string, now: Date = new Date()) => ({ hour: now.getUTCHours(), dayOfWeek: now.getUTCDay() }),
  getOwnerLocalDate: (_tz: string, now: Date = new Date()) => now.toISOString().slice(0, 10),
}));

const state = vi.hoisted(() => ({
  pending: [] as unknown[],
  dropped: 0,
  observations: [] as Array<{ text: string; source?: string; trustLevel?: string }>,
  llmResult: null as string | null,
  llmCalls: 0,
  enabled: true,
}));

vi.mock("../backend/integrations/ha-events.js", () => ({
  drainEvents: () => {
    const out = { events: state.pending, dropped: state.dropped, lastDigestAt: 0 };
    state.pending = [];
    state.dropped = 0;
    return out;
  },
  getPendingCount: () => state.pending.length,
  describeEvent: (e: { friendlyName?: string; device?: string; action?: string; state?: string }) =>
    `${e.friendlyName || e.device}: ${e.action || e.state}`,
}));
vi.mock("../backend/observer.js", () => ({
  recordObservation: (obs: { text: string; source?: string; trustLevel?: string }) => { state.observations.push(obs); },
}));
vi.mock("../backend/integrations/integration-config.js", () => ({
  isIntegrationEnabled: () => state.enabled,
}));
vi.mock("../backend/integrations/homeassistant.js", () => ({
  loadConfig: () => ({ digestIntervalMs: 60_000 }),
}));
vi.mock("../backend/providers/llm-runner.js", () => ({
  LlmRunner: class {
    async run() { state.llmCalls++; return state.llmResult; }
  },
}));

import { runHADigest, buildTemplateDigest, buildDigestPrompt, formatEventLine, TEMPLATE_MAX_EVENTS } from "../backend/ha-digest.js";
import type { HAEventRecord } from "../backend/integrations/ha-events.js";

function rec(i: number, overrides: Partial<HAEventRecord> = {}): HAEventRecord {
  return { id: `e${i}`, receivedAt: 1_700_000_000_000 + i * 60_000, ts: 1_700_000_000_000 + i * 60_000, type: "button_press", device: "Ikea switch 3 silver", action: "on", ...overrides };
}

beforeEach(() => {
  state.pending = [];
  state.dropped = 0;
  state.observations = [];
  state.llmResult = null;
  state.llmCalls = 0;
  state.enabled = true;
});

describe("formatting", () => {
  it("renders event lines with owner-local time and reflex outcome", () => {
    const line = formatEventLine(rec(0, { handledBy: "weather_briefing", handledSummary: "spoke the weather" }), "UTC");
    expect(line).toBe("22:13 Ikea switch 3 silver: on → ARIA spoke the weather");
    expect(buildTemplateDigest([rec(0), rec(1)], "UTC").split("\n")).toHaveLength(2);
  });

  it("prompt lists events and mentions dropped count", () => {
    const prompt = buildDigestPrompt([rec(0)], 5, "UTC");
    expect(prompt).toContain("Ikea switch 3 silver: on");
    expect(prompt).toContain("5 further events were dropped");
  });
});

describe("runHADigest", () => {
  it("does nothing when the buffer is empty", async () => {
    const r = await runHADigest();
    expect(r.recorded).toBe(false);
    expect(state.observations).toHaveLength(0);
  });

  it("does nothing when the integration is disabled", async () => {
    state.enabled = false;
    state.pending = [rec(0)];
    const r = await runHADigest();
    expect(r.recorded).toBe(false);
    expect(state.pending).toHaveLength(1); // not drained
  });

  it("uses the template for small batches and records one trusted observation", async () => {
    state.pending = [rec(1), rec(0)];
    const r = await runHADigest(new Date(1_700_000_200_000));
    expect(r.recorded).toBe(true);
    expect(r.usedLLM).toBe(false);
    expect(state.llmCalls).toBe(0);
    expect(state.observations).toHaveLength(1);
    const obs = state.observations[0];
    expect(obs.source).toBe("homeassistant");
    expect(obs.trustLevel).toBe("trusted");
    expect(obs.text.startsWith("[HOME DIGEST 22:13–22:14, 2 events]")).toBe(true);
  });

  it("uses the cheap model for larger batches and falls back to the template when it returns nothing", async () => {
    state.pending = Array.from({ length: TEMPLATE_MAX_EVENTS + 1 }, (_, i) => rec(i));
    state.llmResult = "- silver STYRBAR pressed 5 times between 22:13 and 22:17";
    const r = await runHADigest();
    expect(r.usedLLM).toBe(true);
    expect(state.observations[0].text).toContain("pressed 5 times");

    state.pending = Array.from({ length: TEMPLATE_MAX_EVENTS + 1 }, (_, i) => rec(i));
    state.llmResult = null;
    const r2 = await runHADigest();
    expect(r2.usedLLM).toBe(false);
    expect(state.observations[1].text.split("\n")).toHaveLength(TEMPLATE_MAX_EVENTS + 2);
  });

  it("reports drops even when nothing was buffered", async () => {
    state.dropped = 3;
    const r = await runHADigest();
    expect(r.recorded).toBe(true);
    expect(state.observations[0].text).toContain("3 events dropped");
  });
});
