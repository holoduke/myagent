/**
 * Preference learning from owner behavior patterns.
 * Extracts signals from observations to build preference nodes in the memory graph.
 * Categories: message_length, active_hours, topic_receptivity, language_pattern.
 */

import type { MemoryGraph } from "./memory/graph.js";
import type { Observation } from "./observer.js";
import type { MemoryNode } from "./memory/types.js";
import { createLogger } from "./logger.js";

const log = createLogger("preferences");

// ── Types ──

export interface PreferenceData {
  category: string;
  value: string;
  confidence: number;
  evidence: string[];
}

export interface PreferenceSignal {
  category: string;
  value: string;
  evidence: string;
}

// ── Signal Extraction ──

/**
 * Analyze observations to extract preference signals from owner behavior.
 * Only analyzes owner's outgoing messages and reply patterns.
 */
export function extractPreferenceSignals(observations: Observation[]): PreferenceSignal[] {
  const signals: PreferenceSignal[] = [];

  const ownerMessages = observations.filter(o => o.isFromMe && o.text);
  const incomingMessages = observations.filter(o => !o.isFromMe && o.text);

  if (ownerMessages.length === 0) return signals;

  // 1. Message length preference
  const avgLength = ownerMessages.reduce((sum, o) => sum + o.text.length, 0) / ownerMessages.length;
  if (avgLength < 50) {
    signals.push({
      category: "message_length",
      value: "prefers short messages (under 50 chars)",
      evidence: `Average outgoing message length: ${Math.round(avgLength)} chars across ${ownerMessages.length} messages`,
    });
  } else if (avgLength > 200) {
    signals.push({
      category: "message_length",
      value: "comfortable with longer messages (200+ chars)",
      evidence: `Average outgoing message length: ${Math.round(avgLength)} chars across ${ownerMessages.length} messages`,
    });
  }

  // 2. Active hours
  const hourCounts = new Map<number, number>();
  for (const msg of ownerMessages) {
    const hour = new Date(msg.timestamp).getHours();
    hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
  }
  const peakHour = [...hourCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (peakHour && peakHour[1] >= 3) {
    signals.push({
      category: "active_hours",
      value: `most active around ${peakHour[0]}:00 (${peakHour[1]} messages)`,
      evidence: `Peak activity hour: ${peakHour[0]}:00 with ${peakHour[1]} messages`,
    });
  }

  // 3. Reply speed → topic receptivity
  for (const incoming of incomingMessages) {
    // Find next owner reply within 10 minutes
    const reply = ownerMessages.find(o =>
      o.timestamp > incoming.timestamp &&
      o.timestamp - incoming.timestamp < 10 * 60 * 1000 &&
      (o.chatJid === incoming.chatJid || o.chatJid === incoming.senderJid)
    );

    if (reply) {
      const replyMs = reply.timestamp - incoming.timestamp;
      if (replyMs < 60_000) {
        // Quick reply — high engagement
        const topic = incoming.text.slice(0, 50);
        signals.push({
          category: "topic_receptivity",
          value: `quick reply to ${incoming.sender}: "${topic}..." (${Math.round(replyMs / 1000)}s)`,
          evidence: `Replied to ${incoming.sender} in ${Math.round(replyMs / 1000)} seconds`,
        });
      }
    }
  }

  // 4. Language pattern
  const dutchPattern = /\b(hoi|goed|dank|mooi|fijn|oké|prima|tot|zien|groet)\b/i;
  const dutchCount = ownerMessages.filter(o => dutchPattern.test(o.text)).length;
  const dutchRatio = dutchCount / ownerMessages.length;
  if (dutchRatio > 0.3) {
    signals.push({
      category: "language_pattern",
      value: `frequently uses Dutch (${Math.round(dutchRatio * 100)}% of messages)`,
      evidence: `${dutchCount}/${ownerMessages.length} messages contain Dutch words`,
    });
  }

  // 5. Emoji usage
  const emojiPattern = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;
  const emojiCount = ownerMessages.filter(o => emojiPattern.test(o.text)).length;
  const emojiRatio = emojiCount / ownerMessages.length;
  if (emojiRatio > 0.4) {
    signals.push({
      category: "language_pattern",
      value: `uses emojis frequently (${Math.round(emojiRatio * 100)}% of messages)`,
      evidence: `${emojiCount}/${ownerMessages.length} messages contain emojis`,
    });
  } else if (emojiRatio < 0.05 && ownerMessages.length >= 10) {
    signals.push({
      category: "language_pattern",
      value: "rarely uses emojis",
      evidence: `Only ${emojiCount}/${ownerMessages.length} messages contain emojis`,
    });
  }

  return signals;
}

// ── Graph Integration ──

/**
 * Create or update preference nodes in the memory graph based on extracted signals.
 */
export function updatePreferences(graph: MemoryGraph, signals: PreferenceSignal[]): void {
  if (signals.length === 0) return;

  // Find existing preference nodes
  const existingPrefs = graph.findByType("preference" as MemoryNode["type"]);
  const prefByCategory = new Map<string, MemoryNode>();
  for (const node of existingPrefs) {
    const match = node.content.match(/^\[([^\]]+)\]/);
    if (match) {
      prefByCategory.set(match[1], node);
    }
  }

  let created = 0;
  let updated = 0;

  for (const signal of signals) {
    const existing = prefByCategory.get(signal.category);

    if (existing) {
      // Update existing preference — append evidence if new
      if (!existing.content.includes(signal.evidence)) {
        const updatedContent = `[${signal.category}] ${signal.value}\nEvidence: ${signal.evidence}`;
        graph.updateNode(existing.id, { content: updatedContent });
        // Reinforce
        const node = graph.getNode(existing.id);
        if (node) {
          node.strength = Math.min(1, node.strength + 0.05);
          node.lastAccessedAt = Date.now();
          node.accessCount++;
        }
        updated++;
      }
    } else {
      // Create new preference node
      graph.applyOperations([{
        op: "add_node",
        id: `pref_${signal.category}_${Date.now().toString(36)}`,
        type: "preference" as MemoryNode["type"],
        content: `[${signal.category}] ${signal.value}\nEvidence: ${signal.evidence}`,
        tags: ["preference", signal.category, "owner-behavior"],
        strength: 0.6,
      }]);
      created++;
    }
  }

  if (created > 0 || updated > 0) {
    log(`Preferences: ${created} created, ${updated} updated from ${signals.length} signals`);
  }
}

// ── Prompt Summary ──

/**
 * Generate a formatted preference summary for inclusion in the brain prompt.
 */
export function getPreferenceSummary(graph: MemoryGraph): string {
  const prefs = graph.findByType("preference" as MemoryNode["type"]);
  if (prefs.length === 0) return "";

  // Sort by strength (most confident first)
  const sorted = [...prefs].sort((a, b) => b.strength - a.strength);

  const lines = sorted
    .slice(0, 10) // max 10 preferences in prompt
    .map(p => {
      const match = p.content.match(/^\[([^\]]+)\]\s*(.*)/s);
      if (match) {
        return `- ${match[1]}: ${match[2].split("\n")[0]}`;
      }
      return `- ${p.content.split("\n")[0]}`;
    });

  return lines.join("\n");
}
