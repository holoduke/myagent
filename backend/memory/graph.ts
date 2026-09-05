import { randomBytes } from "crypto";
import type { MemoryNode, MemoryEdge, MemoryOperation, NodeType, ArchivedNode, ArchivedEdge, GhostNode, RejectedEdge, EdgeType } from "./types.js";
import {
  MAX_GHOST_NODES,
  MAX_REJECTED_EDGES,
  REJECTED_EDGE_TTL_MS,
  MAX_ARCHIVE_NODES,
  RESTORE_STRENGTH_FLOOR,
  RESTORE_STRENGTH_CEILING,
} from "./types.js";
import { createLogger } from "../logger.js";
import type { Observation } from "../observer.js";
import { embedNode, removeEmbedding } from "./embeddings.js";
import { loadGraphFiles, saveGraphFiles } from "./graph-persistence.js";
import type { GraphFiles } from "./graph-persistence.js";
import { validateLoadedGraph } from "./graph-validation.js";
import { applyGraphOperations } from "./graph-operations.js";
import type { ApplyResult } from "./graph-operations.js";
import { correlateNode as correlate } from "./graph-correlate.js";
import type { CorrelationResult } from "./graph-correlate.js";

const log = createLogger("graph");

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

export class MemoryGraph {
  private nodes = new Map<string, MemoryNode>();
  private edges: MemoryEdge[] = [];

  // Indexes
  private byType = new Map<NodeType, Set<string>>();
  private byTag = new Map<string, Set<string>>();
  private edgesFromIdx = new Map<string, MemoryEdge[]>();
  private edgesToIdx = new Map<string, MemoryEdge[]>();

  // Long-term archive (cold storage — searchable but not active)
  private archive = new Map<string, ArchivedNode>();

  // Ghost graph — topology-only remnants of fully evicted nodes
  private ghosts = new Map<string, GhostNode>();

  // Rejected edges — proposed-but-refused candidate associations (no embedding/content)
  // Key: `${from}|${to}|${type ?? "*"}` for fast lookup.
  private rejectedEdges = new Map<string, RejectedEdge>();

  // In-memory mirror of the pending think queue. The durable queue is
  // observations.jsonl past state.lastObservationTime; brain.ts re-syncs this
  // mirror from the file every tick, so adds must be idempotent.
  private pending: Observation[] = [];
  private pendingKeys = new Set<string>();

  // Persistence bookkeeping
  private loadedGeneration = 0;
  private archiveLoadFailed = false;
  private ghostLoadFailed = false;
  private dirty = false;

  // ── Persistence ──

  /**
   * Load the graph from disk, replacing any in-memory state (so it doubles as
   * reload). Never writes: load-time repairs stay in memory and set `dirty`
   * until an explicit save(). Corrupted nodes/edges files throw — an empty
   * memory is an alarming, easy-to-miss outcome, so we refuse to boot instead.
   */
  load(): void {
    const files = loadGraphFiles();
    const validated = validateLoadedGraph(files.nodes, files.edges);

    this.nodes = validated.nodes;
    this.edges = validated.edges;
    this.archive = files.archive;
    this.ghosts = files.ghosts;
    this.rejectedEdges = files.rejectedEdges;
    this.pending = [];
    this.loadedGeneration = files.generation;
    this.archiveLoadFailed = files.archiveLoadFailed;
    this.ghostLoadFailed = files.ghostLoadFailed;
    this.dirty = validated.repaired;

    this.rebuildIndexes();
    log(`Loaded graph (gen ${files.generation}): ${this.nodes.size} nodes, ${this.edges.length} edges, ${this.archive.size} archived, ${this.ghosts.size} ghosts, ${this.rejectedEdges.size} rejected edges`);
  }

  /**
   * Persist to disk. Refused (returns false, state kept in memory) when another
   * writer has saved a newer generation since this graph was loaded.
   */
  save(): boolean {
    const files: GraphFiles = {
      nodes: this.nodes,
      edges: this.edges,
      archive: this.archive,
      ghosts: this.ghosts,
      rejectedEdges: this.rejectedEdges,
      generation: this.loadedGeneration,
      archiveLoadFailed: this.archiveLoadFailed,
      ghostLoadFailed: this.ghostLoadFailed,
    };
    const next = saveGraphFiles(files, this.loadedGeneration);
    if (next === null) return false;
    this.loadedGeneration = next;
    this.dirty = false;
    return true;
  }

  /** True when in-memory state differs from what was last loaded/saved (load-time repairs included). */
  get isDirty(): boolean {
    return this.dirty;
  }

  get generation(): number {
    return this.loadedGeneration;
  }

  /** Mint a node id that is free everywhere (active, archive, ghosts). */
  mintId(): string {
    let id = "n_" + randomBytes(4).toString("hex");
    while (this.hasTopology(id)) id = "n_" + randomBytes(4).toString("hex");
    return id;
  }

  private rebuildIndexes(): void {
    this.byType.clear();
    this.byTag.clear();
    this.edgesFromIdx.clear();
    this.edgesToIdx.clear();

    for (const [id, node] of this.nodes) {
      this.indexNode(id, node);
    }
    for (const edge of this.edges) {
      this.indexEdge(edge);
    }
  }

  private indexNode(id: string, node: MemoryNode): void {
    if (!this.byType.has(node.type)) this.byType.set(node.type, new Set());
    this.byType.get(node.type)!.add(id);
    for (const tag of node.tags) this.indexTag(id, tag);
  }

  private indexTag(id: string, tag: string): void {
    const key = tag.toLowerCase();
    if (!this.byTag.has(key)) this.byTag.set(key, new Set());
    this.byTag.get(key)!.add(id);
  }

  private indexEdge(edge: MemoryEdge): void {
    if (!this.edgesFromIdx.has(edge.from)) this.edgesFromIdx.set(edge.from, []);
    this.edgesFromIdx.get(edge.from)!.push(edge);
    if (!this.edgesToIdx.has(edge.to)) this.edgesToIdx.set(edge.to, []);
    this.edgesToIdx.get(edge.to)!.push(edge);
  }

  // ── Node Operations ──

  addNode(node: MemoryNode): void {
    this.nodes.set(node.id, node);
    this.indexNode(node.id, node);
    this.dirty = true;
    // Trigger async embedding (the only place this happens for new nodes)
    embedNode(node.id, node.content).catch(() => { /* non-critical */ });
  }

  getNode(id: string): MemoryNode | undefined {
    return this.nodes.get(id);
  }

  /**
   * Hard-delete a node and its edges. Internal building block — LLM
   * operations go through archiveNode() so content is never lost outright.
   */
  removeNode(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;

    this.nodes.delete(id);
    this.dirty = true;
    removeEmbedding(id);
    this.byType.get(node.type)?.delete(id);
    for (const tag of node.tags) {
      this.byTag.get(tag.toLowerCase())?.delete(id);
    }

    this.edges = this.edges.filter(e => e.from !== id && e.to !== id);
    this.edgesFromIdx.delete(id);
    this.edgesToIdx.delete(id);
    for (const [key, arr] of this.edgesFromIdx) {
      const filtered = arr.filter(e => e.to !== id);
      if (filtered.length === 0) this.edgesFromIdx.delete(key);
      else this.edgesFromIdx.set(key, filtered);
    }
    for (const [key, arr] of this.edgesToIdx) {
      const filtered = arr.filter(e => e.from !== id);
      if (filtered.length === 0) this.edgesToIdx.delete(key);
      else this.edgesToIdx.set(key, filtered);
    }
  }

  updateNode(id: string, updates: { content?: string; tags?: string[]; pinned?: boolean; importance?: number; confidence?: number; emotionalValence?: number; strength?: number }): void {
    const node = this.nodes.get(id);
    if (!node) return;
    this.dirty = true;

    if (updates.content !== undefined) node.content = updates.content;
    if (updates.pinned !== undefined) node.pinned = updates.pinned;
    if (updates.importance !== undefined) node.importance = clamp(updates.importance, 0, 1);
    if (updates.confidence !== undefined) node.confidence = clamp(updates.confidence, 0, 1);
    if (updates.emotionalValence !== undefined) node.emotionalValence = clamp(updates.emotionalValence, -1, 1);
    if (updates.strength !== undefined) node.strength = clamp(updates.strength, 0, 1);
    if (updates.tags !== undefined) {
      for (const tag of node.tags) {
        this.byTag.get(tag.toLowerCase())?.delete(id);
      }
      node.tags = updates.tags;
      for (const tag of node.tags) this.indexTag(id, tag);
    }
  }

  accessNode(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.lastAccessedAt = Date.now();
    node.accessCount++;
    node.strength = Math.min(1, node.strength + 0.05);
    this.dirty = true;
  }

  /**
   * Shift a node's strength by `amount` (negative to weaken). Positive
   * reinforcement also counts as an access. Returns false for unknown ids.
   */
  reinforceNode(id: string, amount: number): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;
    node.strength = clamp(node.strength + amount, 0, 1);
    if (amount > 0) {
      node.lastAccessedAt = Date.now();
      node.accessCount++;
    }
    this.dirty = true;
    return true;
  }

  get pinnedCount(): number {
    let n = 0;
    for (const node of this.nodes.values()) if (node.pinned) n++;
    return n;
  }

  // ── Edge Operations ──

  addEdge(edge: MemoryEdge): void {
    if (edge.from === edge.to) return;
    if (this.hasEdge(edge.from, edge.to, edge.type)) return;

    const clamped: MemoryEdge = { ...edge, weight: clamp(edge.weight, 0, 1) };
    this.edges.push(clamped);
    this.indexEdge(clamped);
    this.dirty = true;
    // If this edge had previously been rejected, clear the rejection — the
    // brain has changed its mind, so we don't want stale "no" entries.
    this.clearRejectedEdge(edge.from, edge.to, edge.type);
    this.clearRejectedEdge(edge.from, edge.to);
  }

  /** O(1)-ish existence check via the from-index (any type when `type` is omitted). */
  hasEdge(from: string, to: string, type?: string): boolean {
    const fromEdges = this.edgesFromIdx.get(from);
    if (!fromEdges) return false;
    return fromEdges.some(e => e.to === to && (!type || e.type === type));
  }

  /** Remove edge(s) between two nodes; without `type`, all types. Returns whether anything was removed. */
  removeEdge(from: string, to: string, type?: string): boolean {
    const match = (e: MemoryEdge) => e.from === from && e.to === to && (!type || e.type === type);
    const before = this.edges.length;
    this.edges = this.edges.filter(e => !match(e));
    if (this.edges.length === before) return false;
    this.dirty = true;

    const fromArr = this.edgesFromIdx.get(from);
    if (fromArr) {
      const filtered = fromArr.filter(e => !match(e));
      if (filtered.length === 0) this.edgesFromIdx.delete(from);
      else this.edgesFromIdx.set(from, filtered);
    }
    const toArr = this.edgesToIdx.get(to);
    if (toArr) {
      const filtered = toArr.filter(e => !match(e));
      if (filtered.length === 0) this.edgesToIdx.delete(to);
      else this.edgesToIdx.set(to, filtered);
    }
    return true;
  }

  updateEdge(from: string, to: string, updates: { weight?: number; type?: string }, filterType?: string): void {
    const fromEdges = this.edgesFromIdx.get(from);
    if (!fromEdges) return;
    const edge = fromEdges.find(e => e.to === to && (!filterType || e.type === filterType));
    if (!edge) return;
    if (updates.weight !== undefined) edge.weight = clamp(updates.weight, 0, 1);
    if (updates.type !== undefined) edge.type = updates.type as MemoryEdge["type"];
    edge.lastReinforcedAt = Date.now();
    this.dirty = true;
  }

  edgesFrom(id: string): MemoryEdge[] {
    return this.edgesFromIdx.get(id) || [];
  }

  edgesTo(id: string): MemoryEdge[] {
    return this.edgesToIdx.get(id) || [];
  }

  edgesFor(id: string): MemoryEdge[] {
    return [...this.edgesFrom(id), ...this.edgesTo(id)];
  }

  // ── Rejected Edges ──

  private rejectedKey(from: string, to: string, type?: EdgeType): string {
    return `${from}|${to}|${type ?? "*"}`;
  }

  /**
   * Record a rejected candidate edge. If the same candidate already exists,
   * its lastSeenAt and seenCount are bumped (cheap reinforcement) and the
   * reason is updated to the latest justification.
   */
  addRejectedEdge(from: string, to: string, reason: string, type?: EdgeType): void {
    if (from === to) return;
    const key = this.rejectedKey(from, to, type);
    const now = Date.now();
    const existing = this.rejectedEdges.get(key);
    const trimmedReason = reason.slice(0, 200);
    this.dirty = true;
    if (existing) {
      existing.lastSeenAt = now;
      existing.seenCount++;
      existing.reason = trimmedReason || existing.reason;
      return;
    }
    this.rejectedEdges.set(key, { from, to, type, reason: trimmedReason, rejectedAt: now, lastSeenAt: now, seenCount: 1 });
    // LRU cap: when over limit, evict oldest by lastSeenAt
    if (this.rejectedEdges.size > MAX_REJECTED_EDGES) {
      const sorted = Array.from(this.rejectedEdges.entries()).sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
      const overflow = this.rejectedEdges.size - MAX_REJECTED_EDGES;
      for (let i = 0; i < overflow; i++) this.rejectedEdges.delete(sorted[i][0]);
    }
  }

  /** Check whether a candidate edge has been rejected (any type matches when type is null/undefined). */
  hasRejectedEdge(from: string, to: string, type?: EdgeType): boolean {
    if (this.rejectedEdges.has(this.rejectedKey(from, to, type))) return true;
    return type !== undefined && this.rejectedEdges.has(this.rejectedKey(from, to));
  }

  /** Return all rejected edges that touch a given node id (either endpoint). */
  getRejectedEdgesFor(id: string): RejectedEdge[] {
    return Array.from(this.rejectedEdges.values()).filter(e => e.from === id || e.to === id);
  }

  /** All rejected edges, freshest first. */
  allRejectedEdges(): RejectedEdge[] {
    return Array.from(this.rejectedEdges.values()).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  /** Drop a rejected entry — e.g. when the brain has changed its mind and re-added the edge. */
  clearRejectedEdge(from: string, to: string, type?: EdgeType): boolean {
    return this.rejectedEdges.delete(this.rejectedKey(from, to, type));
  }

  /**
   * Prune rejected-edge entries that are stale (older than ttlMs since last seen)
   * or whose endpoints no longer exist anywhere in the graph (active or archived).
   */
  pruneRejectedEdges(ttlMs = REJECTED_EDGE_TTL_MS): number {
    const now = Date.now();
    let pruned = 0;
    for (const [key, entry] of this.rejectedEdges) {
      const stale = now - entry.lastSeenAt > ttlMs;
      if (stale || !this.hasTopology(entry.from) || !this.hasTopology(entry.to)) {
        this.rejectedEdges.delete(key);
        pruned++;
      }
    }
    if (pruned > 0) {
      this.dirty = true;
      log(`Rejected-edge pruning: removed ${pruned} stale or dangling entries`);
    }
    return pruned;
  }

  get rejectedEdgeCount(): number {
    return this.rejectedEdges.size;
  }

  // ── Hierarchical Traversal ──

  /** Get direct children of a node (via hierarchical edges where this node is parent) */
  getChildren(id: string): MemoryNode[] {
    return this.edgesFrom(id)
      .filter(e => e.type === "hierarchical")
      .map(e => this.nodes.get(e.to))
      .filter((n): n is MemoryNode => n !== undefined);
  }

  /** Get direct parents of a node (via hierarchical edges where this node is child) */
  getParents(id: string): MemoryNode[] {
    return this.edgesTo(id)
      .filter(e => e.type === "hierarchical")
      .map(e => this.nodes.get(e.from))
      .filter((n): n is MemoryNode => n !== undefined);
  }

  private walkHierarchy(id: string, maxDepth: number, step: (id: string) => MemoryNode[]): MemoryNode[] {
    const visited = new Set<string>([id]);
    const result: MemoryNode[] = [];
    let frontier = [id];
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const nodeId of frontier) {
        for (const neighbor of step(nodeId)) {
          if (visited.has(neighbor.id)) continue;
          visited.add(neighbor.id);
          result.push(neighbor);
          next.push(neighbor.id);
        }
      }
      frontier = next;
    }
    return result;
  }

  /** Get all ancestors up to maxDepth (BFS up through parents) */
  getAncestors(id: string, maxDepth = 5): MemoryNode[] {
    return this.walkHierarchy(id, maxDepth, nodeId => this.getParents(nodeId));
  }

  /** Get all descendants down to maxDepth (BFS down through children) */
  getDescendants(id: string, maxDepth = 3): MemoryNode[] {
    return this.walkHierarchy(id, maxDepth, nodeId => this.getChildren(nodeId));
  }

  // ── Merge ──

  /**
   * Merge several nodes into one new node. Salience metadata is carried over
   * from the survivor with the highest importance; edges are rewired; the
   * originals are archived (reason "consolidation"), never hard-deleted.
   */
  mergeNodes(ids: string[], into: { content: string; tags: string[] }): string | null {
    const survivors = [...new Set(ids)].filter(id => this.nodes.has(id));
    if (survivors.length < 2) return null;
    const sources = survivors.map(id => this.nodes.get(id)!);
    if (sources.some(n => n.pinned)) return null;

    const primary = [...sources].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))[0];
    const now = Date.now();
    const mergedId = this.mintId();
    const merged: MemoryNode = {
      id: mergedId,
      type: primary.type,
      content: into.content,
      tags: into.tags,
      strength: Math.min(1, Math.max(...sources.map(n => n.strength)) + 0.1),
      pinned: false,
      createdAt: Math.min(...sources.map(n => n.createdAt)),
      lastAccessedAt: now,
      accessCount: sources.reduce((sum, n) => sum + n.accessCount, 0),
      ...(primary.importance !== undefined ? { importance: primary.importance } : {}),
      ...(primary.confidence !== undefined ? { confidence: primary.confidence } : {}),
      ...(primary.emotionalValence !== undefined ? { emotionalValence: primary.emotionalValence } : {}),
      ...(primary.validFrom !== undefined ? { validFrom: primary.validFrom } : {}),
      ...(primary.validUntil !== undefined ? { validUntil: primary.validUntil } : {}),
      ingestedAt: primary.ingestedAt ?? now,
    };

    const survivorSet = new Set(survivors);
    const seen = new Set<string>();
    const rewired: MemoryEdge[] = [];
    for (const id of survivors) {
      for (const edge of this.edgesFor(id)) {
        const from = survivorSet.has(edge.from) ? mergedId : edge.from;
        const to = survivorSet.has(edge.to) ? mergedId : edge.to;
        if (from === to) continue;
        const key = `${from}|${to}|${edge.type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rewired.push({ ...edge, from, to });
      }
    }

    for (const id of survivors) this.archiveNode(id, "consolidation");
    this.addNode(merged);
    for (const edge of rewired) this.addEdge(edge);
    return mergedId;
  }

  // ── Archive (Long-term Cold Storage) ──

  /**
   * Move a node from active graph to archive (cold storage). Edge topology is
   * preserved as a tombstone so restoreNode() can re-link it later.
   */
  archiveNode(id: string, reason: ArchivedNode["archiveReason"] = "decay"): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;
    if (node.pinned) return false; // never archive pinned nodes

    const tombstoneEdges: ArchivedEdge[] = this.edgesFor(id).map(e => ({ from: e.from, to: e.to, type: e.type, weight: e.weight }));
    this.archive.set(id, {
      ...node,
      archivedAt: Date.now(),
      archiveReason: reason,
      archivedEdges: tombstoneEdges.length > 0 ? tombstoneEdges : undefined,
    });
    this.removeNode(id);
    this.evictArchiveOverflow();
    return true;
  }

  /** Evict the least valuable archived nodes (lowest importance, then strength) to the ghost graph. */
  private evictArchiveOverflow(): void {
    if (this.archive.size <= MAX_ARCHIVE_NODES) return;
    const byValue = (a: ArchivedNode, b: ArchivedNode) =>
      ((a.importance ?? 0) - (b.importance ?? 0)) || (a.strength - b.strength) || (a.archivedAt - b.archivedAt);
    const toEvict = Array.from(this.archive.values()).sort(byValue).slice(0, this.archive.size - MAX_ARCHIVE_NODES);
    const now = Date.now();
    for (const evicted of toEvict) {
      this.ghosts.set(evicted.id, {
        id: evicted.id,
        type: evicted.type,
        tagFingerprint: evicted.tags,
        edges: evicted.archivedEdges ?? [],
        archivedAt: evicted.archivedAt,
        evictedAt: now,
        archiveReason: evicted.archiveReason,
      });
      this.archive.delete(evicted.id);
    }
    if (this.ghosts.size > MAX_GHOST_NODES) {
      const oldest = Array.from(this.ghosts.values()).sort((a, b) => a.evictedAt - b.evictedAt);
      for (const g of oldest.slice(0, this.ghosts.size - MAX_GHOST_NODES)) this.ghosts.delete(g.id);
      log(`Ghost graph eviction: trimmed to ${MAX_GHOST_NODES} ghosts`);
    }
    log(`Archive eviction: moved ${toEvict.length} lowest-value nodes to ghost graph (${this.ghosts.size} total ghosts)`);
  }

  /**
   * Search the archive by keyword (matches content and tags).
   * Returns matching archived nodes sorted by relevance (strength * recency).
   */
  searchArchive(query: string, limit = 20): ArchivedNode[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const now = Date.now();
    const scored: { node: ArchivedNode; score: number }[] = [];
    for (const node of this.archive.values()) {
      const contentLower = node.content.toLowerCase();
      const tagsLower = node.tags.map(t => t.toLowerCase());
      const hits = terms.filter(term => contentLower.includes(term) || tagsLower.some(t => t.includes(term))).length;
      if (hits === 0) continue;
      const recencyBonus = 1 / (1 + (now - node.archivedAt) / 86400000 / 30); // half-weight after 30 days
      scored.push({ node, score: (hits / terms.length) * node.strength * (1 + recencyBonus) });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(m => m.node);
  }

  /**
   * Restore a node from archive back to active graph with strength in
   * [RESTORE_STRENGTH_FLOOR, RESTORE_STRENGTH_CEILING] — recallable, but in
   * need of reinforcement.
   */
  restoreNode(id: string): boolean {
    const archived = this.archive.get(id);
    if (!archived) return false;

    const { archivedAt: _, archiveReason: __, archivedEdges, ...nodeData } = archived;
    const now = Date.now();
    this.addNode({
      ...nodeData,
      strength: clamp(archived.strength, RESTORE_STRENGTH_FLOOR, RESTORE_STRENGTH_CEILING),
      lastAccessedAt: now,
      accessCount: archived.accessCount + 1,
      reconstructedAt: now,
      reconstructedFrom: "archive",
      reconstructionOriginal: {
        content: archived.content,
        tags: [...archived.tags],
        edgeCount: archivedEdges?.length ?? 0,
        strength: archived.strength,
      },
    });

    let edgesRestored = 0;
    for (const te of archivedEdges ?? []) {
      const otherId = te.from === id ? te.to : te.from;
      if (!this.nodes.has(otherId)) continue; // other endpoint gone
      this.addEdge({ from: te.from, to: te.to, type: te.type, weight: Math.min(0.5, te.weight), createdAt: now, lastReinforcedAt: now });
      edgesRestored++;
    }
    if (edgesRestored > 0) {
      log(`Restored ${edgesRestored}/${archivedEdges?.length ?? 0} tombstone edges for node ${id}`);
    }

    this.archive.delete(id);
    log(`Restored node ${id} from archive (was archived for "${archived.archiveReason}", marked as reconstructed)`);
    return true;
  }

  get archiveSize(): number {
    return this.archive.size;
  }

  allArchivedNodes(): ArchivedNode[] {
    return Array.from(this.archive.values());
  }

  getArchived(id: string): ArchivedNode | undefined {
    return this.archive.get(id);
  }

  // ── Ghost Graph ──

  get ghostCount(): number {
    return this.ghosts.size;
  }

  allGhostNodes(): GhostNode[] {
    return Array.from(this.ghosts.values());
  }

  getGhost(id: string): GhostNode | undefined {
    return this.ghosts.get(id);
  }

  /** Check if a node exists anywhere: active, archived, or ghost */
  hasTopology(id: string): boolean {
    return this.nodes.has(id) || this.archive.has(id) || this.ghosts.has(id);
  }

  // ── Auto-Correlation ──

  correlateNode(newNode: MemoryNode, maxEdges = 5): CorrelationResult {
    return correlate(this, newNode, maxEdges);
  }

  // ── Queries ──

  findByType(type: NodeType): MemoryNode[] {
    const ids = this.byType.get(type);
    if (!ids) return [];
    return Array.from(ids).map(id => this.nodes.get(id)!).filter(Boolean);
  }

  findByTag(tag: string): MemoryNode[] {
    const ids = this.byTag.get(tag.toLowerCase());
    if (!ids) return [];
    return Array.from(ids).map(id => this.nodes.get(id)!).filter(Boolean);
  }

  allNodes(): MemoryNode[] {
    return Array.from(this.nodes.values());
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  get edgeCount(): number {
    return this.edges.length;
  }

  allEdges(): MemoryEdge[] {
    return this.edges;
  }

  // ── Pending Observations ──

  /** Idempotent: re-adding an observation already in the mirror is a no-op. */
  addPendingObservation(obs: Observation): void {
    const key = `${obs.timestamp}|${obs.senderJid}|${obs.text.slice(0, 120)}`;
    if (this.pendingKeys.has(key)) return;
    this.pendingKeys.add(key);
    this.pending = [...this.pending, obs];
  }

  /** Snapshot copy — callers cannot mutate the mirror through it. */
  getPendingObservations(): Observation[] {
    return [...this.pending];
  }

  clearPendingObservations(): void {
    this.pending = [];
    this.pendingKeys = new Set();
  }

  // ── Batch Apply Operations from Claude ──

  /** Validate and apply a batch of memory operations (see graph-operations.ts). */
  applyOperations(ops: MemoryOperation[] | unknown[]): ApplyResult {
    return applyGraphOperations(this, ops);
  }

  // ── Stats ──

  getStats(): { nodeCount: number; edgeCount: number; archivedCount: number; ghostCount: number; rejectedEdgeCount: number; byType: Record<string, number>; avgStrength: number } {
    const byType: Record<string, number> = {};
    let totalStrength = 0;
    for (const node of this.nodes.values()) {
      byType[node.type] = (byType[node.type] || 0) + 1;
      totalStrength += node.strength;
    }
    return {
      nodeCount: this.nodes.size,
      edgeCount: this.edges.length,
      archivedCount: this.archive.size,
      ghostCount: this.ghosts.size,
      rejectedEdgeCount: this.rejectedEdges.size,
      byType,
      avgStrength: this.nodes.size > 0 ? totalStrength / this.nodes.size : 0,
    };
  }
}
