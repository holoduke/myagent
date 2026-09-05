/**
 * Shared text utilities for the memory subsystem — one home for stop words,
 * keyword extraction, token similarity and tag-overlap clustering, so the
 * retrieval, consolidation and drift modules all agree on what "similar" means.
 */

import type { MemoryNode } from "./types.js";

// ── Stop Words ──

export const STOP_WORDS: ReadonlySet<string> = new Set([
  // English
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "i", "me", "my", "we", "our", "you", "your", "he", "him", "his",
  "she", "her", "it", "its", "they", "them", "their", "this", "that",
  "these", "those", "am", "to", "of", "in", "for", "on", "with", "at",
  "by", "from", "as", "into", "about", "like", "through", "after",
  "over", "between", "out", "against", "during", "without", "before",
  "under", "around", "among", "but", "and", "or", "nor", "not", "so",
  "very", "just", "also", "then", "than", "too", "both", "each",
  "all", "any", "few", "more", "most", "some", "such", "no", "only",
  "own", "same", "here", "there", "when", "where", "why", "how",
  "what", "which", "who", "whom", "if", "because", "until", "while",
  "ok", "okay", "yes", "yeah", "nah", "lol", "haha", "hmm",
  "oh", "ah", "um", "uh", "well", "hey", "hi", "hello", "bye",
  "got", "get", "go", "going", "went", "come", "came", "make", "made",
  "take", "took", "give", "gave", "say", "said", "tell", "told",
  "know", "knew", "think", "thought", "see", "saw", "want", "let",
  "thing", "things", "one", "two", "don", "doesn", "didn", "won",
  "gonna", "wanna", "gotta", "kinda", "really", "actually", "maybe",
  "use", "way",
  // Dutch
  "de", "het", "een", "van", "dat", "die", "voor", "niet", "zijn", "nog",
  "maar", "met", "ook", "naar", "dan", "wat", "als", "bij", "uit", "aan",
  "kan", "wel", "zou", "ik", "je", "hij", "zij", "wij", "jij",
  "mij", "hem", "haar", "ons", "hun", "dit", "deze", "hoe", "waar",
  "wie", "waarom", "wanneer", "weer", "veel", "meer", "goed",
  "heb", "heeft", "ben", "moet", "wil",
  "doe", "doet", "deed", "gaat", "ging", "kom", "komt", "kwam",
  "laat", "laten", "geeft", "geven", "zegt", "zei", "zien", "zag",
  "nee", "ja", "nou", "toch", "even", "echt", "best", "heel",
  "denk", "weet", "iets", "niets", "alles", "ander", "eigen",
  "steeds", "graag", "gewoon", "helemaal", "eigenlijk", "geweldig",
  "leuk", "prima", "mooi", "fijn", "lekker",
]);

/**
 * Words that appear in nearly every memory node and therefore say nothing
 * about topical relatedness. Used on top of STOP_WORDS when correlating nodes.
 */
export const CORRELATION_NOISE_WORDS: ReadonlySet<string> = new Set([
  "gillis", "confirmed", "day", "via", "whatsapp", "group",
]);

// ── Keyword Extraction ──

const KEYWORD_SPLIT = /[^\p{L}0-9\s'-]/gu;

/**
 * Extract unique lowercase keywords (3+ chars, no stop words, no pure numbers)
 * from plain text. Hyphens and apostrophes inside words are preserved.
 */
export function extractKeywordsFromText(text: string, extraStop?: ReadonlySet<string>): string[] {
  return [...new Set(
    text.toLowerCase()
      .replace(KEYWORD_SPLIT, " ")
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w) && !extraStop?.has(w) && !/^\d+$/.test(w)),
  )];
}

// ── Token Similarity ──

const TOKEN_SPLIT = /[\s\-—,.:;!?()[\]"'`/\\]+/;

/** Lowercase token set (tokens shorter than `minLen` are dropped). */
export function tokenize(text: string, minLen = 2): Set<string> {
  return new Set(text.toLowerCase().split(TOKEN_SPLIT).filter(w => w.length >= minLen));
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

/**
 * Jaccard similarity of word-token sets. 1.0 = identical token sets.
 * Two empty strings count as identical.
 */
export function tokenJaccard(a: string, b: string): number {
  if (a === b) return 1;
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  const inter = intersectionSize(setA, setB);
  const union = setA.size + setB.size - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Overlap coefficient variant: shared tokens / larger token set. More lenient
 * than Jaccard for a short text contained in a longer one.
 */
export function tokenOverlap(a: string, b: string): number {
  const setA = tokenize(a, 3);
  const setB = tokenize(b, 3);
  if (setA.size === 0 || setB.size === 0) return 0;
  return intersectionSize(setA, setB) / Math.max(setA.size, setB.size);
}

// ── Tag Similarity ──

function lowerTagSet(tags: string[]): Set<string> {
  return new Set(tags.map(t => t.toLowerCase()));
}

/** Number of tags shared by two nodes (case-insensitive). */
export function tagOverlapCount(a: string[], b: string[]): number {
  return intersectionSize(lowerTagSet(a), lowerTagSet(b));
}

/** Jaccard similarity of two tag lists (case-insensitive). */
export function tagJaccard(a: string[], b: string[]): number {
  const setA = lowerTagSet(a);
  const setB = lowerTagSet(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  const inter = intersectionSize(setA, setB);
  const union = setA.size + setB.size - inter;
  return union > 0 ? inter / union : 0;
}

// ── Tag-Overlap Clustering ──

export interface TagCluster {
  nodes: MemoryNode[];
  /** Lowercased tags shared between the cluster seed and every member */
  sharedTags: string[];
}

export interface TagClusterOptions {
  /** Tags a node must share with the cluster seed to join (default 2) */
  minSharedTags?: number;
  /** Clusters smaller than this are discarded (default 3) */
  minClusterSize?: number;
  /** Members beyond this are dropped from the cluster (default 10) */
  maxClusterSize?: number;
  /** Stop after this many clusters (default 5) */
  maxClusters?: number;
}

/**
 * Greedy clustering by tag overlap: each unused node seeds a cluster of the
 * other unused nodes that share at least `minSharedTags` tags with it. Uses a
 * tag index so it's O(n · tags) rather than O(n²).
 */
export function clusterByTagOverlap(nodes: MemoryNode[], opts: TagClusterOptions = {}): TagCluster[] {
  const minShared = opts.minSharedTags ?? 2;
  const minSize = opts.minClusterSize ?? 3;
  const maxSize = opts.maxClusterSize ?? 10;
  const maxClusters = opts.maxClusters ?? 5;

  const tagIndex = new Map<string, number[]>();
  nodes.forEach((node, i) => {
    for (const tag of new Set(node.tags.map(t => t.toLowerCase()))) {
      const bucket = tagIndex.get(tag) ?? [];
      tagIndex.set(tag, [...bucket, i]);
    }
  });

  const used = new Set<number>();
  const clusters: TagCluster[] = [];

  for (let i = 0; i < nodes.length && clusters.length < maxClusters; i++) {
    if (used.has(i)) continue;
    const seedTags = new Set(nodes[i].tags.map(t => t.toLowerCase()));
    const overlap = new Map<number, number>();
    for (const tag of seedTags) {
      for (const j of tagIndex.get(tag) ?? []) {
        if (j === i || used.has(j)) continue;
        overlap.set(j, (overlap.get(j) ?? 0) + 1);
      }
    }
    const memberIdx = [...overlap.entries()].filter(([, n]) => n >= minShared).map(([j]) => j);
    if (memberIdx.length + 1 < minSize) continue;

    const members = [i, ...memberIdx].slice(0, maxSize);
    for (const j of members) used.add(j);
    const clusterNodes = members.map(j => nodes[j]);
    const sharedTags = [...seedTags].filter(tag =>
      clusterNodes.every(n => n.tags.some(t => t.toLowerCase() === tag)),
    );
    clusters.push({ nodes: clusterNodes, sharedTags });
  }

  return clusters;
}
