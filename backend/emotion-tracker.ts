/**
 * Emotion Detection & Trajectory Tracking (Research Improvement #1)
 * Inspired by DialogueLLM and AFlow patterns.
 *
 * Detects emotional signals in observations and tracks emotional trajectories
 * per contact over time. Creates emotion nodes and edges in the memory graph.
 */

import type { Observation } from "./observer.js";
import type { MemoryGraph } from "./memory/graph.js";
import type { MemoryNode } from "./memory/types.js";
import { createLogger } from "./logger.js";

const log = createLogger("emotion");

// ── Types ──

export interface EmotionSignal {
  emotion: string;
  intensity: number; // 0.0–1.0
  valence: number;   // -1.0 (negative) to 1.0 (positive)
  evidence: string;
  sender: string;
  senderJid: string;
}

export interface EmotionTrajectory {
  senderJid: string;
  senderName: string;
  recentEmotions: { emotion: string; valence: number; timestamp: number }[];
  trend: "improving" | "declining" | "stable" | "volatile";
  currentValence: number;
}

// ── Emotion Patterns ──

const EMOTION_PATTERNS: { pattern: RegExp; emotion: string; valence: number; intensity: number }[] = [
  // Strong positive
  { pattern: /\b(amazing|fantastic|incredible|wonderful|thrilled|ecstatic|overjoyed)\b/i, emotion: "joy", valence: 1.0, intensity: 0.9 },
  { pattern: /\b(love it|love this|so happy|super happy|so excited)\b/i, emotion: "joy", valence: 1.0, intensity: 0.85 },
  { pattern: /❤️|😍|🥰|💕|🎉|🥳/u, emotion: "joy", valence: 0.9, intensity: 0.7 },

  // Moderate positive
  { pattern: /\b(happy|glad|pleased|nice|great|good news|relieved)\b/i, emotion: "happiness", valence: 0.7, intensity: 0.5 },
  { pattern: /\b(thank|thanks|dank|bedankt|fijn|prima|mooi)\b/i, emotion: "gratitude", valence: 0.6, intensity: 0.4 },
  { pattern: /😊|😄|👍|🙏|😁/u, emotion: "happiness", valence: 0.6, intensity: 0.4 },

  // Excitement / anticipation
  { pattern: /\b(can't wait|looking forward|excited|pumped|eager)\b/i, emotion: "anticipation", valence: 0.7, intensity: 0.6 },
  { pattern: /!{2,}/g, emotion: "excitement", valence: 0.5, intensity: 0.4 },

  // Mild negative
  { pattern: /\b(worried|concerned|nervous|anxious|uneasy)\b/i, emotion: "anxiety", valence: -0.5, intensity: 0.5 },
  { pattern: /\b(annoyed|irritated|frustrated|ugh|meh)\b/i, emotion: "frustration", valence: -0.5, intensity: 0.5 },
  { pattern: /😔|😕|😐|🙁/u, emotion: "sadness", valence: -0.4, intensity: 0.4 },

  // Strong negative
  { pattern: /\b(angry|furious|pissed|livid|outraged)\b/i, emotion: "anger", valence: -0.9, intensity: 0.8 },
  { pattern: /\b(devastated|heartbroken|terrible|awful|horrible|miserable)\b/i, emotion: "distress", valence: -0.9, intensity: 0.85 },
  { pattern: /\b(scared|afraid|terrified|panicking)\b/i, emotion: "fear", valence: -0.8, intensity: 0.7 },
  { pattern: /😡|😤|😢|😭|💔/u, emotion: "distress", valence: -0.8, intensity: 0.7 },

  // Surprise
  { pattern: /\b(surprised|shocked|wow|whoa|can't believe|unexpected)\b/i, emotion: "surprise", valence: 0.0, intensity: 0.6 },
  { pattern: /😱|😲|🤯/u, emotion: "surprise", valence: 0.0, intensity: 0.6 },

  // Dutch emotional patterns
  { pattern: /\b(boos|kwaad|geïrriteerd)\b/i, emotion: "anger", valence: -0.7, intensity: 0.6 },
  { pattern: /\b(verdrietig|droevig|huilen)\b/i, emotion: "sadness", valence: -0.7, intensity: 0.6 },
  { pattern: /\b(blij|vrolijk|gelukkig|geweldig)\b/i, emotion: "joy", valence: 0.8, intensity: 0.6 },
  { pattern: /\b(bang|angstig|bezorgd|ongerust)\b/i, emotion: "anxiety", valence: -0.5, intensity: 0.5 },
];

// ── Signal Extraction ──

/**
 * Extract emotional signals from observations.
 * Only processes text messages, skips very short messages.
 */
export function extractEmotionSignals(observations: Observation[]): EmotionSignal[] {
  const signals: EmotionSignal[] = [];

  for (const obs of observations) {
    if (!obs.text || obs.text.length < 5) continue;

    const detected: EmotionSignal[] = [];

    for (const { pattern, emotion, valence, intensity } of EMOTION_PATTERNS) {
      // Reset lastIndex for global patterns
      pattern.lastIndex = 0;
      if (pattern.test(obs.text)) {
        // Avoid duplicates of same emotion from same observation
        if (!detected.some(d => d.emotion === emotion)) {
          detected.push({
            emotion,
            intensity,
            valence,
            evidence: obs.text.slice(0, 80),
            sender: obs.sender,
            senderJid: obs.senderJid,
          });
        }
      }
    }

    // Take strongest signal per observation to avoid noise
    if (detected.length > 0) {
      const strongest = [...detected].sort((a, b) => b.intensity - a.intensity)[0];
      signals.push(strongest);
    }
  }

  return signals;
}

// ── Trajectory Analysis ──

/**
 * Compute emotional trajectory for a contact based on recent emotion nodes.
 */
export function computeTrajectory(
  senderJid: string,
  senderName: string,
  graph: MemoryGraph,
): EmotionTrajectory | null {
  // Find emotion nodes related to this contact
  const emotionNodes = graph.findByType("emotion")
    .filter(n => n.tags.includes(senderJid) || n.content.toLowerCase().includes(senderName.toLowerCase()));

  if (emotionNodes.length < 2) return null;

  // Sort by creation time, take last 10
  const sorted = [...emotionNodes]
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-10);

  const recentEmotions = sorted.map(n => ({
    emotion: n.tags.find(t => EMOTION_PATTERNS.some(p => p.emotion === t)) || "unknown",
    valence: n.emotionalValence ?? 0,
    timestamp: n.createdAt,
  }));

  // Compute trend from valence changes
  const valences = recentEmotions.map(e => e.valence);
  const currentValence = valences[valences.length - 1];
  const avgFirst = valences.slice(0, Math.ceil(valences.length / 2)).reduce((s, v) => s + v, 0) / Math.ceil(valences.length / 2);
  const secondHalf = valences.slice(Math.ceil(valences.length / 2));
  const avgSecond = secondHalf.length > 0 ? secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length : 0;

  // Check volatility: high variance in recent valences
  const variance = valences.reduce((s, v) => s + Math.pow(v - currentValence, 2), 0) / valences.length;

  let trend: EmotionTrajectory["trend"];
  if (variance > 0.5) {
    trend = "volatile";
  } else if (avgSecond - avgFirst > 0.2) {
    trend = "improving";
  } else if (avgFirst - avgSecond > 0.2) {
    trend = "declining";
  } else {
    trend = "stable";
  }

  return { senderJid, senderName, recentEmotions, trend, currentValence };
}

// ── Graph Integration ──

/**
 * Create emotion nodes in the memory graph from detected signals.
 * Links emotion nodes to the person via emotional edges.
 */
export function recordEmotionSignals(graph: MemoryGraph, signals: EmotionSignal[]): number {
  let created = 0;

  for (const signal of signals) {
    const nodeId = `emo_${signal.senderJid.slice(0, 8)}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    graph.applyOperations([{
      op: "add_node",
      id: nodeId,
      type: "emotion",
      content: `[${signal.emotion}] ${signal.sender}: "${signal.evidence}"`,
      tags: [signal.emotion, signal.senderJid, "emotion-signal"],
      strength: signal.intensity * 0.8,
      importance: signal.intensity > 0.7 ? 0.5 : undefined,
    }]);

    // Set emotional valence via updateNode (avoid direct mutation)
    graph.updateNode(nodeId, { emotionalValence: signal.valence });

    // Link to person node if it exists
    const personNodes = graph.findByType("person")
      .filter(p => p.tags.some(t => t.includes(signal.senderJid)) || p.content.toLowerCase().includes(signal.sender.toLowerCase()));

    if (personNodes.length > 0) {
      graph.applyOperations([{
        op: "add_edge",
        from: personNodes[0].id,
        to: nodeId,
        type: "emotional",
        weight: signal.intensity,
      }]);
    }

    created++;
  }

  if (created > 0) {
    log(`Recorded ${created} emotion signals`);
  }

  return created;
}

// ── Prompt Summary ──

/**
 * Generate an emotion context summary for the brain prompt.
 */
export function getEmotionContextSummary(graph: MemoryGraph): string {
  const recentEmotions = graph.findByType("emotion")
    .filter(n => Date.now() - n.createdAt < 24 * 3600_000) // last 24h
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 5);

  if (recentEmotions.length === 0) return "";

  const lines = recentEmotions.map(n => {
    const valenceLabel = (n.emotionalValence ?? 0) > 0.3 ? "positive"
      : (n.emotionalValence ?? 0) < -0.3 ? "negative" : "neutral";
    return `- ${n.content.slice(0, 80)} (${valenceLabel})`;
  });

  return lines.join("\n");
}
