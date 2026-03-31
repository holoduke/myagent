/**
 * Post-Send Verbal Self-Reflection (Research Improvement #2)
 * Inspired by Reflexion architecture.
 *
 * Tracks message outcomes (did the recipient respond? How long? Was it positive?)
 * and creates reflection nodes summarizing what worked and what didn't.
 */

import type { MemoryGraph } from "./memory/graph.js";
import type { Observation } from "./observer.js";
import { createLogger } from "./logger.js";
import { safeReadJSON, atomicWriteJSON, ensureDir } from "./utils/file-store.js";
import { BRAIN_DIR } from "./config.js";

const log = createLogger("reflection");

const REFLECTIONS_FILE = `${BRAIN_DIR}/reflection-tracker.json`;
const MAX_PENDING = 50;

// ── Types ──

export interface PendingReflection {
  /** ID of this pending reflection */
  id: string;
  /** The message that was sent */
  messageSent: string;
  /** Who it was sent to (JID) */
  targetJid: string;
  /** When it was sent */
  sentAt: number;
  /** Was it initiative-driven or a reply? */
  wasInitiative: boolean;
  /** Self-critique score at send time */
  critiqueScore?: number;
}

export interface ReflectionOutcome {
  /** Did the recipient respond? */
  gotResponse: boolean;
  /** Time to response in ms */
  responseTimeMs?: number;
  /** Was the response positive? (simple heuristic) */
  responsePositive?: boolean;
  /** Response snippet */
  responseSnippet?: string;
}

interface ReflectionStore {
  pending: PendingReflection[];
}

// ── Store ──

let store: ReflectionStore | null = null;

function loadStore(): ReflectionStore {
  if (store) return store;
  store = safeReadJSON<ReflectionStore>(REFLECTIONS_FILE, { pending: [] });
  return store;
}

function saveStore(): void {
  if (!store) return;
  ensureDir(BRAIN_DIR);
  atomicWriteJSON(REFLECTIONS_FILE, store);
}

// ── Public API ──

/**
 * Record a sent message for future reflection tracking.
 */
export function trackSentMessage(
  messageSent: string,
  targetJid: string,
  wasInitiative: boolean,
  critiqueScore?: number,
): void {
  const s = loadStore();

  // Prevent unbounded growth
  if (s.pending.length >= MAX_PENDING) {
    s.pending = s.pending.slice(-MAX_PENDING + 1);
  }

  s.pending.push({
    id: `ref_${Date.now().toString(36)}`,
    messageSent: messageSent.slice(0, 200),
    targetJid,
    sentAt: Date.now(),
    wasInitiative,
    critiqueScore,
  });

  saveStore();
}

/**
 * Check new observations against pending reflections to detect responses.
 * Returns resolved reflections with outcomes.
 */
export function resolveReflections(
  observations: Observation[],
): { reflection: PendingReflection; outcome: ReflectionOutcome }[] {
  const s = loadStore();
  const results: { reflection: PendingReflection; outcome: ReflectionOutcome }[] = [];

  const RESPONSE_WINDOW = 4 * 3600_000; // 4 hours max

  // Expire old pending reflections (>24h with no response)
  const expiredIds = new Set<string>();
  const now = Date.now();
  for (const pending of s.pending) {
    if (now - pending.sentAt > 24 * 3600_000) {
      results.push({
        reflection: pending,
        outcome: { gotResponse: false },
      });
      expiredIds.add(pending.id);
    }
  }

  // Check observations for responses to pending messages
  for (const obs of observations) {
    if (obs.isFromMe) continue;
    if (!obs.text) continue;

    for (const pending of s.pending) {
      if (expiredIds.has(pending.id)) continue;

      // Match by JID and timing
      const isFromTarget = obs.senderJid === pending.targetJid ||
        obs.chatJid === pending.targetJid;
      const timeSinceSent = obs.timestamp - pending.sentAt;
      const isInWindow = timeSinceSent > 0 && timeSinceSent < RESPONSE_WINDOW;

      if (isFromTarget && isInWindow) {
        // Simple positivity heuristic
        const positiveWords = /\b(thanks|great|good|nice|ok|sure|yes|ja|goed|fijn|prima|top|dank)\b/i;
        const negativeWords = /\b(no|stop|don't|niet|nee|annoying|spam|shut up)\b/i;
        const isPositive = positiveWords.test(obs.text) && !negativeWords.test(obs.text);

        results.push({
          reflection: pending,
          outcome: {
            gotResponse: true,
            responseTimeMs: timeSinceSent,
            responsePositive: isPositive,
            responseSnippet: obs.text.slice(0, 80),
          },
        });
        expiredIds.add(pending.id);
        break;
      }
    }
  }

  // Remove resolved/expired from pending
  if (expiredIds.size > 0) {
    s.pending = s.pending.filter(p => !expiredIds.has(p.id));
    saveStore();
  }

  return results;
}

/**
 * Create reflection nodes in the memory graph from resolved reflections.
 */
export function createReflectionNodes(
  graph: MemoryGraph,
  reflections: { reflection: PendingReflection; outcome: ReflectionOutcome }[],
): number {
  let created = 0;

  for (const { reflection, outcome } of reflections) {
    let content: string;
    const tags = ["reflection", "self-assessment", "messaging-outcome"];

    if (outcome.gotResponse) {
      const responseTime = outcome.responseTimeMs
        ? `${Math.round(outcome.responseTimeMs / 60_000)}min`
        : "unknown";
      const sentiment = outcome.responsePositive ? "positive" : "neutral/negative";
      content = `[reflection] Message "${reflection.messageSent.slice(0, 60)}..." → ${outcome.gotResponse ? "got response" : "no response"} (${responseTime}, ${sentiment})`;

      if (outcome.responsePositive) {
        tags.push("positive-outcome");
      }
    } else {
      content = `[reflection] Message "${reflection.messageSent.slice(0, 60)}..." → no response within 24h`;
      tags.push("no-response");
    }

    if (reflection.wasInitiative) {
      tags.push("initiative-message");
    }

    const nodeId = `ref_${Date.now().toString(36)}_${created}`;
    graph.applyOperations([{
      op: "add_node",
      id: nodeId,
      type: "reflection",
      content,
      tags,
      strength: 0.5,
      importance: 0.3,
    }]);
    created++;
  }

  if (created > 0) {
    log(`Created ${created} reflection nodes from message outcomes`);
  }

  return created;
}

/**
 * Generate a reflection summary for the brain prompt.
 */
export function getReflectionSummary(graph: MemoryGraph): string {
  const reflections = graph.findByType("reflection")
    .filter(n => Date.now() - n.createdAt < 7 * 24 * 3600_000) // last 7 days
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 5);

  if (reflections.length === 0) return "";

  const positive = reflections.filter(n => n.tags.includes("positive-outcome")).length;
  const noResponse = reflections.filter(n => n.tags.includes("no-response")).length;

  const lines = [
    `Recent messaging outcomes: ${positive} positive, ${noResponse} no-response out of ${reflections.length} tracked`,
  ];

  // Show the most recent reflection
  if (reflections.length > 0) {
    lines.push(`Latest: ${reflections[0].content.slice(0, 100)}`);
  }

  return lines.join("\n");
}
