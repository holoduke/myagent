/**
 * Affective Modulation (Research: Emotional Intelligence in AI Agents, 2025)
 *
 * Adjusts ARIA's communication behavior based on the detected emotional state
 * of the conversation partner. Goes beyond emotion detection to actually
 * modulate response style, proactivity, and message length.
 *
 * When stress detected → shorter messages, fewer proactive actions, more empathy.
 * When positive mood → deeper engagement, higher proactivity, match energy.
 */

import type { MemoryGraph } from "./memory/graph.js";
import { createLogger } from "./logger.js";

const log = createLogger("affective");

// ── Types ──

export interface AffectiveProfile {
  /** Current dominant emotion state */
  dominantEmotion: string;
  /** Overall valence: -1.0 (negative) to 1.0 (positive) */
  valence: number;
  /** Intensity: 0.0 (calm) to 1.0 (strong emotion) */
  intensity: number;
  /** Communication adaptations based on emotional state */
  adaptations: AffectiveAdaptations;
}

export interface AffectiveAdaptations {
  /** Message length modifier: 0.5 = half length, 1.5 = more detail */
  messageLengthModifier: number;
  /** Whether to increase empathy signals */
  increaseEmpathy: boolean;
  /** Whether to reduce proactive suggestions */
  reduceProactivity: boolean;
  /** Whether to mirror positive energy */
  mirrorPositivity: boolean;
  /** Suggested tone: brief, warm, supportive, energetic, neutral */
  suggestedTone: string;
}

// ── Affect Assessment ──

/**
 * Assess the current affective state from recent emotion nodes in the graph.
 * Returns null if insufficient emotional data.
 */
export function assessCurrentAffect(graph: MemoryGraph, targetJid?: string): AffectiveProfile | null {
  const now = Date.now();
  const WINDOW = 6 * 3600_000; // 6-hour lookback

  // Get recent emotion nodes
  let recentEmotions = graph.findByType("emotion")
    .filter(n => now - n.createdAt < WINDOW)
    .sort((a, b) => b.createdAt - a.createdAt);

  // If target JID specified, filter to that contact
  if (targetJid) {
    recentEmotions = recentEmotions.filter(n => n.tags.includes(targetJid));
  }

  if (recentEmotions.length === 0) return null;

  // Calculate aggregate emotional state
  const valences = recentEmotions.map(n => n.emotionalValence ?? 0);
  const avgValence = valences.reduce((s, v) => s + v, 0) / valences.length;

  // Find dominant emotion from tags
  const emotionCounts = new Map<string, number>();
  for (const node of recentEmotions) {
    for (const tag of node.tags) {
      if (!["emotion-signal", targetJid ?? ""].includes(tag) && !tag.includes("@")) {
        emotionCounts.set(tag, (emotionCounts.get(tag) ?? 0) + 1);
      }
    }
  }
  const dominantEmotion = [...emotionCounts.entries()]
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? "neutral";

  // Calculate intensity from recent nodes
  const intensity = Math.min(1, recentEmotions.slice(0, 3).reduce((s, n) => s + n.strength, 0) / 3);

  // Determine adaptations
  const adaptations = computeAdaptations(avgValence, intensity, dominantEmotion);

  return { dominantEmotion, valence: avgValence, intensity, adaptations };
}

/**
 * Compute communication adaptations based on emotional state.
 */
function computeAdaptations(valence: number, intensity: number, emotion: string): AffectiveAdaptations {
  // Negative high-intensity: stress, grief, anger
  if (valence < -0.3 && intensity > 0.5) {
    return {
      messageLengthModifier: 0.7,
      increaseEmpathy: true,
      reduceProactivity: true,
      mirrorPositivity: false,
      suggestedTone: "supportive",
    };
  }

  // Negative mild: worry, concern
  if (valence < -0.3) {
    return {
      messageLengthModifier: 0.85,
      increaseEmpathy: true,
      reduceProactivity: false,
      mirrorPositivity: false,
      suggestedTone: "warm",
    };
  }

  // Positive high-intensity: joy, excitement
  if (valence > 0.3 && intensity > 0.5) {
    return {
      messageLengthModifier: 1.2,
      increaseEmpathy: false,
      reduceProactivity: false,
      mirrorPositivity: true,
      suggestedTone: "energetic",
    };
  }

  // Positive mild: happy, grateful
  if (valence > 0.3) {
    return {
      messageLengthModifier: 1.0,
      increaseEmpathy: false,
      reduceProactivity: false,
      mirrorPositivity: true,
      suggestedTone: "warm",
    };
  }

  // Neutral
  return {
    messageLengthModifier: 1.0,
    increaseEmpathy: false,
    reduceProactivity: false,
    mirrorPositivity: false,
    suggestedTone: "neutral",
  };
}

/**
 * Generate affective modulation context for the brain prompt.
 */
export function getAffectiveModulationSummary(graph: MemoryGraph): string {
  const profile = assessCurrentAffect(graph);
  if (!profile) return "";

  const parts: string[] = [];
  parts.push(`Recent mood: ${profile.dominantEmotion} (valence: ${profile.valence.toFixed(1)})`);

  if (profile.adaptations.increaseEmpathy) {
    parts.push("Adapt: show empathy, be gentle");
  }
  if (profile.adaptations.reduceProactivity) {
    parts.push("Adapt: reduce proactive suggestions");
  }
  if (profile.adaptations.mirrorPositivity) {
    parts.push("Adapt: match positive energy");
  }
  if (profile.adaptations.suggestedTone !== "neutral") {
    parts.push(`Tone: ${profile.adaptations.suggestedTone}`);
  }

  return parts.join(" | ");
}
