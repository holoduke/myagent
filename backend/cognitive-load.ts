/**
 * Owner Cognitive Load Estimator (Research: Bounded Agent Complementarity, 2026)
 *
 * Estimates the owner's current cognitive load from available signals and
 * adapts ARIA's behavior accordingly. When load is high: batch/defer non-urgent
 * communications, simplify outputs, reduce proactive suggestions.
 *
 * Signals used:
 * - Time of day (early morning / late night = lower capacity)
 * - Calendar density (many events = higher load)
 * - Recent message volume (high volume = likely busy)
 * - Message complexity (long messages from owner = deep focus or high load)
 * - Day of week (weekdays = generally higher load)
 */

import type { WorkingMemory } from "./memory/types.js";
import type { Observation } from "./observer.js";
import { createLogger } from "./logger.js";

const log = createLogger("cognitive-load");

// ── Types ──

export type LoadLevel = "low" | "moderate" | "high" | "overloaded";

export interface CognitiveLoadEstimate {
  level: LoadLevel;
  score: number; // 0.0 (minimal load) to 1.0 (overloaded)
  factors: { name: string; contribution: number }[];
  adaptations: LoadAdaptations;
}

export interface LoadAdaptations {
  /** Whether to defer non-urgent proactive messages */
  deferProactive: boolean;
  /** Whether to simplify message content */
  simplifyMessages: boolean;
  /** Max recommended message length (chars) */
  maxMessageLength: number;
  /** Whether to batch updates into digests instead of individual messages */
  batchUpdates: boolean;
}

// ── Load Estimation ──

/**
 * Estimate the owner's current cognitive load from available signals.
 */
export function estimateCognitiveLoad(
  wm: WorkingMemory,
  recentObservations: Observation[],
  currentHour: number = new Date().getHours(),
  currentDay: number = new Date().getDay(), // 0=Sun
): CognitiveLoadEstimate {
  const factors: { name: string; contribution: number }[] = [];

  // Factor 1: Time of day
  // Early morning (5-8) and late night (22-1): reduced capacity
  // Peak hours (9-12, 14-17): normal capacity
  // Post-lunch dip (13-14): slightly reduced
  let timeScore: number;
  if (currentHour >= 23 || currentHour < 6) {
    timeScore = 0.8; // Late night / very early = high load context
  } else if (currentHour >= 6 && currentHour < 9) {
    timeScore = 0.4; // Morning ramp-up
  } else if (currentHour >= 12 && currentHour < 14) {
    timeScore = 0.5; // Lunch / post-lunch dip
  } else {
    timeScore = 0.2; // Peak cognitive hours
  }
  factors.push({ name: "time_of_day", contribution: timeScore * 0.2 });

  // Factor 2: Calendar density
  const upcomingEvents = wm.temporal?.upcomingEvents ?? [];
  const calendarScore = Math.min(1, upcomingEvents.length / 5);
  factors.push({ name: "calendar_density", contribution: calendarScore * 0.25 });

  // Factor 3: Recent message volume
  const recentOwnerMessages = recentObservations.filter(o => o.isFromMe);
  const messageVolume = Math.min(1, recentOwnerMessages.length / 20);
  factors.push({ name: "message_volume", contribution: messageVolume * 0.2 });

  // Factor 4: Average message complexity (owner's messages)
  const ownerTexts = recentOwnerMessages.map(o => o.text).filter(t => t.length > 0);
  const avgLength = ownerTexts.length > 0
    ? ownerTexts.reduce((s, t) => s + t.length, 0) / ownerTexts.length
    : 0;
  const complexityScore = Math.min(1, avgLength / 300); // 300+ chars = complex
  factors.push({ name: "message_complexity", contribution: complexityScore * 0.15 });

  // Factor 5: Day of week
  const isWeekday = currentDay >= 1 && currentDay <= 5;
  const dayScore = isWeekday ? 0.6 : 0.2;
  factors.push({ name: "day_of_week", contribution: dayScore * 0.2 });

  // Calculate total score
  const score = Math.min(1, factors.reduce((s, f) => s + f.contribution, 0));

  // Determine level
  const level: LoadLevel =
    score > 0.75 ? "overloaded"
    : score > 0.5 ? "high"
    : score > 0.3 ? "moderate"
    : "low";

  // Compute adaptations
  const adaptations = computeLoadAdaptations(level, score);

  return { level, score, factors, adaptations };
}

/**
 * Compute behavioral adaptations based on cognitive load level.
 */
function computeLoadAdaptations(level: LoadLevel, score: number): LoadAdaptations {
  switch (level) {
    case "overloaded":
      return {
        deferProactive: true,
        simplifyMessages: true,
        maxMessageLength: 200,
        batchUpdates: true,
      };
    case "high":
      return {
        deferProactive: true,
        simplifyMessages: true,
        maxMessageLength: 400,
        batchUpdates: false,
      };
    case "moderate":
      return {
        deferProactive: false,
        simplifyMessages: false,
        maxMessageLength: 800,
        batchUpdates: false,
      };
    case "low":
    default:
      return {
        deferProactive: false,
        simplifyMessages: false,
        maxMessageLength: 1500,
        batchUpdates: false,
      };
  }
}

/**
 * Generate cognitive load context for the brain prompt.
 */
export function getCognitiveLoadSummary(
  wm: WorkingMemory,
  recentObservations: Observation[],
): string {
  const estimate = estimateCognitiveLoad(wm, recentObservations);
  if (estimate.level === "low") return "";

  const parts = [`Owner cognitive load: ${estimate.level} (${(estimate.score * 100).toFixed(0)}%)`];

  if (estimate.adaptations.deferProactive) {
    parts.push("defer non-urgent messages");
  }
  if (estimate.adaptations.simplifyMessages) {
    parts.push("keep messages brief");
  }
  if (estimate.adaptations.batchUpdates) {
    parts.push("batch updates into digests");
  }

  return parts.join(" — ");
}
