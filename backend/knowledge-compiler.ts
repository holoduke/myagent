/**
 * Knowledge Compilation (Research: SOAR/ACT-R Cognitive Design Patterns, 2025)
 *
 * When ARIA detects repeated reasoning patterns (same type of context → same conclusion),
 * compile them into fast-path "compiled knowledge" procedure nodes. On future encounters,
 * skip the full reasoning chain and use the compiled result directly.
 *
 * This saves tokens, reduces latency, and codifies learned strategies.
 */

import type { MemoryGraph } from "./memory/graph.js";
import type { MemoryNode } from "./memory/types.js";
import { createLogger } from "./logger.js";

const log = createLogger("knowledge-compiler");

// ── Types ──

export interface ReasoningPattern {
  /** The type of context that triggers this pattern */
  contextSignature: string;
  /** The conclusion or action taken */
  conclusion: string;
  /** How many times this pattern has been observed */
  occurrences: number;
  /** Node IDs that contributed to this pattern */
  sourceNodeIds: string[];
  /** Average confidence of the pattern */
  avgConfidence: number;
}

// ── Pattern Detection ──

const COMPILATION_THRESHOLD = 3; // Require 3+ occurrences to compile

/**
 * Detect repeated reasoning patterns by analyzing insight and procedure nodes
 * that share similar tags and content structure.
 */
export function detectRepeatedPatterns(graph: MemoryGraph): ReasoningPattern[] {
  const patterns = new Map<string, ReasoningPattern>();

  // Look at insight nodes — these represent conclusions Claude has reached
  const insights = graph.findByType("insight");
  const procedures = graph.findByType("procedure");
  const allReasoningNodes = [...insights, ...procedures];

  // Group by tag signature (sorted tags as key)
  for (const node of allReasoningNodes) {
    const significantTags = node.tags
      .filter(t => !["gist", "reflective-consolidation", "promoted-to-semantic", "evidence-updated"].includes(t))
      .sort()
      .slice(0, 5);

    if (significantTags.length < 2) continue;

    const signature = significantTags.join("|");
    const existing = patterns.get(signature);

    if (existing) {
      existing.occurrences++;
      existing.sourceNodeIds.push(node.id);
      existing.avgConfidence = (existing.avgConfidence * (existing.occurrences - 1) + (node.confidence ?? 0.5)) / existing.occurrences;

      // Update conclusion to the most recent version
      if (node.createdAt > (graph.getNode(existing.sourceNodeIds[0])?.createdAt ?? 0)) {
        existing.conclusion = node.content;
      }
    } else {
      patterns.set(signature, {
        contextSignature: signature,
        conclusion: node.content,
        occurrences: 1,
        sourceNodeIds: [node.id],
        avgConfidence: node.confidence ?? 0.5,
      });
    }
  }

  // Return only patterns that meet the compilation threshold
  return [...patterns.values()].filter(p => p.occurrences >= COMPILATION_THRESHOLD);
}

/**
 * Check if a compiled knowledge node already exists for a given pattern.
 */
function isAlreadyCompiled(graph: MemoryGraph, signature: string): boolean {
  return graph.findByType("procedure").some(n =>
    n.tags.includes("compiled-knowledge") && n.tags.includes(signature),
  );
}

/**
 * Compile a repeated reasoning pattern into a procedure node.
 * This creates a fast-path shortcut that can be retrieved instead of re-reasoning.
 */
export function compilePattern(graph: MemoryGraph, pattern: ReasoningPattern): string | null {
  // Skip if already compiled
  if (isAlreadyCompiled(graph, pattern.contextSignature)) return null;

  const nodeId = `compiled_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const contextTags = pattern.contextSignature.split("|");

  graph.applyOperations([{
    op: "add_node",
    id: nodeId,
    type: "procedure",
    content: `[compiled knowledge] When context involves [${contextTags.join(", ")}]: ${pattern.conclusion.slice(0, 200)}`,
    tags: [...contextTags, "compiled-knowledge", pattern.contextSignature],
    strength: 0.7,
    importance: 0.5,
  }]);

  // Create edges from the compiled node to its source nodes
  for (const sourceId of pattern.sourceNodeIds.slice(0, 3)) {
    if (graph.getNode(sourceId)) {
      graph.applyOperations([{
        op: "add_edge",
        from: nodeId,
        to: sourceId,
        type: "topical",
        weight: 0.5,
      }]);
    }
  }

  log(`Compiled pattern: "${contextTags.join(", ")}" (${pattern.occurrences} occurrences, confidence: ${pattern.avgConfidence.toFixed(2)})`);

  return nodeId;
}

/**
 * Run the knowledge compilation pass.
 * Detects repeated patterns and compiles them into procedure nodes.
 */
export function runKnowledgeCompilation(graph: MemoryGraph): number {
  const patterns = detectRepeatedPatterns(graph);
  if (patterns.length === 0) return 0;

  let compiled = 0;
  for (const pattern of patterns) {
    if (compilePattern(graph, pattern)) compiled++;
  }

  if (compiled > 0) {
    log(`Knowledge compilation: compiled ${compiled}/${patterns.length} patterns into procedure nodes`);
  }

  return compiled;
}

/**
 * Get compiled knowledge summary for the brain prompt.
 */
export function getCompiledKnowledgeSummary(graph: MemoryGraph): string {
  const compiled = graph.findByType("procedure")
    .filter(n => n.tags.includes("compiled-knowledge"))
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 5);

  if (compiled.length === 0) return "";

  return compiled
    .map(n => `- ${n.content.replace("[compiled knowledge] ", "").slice(0, 100)}`)
    .join("\n");
}
