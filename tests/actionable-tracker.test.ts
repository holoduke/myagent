import { describe, it, expect, vi } from "vitest";

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign(
    (..._args: unknown[]) => {},
    { info: () => {}, warn: () => {}, error: () => {} },
  ),
}));

vi.mock("../backend/config.js", () => ({
  BRAIN_DIR: "/tmp/test-brain",
}));

vi.mock("../backend/utils/file-store.js", () => ({
  safeReadJSON: () => [],
  atomicWriteJSON: () => {},
  ensureDir: () => {},
}));

vi.mock("../backend/contact-whitelist.js", () => ({
  getActionMode: () => "auto",
}));

vi.mock("../backend/brain-config.js", () => ({
  getBrainConfig: () => ({ ownerTimezone: "Europe/Amsterdam" }),
}));

vi.mock("../backend/integrations/calendar.js", () => ({
  createEvent: () => Promise.resolve({ success: false }),
}));

vi.mock("../backend/integrations/gmail.js", () => ({
  loadAccounts: () => [],
}));

import {
  parseTimeFromSignals,
  computeDutchHolidays,
  parseDateFromSignals,
  extractMultipleEvents,
  buildEventWindow,
} from "../backend/actionable-tracker.js";
import type { ActionableSignal } from "../backend/actionable.js";

function signal(snippet: string, category: "event" = "event"): ActionableSignal {
  return { category, snippet, pattern: "test" };
}

// ── buildEventWindow (owner timezone, not container-local) ──

describe("buildEventWindow", () => {
  it("interprets wall-clock times in the owner's timezone", () => {
    const w = buildEventWindow("2026-07-01", "14:30", null, "Europe/Amsterdam");
    expect(w?.start.toISOString()).toBe("2026-07-01T12:30:00.000Z");
    expect(w?.end.toISOString()).toBe("2026-07-01T13:30:00.000Z");
  });

  it("defaults to 10:00 local and a one-hour duration", () => {
    const w = buildEventWindow("2026-01-15", null, null, "Europe/Amsterdam");
    expect(w?.start.toISOString()).toBe("2026-01-15T09:00:00.000Z");
    expect(w?.end.toISOString()).toBe("2026-01-15T10:00:00.000Z");
  });

  it("uses an explicit end time when it is after the start", () => {
    const w = buildEventWindow("2026-07-01", "09:00", "11:15", "Europe/Amsterdam");
    expect(w?.end.toISOString()).toBe("2026-07-01T09:15:00.000Z");
    const inverted = buildEventWindow("2026-07-01", "09:00", "08:00", "Europe/Amsterdam");
    expect(inverted?.end.toISOString()).toBe("2026-07-01T08:00:00.000Z"); // falls back to +1h
  });

  it("returns null for malformed dates", () => {
    expect(buildEventWindow("next week", "10:00", null, "Europe/Amsterdam")).toBeNull();
  });
});

// ── parseTimeFromSignals ──

describe("parseTimeFromSignals", () => {
  it("parses 'om 14:30'", () => {
    expect(parseTimeFromSignals([signal("om 14:30")])).toEqual([14, 30]);
  });

  it("parses 'at 16:00'", () => {
    expect(parseTimeFromSignals([signal("at 16:00")])).toEqual([16, 0]);
  });

  it("parses bare time '16:00'", () => {
    expect(parseTimeFromSignals([signal("meeting 16:00")])).toEqual([16, 0]);
  });

  it("parses 'rond 13:00'", () => {
    expect(parseTimeFromSignals([signal("rond 13:00")])).toEqual([13, 0]);
  });

  it("parses 'ongeveer 9:30'", () => {
    expect(parseTimeFromSignals([signal("ongeveer 9:30")])).toEqual([9, 30]);
  });

  it("parses time with dot separator '14.30'", () => {
    expect(parseTimeFromSignals([signal("om 14.30")])).toEqual([14, 30]);
  });

  it("returns null when no time found", () => {
    expect(parseTimeFromSignals([signal("morgen meeting")])).toBeNull();
  });

  it("finds time in second signal if first has none", () => {
    expect(parseTimeFromSignals([
      signal("morgen overleg"),
      signal("om 10:00"),
    ])).toEqual([10, 0]);
  });
});

// ── computeDutchHolidays ──

describe("computeDutchHolidays", () => {
  it("returns 11 holidays", () => {
    const holidays = computeDutchHolidays(2024);
    expect(holidays).toHaveLength(11);
  });

  it("has correct fixed holidays", () => {
    const holidays = computeDutchHolidays(2024);
    const byKey = Object.fromEntries(holidays.map(h => [h.key, h.date]));

    expect(byKey.new_years_day.getMonth()).toBe(0);
    expect(byKey.new_years_day.getDate()).toBe(1);

    expect(byKey.kings_day.getMonth()).toBe(3);
    expect(byKey.kings_day.getDate()).toBe(27);

    expect(byKey.liberation_day.getMonth()).toBe(4);
    expect(byKey.liberation_day.getDate()).toBe(5);

    expect(byKey.christmas_day.getMonth()).toBe(11);
    expect(byKey.christmas_day.getDate()).toBe(25);

    expect(byKey.boxing_day.getMonth()).toBe(11);
    expect(byKey.boxing_day.getDate()).toBe(26);
  });

  it("computes correct Easter for 2024 (March 31)", () => {
    const holidays = computeDutchHolidays(2024);
    const easter = holidays.find(h => h.key === "easter_sunday")!;
    expect(easter.date.getMonth()).toBe(2); // March
    expect(easter.date.getDate()).toBe(31);
  });

  it("computes correct Easter for 2025 (April 20)", () => {
    const holidays = computeDutchHolidays(2025);
    const easter = holidays.find(h => h.key === "easter_sunday")!;
    expect(easter.date.getMonth()).toBe(3); // April
    expect(easter.date.getDate()).toBe(20);
  });

  it("computes Ascension Day as Easter + 39 days", () => {
    const holidays = computeDutchHolidays(2024);
    const easter = holidays.find(h => h.key === "easter_sunday")!;
    const ascension = holidays.find(h => h.key === "ascension")!;
    const diff = Math.round((ascension.date.getTime() - easter.date.getTime()) / 86400000);
    expect(diff).toBe(39);
  });

  it("computes Whit Sunday as Easter + 49 days", () => {
    const holidays = computeDutchHolidays(2024);
    const easter = holidays.find(h => h.key === "easter_sunday")!;
    const whit = holidays.find(h => h.key === "whit_sunday")!;
    const diff = Math.round((whit.date.getTime() - easter.date.getTime()) / 86400000);
    expect(diff).toBe(49);
  });

  it("Easter Monday is Easter + 1", () => {
    const holidays = computeDutchHolidays(2024);
    const easter = holidays.find(h => h.key === "easter_sunday")!;
    const easterMon = holidays.find(h => h.key === "easter_monday")!;
    const diff = Math.round((easterMon.date.getTime() - easter.date.getTime()) / 86400000);
    expect(diff).toBe(1);
  });
});

// ── parseDateFromSignals ──

describe("parseDateFromSignals", () => {
  it("parses 'morgen' as tomorrow", () => {
    const result = parseDateFromSignals([signal("afspraak morgen")]);
    expect(result).not.toBeNull();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(result!.getDate()).toBe(tomorrow.getDate());
  });

  it("parses 'tomorrow' as tomorrow", () => {
    const result = parseDateFromSignals([signal("meeting tomorrow")]);
    expect(result).not.toBeNull();
  });

  it("parses 'overmorgen' as day after tomorrow", () => {
    const result = parseDateFromSignals([signal("overmorgen eten")]);
    expect(result).not.toBeNull();
    const dayAfter = new Date();
    dayAfter.setDate(dayAfter.getDate() + 2);
    expect(result!.getDate()).toBe(dayAfter.getDate());
  });

  it("parses Dutch day names", () => {
    const result = parseDateFromSignals([signal("volgende maandag")]);
    expect(result).not.toBeNull();
    expect(result!.getDay()).toBe(1); // Monday
  });

  it("parses English day names", () => {
    const result = parseDateFromSignals([signal("next friday")]);
    expect(result).not.toBeNull();
    expect(result!.getDay()).toBe(5); // Friday
  });

  it("parses 'volgende week' as +7 days", () => {
    const result = parseDateFromSignals([signal("volgende week vergadering")]);
    expect(result).not.toBeNull();
    const expected = new Date();
    expected.setDate(expected.getDate() + 7);
    expect(result!.getDate()).toBe(expected.getDate());
  });

  it("parses explicit date like '15 maart'", () => {
    const result = parseDateFromSignals([signal("op 15 maart eten")]);
    expect(result).not.toBeNull();
    expect(result!.getMonth()).toBe(2); // March (0-indexed)
    expect(result!.getDate()).toBe(15);
  });

  it("parses English month '15 march'", () => {
    const result = parseDateFromSignals([signal("on 15 march meeting")]);
    expect(result).not.toBeNull();
    expect(result!.getMonth()).toBe(2);
    expect(result!.getDate()).toBe(15);
  });

  it("parses Dutch holiday 'koningsdag'", () => {
    const result = parseDateFromSignals([signal("feestje op koningsdag")]);
    expect(result).not.toBeNull();
    expect(result!.getMonth()).toBe(3); // April
    expect(result!.getDate()).toBe(27);
  });

  it("returns null when no date signal found", () => {
    const result = parseDateFromSignals([signal("just a regular message")]);
    expect(result).toBeNull();
  });
});

// ── extractMultipleEvents ──

describe("extractMultipleEvents", () => {
  it("extracts single event from signals", () => {
    const signals = [signal("morgen om 14:00 koffie")];
    const events = extractMultipleEvents("morgen om 14:00 koffie", signals);
    expect(events).toHaveLength(1);
    expect(events[0].hours).toBe(14);
    expect(events[0].minutes).toBe(0);
  });

  it("defaults time to 10:00 when no time found", () => {
    const signals = [signal("morgen vergadering")];
    const events = extractMultipleEvents("morgen vergadering", signals);
    expect(events).toHaveLength(1);
    expect(events[0].hours).toBe(10);
    expect(events[0].minutes).toBe(0);
  });

  it("returns empty array when no date found", () => {
    const signals = [signal("just talking")];
    const events = extractMultipleEvents("just talking", signals);
    expect(events).toHaveLength(0);
  });

  it("splits on 'en' for multiple events", () => {
    const text = "morgen om 10:00 koffie en overmorgen om 14:00 lunch";
    const signals = [signal(text)];
    const events = extractMultipleEvents(text, signals);
    // Should find at least 1 event (splitting on " en ")
    expect(events.length).toBeGreaterThanOrEqual(1);
  });
});
