import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage } from "http";

const state = vi.hoisted(() => ({
  token: "secret-token-123",
  enabled: true,
  reflex: null as null | { reflexId: string; speak?: string; summary: string; usedLLM: boolean; durationMs: number; delivery: "response" | "push" },
  buffered: [] as Array<{ id: string; handled?: { by: string; summary: string } }>,
  pulled: [] as unknown[],
}));

vi.mock("../backend/integrations/homeassistant.js", () => ({
  getWebhookToken: () => state.token,
}));
vi.mock("../backend/integrations/integration-config.js", () => ({
  isIntegrationEnabled: () => state.enabled,
}));
vi.mock("../backend/ha-reflexes.js", () => ({
  runReflexForEvent: async () => state.reflex,
}));
vi.mock("../backend/integrations/ha-events.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../backend/integrations/ha-events.js")>();
  return {
    ...original,
    bufferEvent: (event: { id: string }, handled?: { by: string; summary: string }) => {
      state.buffered.push({ id: event.id, handled });
      return "accepted";
    },
  };
});
vi.mock("../backend/integrations/ha-commands.js", () => ({
  pullQueuedCommands: () => state.pulled,
}));

import { extractToken, tokensMatch, consumeRateBudget, processInboundEvent, WEBHOOK_RATE_LIMIT } from "../backend/integrations/ha-webhook.js";

function req(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

beforeEach(() => {
  state.buffered = [];
  state.reflex = null;
});

describe("auth helpers", () => {
  it("extracts the token from X-ARIA-Token or a Bearer header", () => {
    expect(extractToken(req({ "x-aria-token": "abc" }))).toBe("abc");
    expect(extractToken(req({ authorization: "Bearer xyz" }))).toBe("xyz");
    expect(extractToken(req({ authorization: "Basic xyz" }))).toBe("");
    expect(extractToken(req({}))).toBe("");
  });

  it("compares tokens safely", () => {
    expect(tokensMatch("secret", "secret")).toBe(true);
    expect(tokensMatch("secret", "secreT")).toBe(false);
    expect(tokensMatch("", "")).toBe(false);
    expect(tokensMatch("short", "longer-token")).toBe(false);
  });

  it("enforces the per-minute budget and resets on a new window", () => {
    const start = 10_000_000;
    for (let i = 0; i < WEBHOOK_RATE_LIMIT; i++) expect(consumeRateBudget(start + i)).toBe(true);
    expect(consumeRateBudget(start + WEBHOOK_RATE_LIMIT)).toBe(false);
    expect(consumeRateBudget(start + 60_000)).toBe(true);
  });
});

describe("processInboundEvent", () => {
  const event = { id: "hae_x", receivedAt: 1, ts: 1, type: "button_press", device: "Ikea switch 3 silver", action: "on" };

  it("buffers the event and reports no reflex when nothing matched", async () => {
    const r = await processInboundEvent(event);
    expect(r).toMatchObject({ ok: true, eventId: "hae_x", buffered: "accepted", reflex: null });
    expect(state.buffered[0].handled).toBeUndefined();
  });

  it("returns the reflex speech and attaches the outcome to the buffered event", async () => {
    state.reflex = { reflexId: "weather_briefing", speak: "Goedemorgen. Vandaag zon.", summary: "spoke the weather", usedLLM: true, durationMs: 1200, delivery: "response" };
    const r = await processInboundEvent(event);
    expect(r.reflex).toMatchObject({ id: "weather_briefing", speak: "Goedemorgen. Vandaag zon.", delivery: "response" });
    expect(state.buffered[0].handled).toEqual({ by: "weather_briefing", summary: "spoke the weather" });
  });
});
