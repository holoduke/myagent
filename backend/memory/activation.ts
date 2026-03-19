import type { MemoryGraph } from "./graph.js";
import type { MemoryNode, WorkingMemory } from "./types.js";
import type { Observation } from "../observer.js";
import { createLogger } from "../logger.js";

const log = createLogger("activation");

// ── Keyword Extraction ──

const STOP_WORDS = new Set([
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
  "ok", "okay", "yes", "no", "yeah", "nah", "lol", "haha", "hmm",
  "oh", "ah", "um", "uh", "well", "hey", "hi", "hello", "bye",
  "got", "get", "go", "going", "went", "come", "came", "make", "made",
  "take", "took", "give", "gave", "say", "said", "tell", "told",
  "know", "knew", "think", "thought", "see", "saw", "want", "let",
  "thing", "things", "one", "two", "don", "doesn", "didn", "won",
  "gonna", "wanna", "gotta", "kinda", "really", "actually", "maybe",
  // Dutch stop words
  "de", "het", "een", "van", "dat", "die", "voor", "niet", "zijn", "nog",
  "maar", "met", "ook", "naar", "dan", "wat", "als", "bij", "uit", "aan",
  "kan", "wel", "zou", "ik", "je", "hij", "zij", "wij", "jij",
  "mij", "hem", "haar", "ons", "hun", "dit", "deze", "hoe", "waar",
  "wie", "waarom", "wanneer", "weer", "veel", "meer", "goed",
  "heb", "heeft", "ben", "was", "moet", "wil",
  "doe", "doet", "deed", "gaat", "ging", "kom", "komt", "kwam",
  "laat", "laten", "geeft", "geven", "zegt", "zei", "zien", "zag",
  "nee", "ja", "nou", "toch", "even", "echt", "best", "heel",
  "denk", "weet", "iets", "niets", "alles", "ander", "eigen",
  "steeds", "graag", "gewoon", "helemaal", "eigenlijk", "geweldig",
  "leuk", "prima", "mooi", "fijn", "lekker",
]);

/** Extract unique lowercase keywords (3+ chars, no stop words) from plain text */
export function extractKeywordsFromText(text: string): string[] {
  return [...new Set(
    text.toLowerCase()
      .replace(/[^\p{L}0-9\s'-]/gu, " ")
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w))
  )];
}

export function extractKeywords(observations: Observation[]): string[] {
  const freqs = new Map<string, number>();

  for (const obs of observations) {
    const words = obs.text
      .toLowerCase()
      .replace(/[^\p{L}0-9\s'-]/gu, " ")
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w));

    for (const word of words) {
      freqs.set(word, (freqs.get(word) || 0) + 1);
    }

    // Also extract names (sender)
    if (obs.sender) {
      const name = obs.sender.toLowerCase().trim();
      if (name.length > 1) {
        freqs.set(name, (freqs.get(name) || 0) + 3); // Names weighted higher
      }
    }

    // Group names as keywords
    if (obs.groupName) {
      const gName = obs.groupName.toLowerCase().trim();
      if (gName.length > 1) {
        freqs.set(gName, (freqs.get(gName) || 0) + 2);
      }
    }
  }

  // Sort by frequency, return top terms
  return Array.from(freqs.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([word]) => word);
}

// ── Spreading Activation ──

interface ActivatedNode {
  node: MemoryNode;
  activation: number;
}

export function spreadingActivation(
  graph: MemoryGraph,
  seedTerms: string[],
  maxNodes: number,
  maxHops = 2,
): ActivatedNode[] {
  const activations = new Map<string, number>();

  // Seed: match keywords against node content and tags
  for (const node of graph.allNodes()) {
    let score = 0;
    const contentLower = node.content.toLowerCase();
    const tagsLower = node.tags.map(t => t.toLowerCase());

    for (const term of seedTerms) {
      if (contentLower.includes(term)) score += 0.3;
      if (tagsLower.some(t => t.includes(term))) score += 0.5;
    }

    if (score > 0) {
      // Weight by node strength
      activations.set(node.id, score * node.strength);
    }
  }

  // Spread through edges
  for (let hop = 0; hop < maxHops; hop++) {
    const spreadFactor = Math.pow(0.5, hop + 1); // 0.5, 0.25, ...
    const currentIds = Array.from(activations.keys());

    for (const id of currentIds) {
      const nodeActivation = activations.get(id)!;
      const edges = graph.edgesFor(id);

      for (const edge of edges) {
        const neighborId = edge.from === id ? edge.to : edge.from;
        const neighbor = graph.getNode(neighborId);
        if (!neighbor) continue;

        const spread = nodeActivation * spreadFactor * edge.weight * neighbor.strength;
        if (spread < 0.01) continue;

        const existing = activations.get(neighborId) || 0;
        activations.set(neighborId, Math.max(existing, spread));
      }
    }
  }

  // Hierarchical boost pass: after normal spreading, boost via hierarchy
  const hierarchicalIds = Array.from(activations.keys());
  for (const id of hierarchicalIds) {
    const nodeActivation = activations.get(id)!;

    // If this node has concept parents, activate siblings
    const parents = graph.getParents(id);
    for (const parent of parents) {
      const parentAct = activations.get(parent.id) || 0;
      // Activate the parent concept if not already
      if (!activations.has(parent.id)) {
        activations.set(parent.id, nodeActivation * 0.4);
      }
      // Activate siblings (other children of the same parent)
      const siblings = graph.getChildren(parent.id);
      for (const sibling of siblings) {
        if (sibling.id === id) continue;
        const siblingBoost = 0.3 * (parentAct || nodeActivation * 0.4) * sibling.strength;
        if (siblingBoost < 0.01) continue;
        const existing = activations.get(sibling.id) || 0;
        activations.set(sibling.id, Math.max(existing, siblingBoost));
      }
    }

    // If this is a concept node, activate all children
    const node = graph.getNode(id);
    if (node && node.type === "concept") {
      const children = graph.getChildren(id);
      for (const child of children) {
        const childBoost = 0.6 * nodeActivation * child.strength;
        if (childBoost < 0.01) continue;
        const existing = activations.get(child.id) || 0;
        activations.set(child.id, Math.max(existing, childBoost));
      }
    }
  }

  // Collect and sort by activation
  const results: ActivatedNode[] = [];
  for (const [id, activation] of activations) {
    const node = graph.getNode(id);
    if (node) {
      results.push({ node, activation });
    }
  }

  results.sort((a, b) => b.activation - a.activation);
  return results.slice(0, maxNodes);
}

// ── Context Selection ──

export function selectContextForThink(
  graph: MemoryGraph,
  wm: WorkingMemory,
  observations: Observation[],
  boostNodeIds: string[] = [],
): MemoryNode[] {
  const keywords = extractKeywords(observations);
  log(`Think context: ${keywords.length} keywords from ${observations.length} observations`);

  // Association-triggered archive recall: use spreading activation pattern to score cold storage
  if (keywords.length > 0 && graph.archiveSize > 0) {
    // Run a lightweight activation pass to get the current context pattern
    const contextActivation = spreadingActivation(graph, keywords, 10, 1);

    // Build activation-weighted terms from the activated nodes
    const weightedTerms = new Map<string, number>();
    for (const { node, activation } of contextActivation) {
      for (const term of extractKeywordsFromText(node.content)) {
        const existing = weightedTerms.get(term) || 0;
        weightedTerms.set(term, Math.max(existing, activation));
      }
      for (const tag of node.tags) {
        const t = tag.toLowerCase();
        const existing = weightedTerms.get(t) || 0;
        weightedTerms.set(t, Math.max(existing, activation));
      }
    }
    // Direct keywords get base weight
    for (const kw of keywords.slice(0, 10)) {
      const existing = weightedTerms.get(kw) || 0;
      weightedTerms.set(kw, Math.max(existing, 0.3));
    }

    // Score archived nodes against weighted terms
    const RECALL_THRESHOLD = 0.2;
    const recalled: { id: string; score: number }[] = [];
    for (const archived of graph.allArchivedNodes()) {
      const contentLower = archived.content.toLowerCase();
      const tagsLower = archived.tags.map(t => t.toLowerCase());
      let score = 0;
      for (const [term, weight] of weightedTerms) {
        if (contentLower.includes(term)) score += 0.3 * weight;
        if (tagsLower.some(t => t.includes(term))) score += 0.5 * weight;
      }
      if (score > 0) {
        score *= archived.strength;
        if (score >= RECALL_THRESHOLD) {
          recalled.push({ id: archived.id, score });
        }
      }
    }

    // Restore top matches (max 3 per think cycle)
    recalled.sort((a, b) => b.score - a.score);
    let restored = 0;
    for (const { id } of recalled.slice(0, 3)) {
      if (graph.restoreNode(id)) restored++;
    }
    if (restored > 0) {
      log(`Archive recall: restored ${restored} nodes via activation-weighted scoring (${weightedTerms.size} terms)`);
    }
  }

  const activated = spreadingActivation(graph, keywords, 25);

  // Boost activation for initiative signal related nodes
  for (const nodeId of boostNodeIds) {
    const existing = activated.find(a => a.node.id === nodeId);
    if (existing) {
      existing.activation += 0.5; // Significant boost
    } else {
      const node = graph.getNode(nodeId);
      if (node) {
        activated.push({ node, activation: 0.5 });
      }
    }
  }
  // Boost activation for nodes related to due follow-ups
  const now = Date.now();
  const FOLLOWUP_BOOST = 0.3;
  for (const fu of wm.pendingFollowUps) {
    if (fu.potentiallyResolved) continue;
    if (!fu.dueAt || fu.dueAt > now) continue; // only due or overdue

    // Extract keywords from the follow-up question + context
    const fuKeywords = extractKeywordsFromText(fu.question + " " + fu.context);

    // Find and boost person nodes matching targetPerson
    if (fu.targetPerson) {
      const personName = fu.targetPerson.toLowerCase();
      for (const pNode of graph.findByType("person")) {
        if (pNode.content.toLowerCase().includes(personName) ||
            pNode.tags.some(t => t.toLowerCase().includes(personName))) {
          const existing = activated.find(a => a.node.id === pNode.id);
          if (existing) {
            existing.activation += FOLLOWUP_BOOST;
          } else {
            activated.push({ node: pNode, activation: FOLLOWUP_BOOST });
          }
        }
      }
    }

    // Find and boost topic-matching nodes
    if (fuKeywords.length > 0) {
      for (const node of graph.allNodes()) {
        if (activated.some(a => a.node.id === node.id && a.activation >= FOLLOWUP_BOOST)) continue;
        const contentLower = node.content.toLowerCase();
        const tagsLower = node.tags.map(t => t.toLowerCase());
        let hits = 0;
        for (const kw of fuKeywords) {
          if (contentLower.includes(kw)) hits++;
          if (tagsLower.some(t => t.includes(kw))) hits++;
        }
        // Require at least 2 keyword hits to avoid noise
        if (hits >= 2) {
          const existing = activated.find(a => a.node.id === node.id);
          if (existing) {
            existing.activation += FOLLOWUP_BOOST;
          } else {
            activated.push({ node, activation: FOLLOWUP_BOOST });
          }
        }
      }
    }
  }

  // Re-sort after boosting
  activated.sort((a, b) => b.activation - a.activation);

  // Inject concept parents for activated nodes
  const conceptNodes: MemoryNode[] = [];
  const seenConcepts = new Set<string>();
  for (const a of activated) {
    const parents = graph.getParents(a.node.id);
    for (const parent of parents) {
      if (parent.type === "concept" && !seenConcepts.has(parent.id) && !activated.some(x => x.node.id === parent.id)) {
        seenConcepts.add(parent.id);
        conceptNodes.push(parent);
      }
    }
  }

  // Also include working memory's activated nodes
  const wmNodes: MemoryNode[] = [];
  for (const id of wm.activatedNodeIds) {
    const node = graph.getNode(id);
    if (node && !activated.some(a => a.node.id === id) && !conceptNodes.some(c => c.id === id)) {
      wmNodes.push(node);
    }
  }

  // Include all pinned nodes (core identity)
  const pinned = graph.allNodes().filter(
    n => n.pinned && !activated.some(a => a.node.id === n.id) && !wmNodes.some(w => w.id === n.id),
  );

  const result = [
    ...pinned,
    ...conceptNodes,
    ...activated.map(a => a.node),
    ...wmNodes.slice(0, 5),
  ];

  log(`Think context selected: ${result.length} nodes (${pinned.length} pinned, ${conceptNodes.length} concepts, ${activated.length} activated, ${wmNodes.length} from WM)`);
  return result.slice(0, 35);
}

export function selectContextForConsolidate(graph: MemoryGraph): {
  weakNodes: MemoryNode[];
  orphanNodes: MemoryNode[];
  duplicateCandidates: [MemoryNode, MemoryNode][];
  stats: ReturnType<MemoryGraph["getStats"]>;
} {
  const stats = graph.getStats();
  const allNodes = graph.allNodes();

  // Weak nodes (strength < 0.3, not pinned)
  const weakNodes = allNodes
    .filter(n => !n.pinned && n.strength < 0.3)
    .sort((a, b) => a.strength - b.strength)
    .slice(0, 20);

  // Orphan nodes (no edges)
  const orphanNodes = allNodes
    .filter(n => !n.pinned && graph.edgesFor(n.id).length === 0)
    .slice(0, 15);

  // Duplicate candidates: same type, similar tags
  const duplicateCandidates: [MemoryNode, MemoryNode][] = [];
  const byType = new Map<string, MemoryNode[]>();
  for (const node of allNodes) {
    if (!byType.has(node.type)) byType.set(node.type, []);
    byType.get(node.type)!.push(node);
  }

  for (const [, nodes] of byType) {
    for (let i = 0; i < nodes.length && duplicateCandidates.length < 10; i++) {
      for (let j = i + 1; j < nodes.length && duplicateCandidates.length < 10; j++) {
        const overlap = nodes[i].tags.filter(t =>
          nodes[j].tags.some(t2 => t2.toLowerCase() === t.toLowerCase()),
        );
        if (overlap.length >= 2) {
          duplicateCandidates.push([nodes[i], nodes[j]]);
        }
      }
    }
  }

  log(`Consolidate context: ${weakNodes.length} weak, ${orphanNodes.length} orphans, ${duplicateCandidates.length} duplicate candidates`);

  return { weakNodes, orphanNodes, duplicateCandidates, stats };
}

export function selectContextForReflect(graph: MemoryGraph): MemoryNode[] {
  const allNodes = graph.allNodes();

  // Strongest nodes
  const strongest = allNodes
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 15);

  // All meta and plan nodes
  const metaAndPlans = allNodes
    .filter(n => (n.type === "meta" || n.type === "plan") && !strongest.some(s => s.id === n.id));

  // All pinned nodes not already included
  const pinned = allNodes
    .filter(n => n.pinned && !strongest.some(s => s.id === n.id) && !metaAndPlans.some(m => m.id === n.id));

  const result = [...pinned, ...strongest, ...metaAndPlans];
  log(`Reflect context: ${result.length} nodes (${pinned.length} pinned, ${strongest.length} strongest, ${metaAndPlans.length} meta/plan)`);
  return result.slice(0, 40);
}

// ── Serialization ──

export function serializeNodesForPrompt(nodes: MemoryNode[], graph: MemoryGraph): string {
  if (nodes.length === 0) return "(no memory nodes yet)";

  return nodes.map(node => {
    const edges = graph.edgesFor(node.id);
    const nonHierarchical = edges.filter(e => e.type !== "hierarchical").slice(0, 5);
    const connections = nonHierarchical.map(e => {
      const otherId = e.from === node.id ? e.to : e.from;
      const other = graph.getNode(otherId);
      const label = other ? other.content.slice(0, 30) : otherId;
      return `${e.type}→${label}`;
    });

    // Show hierarchical info
    const parents = graph.getParents(node.id);
    const children = graph.getChildren(node.id);
    const parentStr = parents.length > 0
      ? ` | parent: ${parents.map(p => `${p.content.slice(0, 30)} (${p.type})`).join(", ")}`
      : "";
    const childStr = children.length > 0
      ? ` | children: ${children.length}`
      : "";

    // For concept nodes, show sibling count
    let siblingStr = "";
    if (parents.length > 0) {
      const siblingCount = parents.reduce((sum, p) => sum + graph.getChildren(p.id).length - 1, 0);
      if (siblingCount > 0) siblingStr = ` | siblings: ${siblingCount} more`;
    }

    const connStr = connections.length > 0 ? ` | links: ${connections.join(", ")}` : "";
    const pinStr = node.pinned ? " [PINNED]" : "";
    const tags = node.tags.length > 0 ? ` #${node.tags.join(" #")}` : "";

    return `[${node.id}] (${node.type}, str:${node.strength.toFixed(2)}${pinStr})${tags}\n  ${node.content.slice(0, 200)}${connStr}${parentStr}${childStr}${siblingStr}`;
  }).join("\n\n");
}
