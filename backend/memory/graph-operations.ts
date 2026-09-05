/**
 * The LLM → graph boundary.
 *
 * `validateOperations` is a hand-written shape/range validator (no schema
 * library) that drops malformed operations with a logged reason.
 * `applyGraphOperations` then applies the survivors with the safety rules:
 *   - remove_node archives instead of hard-deleting
 *   - pinned nodes can't be removed or merged
 *   - at most MAX_DESTRUCTIVE_OPS_PER_BATCH removes + merges per batch
 *   - pinning needs importance ≥ MIN_PIN_IMPORTANCE and a free pin slot
 *   - LLM-chosen ids colliding with archived/ghost ids are re-minted
 */

import type { MemoryGraph } from "./graph.js";
import type { MemoryNode, MemoryOperation, NodeType, EdgeType } from "./types.js";
import {
  NODE_TYPES,
  EDGE_TYPES,
  MAX_DESTRUCTIVE_OPS_PER_BATCH,
  MAX_NODE_CONTENT_CHARS,
  MAX_PINNED_NODES,
  MIN_PIN_IMPORTANCE,
} from "./types.js";
import { createLogger } from "../logger.js";

const log = createLogger("graph-ops");

// ── Validation ──

export interface DroppedOperation {
  op: unknown;
  reason: string;
}

export interface ValidationResult {
  valid: MemoryOperation[];
  dropped: DroppedOperation[];
}

type Raw = Record<string, unknown>;

const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(t => typeof t === "string");
const isUnit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNodeType = (v: unknown): v is NodeType => typeof v === "string" && (NODE_TYPES as readonly string[]).includes(v);
const isEdgeType = (v: unknown): v is EdgeType => typeof v === "string" && (EDGE_TYPES as readonly string[]).includes(v);

/** Optional field: absent/null is fine, present must satisfy `check`. */
function optional(v: unknown, check: (x: unknown) => boolean): boolean {
  return v === undefined || v === null || check(v);
}

function clampContent(content: string): string {
  if (content.length <= MAX_NODE_CONTENT_CHARS) return content;
  log(`Truncating node content from ${content.length} to ${MAX_NODE_CONTENT_CHARS} chars`);
  return content.slice(0, MAX_NODE_CONTENT_CHARS);
}

function validateAddNode(r: Raw): MemoryOperation | string {
  if (!isNonEmptyString(r.id)) return "add_node: missing id";
  if (!isNodeType(r.type)) return `add_node: unknown node type "${String(r.type)}"`;
  if (!isNonEmptyString(r.content)) return "add_node: missing/invalid content";
  if (r.tags !== undefined && !isStringArray(r.tags)) return "add_node: tags must be an array of strings";
  if (!optional(r.strength, isUnit)) return `add_node: strength out of range (${String(r.strength)})`;
  if (!optional(r.importance, isUnit)) return `add_node: importance out of range (${String(r.importance)})`;
  if (!optional(r.confidence, isUnit)) return `add_node: confidence out of range (${String(r.confidence)})`;
  if (!optional(r.validFrom, isFiniteNumber) || !optional(r.validUntil, isFiniteNumber)) return "add_node: invalid validity window";
  return {
    op: "add_node",
    id: r.id.trim(),
    type: r.type,
    content: clampContent(r.content),
    tags: (r.tags as string[] | undefined) ?? [],
    ...(r.pinned === true ? { pinned: true } : {}),
    ...(isUnit(r.strength) ? { strength: r.strength } : {}),
    ...(isUnit(r.importance) ? { importance: r.importance } : {}),
    ...(isUnit(r.confidence) ? { confidence: r.confidence } : {}),
    ...(isFiniteNumber(r.validFrom) ? { validFrom: r.validFrom } : {}),
    ...(isFiniteNumber(r.validUntil) ? { validUntil: r.validUntil } : {}),
  };
}

function validateUpdateNode(r: Raw): MemoryOperation | string {
  if (!isNonEmptyString(r.id)) return "update_node: missing id";
  if (r.content !== undefined && r.content !== null && !isNonEmptyString(r.content)) return "update_node: invalid content";
  if (r.tags !== undefined && r.tags !== null && !isStringArray(r.tags)) return "update_node: tags must be an array of strings";
  if (!optional(r.importance, isUnit)) return `update_node: importance out of range (${String(r.importance)})`;
  return {
    op: "update_node",
    id: r.id.trim(),
    ...(isNonEmptyString(r.content) ? { content: clampContent(r.content) } : {}),
    ...(isStringArray(r.tags) ? { tags: r.tags } : {}),
    ...(typeof r.pinned === "boolean" ? { pinned: r.pinned } : {}),
    ...(isUnit(r.importance) ? { importance: r.importance } : {}),
  };
}

function validateEdgeEndpoints(r: Raw, name: string): string | null {
  if (!isNonEmptyString(r.from) || !isNonEmptyString(r.to)) return `${name}: missing from/to`;
  return null;
}

function validateAmountOp(r: Raw, name: "strengthen" | "weaken"): MemoryOperation | string {
  if (!isNonEmptyString(r.id)) return `${name}: missing id`;
  if (!isUnit(r.amount) || r.amount === 0) return `${name}: amount out of range (${String(r.amount)})`;
  return { op: name, id: r.id.trim(), amount: r.amount };
}

function validateMergeNodes(r: Raw): MemoryOperation | string {
  if (!isStringArray(r.ids) || r.ids.length < 2) return "merge_nodes: needs at least two ids";
  if (!isObject(r.into) || !isNonEmptyString(r.into.content)) return "merge_nodes: missing into.content";
  if (r.into.tags !== undefined && !isStringArray(r.into.tags)) return "merge_nodes: into.tags must be an array of strings";
  return {
    op: "merge_nodes",
    ids: r.ids.map(id => id.trim()),
    into: { content: clampContent(r.into.content), tags: (r.into.tags as string[] | undefined) ?? [] },
  };
}

function validateOne(raw: unknown): MemoryOperation | string {
  if (!isObject(raw)) return "operation is not an object";
  const r = raw;
  switch (r.op) {
    case "add_node": return validateAddNode(r);
    case "update_node": return validateUpdateNode(r);
    case "strengthen": return validateAmountOp(r, "strengthen");
    case "weaken": return validateAmountOp(r, "weaken");
    case "merge_nodes": return validateMergeNodes(r);
    case "remove_node":
      return isNonEmptyString(r.id) ? { op: "remove_node", id: r.id.trim() } : "remove_node: missing id";
    case "add_edge": {
      const bad = validateEdgeEndpoints(r, "add_edge");
      if (bad) return bad;
      if (!isEdgeType(r.type)) return `add_edge: unknown edge type "${String(r.type)}"`;
      if (!isUnit(r.weight)) return `add_edge: weight out of range (${String(r.weight)})`;
      return { op: "add_edge", from: (r.from as string).trim(), to: (r.to as string).trim(), type: r.type, weight: r.weight };
    }
    case "update_edge": {
      const bad = validateEdgeEndpoints(r, "update_edge");
      if (bad) return bad;
      if (!optional(r.weight, isUnit)) return `update_edge: weight out of range (${String(r.weight)})`;
      if (!optional(r.type, isEdgeType)) return `update_edge: unknown edge type "${String(r.type)}"`;
      return {
        op: "update_edge",
        from: (r.from as string).trim(),
        to: (r.to as string).trim(),
        ...(isUnit(r.weight) ? { weight: r.weight } : {}),
        ...(isEdgeType(r.type) ? { type: r.type } : {}),
      };
    }
    case "remove_edge": {
      const bad = validateEdgeEndpoints(r, "remove_edge");
      if (bad) return bad;
      if (!optional(r.type, isEdgeType)) return `remove_edge: unknown edge type "${String(r.type)}"`;
      return { op: "remove_edge", from: (r.from as string).trim(), to: (r.to as string).trim(), ...(isEdgeType(r.type) ? { type: r.type } : {}) };
    }
    case "reject_edge": {
      const bad = validateEdgeEndpoints(r, "reject_edge");
      if (bad) return bad;
      if (!optional(r.type, isEdgeType)) return `reject_edge: unknown edge type "${String(r.type)}"`;
      return {
        op: "reject_edge",
        from: (r.from as string).trim(),
        to: (r.to as string).trim(),
        reason: typeof r.reason === "string" ? r.reason : "",
        ...(isEdgeType(r.type) ? { type: r.type } : {}),
      };
    }
    default:
      return `unknown op "${String(r.op)}"`;
  }
}

/** Drop malformed operations, logging each reason. Never throws. */
export function validateOperations(ops: unknown): ValidationResult {
  if (!Array.isArray(ops)) {
    log("Operations payload is not an array — dropping all");
    return { valid: [], dropped: [{ op: ops, reason: "operations is not an array" }] };
  }
  const valid: MemoryOperation[] = [];
  const dropped: DroppedOperation[] = [];
  for (const raw of ops) {
    const result = validateOne(raw);
    if (typeof result === "string") {
      dropped.push({ op: raw, reason: result });
      log(`Dropped operation (${result}): ${JSON.stringify(raw).slice(0, 160)}`);
    } else {
      valid.push(result);
    }
  }
  return { valid, dropped };
}

// ── Application ──

export interface ApplyResult {
  applied: number;
  skipped: number;
  dropped: number;
}

interface BatchState {
  now: number;
  destructiveUsed: number;
  /** LLM-chosen ids that were re-minted because they collided with archived/ghost ids */
  remap: Map<string, string>;
}

const isDestructive = (op: MemoryOperation): boolean => op.op === "remove_node" || op.op === "merge_nodes";

/** Whether a pin request may be honoured: importance floor + global pin cap. */
function pinAllowed(graph: MemoryGraph, id: string, importance: number | undefined, alreadyPinned: boolean): boolean {
  if (alreadyPinned) return true;
  if ((importance ?? 0) < MIN_PIN_IMPORTANCE) {
    log(`Ignoring pin on ${id}: importance ${importance ?? "unset"} < ${MIN_PIN_IMPORTANCE}`);
    return false;
  }
  if (graph.pinnedCount >= MAX_PINNED_NODES) {
    log(`Ignoring pin on ${id}: pinned cap ${MAX_PINNED_NODES} reached`);
    return false;
  }
  return true;
}

/** Resolve an id through this batch's re-mint map. */
const resolveId = (state: BatchState, id: string): string => state.remap.get(id) ?? id;

function chainTemporalEvent(graph: MemoryGraph, node: MemoryNode, now: number): void {
  const DAY_MS = 24 * 3600000;
  const tagsLower = new Set(node.tags.map(t => t.toLowerCase()));
  const recent = graph.findByType("event")
    .filter(e => e.id !== node.id && now - e.createdAt < DAY_MS)
    .filter(e => e.tags.filter(t => tagsLower.has(t.toLowerCase())).length >= 2)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!recent) return;
  graph.addEdge({ from: recent.id, to: node.id, type: "temporal", weight: 0.6, createdAt: now, lastReinforcedAt: now });
  log(`Temporal chain: linked ${node.id} → ${recent.id}`);
}

function applyAddNode(graph: MemoryGraph, op: Extract<MemoryOperation, { op: "add_node" }>, state: BatchState): boolean {
  if (graph.getNode(op.id)) return false;
  let id = op.id;
  if (graph.hasTopology(id)) {
    id = graph.mintId();
    state.remap.set(op.id, id);
    log(`Re-minted id ${op.id} → ${id} (collides with archived/ghost node)`);
  }
  const pinned = op.pinned === true && pinAllowed(graph, id, op.importance, false);
  const now = state.now;
  const node: MemoryNode = {
    id,
    type: op.type,
    content: op.content,
    tags: op.tags,
    strength: op.strength ?? 0.8,
    pinned,
    createdAt: now,
    lastAccessedAt: now,
    accessCount: 1,
    ingestedAt: now,
    ...(op.importance !== undefined ? { importance: op.importance } : {}),
    ...(op.confidence !== undefined ? { confidence: op.confidence } : {}),
    ...(op.validFrom !== undefined ? { validFrom: op.validFrom } : {}),
    ...(op.validUntil !== undefined ? { validUntil: op.validUntil } : {}),
  };
  graph.addNode(node); // addNode schedules the embedding — no second embedNode call here
  graph.correlateNode(node);
  if (node.type === "event") chainTemporalEvent(graph, node, now);
  return true;
}

function applyUpdateNode(graph: MemoryGraph, op: Extract<MemoryOperation, { op: "update_node" }>, state: BatchState): boolean {
  const id = resolveId(state, op.id);
  const node = graph.getNode(id);
  if (!node) return false;
  const importance = op.importance ?? node.importance;
  const pinned = op.pinned === undefined
    ? undefined
    : op.pinned && !pinAllowed(graph, id, importance, node.pinned) ? undefined : op.pinned;
  graph.updateNode(id, { content: op.content, tags: op.tags, pinned, importance: op.importance });
  return true;
}

function applyOne(graph: MemoryGraph, op: MemoryOperation, state: BatchState): boolean {
  switch (op.op) {
    case "add_node":
      return applyAddNode(graph, op, state);
    case "update_node":
      return applyUpdateNode(graph, op, state);
    case "add_edge": {
      const from = resolveId(state, op.from);
      const to = resolveId(state, op.to);
      if (from === to || !graph.getNode(from) || !graph.getNode(to)) return false;
      graph.addEdge({ from, to, type: op.type, weight: op.weight, createdAt: state.now, lastReinforcedAt: state.now });
      return true;
    }
    case "strengthen":
      return graph.reinforceNode(resolveId(state, op.id), op.amount);
    case "weaken":
      return graph.reinforceNode(resolveId(state, op.id), -op.amount);
    case "update_edge": {
      const from = resolveId(state, op.from);
      const to = resolveId(state, op.to);
      if (!graph.hasEdge(from, to, op.type)) return false;
      graph.updateEdge(from, to, { weight: op.weight, type: op.type }, op.type);
      return true;
    }
    case "merge_nodes": {
      const ids = op.ids.map(id => resolveId(state, id));
      if (ids.some(id => graph.getNode(id)?.pinned)) {
        log(`Refusing merge_nodes: pinned node in ${ids.join(", ")}`);
        return false;
      }
      return graph.mergeNodes(ids, op.into) !== null;
    }
    case "remove_node": {
      const id = resolveId(state, op.id);
      const node = graph.getNode(id);
      if (!node) return false;
      if (node.pinned) {
        log(`Refusing remove_node on pinned node ${id}`);
        return false;
      }
      return graph.archiveNode(id, "manual");
    }
    case "remove_edge":
      return graph.removeEdge(resolveId(state, op.from), resolveId(state, op.to), op.type);
    case "reject_edge": {
      const from = resolveId(state, op.from);
      const to = resolveId(state, op.to);
      if (from === to || !graph.hasTopology(from) || !graph.hasTopology(to)) return false;
      graph.addRejectedEdge(from, to, op.reason ?? "", op.type);
      return true;
    }
  }
}

/** Validate then apply a batch of LLM operations against the graph. */
export function applyGraphOperations(graph: MemoryGraph, rawOps: unknown): ApplyResult {
  const { valid, dropped } = validateOperations(rawOps);
  const state: BatchState = { now: Date.now(), destructiveUsed: 0, remap: new Map() };
  let applied = 0;
  let skipped = 0;

  for (const op of valid) {
    if (isDestructive(op)) {
      if (state.destructiveUsed >= MAX_DESTRUCTIVE_OPS_PER_BATCH) {
        log(`Skipping ${op.op}: destructive cap ${MAX_DESTRUCTIVE_OPS_PER_BATCH} reached for this batch`);
        skipped++;
        continue;
      }
      state.destructiveUsed++;
    }
    try {
      if (applyOne(graph, op, state)) applied++;
      else skipped++;
    } catch (err) {
      log(`Operation failed: ${JSON.stringify(op).slice(0, 100)} — ${err}`);
      skipped++;
    }
  }

  return { applied, skipped, dropped: dropped.length };
}
