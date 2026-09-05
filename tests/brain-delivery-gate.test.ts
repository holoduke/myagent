import { describe, it, expect, vi } from "vitest";

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((..._args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock("../backend/config.js", () => ({ BRAIN_DIR: "/tmp/test-brain-delivery", OWNER_NAME: "Owner" }));
vi.mock("../backend/utils/file-store.js", () => ({
  safeReadJSON: (_p: string, fallback: unknown) => fallback,
  atomicWriteJSON: () => {},
  ensureDir: () => {},
  atomicWriteFile: () => {},
}));
vi.mock("../backend/integrations/whatsapp.js", () => ({ isWhatsAppConnected: () => false }));
vi.mock("../backend/integrations/calendar.js", () => ({ isOwnerInMeeting: () => false }));
vi.mock("../backend/action-verifier.js", () => ({ verify: () => ({ verdict: "allowed", reasons: [] }) }));
vi.mock("../backend/scheduler.js", () => ({
  getDueMessages: () => [],
  getScheduledMessages: () => [],
  markDelivered: () => {},
  markFailed: () => [],
  getRecentDeliveries: () => [],
  logDelivery: () => {},
  scheduleMessage: () => "sched_x",
  DEDUP_WINDOW_MS: 3 * 3600_000,
}));
vi.mock("../backend/brain-config.js", () => ({
  getBrainConfig: () => ({ ownerTimezone: "UTC", quietStart: 23, quietEnd: 7, minMessageInterval: 0, maxMessagesPerDay: 10 }),
}));

import { evaluateSendGate } from "../backend/brain-delivery.js";
import type { SendGateInput } from "../backend/brain-delivery.js";

function input(overrides: Partial<SendGateInput> = {}): SendGateInput {
  return {
    bypass: false,
    isDirectReply: false,
    isQuiet: false,
    inMeeting: false,
    messageIntervalOk: true,
    underDailyLimit: true,
    ...overrides,
  };
}

describe("evaluateSendGate", () => {
  it("sends when nothing blocks", () => {
    expect(evaluateSendGate(input())).toEqual({ action: "send" });
  });

  it("suppresses proactive messages in quiet hours but reroutes direct replies", () => {
    expect(evaluateSendGate(input({ isQuiet: true }))).toEqual({ action: "suppress", reason: "quiet hours" });
    expect(evaluateSendGate(input({ isQuiet: true, isDirectReply: true }))).toEqual({ action: "reroute", reason: "quiet hours" });
  });

  it("suppresses proactive messages during a meeting but reroutes direct replies", () => {
    expect(evaluateSendGate(input({ inMeeting: true }))).toEqual({ action: "suppress", reason: "owner in meeting" });
    expect(evaluateSendGate(input({ inMeeting: true, isDirectReply: true }))).toEqual({ action: "reroute", reason: "owner in meeting" });
  });

  it("digest bypass ignores quiet hours and the throttle (meeting is already excluded upstream)", () => {
    expect(evaluateSendGate(input({ bypass: true, isQuiet: true, messageIntervalOk: false, underDailyLimit: false }))).toEqual({ action: "send" });
  });

  it("applies the interval and daily throttle only to proactive sends", () => {
    expect(evaluateSendGate(input({ messageIntervalOk: false }))).toEqual({ action: "suppress", reason: "too soon" });
    expect(evaluateSendGate(input({ underDailyLimit: false }))).toEqual({ action: "suppress", reason: "daily limit reached" });
    expect(evaluateSendGate(input({ isDirectReply: true, messageIntervalOk: false, underDailyLimit: false }))).toEqual({ action: "send" });
  });

  it("quiet hours take precedence over the throttle", () => {
    expect(evaluateSendGate(input({ isQuiet: true, messageIntervalOk: false }))).toEqual({ action: "suppress", reason: "quiet hours" });
  });
});
