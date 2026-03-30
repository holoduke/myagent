import { appendFileSync, statSync, renameSync } from "fs";
import { safeReadJSON, atomicWriteJSON, ensureDir } from "../utils/file-store.js";
import { randomBytes } from "crypto";
import type { MemoryNode, MemoryEdge, MemoryOperation, NodeType, ArchivedNode, ArchivedEdge, GhostNode, WALEntry, WALOperationType } from "./types.js";
import { MAX_GHOST_NODES, WAL_MAX_BYTES } from "./types.js";
import { createLogger } from "../logger.js";

const log = createLogger("graph");


const GRAPH_DIR = `${BRAIN_DIR}/graph`;
const NODES_FILE = `${GRAPH_DIR}/nodes.json`;
const EDGES_FILE = `${GRAPH_DIR}/edges.json`;
const ARCHIVE_FILE = `${GRAPH_DIR}/archive.json`;
const GHOST_FILE = `${GRAPH_DIR}/ghost-graph.json`;
const WAL_FILE = `${GRAPH_DIR}/wal.jsonl`;

const MAX_ARCHIVE_NODES = 2000;



function genId(): string {
  return "n_" + randomBytes(4).toString("hex");
}

import type { Observation } from "../observer.js";
import { BRAIN_DIR } from "../config.js";

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

  // Pending observations buffer (for observe ticks)
  private pending: Observation[] = [];

  // ── Persistence ──

  load(): void {
    ensureDir(GRAPH_DIR);

    const nodesRaw = safeReadJSON<Record<string, MemoryNode>>(NODES_FILE, {});
    for (const [id, node] of Object.entries(nodesRaw)) {
      this.nodes.set(id, node);
    }

    this.edges = safeReadJSON<MemoryEdge[]>(EDGES_FILE, []);

    const archiveRaw = safeReadJSON<Record<string, ArchivedNode>>(ARCHIVE_FILE, {});
    for (const [id, node] of Object.entries(archiveRaw)) {
      this.archive.set(id, node);
    }

    const ghostRaw = safeReadJSON<Record<string, GhostNode>>(GHOST_FILE, {});
    for (const [id, node] of Object.entries(ghostRaw)) {
      this.ghosts.set(id, node);
    }

    this.rebuildIndexes();
    this.validateGraph();
    log(`Loaded graph: ${this.nodes.size} nodes, ${this.edges.length} edges, ${this.archive.size} archived, ${this.ghosts.size} ghosts`);
  }

  save(): void {
    ensureDir(GRAPH_DIR);

    try {
      const nodesObj: Record<string, MemoryNode> = {};
      for (const [id, node] of this.nodes) {
        nodesObj[id] = node;
      }
      atomicWriteJSON(NODES_FILE, nodesObj, 0);
    } catch (err) {
      log(`Failed to save nodes — aborting remaining saves: ${err}`);
      throw err;
    }

    try {
      atomicWriteJSON(EDGES_FILE, this.edges, 0);
    } catch (err) {
      log(`Failed to save edges — aborting remaining saves: ${err}`);
      throw err;
    }

    try {
      // Save archive
      const archiveObj: Record<string, ArchivedNode> = {};
      for (const [id, node] of this.archive) {
        archiveObj[id] = node;
      }
      atomicWriteJSON(ARCHIVE_FILE, archiveObj, 0);
    } catch (err) {
      log(`Failed to save archive — aborting remaining saves: ${err}`);
      throw err;
    }

    try {
      // Save ghost graph
      const ghostObj: Record<string, GhostNode> = {};
      for (const [id, node] of this.ghosts) {
        ghostObj[id] = node;
      }
      atomicWriteJSON(GHOST_FILE, ghostObj, 0);
    } catch (err) {
      log(`Failed to save ghost graph: ${err}`);
      throw err;
    }
  }

  // ── Write-Ahead Log ──

  /** Append a mutation entry to the WAL file */
  private walAppend(entry: WALEntry): void {
    try {
      ensureDir(GRAPH_DIR);
      const line = JSON.stringify(entry) + "\n";
      appendFileSync(WAL_FILE, line, "utf-8");

      // Roll if over size limit
      try {
        const stat = statSync(WAL_FILE);
        if (stat.size > WAL_MAX_BYTES) {
          const rolled = `${WAL_FILE}.${Date.now()}.old`;
          renameSync(WAL_FILE, rolled);
          log(`WAL rolled: ${WAL_FILE} → ${rolled} (${stat.size} bytes)`);
        }
      } catch {
        // stat/rename failure is non-critical
      }
    } catch (err) {
      log(`WAL append failed: ${err}`);
    }
  }

  /** Convenience: build and append a WAL entry */
  private walLog(op: WALOperationType, fields: Omit<WALEntry, "ts" | "op"> = {}): void {
    this.walAppend({ ts: Date.now(), op, ...fields });
  }

  private rebuildIndexes(): void {
    this.byType.clear();
    this.byTag.clear();
    this.edgesFromIdx.clear();
    this.edgesToIdx.clear();

    for (const [id, node] of this.nodes) {
      // byType
      if (!this.byType.has(node.type)) this.byType.set(node.type, new Set());
      this.byType.get(node.type)!.add(id);

      // byTag
      for (const tag of node.tags) {
        const key = tag.toLowerCase();
        if (!this.byTag.has(key)) this.byTag.set(key, new Set());
        this.byTag.get(key)!.add(id);
      }
    }

    for (const edge of this.edges) {
      if (!this.edgesFromIdx.has(edge.from)) this.edgesFromIdx.set(edge.from, []);
      this.edgesFromIdx.get(edge.from)!.push(edge);
      if (!this.edgesToIdx.has(edge.to)) this.edgesToIdx.set(edge.to, []);
      this.edgesToIdx.get(edge.to)!.push(edge);
    }
  }

  /** Validate graph integrity on load: remove phantom edges, detect duplicates */
  private validateGraph(): void {
    let repairsMade = false;

    // (1) Remove edges referencing nonexistent nodes
    const originalEdgeCount = this.edges.length;
    this.edges = this.edges.filter(e => this.nodes.has(e.from) && this.nodes.has(e.to));
    const phantomEdgesRemoved = originalEdgeCount - this.edges.length;
    if (phantomEdgesRemoved > 0) {
      log(`Graph validation: removed ${phantomEdgesRemoved} phantom edge(s) referencing nonexistent nodes`);
      this.rebuildIndexes();
      repairsMade = true;
    }

    // (2) Remove self-loop edges (from === to)
    const preLoopCount = this.edges.length;
    this.edges = this.edges.filter(e => e.from !== e.to);
    const selfLoopsRemoved = preLoopCount - this.edges.length;
    if (selfLoopsRemoved > 0) {
      log(`Graph validation: removed ${selfLoopsRemoved} self-loop edge(s)`);
      repairsMade = true;
    }

    // (3) Validate node numeric fields: strength, importance, lastAccessedAt
    let nodesRepaired = 0;
    for (const [id, node] of this.nodes) {
      // NaN/Infinity check on strength — reset to 0.5
      if (!Number.isFinite(node.strength)) {
        log(`Graph validation: node ${id} has invalid strength (${node.strength}), resetting to 0.5`);
        node.strength = 0.5;
        nodesRepaired++;
      }
      // Clamp strength to [0, 1]
      if (node.strength < 0 || node.strength > 1) {
        node.strength = Math.max(0, Math.min(1, node.strength));
        nodesRepaired++;
      }
      // Validate importance field if present
      if (node.importance !== undefined) {
        if (!Number.isFinite(node.importance)) {
          log(`Graph validation: node ${id} has invalid importance (${node.importance}), resetting to 0.5`);
          node.importance = 0.5;
          nodesRepaired++;
        } else if (node.importance < 0 || node.importance > 1) {
          node.importance = Math.max(0, Math.min(1, node.importance));
          nodesRepaired++;
        }
      }
      // NaN check on lastAccessedAt — reset to now
      if (!Number.isFinite(node.lastAccessedAt)) {
        log(`Graph validation: node ${id} has invalid lastAccessedAt (${node.lastAccessedAt}), resetting to now`);
        node.lastAccessedAt = Date.now();
        nodesRepaired++;
      }
    }
    if (nodesRepaired > 0) {
      log(`Graph validation: repaired ${nodesRepaired} invalid node field(s)`);
      repairsMade = true;
    }

    // (4) Clamp out-of-range or NaN edge weights to [0, 1]
    let weightsClamped = 0;
    for (const edge of this.edges) {
      if (!Number.isFinite(edge.weight)) {
        log(`Graph validation: edge ${edge.from}->${edge.to} has invalid weight (${edge.weight}), resetting to 0.5`);
        edge.weight = 0.5;
        weightsClamped++;
      } else if (edge.weight < 0 || edge.weight > 1) {
        edge.weight = Math.max(0, Math.min(1, edge.weight));
        weightsClamped++;
      }
    }
    if (weightsClamped > 0) {
      log(`Graph validation: clamped ${weightsClamped} edge weight(s) to [0, 1] range`);
      repairsMade = true;
    }

    // (5) Deduplicate edges (same from/to/type) — keep highest weight
    const bestByKey = new Map<string, MemoryEdge>();
    for (const edge of this.edges) {
      const key = `${edge.from}|${edge.to}|${edge.type}`;
      const existing = bestByKey.get(key);
      if (!existing || edge.weight > existing.weight) {
        bestByKey.set(key, edge);
      }
    }
    const duplicatesRemoved = this.edges.length - bestByKey.size;
    if (duplicatesRemoved > 0) {
      this.edges = Array.from(bestByKey.values());
      log(`Graph validation: removed ${duplicatesRemoved} duplicate edge(s), kept highest weight for each`);
      repairsMade = true;
    }

    // Rebuild indexes if any edge repairs were made in steps 2-4
    if (selfLoopsRemoved > 0 || duplicatesRemoved > 0) {
      this.rebuildIndexes();
    }

    // (6) Persist repairs and log summary
    if (repairsMade) {
      this.save();
      log(`Graph validation: repairs complete (${phantomEdgesRemoved} phantom, ${selfLoopsRemoved} self-loops, ${nodesRepaired} node fields, ${weightsClamped} weights clamped, ${duplicatesRemoved} duplicates removed)`);
    }
  }

  // ── Node Operations ──

  addNode(node: MemoryNode): void {
    this.nodes.set(node.id, node);

    if (!this.byType.has(node.type)) this.byType.set(node.type, new Set());
    this.byType.get(node.type)!.add(node.id);

    for (const tag of node.tags) {
      const key = tag.toLowerCase();
      if (!this.byTag.has(key)) this.byTag.set(key, new Set());
      this.byTag.get(key)!.add(node.id);
    }
  }

  getNode(id: string): MemoryNode | undefined {
    return this.nodes.get(id);
  }

  removeNode(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;

    this.nodes.delete(id);
    this.byType.get(node.type)?.delete(id);
    for (const tag of node.tags) {
      this.byTag.get(tag.toLowerCase())?.delete(id);
    }

    // Remove all edges involving this node
    this.edges = this.edges.filter(e => e.from !== id && e.to !== id);
    this.edgesFromIdx.delete(id);
    this.edgesToIdx.delete(id);
    // Clean ALL references in other indexes (filter removes all matches, not just the first)
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

  updateNode(id: string, updates: { content?: string; tags?: string[]; pinned?: boolean }): void {
    const node = this.nodes.get(id);
    if (!node) return;

    if (updates.content !== undefined) node.content = updates.content;
    if (updates.pinned !== undefined) node.pinned = updates.pinned;
    if (updates.tags !== undefined) {
      // Remove old tag indexes
      for (const tag of node.tags) {
        this.byTag.get(tag.toLowerCase())?.delete(id);
      }
      node.tags = updates.tags;
      // Add new tag indexes
      for (const tag of node.tags) {
        const key = tag.toLowerCase();
        if (!this.byTag.has(key)) this.byTag.set(key, new Set());
        this.byTag.get(key)!.add(id);
      }
    }
  }

  accessNode(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.lastAccessedAt = Date.now();
    node.accessCount++;
    node.strength = Math.min(1, node.strength + 0.05);
  }

  // ── Edge Operations ──

  addEdge(edge: MemoryEdge): void {
    // Prevent self-loops
    if (edge.from === edge.to) return;

    // Avoid duplicates (O(1) lookup via edgesFromIdx instead of O(n) full scan)
    const fromEdges = this.edgesFromIdx.get(edge.from) ?? [];
    const exists = fromEdges.some(e => e.to === edge.to && e.type === edge.type);
    if (exists) return;

    // Clamp weight to [0, 1]
    edge.weight = Math.max(0, Math.min(1, edge.weight));

    this.edges.push(edge);
    if (!this.edgesFromIdx.has(edge.from)) this.edgesFromIdx.set(edge.from, []);
    this.edgesFromIdx.get(edge.from)!.push(edge);
    if (!this.edgesToIdx.has(edge.to)) this.edgesToIdx.set(edge.to, []);
    this.edgesToIdx.get(edge.to)!.push(edge);
  }

  removeEdge(from: string, to: string, type?: string): void {
    const match = (e: MemoryEdge) => e.from === from && e.to === to && (!type || e.type === type);
    this.edges = this.edges.filter(e => !match(e));
    const fromArr = this.edgesFromIdx.get(from);
    if (fromArr) {
      const filtered = fromArr.filter(e => !(e.to === to && (!type || e.type === type)));
      if (filtered.length === 0) this.edgesFromIdx.delete(from);
      else this.edgesFromIdx.set(from, filtered);
    }
    const toArr = this.edgesToIdx.get(to);
    if (toArr) {
      const filtered = toArr.filter(e => !(e.from === from && (!type || e.type === type)));
      if (filtered.length === 0) this.edgesToIdx.delete(to);
      else this.edgesToIdx.set(to, filtered);
    }
  }

  updateEdge(from: string, to: string, updates: { weight?: number; type?: string }, filterType?: string): void {
    // O(1) index lookup instead of O(n) full scan — only search edges from this node
    const fromEdges = this.edgesFromIdx.get(from);
    if (!fromEdges) return;
    const edge = fromEdges.find(e => e.to === to && (!filterType || e.type === filterType));
    if (!edge) return;
    if (updates.weight !== undefined) edge.weight = Math.max(0, Math.min(1, updates.weight));
    if (updates.type !== undefined) edge.type = updates.type as MemoryEdge["type"];
    edge.lastReinforcedAt = Date.now();
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

  // ── Hierarchical Traversal ──

  /** Get direct children of a node (via hierarchical edges where this node is parent) */
  getChildren(id: string): MemoryNode[] {
    return this.edgesFrom(id)
      .filter(e => e.type === "hierarchical")
      .map(e => this.nodes.get(e.to))
      .filter((n): n is MemoryNode => n !== null && n !== undefined);
  }

  /** Get direct parents of a node (via hierarchical edges where this node is child) */
  getParents(id: string): MemoryNode[] {
    return this.edgesTo(id)
      .filter(e => e.type === "hierarchical")
      .map(e => this.nodes.get(e.from))
      .filter((n): n is MemoryNode => n !== null && n !== undefined);
  }

  /** Get all ancestors up to maxDepth (BFS up through parents) */
  getAncestors(id: string, maxDepth = 5): MemoryNode[] {
    const visited = new Set<string>([id]);
    const result: MemoryNode[] = [];
    let frontier = [id];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];
      for (const nodeId of frontier) {
        for (const parent of this.getParents(nodeId)) {
          if (!visited.has(parent.id)) {
            visited.add(parent.id);
            result.push(parent);
            nextFrontier.push(parent.id);
          }
        }
      }
      frontier = nextFrontier;
    }

    return result;
  }

  /** Get all descendants down to maxDepth (BFS down through children) */
  getDescendants(id: string, maxDepth = 3): MemoryNode[] {
    const visited = new Set<string>([id]);
    const result: MemoryNode[] = [];
    let frontier = [id];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];
      for (const nodeId of frontier) {
        for (const child of this.getChildren(nodeId)) {
          if (!visited.has(child.id)) {
            visited.add(child.id);
            result.push(child);
            nextFrontier.push(child.id);
          }
        }
      }
      frontier = nextFrontier;
    }

    return result;
  }

  // ── Merge ──

  mergeNodes(ids: string[], into: { content: string; tags: string[] }): string | null {
    if (ids.length < 2) return null;
    const survivors = ids.filter(id => this.nodes.has(id));
    if (survivors.length < 2) return null;

    const primary = this.nodes.get(survivors[0])!;
    const now = Date.now();
    const mergedId = genId();
    const maxStrength = Math.max(...survivors.map(id => this.nodes.get(id)!.strength));
    const totalAccess = survivors.reduce((sum, id) => sum + (this.nodes.get(id)?.accessCount ?? 0), 0);

    const merged: MemoryNode = {
      id: mergedId,
      type: primary.type,
      content: into.content,
      tags: into.tags,
      strength: Math.min(1, maxStrength + 0.1),
      pinned: survivors.some(id => this.nodes.get(id)?.pinned),
      createdAt: Math.min(...survivors.map(id => this.nodes.get(id)!.createdAt)),
      lastAccessedAt: now,
      accessCount: totalAccess,
    };

    // Collect all edges from merged nodes, rewire to merged node
    // Use Set-based dedup (same pattern as validateGraph) for O(n) instead of O(n²)
    const seenEdges = new Set<string>();
    const rewiredEdges: MemoryEdge[] = [];
    for (const id of survivors) {
      for (const edge of this.edgesFor(id)) {
        const from = survivors.includes(edge.from) ? mergedId : edge.from;
        const to = survivors.includes(edge.to) ? mergedId : edge.to;
        if (from === to) continue; // Self-loop
        const key = `${from}|${to}|${edge.type}`;
        if (!seenEdges.has(key)) {
          seenEdges.add(key);
          rewiredEdges.push({ ...edge, from, to });
        }
      }
    }

    // Remove old nodes
    for (const id of survivors) {
      this.removeNode(id);
    }

    // Add merged node and rewired edges
    this.addNode(merged);
    for (const edge of rewiredEdges) {
      this.addEdge(edge);
    }

    return mergedId;
  }

  // ── Archive (Long-term Cold Storage) ──

  /**
   * Move a node from active graph to archive (cold storage).
   * The node is removed from active graph + edges, but preserved in archive.
   * Can be restored later via searchArchive() + restoreNode().
   */
  archiveNode(id: string, reason: ArchivedNode["archiveReason"] = "decay"): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;
    if (node.pinned) return false; // never archive pinned nodes

    // Capture edge topology BEFORE removal (tombstone preservation)
    const tombstoneEdges: ArchivedEdge[] = this.edgesFor(id).map(e => ({
      from: e.from,
      to: e.to,
      type: e.type,
      weight: e.weight,
    }));

    // Create archived copy with preserved edges
    const archived: ArchivedNode = {
      ...node,
      archivedAt: Date.now(),
      archiveReason: reason,
      archivedEdges: tombstoneEdges.length > 0 ? tombstoneEdges : undefined,
    };

    this.archive.set(id, archived);
    this.walLog("archive", { nodeId: id, meta: { reason, type: node.type, edgeCount: tombstoneEdges.length } });

    // Remove from active graph (edges get cleaned up)
    this.removeNode(id);

    // Evict oldest archived nodes if over limit — preserve as ghosts
    if (this.archive.size > MAX_ARCHIVE_NODES) {
      const sorted = Array.from(this.archive.values())
        .sort((a, b) => a.archivedAt - b.archivedAt);
      const toEvict = sorted.slice(0, this.archive.size - MAX_ARCHIVE_NODES);
      const now = Date.now();
      for (const evicted of toEvict) {
        // Create ghost node — topology-only remnant (no content)
        const ghost: GhostNode = {
          id: evicted.id,
          type: evicted.type,
          tagFingerprint: evicted.tags,
          edges: evicted.archivedEdges ?? [],
          archivedAt: evicted.archivedAt,
          evictedAt: now,
          archiveReason: evicted.archiveReason,
        };
        this.ghosts.set(evicted.id, ghost);
        this.archive.delete(evicted.id);
      }

      // Cap ghost graph size — evict oldest ghosts when over limit
      if (this.ghosts.size > MAX_GHOST_NODES) {
        const ghostsSorted = Array.from(this.ghosts.values())
          .sort((a, b) => a.evictedAt - b.evictedAt);
        const ghostsToEvict = ghostsSorted.slice(0, this.ghosts.size - MAX_GHOST_NODES);
        for (const g of ghostsToEvict) {
          this.ghosts.delete(g.id);
        }
        log(`Ghost graph eviction: removed ${ghostsToEvict.length} oldest ghost nodes`);
      }

      log(`Archive eviction: moved ${toEvict.length} nodes to ghost graph (${this.ghosts.size} total ghosts)`);
    }

    return true;
  }

  /**
   * Search the archive by keyword (matches content and tags).
   * Returns matching archived nodes sorted by relevance (strength * recency).
   */
  searchArchive(query: string, limit = 20): ArchivedNode[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    const matches: { node: ArchivedNode; score: number }[] = [];

    for (const node of this.archive.values()) {
      const contentLower = node.content.toLowerCase();
      const tagsLower = node.tags.map(t => t.toLowerCase());

      let termHits = 0;
      for (const term of terms) {
        if (contentLower.includes(term) || tagsLower.some(t => t.includes(term))) {
          termHits++;
        }
      }

      if (termHits === 0) continue;

      // Score: term coverage * original strength * recency bonus
      const coverage = termHits / terms.length;
      const recencyDays = (Date.now() - node.archivedAt) / 86400000;
      const recencyBonus = 1 / (1 + recencyDays / 30); // half-weight after 30 days
      const score = coverage * node.strength * (1 + recencyBonus);

      matches.push({ node, score });
    }

    return matches
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(m => m.node);
  }

  /**
   * Restore a node from archive back to active graph.
   * Strength is reduced (it was forgotten for a reason) but the memory lives again.
   */
  restoreNode(id: string): boolean {
    const archived = this.archive.get(id);
    if (!archived) return false;

    // Restore with reduced strength and reconstruction metadata
    const { archivedAt: _, archiveReason: __, archivedEdges, ...nodeData } = archived;
    const now = Date.now();
    const restored: MemoryNode = {
      ...nodeData,
      strength: Math.min(0.6, archived.strength), // cap at 0.6 — needs reinforcement
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
    };

    this.addNode(restored);

    // Re-create tombstone edges where the other endpoint still exists
    if (archivedEdges && archivedEdges.length > 0) {
      let edgesRestored = 0;
      for (const te of archivedEdges) {
        const from = te.from === id ? id : te.from;
        const to = te.to === id ? id : te.to;
        const otherId = from === id ? to : from;
        if (!this.nodes.has(otherId)) continue; // other endpoint gone
        this.addEdge({
          from,
          to,
          type: te.type,
          weight: Math.min(0.5, te.weight), // reduced weight — stale connection
          createdAt: now,
          lastReinforcedAt: now,
        });
        edgesRestored++;
      }
      if (edgesRestored > 0) {
        log(`Restored ${edgesRestored}/${archivedEdges.length} tombstone edges for node ${id}`);
      }
    }

    this.archive.delete(id);
    this.walLog("restore", { nodeId: id, meta: { type: archived.type, archiveReason: archived.archiveReason } });

    log(`Restored node ${id} from archive (was archived for "${archived.archiveReason}", marked as reconstructed)`);
    return true;
  }

  /** Get archive stats */
  get archiveSize(): number {
    return this.archive.size;
  }

  /** Get all archived nodes (for dashboard/inspection) */
  allArchivedNodes(): ArchivedNode[] {
    return Array.from(this.archive.values());
  }

  /** Get a specific archived node by ID */
  getArchived(id: string): ArchivedNode | undefined {
    return this.archive.get(id);
  }

  // ── Ghost Graph ──

  /** Get ghost graph size */
  get ghostCount(): number {
    return this.ghosts.size;
  }

  /** Get all ghost nodes (for dashboard/inspection) */
  allGhostNodes(): GhostNode[] {
    return Array.from(this.ghosts.values());
  }

  /** Get a specific ghost node by ID */
  getGhost(id: string): GhostNode | undefined {
    return this.ghosts.get(id);
  }

  /** Check if a node exists anywhere: active, archived, or ghost */
  hasTopology(id: string): boolean {
    return this.nodes.has(id) || this.archive.has(id) || this.ghosts.has(id);
  }

  // ── Auto-Correlation ──

  /**
   * Find existing nodes correlated to a new node by tag overlap and content keyword matching.
   * Auto-creates topical edges between the new node and strongly correlated existing nodes.
   * Also detects potential contradictions for person/fact nodes.
   */
  correlateNode(newNode: MemoryNode, maxEdges = 5): { correlated: number; contradictions: string[] } {
    const contradictions: string[] = [];
    const newTagsLower = new Set(newNode.tags.map(t => t.toLowerCase()));
    const newContentLower = newNode.content.toLowerCase();

    // Extract meaningful keywords from content (3+ chars, skip stop words)
    const stopWords = new Set([
      "the", "and", "for", "was", "are", "but", "not", "you", "all", "can",
      "has", "her", "his", "one", "our", "out", "had", "she", "him", "how",
      "its", "may", "who", "did", "get", "let", "say", "too", "use", "way",
      "that", "this", "with", "have", "from", "they", "been", "said", "each",
      "which", "their", "will", "other", "about", "than", "then", "them",
      "these", "some", "when", "what", "into", "also", "just", "more",
      "gillis", "confirmed", "day", "via", "whatsapp", "group",
    ]);
    const newKeywords = new Set(
      newContentLower
        .split(/[\s\-—,.:;!?()[\]"'`/\\]+/)
        .filter(w => w.length >= 3 && !stopWords.has(w) && !/^\d+$/.test(w))
    );

    // Score all existing nodes
    const candidates: { id: string; score: number; matchType: "tag" | "content" | "both" }[] = [];

    for (const [id, existing] of this.nodes) {
      if (id === newNode.id) continue;

      const existTagsLower = new Set(existing.tags.map(t => t.toLowerCase()));
      const existContentLower = existing.content.toLowerCase();

      // Tag overlap score
      let tagOverlap = 0;
      for (const tag of newTagsLower) {
        if (existTagsLower.has(tag)) tagOverlap++;
      }
      const tagScore = newTagsLower.size > 0 ? tagOverlap / newTagsLower.size : 0;

      // Content keyword overlap score
      let keywordHits = 0;
      for (const kw of newKeywords) {
        if (existContentLower.includes(kw)) keywordHits++;
      }
      const contentScore = newKeywords.size > 0 ? keywordHits / newKeywords.size : 0;

      // Combined score (tags weighted higher — they're more intentional)
      const combined = tagScore * 0.6 + contentScore * 0.4;

      // Minimum threshold to be considered correlated
      if (combined < 0.15) continue;

      // Already connected? Skip.
      const alreadyLinked = this.edgesFrom(newNode.id).some(e => e.to === id)
        || this.edgesTo(newNode.id).some(e => e.from === id);
      if (alreadyLinked) continue;

      const matchType = tagScore > 0 && contentScore > 0 ? "both"
        : tagScore > 0 ? "tag" : "content";

      candidates.push({ id, score: combined, matchType });

      // Contradiction detection: same person or fact with conflicting info
      if (combined > 0.3 && (newNode.type === "person" || newNode.type === "fact")
        && existing.type === newNode.type) {
        // Check for potential conflict markers (age, date, number mismatches)
        const agePattern = /(\d+)\s*(?:years?\s*old|jaar|jr)/i;
        const newAge = newContentLower.match(agePattern);
        const existAge = existContentLower.match(agePattern);
        if (newAge && existAge && newAge[1] !== existAge[1]) {
          contradictions.push(
            `Possible conflict: "${newNode.content.slice(0, 60)}..." says ${newAge[0]} but existing node ${id} says ${existAge[0]}`
          );
        }
      }
    }

    // Sort by score, take top N
    candidates.sort((a, b) => b.score - a.score);
    const topCorrelations = candidates.slice(0, maxEdges);

    // Create edges
    const now = Date.now();
    for (const match of topCorrelations) {
      // Determine edge type based on node types
      const existing = this.nodes.get(match.id)!;
      let edgeType: MemoryEdge["type"] = "topical";
      if (newNode.type === "person" && existing.type === "person") edgeType = "social";
      if (newNode.type === "event" && existing.type === "event") edgeType = "temporal";
      if (newNode.type === "emotion") edgeType = "emotional";

      this.addEdge({
        from: newNode.id,
        to: match.id,
        type: edgeType,
        weight: Math.min(0.7, match.score), // cap at 0.7 — not as strong as explicit edges
        createdAt: now,
        lastReinforcedAt: now,
      });
    }

    if (topCorrelations.length > 0) {
      log(`Auto-correlated node ${newNode.id} → ${topCorrelations.length} edge(s) created [${topCorrelations.map(c => c.id + ":" + c.score.toFixed(2)).join(", ")}]`);
    }
    if (contradictions.length > 0) {
      log(`⚠ Contradictions detected for ${newNode.id}: ${contradictions.join("; ")}`);
    }

    return { correlated: topCorrelations.length, contradictions };
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

  addPendingObservation(obs: Observation): void {
    this.pending.push(obs);
  }

  getPendingObservations(): Observation[] {
    return this.pending;
  }

  clearPendingObservations(): void {
    this.pending = [];
  }

  // ── Batch Apply Operations from Claude ──

  applyOperations(ops: MemoryOperation[]): { applied: number; skipped: number } {
    let applied = 0;
    let skipped = 0;
    const now = Date.now();

    for (const op of ops) {
      try {
        switch (op.op) {
          case "add_node": {
            if (this.nodes.has(op.id)) { skipped++; break; }
            const newNode: MemoryNode = {
              id: op.id,
              type: op.type,
              content: op.content,
              tags: op.tags || [],
              strength: op.strength ?? 0.8,
              pinned: op.pinned ?? false,
              createdAt: now,
              lastAccessedAt: now,
              accessCount: 1,
              ...(op.importance !== null && op.importance !== undefined ? { importance: Math.max(0, Math.min(1, op.importance)) } : {}),
            };
            this.addNode(newNode);
            // Auto-correlate: find related nodes and create edges
            this.correlateNode(newNode);
            this.walLog("add_node", { nodeId: op.id, meta: { type: op.type, tags: op.tags } });
            applied++;
            break;
          }
          case "add_edge": {
            if (!this.nodes.has(op.from) || !this.nodes.has(op.to)) { skipped++; break; }
            if (op.from === op.to) { skipped++; break; }
            this.addEdge({
              from: op.from, to: op.to,
              type: op.type,
              weight: Math.max(0, Math.min(1, op.weight)),
              createdAt: now,
              lastReinforcedAt: now,
            });
            this.walLog("add_edge", { edgeFrom: op.from, edgeTo: op.to, meta: { type: op.type, weight: op.weight } });
            applied++;
            break;
          }
          case "strengthen": {
            const node = this.nodes.get(op.id);
            if (!node) { skipped++; break; }
            node.strength = Math.min(1, node.strength + op.amount);
            node.lastAccessedAt = now;
            node.accessCount++;
            this.walLog("strengthen", { nodeId: op.id, meta: { amount: op.amount } });
            applied++;
            break;
          }
          case "weaken": {
            const node = this.nodes.get(op.id);
            if (!node) { skipped++; break; }
            node.strength = Math.max(0, node.strength - op.amount);
            this.walLog("weaken", { nodeId: op.id, meta: { amount: op.amount } });
            applied++;
            break;
          }
          case "update_node": {
            if (!this.nodes.has(op.id)) { skipped++; break; }
            this.updateNode(op.id, { content: op.content, tags: op.tags, pinned: op.pinned });
            // Handle importance update separately (not part of updateNode's generic interface)
            if (op.importance !== null && op.importance !== undefined) {
              const node = this.nodes.get(op.id);
              if (node) node.importance = Math.max(0, Math.min(1, op.importance));
            }
            this.walLog("update_node", { nodeId: op.id, meta: { hasContent: op.content !== null && op.content !== undefined, hasTags: op.tags !== null && op.tags !== undefined } });
            applied++;
            break;
          }
          case "update_edge": {
            // Use index to check existence instead of O(n) scan
            const fromEdges = this.edgesFromIdx.get(op.from);
            const hasEdge = fromEdges?.some(e => e.to === op.to && (!op.type || e.type === op.type));
            if (!hasEdge) { skipped++; break; }
            this.updateEdge(op.from, op.to, { weight: op.weight, type: op.type }, op.type);
            this.walLog("update_edge", { edgeFrom: op.from, edgeTo: op.to, meta: { weight: op.weight } });
            applied++;
            break;
          }
          case "merge_nodes": {
            const mergedId = this.mergeNodes(op.ids, op.into);
            if (mergedId) {
              this.walLog("merge_nodes", { nodeId: mergedId, nodeIds: op.ids, meta: { into: op.into } });
              applied++;
            } else { skipped++; }
            break;
          }
          case "remove_node": {
            if (!this.nodes.has(op.id)) { skipped++; break; }
            this.walLog("remove_node", { nodeId: op.id, meta: { type: this.nodes.get(op.id)!.type } });
            this.removeNode(op.id);
            applied++;
            break;
          }
          case "remove_edge": {
            this.walLog("remove_edge", { edgeFrom: op.from, edgeTo: op.to, meta: { type: op.type } });
            this.removeEdge(op.from, op.to, op.type);
            applied++;
            break;
          }
          default:
            skipped++;
        }
      } catch (err) {
        log(`Operation failed: ${JSON.stringify(op).slice(0, 100)} — ${err}`);
        skipped++;
      }
    }

    return { applied, skipped };
  }

  // ── Validation & Repair ──

  validate(repair = false): { valid: boolean; issues: string[] } {
    const issues: string[] = [];

    // Check for dangling edges (edges referencing non-existent nodes)
    const danglingEdges: { from: string; to: string }[] = [];
    for (const edge of this.edges) {
      if (!this.nodes.has(edge.from)) {
        issues.push(`Dangling edge: 'from' node ${edge.from} does not exist`);
        danglingEdges.push({ from: edge.from, to: edge.to });
      }
      if (!this.nodes.has(edge.to)) {
        issues.push(`Dangling edge: 'to' node ${edge.to} does not exist`);
        danglingEdges.push({ from: edge.from, to: edge.to });
      }
    }

    // Check for self-loop edges
    for (const edge of this.edges) {
      if (edge.from === edge.to) {
        issues.push(`Self-loop edge on node ${edge.from}`);
        danglingEdges.push({ from: edge.from, to: edge.to });
      }
    }

    // Check for out-of-range weights and strengths
    for (const edge of this.edges) {
      if (edge.weight < 0 || edge.weight > 1) {
        issues.push(`Edge ${edge.from}→${edge.to} has out-of-range weight: ${edge.weight}`);
        if (repair) edge.weight = Math.max(0, Math.min(1, edge.weight));
      }
    }
    for (const [id, node] of this.nodes) {
      if (node.strength < 0 || node.strength > 1) {
        issues.push(`Node ${id} has out-of-range strength: ${node.strength}`);
        if (repair) node.strength = Math.max(0, Math.min(1, node.strength));
      }
    }

    // Check index consistency
    for (const [id, node] of this.nodes) {
      const typeSet = this.byType.get(node.type);
      if (!typeSet || !typeSet.has(id)) {
        issues.push(`Node ${id} missing from byType index for type ${node.type}`);
      }
    }

    // Repair: remove dangling/self-loop edges
    if (repair && danglingEdges.length > 0) {
      for (const { from, to } of danglingEdges) {
        this.removeEdge(from, to);
      }
      issues.push(`Repaired: removed ${danglingEdges.length} invalid edge(s)`);
    }

    if (issues.length > 0) {
      log(`Graph validation: ${issues.length} issue(s) found${repair ? " (repaired)" : ""}`);
    }

    return { valid: issues.length === 0, issues };
  }

  // ── Stats ──

  getStats(): { nodeCount: number; edgeCount: number; archivedCount: number; ghostCount: number; byType: Record<string, number>; avgStrength: number } {
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
      byType,
      avgStrength: this.nodes.size > 0 ? totalStrength / this.nodes.size : 0,
    };
  }
}
