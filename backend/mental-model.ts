/**
 * Theory of Mind - Contact Mental Models (Research Improvement #10)
 * Inspired by ToMAgent architecture.
 *
 * Models mental states of contacts: what they know, what they
 * care about, their communication preferences, and current concerns.
 * Enriches context for more empathetic and relevant responses.
 */

import type { MemoryGraph } from "./memory/graph.js";
import type { MemoryNode } from "./memory/types.js";
import type { Observation } from "./observer.js";
import { createLogger } from "./logger.js";

const log = createLogger("mental-model");

// ── Types ──

export interface ContactModel {
  personNodeId: string;
  name: string;
  /** Topics they frequently discuss */
  topicInterests: string[];
  /** Their communication style (brief/verbose, formal/casual) */
  communicationStyle: "brief" | "verbose" | "mixed";
  /** Recent emotional state (derived from emotion tracker) */
  recentMood?: string;
  /** When they're typically active */
  activeHours?: number[];
  /** Languages they use */
  languages: string[];
  /** Ongoing concerns or projects they've mentioned */
  currentConcerns: string[];
}

// ── Model Building ──

/**
 * Build a mental model of a contact from their memory graph data.
 */
export function buildContactModel(
  graph: MemoryGraph,
  personNodeId: string,
): ContactModel | null {
  const personNode = graph.getNode(personNodeId);
  if (!personNode || personNode.type !== "person") return null;

  const name = personNode.content.split("\n")[0].replace(/^\[.*?\]\s*/, "").slice(0, 50);

  // Find all nodes connected to this person
  const edges = graph.edgesFor(personNodeId);
  const connectedNodeIds = edges.map(e => e.from === personNodeId ? e.to : e.from);
  const connectedNodes = connectedNodeIds
    .map(id => graph.getNode(id))
    .filter((n): n is MemoryNode => n !== null);

  // Extract topic interests from connected event/fact nodes
  const topicTags = new Map<string, number>();
  for (const node of connectedNodes) {
    if (node.type === "event" || node.type === "fact" || node.type === "insight") {
      for (const tag of node.tags) {
        if (!["person", "event", "emotion-signal", personNodeId].includes(tag)) {
          topicTags.set(tag, (topicTags.get(tag) ?? 0) + 1);
        }
      }
    }
  }
  const topicInterests = [...topicTags.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag]) => tag);

  // Detect communication style from connected event nodes
  const eventNodes = connectedNodes.filter(n => n.type === "event");
  const avgLength = eventNodes.length > 0
    ? eventNodes.reduce((sum, n) => sum + n.content.length, 0) / eventNodes.length
    : 0;
  const communicationStyle: ContactModel["communicationStyle"] =
    avgLength < 60 ? "brief" : avgLength > 200 ? "verbose" : "mixed";

  // Detect languages from content
  const languages: string[] = [];
  const dutchPattern = /\b(hoi|goed|dank|mooi|fijn|oké|prima)\b/i;
  const hasDutch = connectedNodes.some(n => dutchPattern.test(n.content));
  if (hasDutch) languages.push("Dutch");
  languages.push("English"); // default

  // Extract current concerns from recent fact/event nodes
  const recentNodes = connectedNodes
    .filter(n => Date.now() - n.createdAt < 7 * 24 * 3600_000)
    .sort((a, b) => b.createdAt - a.createdAt);
  const currentConcerns = recentNodes
    .slice(0, 3)
    .map(n => n.content.slice(0, 60));

  // Recent mood from emotion nodes
  const emotionNodes = connectedNodes
    .filter(n => n.type === "emotion")
    .sort((a, b) => b.createdAt - a.createdAt);
  const recentMood = emotionNodes.length > 0
    ? emotionNodes[0].tags.find(t => !["emotion-signal", personNodeId].includes(t))
    : undefined;

  return {
    personNodeId,
    name,
    topicInterests,
    communicationStyle,
    recentMood,
    languages,
    currentConcerns,
  };
}

/**
 * Build mental models for all active contacts (person nodes with recent activity).
 */
export function buildActiveContactModels(graph: MemoryGraph): ContactModel[] {
  const now = Date.now();
  const ACTIVE_THRESHOLD = 14 * 24 * 3600_000; // 14 days

  return graph.findByType("person")
    .filter(p => p.pinned || (now - p.lastAccessedAt < ACTIVE_THRESHOLD))
    .map(p => buildContactModel(graph, p.id))
    .filter((m): m is ContactModel => m !== null)
    .slice(0, 10); // cap at 10 models for prompt space
}

/**
 * Generate a Theory of Mind summary for the brain prompt.
 */
export function getToMSummary(graph: MemoryGraph): string {
  const models = buildActiveContactModels(graph);
  if (models.length === 0) return "";

  const lines = models.map(m => {
    const parts = [`${m.name}`];
    if (m.topicInterests.length > 0) {
      parts.push(`interests: ${m.topicInterests.slice(0, 3).join(", ")}`);
    }
    if (m.recentMood) {
      parts.push(`mood: ${m.recentMood}`);
    }
    if (m.currentConcerns.length > 0) {
      parts.push(`on their mind: "${m.currentConcerns[0]}"`);
    }
    return `- ${parts.join(" | ")}`;
  });

  return lines.join("\n");
}
