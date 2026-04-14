/**
 * Narrative Summary Builder (Research: StorySage/Narrative Mind, 2025)
 *
 * Constructs a coherent narrative summary of recent events and ongoing themes,
 * rather than presenting memory as disconnected nodes. Stored as a meta node
 * and injected into reflect-tick prompts for richer context.
 *
 * "What's been happening" as a story, not a bag of facts.
 */

import type { MemoryGraph } from "./memory/graph.js";
import type { MemoryNode } from "./memory/types.js";
import { createLogger } from "./logger.js";

const log = createLogger("narrative");

// ── Types ──

export interface NarrativeThread {
  topic: string;
  events: { content: string; timestamp: number; sentiment: string }[];
  participants: string[];
  status: "ongoing" | "concluded" | "stale";
}

export interface NarrativeSummary {
  threads: NarrativeThread[];
  overallMood: string;
  keyThemes: string[];
  generatedAt: number;
}

// ── Narrative Construction ──

const LOOKBACK_WINDOW = 7 * 24 * 3600_000; // 7 days
const MAX_THREADS = 5;

/**
 * Build a coherent narrative from recent memory nodes.
 * Groups related events into threads, identifies themes and participants.
 */
export function buildNarrative(graph: MemoryGraph): NarrativeSummary {
  const now = Date.now();

  // Gather recent event and fact nodes
  const recentNodes = [
    ...graph.findByType("event"),
    ...graph.findByType("fact"),
    ...graph.findByType("insight"),
  ]
    .filter(n => now - n.createdAt < LOOKBACK_WINDOW && n.strength > 0.2)
    .sort((a, b) => a.createdAt - b.createdAt);

  // Group into threads by shared tags (topic clustering)
  const threads = clusterIntoThreads(recentNodes, graph);

  // Determine overall mood from emotion nodes
  const recentEmotions = graph.findByType("emotion")
    .filter(n => now - n.createdAt < LOOKBACK_WINDOW);
  const avgValence = recentEmotions.length > 0
    ? recentEmotions.reduce((s, n) => s + (n.emotionalValence ?? 0), 0) / recentEmotions.length
    : 0;
  const overallMood = avgValence > 0.3 ? "positive" : avgValence < -0.3 ? "concerned" : "neutral";

  // Extract key themes (most frequent tags across all recent nodes)
  const tagCounts = new Map<string, number>();
  for (const node of recentNodes) {
    for (const tag of node.tags) {
      const key = tag.toLowerCase();
      if (!["event", "fact", "insight", "emotion-signal", "gist"].includes(key)) {
        tagCounts.set(key, (tagCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const keyThemes = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag]) => tag);

  return {
    threads: threads.slice(0, MAX_THREADS),
    overallMood,
    keyThemes,
    generatedAt: now,
  };
}

/**
 * Cluster recent nodes into narrative threads based on tag overlap.
 */
function clusterIntoThreads(nodes: MemoryNode[], graph: MemoryGraph): NarrativeThread[] {
  const threads: NarrativeThread[] = [];
  const used = new Set<string>();

  for (const node of nodes) {
    if (used.has(node.id)) continue;

    // Find related nodes via shared tags
    const cluster = [node];
    for (const other of nodes) {
      if (other.id === node.id || used.has(other.id)) continue;
      const sharedTags = node.tags.filter(t =>
        other.tags.some(ot => ot.toLowerCase() === t.toLowerCase()),
      );
      if (sharedTags.length >= 2) {
        cluster.push(other);
      }
    }

    if (cluster.length >= 2) {
      for (const n of cluster) used.add(n.id);

      // Extract topic from most common tags
      const topicTags = new Map<string, number>();
      for (const n of cluster) {
        for (const tag of n.tags) {
          topicTags.set(tag.toLowerCase(), (topicTags.get(tag.toLowerCase()) ?? 0) + 1);
        }
      }
      const topic = [...topicTags.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([t]) => t)
        .join(" & ");

      // Extract participants (person nodes connected to cluster nodes)
      const participantSet = new Set<string>();
      for (const n of cluster) {
        const edges = graph.edgesFor(n.id);
        for (const edge of edges) {
          const otherId = edge.from === n.id ? edge.to : edge.from;
          const other = graph.getNode(otherId);
          if (other?.type === "person") {
            participantSet.add(other.content.split("\n")[0].slice(0, 30));
          }
        }
      }

      // Determine thread status
      const now = Date.now();
      const latestEvent = Math.max(...cluster.map(n => n.createdAt));
      const status: NarrativeThread["status"] =
        now - latestEvent < 2 * 24 * 3600_000 ? "ongoing"
        : now - latestEvent < 5 * 24 * 3600_000 ? "stale"
        : "concluded";

      // Build events with sentiment
      const events = cluster.map(n => ({
        content: n.content.slice(0, 80),
        timestamp: n.createdAt,
        sentiment: (n.emotionalValence ?? 0) > 0.2 ? "positive"
          : (n.emotionalValence ?? 0) < -0.2 ? "negative" : "neutral",
      }));

      threads.push({
        topic,
        events,
        participants: [...participantSet],
        status,
      });
    }
  }

  // Sort by recency (most recent thread first)
  threads.sort((a, b) => {
    const latestA = Math.max(...a.events.map(e => e.timestamp));
    const latestB = Math.max(...b.events.map(e => e.timestamp));
    return latestB - latestA;
  });

  return threads;
}

/**
 * Generate a narrative context summary for the brain prompt.
 */
export function getNarrativeSummary(graph: MemoryGraph): string {
  const narrative = buildNarrative(graph);
  if (narrative.threads.length === 0) return "";

  const lines: string[] = [];
  lines.push(`Mood: ${narrative.overallMood} | Themes: ${narrative.keyThemes.join(", ")}`);

  for (const thread of narrative.threads.slice(0, 3)) {
    const participants = thread.participants.length > 0
      ? ` (with ${Array.isArray(thread.participants) ? thread.participants.join(", ") : thread.participants})`
      : "";
    const eventCount = thread.events.length;
    lines.push(`- [${thread.status}] ${thread.topic}${participants}: ${eventCount} events`);
  }

  return lines.join("\n");
}
