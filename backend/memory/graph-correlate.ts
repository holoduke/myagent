/**
 * Auto-correlation of a freshly added node: finds related nodes by tag and
 * keyword overlap, links them, flags obvious contradictions and cross-tags
 * strong matches (bounded — never with retention-tier signal tags, never past
 * MAX_TAGS_PER_NODE, always through updateNode so the change is logged).
 */

import type { MemoryGraph } from "./graph.js";
import type { MemoryNode, MemoryEdge } from "./types.js";
import { MAX_TAGS_PER_NODE, TIER_TAG_SIGNALS } from "./types.js";
import { extractKeywordsFromText, CORRELATION_NOISE_WORDS } from "./text-utils.js";
import { createLogger } from "../logger.js";

const log = createLogger("graph");

/** Tags that classifyRetentionTier keys on — enriching with these would silently change decay tiers. */
const TIER_SIGNAL_TAGS: ReadonlySet<string> = new Set(
  Object.values(TIER_TAG_SIGNALS).flat().map(t => t.toLowerCase()),
);

const MIN_CORRELATION = 0.15;
const ENRICH_THRESHOLD = 0.3;
const MAX_SAME_TYPE_CANDIDATES = 50;
const AGE_PATTERN = /(\d+)\s*(?:years?\s*old|jaar|jr)/i;

interface Candidate {
  id: string;
  score: number;
}

export interface CorrelationResult {
  correlated: number;
  contradictions: string[];
}

function candidateIds(graph: MemoryGraph, node: MemoryNode): Set<string> {
  const ids = new Set<string>();
  for (const tag of node.tags) {
    for (const match of graph.findByTag(tag)) {
      if (match.id !== node.id) ids.add(match.id);
    }
  }
  let added = 0;
  for (const match of graph.findByType(node.type)) {
    if (match.id === node.id || ids.has(match.id)) continue;
    ids.add(match.id);
    if (++added >= MAX_SAME_TYPE_CANDIDATES) break;
  }
  return ids;
}

function scoreCandidate(node: MemoryNode, existing: MemoryNode, newTags: Set<string>, keywords: Set<string>): number {
  const existTags = new Set(existing.tags.map(t => t.toLowerCase()));
  const tagOverlap = [...newTags].filter(t => existTags.has(t)).length;
  const tagScore = newTags.size > 0 ? tagOverlap / newTags.size : 0;
  const contentLower = existing.content.toLowerCase();
  const keywordHits = [...keywords].filter(kw => contentLower.includes(kw)).length;
  const contentScore = keywords.size > 0 ? keywordHits / keywords.size : 0;
  return tagScore * 0.6 + contentScore * 0.4;
}

function detectAgeConflict(node: MemoryNode, existing: MemoryNode): string | null {
  if (node.type !== existing.type || (node.type !== "person" && node.type !== "fact")) return null;
  const newAge = node.content.match(AGE_PATTERN);
  const existAge = existing.content.match(AGE_PATTERN);
  if (!newAge || !existAge || newAge[1] === existAge[1]) return null;
  return `Possible conflict: "${node.content.slice(0, 60)}..." says ${newAge[0]} but existing node ${existing.id} says ${existAge[0]}`;
}

function edgeTypeFor(a: MemoryNode, b: MemoryNode): MemoryEdge["type"] {
  if (a.type === "person" && b.type === "person") return "social";
  if (a.type === "event" && b.type === "event") return "temporal";
  if (a.type === "emotion") return "emotional";
  return "topical";
}

/** Tags from `source` worth copying onto `target`: new, non-trivial, not tier signals, within the cap. */
export function pickEnrichmentTags(source: string[], target: string[], maxNew = 2): string[] {
  const room = Math.max(0, MAX_TAGS_PER_NODE - target.length);
  const existing = new Set(target.map(t => t.toLowerCase()));
  return source
    .filter(t => t.length > 1 && !existing.has(t.toLowerCase()) && !TIER_SIGNAL_TAGS.has(t.toLowerCase()))
    .slice(0, Math.min(maxNew, room));
}

function enrichTags(graph: MemoryGraph, node: MemoryNode, matches: Candidate[]): void {
  for (const match of matches) {
    if (match.score <= ENRICH_THRESHOLD) continue;
    const existing = graph.getNode(match.id);
    if (!existing) continue;
    const enrich = pickEnrichmentTags(node.tags, existing.tags);
    if (enrich.length === 0) continue;
    graph.updateNode(existing.id, { tags: [...existing.tags, ...enrich] });
    log(`Tag enrichment: ${existing.id} += [${enrich.join(", ")}] (from ${node.id})`);
  }
}

/**
 * Link `node` to its strongest correlates (max `maxEdges`), returning how many
 * edges were created and any contradictions spotted along the way.
 */
export function correlateNode(graph: MemoryGraph, node: MemoryNode, maxEdges = 5): CorrelationResult {
  const newTags = new Set(node.tags.map(t => t.toLowerCase()));
  const keywords = new Set(extractKeywordsFromText(node.content, CORRELATION_NOISE_WORDS));
  const contradictions: string[] = [];
  const candidates: Candidate[] = [];

  for (const id of candidateIds(graph, node)) {
    const existing = graph.getNode(id);
    if (!existing) continue;
    const score = scoreCandidate(node, existing, newTags, keywords);
    if (score < MIN_CORRELATION) continue;
    if (graph.hasEdge(node.id, id) || graph.hasEdge(id, node.id)) continue;
    candidates.push({ id, score });
    if (score > ENRICH_THRESHOLD) {
      const conflict = detectAgeConflict(node, existing);
      if (conflict) contradictions.push(conflict);
    }
  }

  const top = [...candidates].sort((a, b) => b.score - a.score).slice(0, maxEdges);
  const now = Date.now();
  for (const match of top) {
    const existing = graph.getNode(match.id);
    if (!existing) continue;
    graph.addEdge({
      from: node.id,
      to: match.id,
      type: edgeTypeFor(node, existing),
      weight: Math.min(0.7, match.score), // never as strong as an explicit edge
      createdAt: now,
      lastReinforcedAt: now,
    });
  }
  enrichTags(graph, node, top);

  if (top.length > 0) {
    log(`Auto-correlated node ${node.id} → ${top.length} edge(s) [${top.map(c => `${c.id}:${c.score.toFixed(2)}`).join(", ")}]`);
  }
  if (contradictions.length > 0) {
    log(`⚠ Contradictions detected for ${node.id}: ${contradictions.join("; ")}`);
  }
  return { correlated: top.length, contradictions };
}
