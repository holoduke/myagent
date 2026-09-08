import { describe, it, expect } from "vitest";
import { mergePendingFollowUps, dedupeFollowUps, splitDueSoonFollowUps, cleanupWorkingMemory, clusterRelatedFollowUps, FOLLOWUP_DUE_SOON_MS, DEFAULT_FOLLOWUP_DUE_MS } from "./working-memory.js";
import type { PendingFollowUp, WorkingMemory } from "./types.js";

const fu = (id: string, question: string, createdAt: number, extra: Partial<PendingFollowUp> = {}): PendingFollowUp => ({
  id,
  question,
  context: "",
  createdAt,
  ...extra,
});

describe("mergePendingFollowUps fuzzy matching", () => {
  it("matches a re-emitted follow-up with fresh wording, keeping id and createdAt", () => {
    const existing = [fu("fu_1", "Paardenmarkt agenda-events aanmaken voor Julian en Lucas", 1000)];
    const incoming = [fu("fu_new", "Agenda-events aanmaken voor de Paardenmarkt (Julian en Lucas)", 2000)];
    const merged = mergePendingFollowUps(existing, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("fu_1");
    expect(merged[0].createdAt).toBe(1000);
    expect(merged[0].question).toBe(incoming[0].question);
  });

  it("resolves an existing follow-up re-emitted with fresh wording and resolved=true", () => {
    const existing = [fu("fu_1", "Webinar AI en Erfgoed datumprikker invullen", 1000)];
    const incoming = [fu("fu_new", "Datumprikker invullen voor webinar AI en Erfgoed", 2000, { resolved: true } as Partial<PendingFollowUp>)];
    expect(mergePendingFollowUps(existing, incoming)).toHaveLength(0);
  });

  it("keeps genuinely different follow-ups separate", () => {
    const existing = [fu("fu_1", "FM build en advertenties controleren", 1000)];
    const incoming = [fu("fu_new", "Autoverzekering overstap ANWB afronden", 2000)];
    expect(mergePendingFollowUps(existing, incoming)).toHaveLength(2);
  });

  it("matches a rephrased variant sharing a distinctive anchor plus a topic word", () => {
    const existing = [fu("fu_1", "Zijn Gillis's 4 auto's ongeschonden na de Duyfrak-krassen?", 1000)];
    const incoming = [fu("fu_new", "Kwamen er meer meldingen van bekraste auto's op het Duyfrak-binnenterrein?", 2000)];
    const merged = mergePendingFollowUps(existing, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("fu_1");
    expect(merged[0].createdAt).toBe(1000);
  });

  it("does not merge different questions that only share a person name", () => {
    const existing = [fu("fu_1", "Julian zwemles diploma vragen", 1000)];
    const incoming = [fu("fu_new", "Julian schoolreisje formulier betalen", 2000)];
    expect(mergePendingFollowUps(existing, incoming)).toHaveLength(2);
  });

  it("matches across diacritics and possessive forms", () => {
    const existing = [fu("fu_1", "Cadeau voor Valérie's verjaardag regelen", 1000)];
    const incoming = [fu("fu_new", "Verjaardag cadeau regelen voor Valerie", 2000)];
    expect(mergePendingFollowUps(existing, incoming)).toHaveLength(1);
  });
});

describe("dedupeFollowUps", () => {
  it("collapses near-duplicates keeping oldest id/createdAt and newest wording", () => {
    const items = [
      fu("fu_a", "Paardenmarkt agenda-events aanmaken voor de kinderen", 1000),
      fu("fu_b", "Agenda-events voor de Paardenmarkt aanmaken (kinderen)", 2000),
      fu("fu_c", "Paardenmarkt: agenda-events aanmaken kinderen", 3000),
      fu("fu_d", "Autoverzekering overstap ANWB afronden", 1500),
    ];
    const result = dedupeFollowUps(items);
    expect(result).toHaveLength(2);
    const paarden = result.find(f => f.id === "fu_a");
    expect(paarden).toBeDefined();
    expect(paarden!.createdAt).toBe(1000);
    expect(paarden!.question).toBe(items[2].question);
    expect(result.some(f => f.id === "fu_d")).toBe(true);
  });

  it("leaves a list without duplicates untouched", () => {
    const items = [
      fu("fu_a", "Schoolreisje Julian inplannen", 1000),
      fu("fu_b", "Moltbook post over verkiezingen schrijven", 2000),
    ];
    expect(dedupeFollowUps(items)).toEqual(items);
  });
});

describe("clusterRelatedFollowUps", () => {
  it("groups multi-angle questions about the same arc without merging them", () => {
    const items = [
      fu("fu_lgm1500", "Heeft Lageman teruggebeld over de offerte van 1500 euro?", 1000),
      fu("fu_lgmbudget1", "Past de Lageman offerte nog binnen het budget van de verbouwing?", 2000),
      fu("fu_anwb", "Autoverzekering overstap ANWB afronden", 3000),
      fu("fu_moltbook", "Moltbook post over verkiezingen schrijven", 4000),
    ];
    const clusters = clusterRelatedFollowUps(items);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].ids.sort()).toEqual(["fu_lgm1500", "fu_lgmbudget1"]);
    expect(clusters[0].sharedTerms).toContain("lageman");
  });

  it("chains relatedness transitively into one cluster", () => {
    const items = [
      fu("fu_a", "Heeft Lageman teruggebeld over de offerte?", 1000),
      fu("fu_b", "Lageman offerte budget bespreken met Ilse", 2000),
      fu("fu_c", "Budget verbouwing Lageman definitief maken", 3000),
    ];
    const clusters = clusterRelatedFollowUps(items);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].ids).toHaveLength(3);
  });

  it("does not cluster questions that only share a person name", () => {
    const items = [
      fu("fu_a", "Julian zwemles diploma vragen", 1000),
      fu("fu_b", "Julian schoolreisje formulier betalen", 2000),
    ];
    expect(clusterRelatedFollowUps(items)).toHaveLength(0);
  });

  it("returns no clusters for unrelated follow-ups or an empty list", () => {
    const items = [
      fu("fu_a", "Schoolreisje Julian inplannen", 1000),
      fu("fu_b", "Moltbook post over verkiezingen schrijven", 2000),
    ];
    expect(clusterRelatedFollowUps(items)).toHaveLength(0);
    expect(clusterRelatedFollowUps([])).toHaveLength(0);
  });
});

describe("cleanupWorkingMemory default dueAt", () => {
  const makeWm = (pendingFollowUps: PendingFollowUp[]): WorkingMemory => ({
    currentContext: "",
    mood: "neutral",
    shortTermTracking: [],
    activatedNodeIds: [],
    lastUpdated: 0,
    activeGoals: [],
    pendingFollowUps,
    conversationThreads: [],
    temporal: {
      dayOfWeek: "Monday",
      timeOfDay: "morning",
      hour: 8,
      date: "2026-09-07",
      isWeekend: false,
      upcomingEvents: [],
    },
  });

  it("assigns createdAt + 7 days to follow-ups without a dueAt", () => {
    const createdAt = Date.now() - 1000;
    const wm = makeWm([fu("fu_a", "Zwevende follow-up zonder deadline", createdAt)]);
    const result = cleanupWorkingMemory(wm);
    expect(result.followUpsDefaultedDue).toBe(1);
    expect(wm.pendingFollowUps[0].dueAt).toBe(createdAt + DEFAULT_FOLLOWUP_DUE_MS);
  });

  it("leaves an existing dueAt untouched", () => {
    const now = Date.now();
    const dueAt = now + 3 * 24 * 60 * 60 * 1000;
    const wm = makeWm([fu("fu_a", "Follow-up met eigen deadline", now - 1000, { dueAt })]);
    const result = cleanupWorkingMemory(wm);
    expect(result.followUpsDefaultedDue).toBe(0);
    expect(wm.pendingFollowUps[0].dueAt).toBe(dueAt);
  });
});

describe("splitDueSoonFollowUps", () => {
  const NOW = 1_000_000_000_000;
  const HOUR = 60 * 60 * 1000;

  it("separates overdue and due-within-48h items from the rest, most urgent first", () => {
    const items = [
      fu("fu_far", "Ver weg", 1000, { dueAt: NOW + FOLLOWUP_DUE_SOON_MS + HOUR }),
      fu("fu_soon", "Binnenkort", 1000, { dueAt: NOW + 24 * HOUR }),
      fu("fu_none", "Geen deadline", 1000),
      fu("fu_over", "Verlopen", 1000, { dueAt: NOW - HOUR }),
    ];
    const { dueSoon, rest } = splitDueSoonFollowUps(items, NOW);
    expect(dueSoon.map(f => f.id)).toEqual(["fu_over", "fu_soon"]);
    expect(rest.map(f => f.id)).toEqual(["fu_far", "fu_none"]);
  });

  it("treats a dueAt exactly at the window edge as due-soon", () => {
    const items = [fu("fu_edge", "Op de rand", 1000, { dueAt: NOW + FOLLOWUP_DUE_SOON_MS })];
    const { dueSoon, rest } = splitDueSoonFollowUps(items, NOW);
    expect(dueSoon).toHaveLength(1);
    expect(rest).toHaveLength(0);
  });

  it("keeps undated items in their original order", () => {
    const items = [
      fu("fu_a", "Eerste", 3000),
      fu("fu_b", "Tweede", 1000),
      fu("fu_c", "Derde", 2000),
    ];
    const { dueSoon, rest } = splitDueSoonFollowUps(items, NOW);
    expect(dueSoon).toHaveLength(0);
    expect(rest.map(f => f.id)).toEqual(["fu_a", "fu_b", "fu_c"]);
  });
});
