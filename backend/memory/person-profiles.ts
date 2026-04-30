/**
 * Structured Person Profiles
 *
 * Extracts and maintains structured profiles from person nodes and their
 * connected facts, events, and social edges. Provides a canonical view
 * per person for more reliable person-related queries.
 */

import type { MemoryGraph } from "./graph.js";
import type { MemoryNode } from "./types.js";
import { createLogger } from "../logger.js";
import { safeReadJSON, atomicWriteJSON, ensureDir } from "../utils/file-store.js";
import { BRAIN_DIR } from "../config.js";

const log = createLogger("person-profiles");

const PROFILES_FILE = `${BRAIN_DIR}/graph/person-profiles.json`;

// ── Types ──

export interface PersonProfile {
  /** Node ID of the person node in the graph */
  nodeId: string;
  /** Display name */
  name: string;
  /** Relationship to Gillis (e.g. "partner", "friend", "colleague", "co-parent") */
  relation: string;
  /** Tags aggregated from all connected nodes */
  tags: string[];
  /** Key facts extracted from connected fact/event nodes */
  keyFacts: string[];
  /** Last time this person appeared in an observation */
  lastSeenAt: number;
  /** Total messages observed from this person (approximate) */
  messageCount: number;
  /** Average contact frequency: messages per week (rolling 30-day) */
  contactFrequency: number;
  /** Last time the profile was rebuilt */
  updatedAt: number;
}

// ── Relation Inference ──

const RELATION_SIGNALS: Record<string, string[]> = {
  partner: ["partner", "ilse", "girlfriend", "vriendin"],
  "co-parent": ["co-parent", "maaike", "co-ouder"],
  child: ["child", "children", "son", "daughter", "gillis-child", "zoon", "dochter"],
  family: ["family", "brother", "sister", "parent", "mother", "father", "broer", "zus", "ouder"],
  friend: ["friend", "gillis-friend", "vriend", "vriendin"],
  colleague: ["colleague", "work", "newstory", "professional", "collega"],
};

function inferRelation(node: MemoryNode, connectedNodes: MemoryNode[]): string {
  const allTags = new Set([
    ...node.tags.map(t => t.toLowerCase()),
    ...connectedNodes.flatMap(n => n.tags.map(t => t.toLowerCase())),
  ]);
  const allContent = [node.content, ...connectedNodes.map(n => n.content)]
    .join(" ").toLowerCase();

  for (const [relation, signals] of Object.entries(RELATION_SIGNALS)) {
    for (const signal of signals) {
      if (allTags.has(signal) || allContent.includes(signal)) {
        return relation;
      }
    }
  }
  return "contact";
}

// ── Key Fact Extraction ──

function extractKeyFacts(connectedNodes: MemoryNode[]): string[] {
  const facts: string[] = [];
  const seen = new Set<string>();

  for (const node of connectedNodes) {
    if (node.type !== "fact" && node.type !== "event" && node.type !== "preference") continue;
    // Skip weak/dying nodes
    if (node.strength < 0.15) continue;

    const summary = node.content.slice(0, 120);
    // Simple dedup via first 40 chars
    const key = summary.slice(0, 40).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push(summary);
  }

  return facts.slice(0, 10); // max 10 key facts per person
}

// ── Profile Building ──

/**
 * Build or refresh a structured profile for a person node.
 */
function buildProfile(graph: MemoryGraph, personNode: MemoryNode): PersonProfile {
  const edges = graph.edgesFor(personNode.id);
  const connectedNodes: MemoryNode[] = [];

  for (const edge of edges) {
    const otherId = edge.from === personNode.id ? edge.to : edge.from;
    const other = graph.getNode(otherId);
    if (other) connectedNodes.push(other);
  }

  const relation = inferRelation(personNode, connectedNodes);
  const keyFacts = extractKeyFacts(connectedNodes);

  // Aggregate tags from person + connected nodes
  const allTags = new Set<string>();
  for (const tag of personNode.tags) allTags.add(tag.toLowerCase());
  for (const node of connectedNodes) {
    for (const tag of node.tags) {
      if (tag.length > 2) allTags.add(tag.toLowerCase());
    }
  }

  // Extract name from content (first line or up to first period/comma)
  const name = personNode.content.split(/[.,\n]/)[0].trim().slice(0, 50);

  // Last seen: most recent lastAccessedAt among person + connected event nodes
  let lastSeenAt = personNode.lastAccessedAt;
  for (const node of connectedNodes) {
    if (node.type === "event" && node.lastAccessedAt > lastSeenAt) {
      lastSeenAt = node.lastAccessedAt;
    }
  }

  return {
    nodeId: personNode.id,
    name,
    relation,
    tags: Array.from(allTags).slice(0, 20),
    keyFacts,
    lastSeenAt,
    messageCount: personNode.accessCount,
    contactFrequency: 0, // computed separately below
    updatedAt: Date.now(),
  };
}

// ── Public API ──

/**
 * Rebuild all person profiles from the current graph state.
 * Called during consolidation ticks.
 */
export function rebuildPersonProfiles(graph: MemoryGraph): PersonProfile[] {
  const personNodes = graph.findByType("person");
  const profiles: PersonProfile[] = [];

  for (const node of personNodes) {
    const profile = buildProfile(graph, node);
    profiles.push(profile);
  }

  // Sort by last seen (most recent first)
  profiles.sort((a, b) => b.lastSeenAt - a.lastSeenAt);

  // Save to disk
  try {
    ensureDir(`${BRAIN_DIR}/graph`);
    atomicWriteJSON(PROFILES_FILE, profiles, 2);
  } catch (err) {
    log(`Failed to save person profiles: ${err}`);
  }

  log(`Rebuilt ${profiles.length} person profiles`);
  return profiles;
}

/**
 * Load cached person profiles from disk.
 */
export function loadPersonProfiles(): PersonProfile[] {
  return safeReadJSON<PersonProfile[]>(PROFILES_FILE, []);
}

/**
 * Serialize person profiles for inclusion in brain prompts.
 * Returns a compact string suitable for context injection.
 */
export function serializeProfilesForPrompt(profiles: PersonProfile[], maxProfiles = 15): string {
  if (profiles.length === 0) return "";

  const lines = profiles.slice(0, maxProfiles).map(p => {
    const lastSeen = timeSince(p.lastSeenAt);
    const facts = p.keyFacts.length > 0 ? ` | facts: ${p.keyFacts.slice(0, 3).join("; ")}` : "";
    return `  ${p.name} (${p.relation}) — last: ${lastSeen}, msgs: ${p.messageCount}${facts}`;
  });

  return `People:\n${lines.join("\n")}`;
}

function timeSince(ms: number): string {
  const hours = Math.floor((Date.now() - ms) / 3600000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}
