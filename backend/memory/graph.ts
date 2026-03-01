import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { appendFileSync } from "fs";
import { randomBytes } from "crypto";
import type { MemoryNode, MemoryEdge, MemoryOperation, NodeType } from "./types.js";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
function log(msg: string) {
  const line = `[${new Date().toISOString()}] [graph] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

const BRAIN_DIR = process.env.BRAIN_DIR || "/data/brain";
const GRAPH_DIR = `${BRAIN_DIR}/graph`;
const NODES_FILE = `${GRAPH_DIR}/nodes.json`;
const EDGES_FILE = `${GRAPH_DIR}/edges.json`;

function atomicWrite(filepath: string, data: string): void {
  const tmp = filepath + ".tmp";
  writeFileSync(tmp, data);
  renameSync(tmp, filepath);
}

function genId(): string {
  return "n_" + randomBytes(4).toString("hex");
}

import type { Observation } from "../observer.js";

export class MemoryGraph {
  private nodes = new Map<string, MemoryNode>();
  private edges: MemoryEdge[] = [];

  // Indexes
  private byType = new Map<NodeType, Set<string>>();
  private byTag = new Map<string, Set<string>>();
  private edgesFromIdx = new Map<string, MemoryEdge[]>();
  private edgesToIdx = new Map<string, MemoryEdge[]>();

  // Pending observations buffer (for observe ticks)
  private pending: Observation[] = [];

  // ── Persistence ──

  load(): void {
    if (!existsSync(GRAPH_DIR)) {
      mkdirSync(GRAPH_DIR, { recursive: true });
    }

    if (existsSync(NODES_FILE)) {
      try {
        const raw = JSON.parse(readFileSync(NODES_FILE, "utf-8")) as Record<string, MemoryNode>;
        for (const [id, node] of Object.entries(raw)) {
          this.nodes.set(id, node);
        }
      } catch {
        log("Failed to parse nodes.json, starting fresh");
      }
    }

    if (existsSync(EDGES_FILE)) {
      try {
        this.edges = JSON.parse(readFileSync(EDGES_FILE, "utf-8")) as MemoryEdge[];
      } catch {
        log("Failed to parse edges.json, starting fresh");
      }
    }

    this.rebuildIndexes();
    log(`Loaded graph: ${this.nodes.size} nodes, ${this.edges.length} edges`);
  }

  save(): void {
    if (!existsSync(GRAPH_DIR)) {
      mkdirSync(GRAPH_DIR, { recursive: true });
    }

    const nodesObj: Record<string, MemoryNode> = {};
    for (const [id, node] of this.nodes) {
      nodesObj[id] = node;
    }
    atomicWrite(NODES_FILE, JSON.stringify(nodesObj));
    atomicWrite(EDGES_FILE, JSON.stringify(this.edges));
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
    // Clean references in other indexes
    for (const [, arr] of this.edgesFromIdx) {
      const idx = arr.findIndex(e => e.to === id);
      if (idx !== -1) arr.splice(idx, 1);
    }
    for (const [, arr] of this.edgesToIdx) {
      const idx = arr.findIndex(e => e.from === id);
      if (idx !== -1) arr.splice(idx, 1);
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

    // Avoid duplicates
    const exists = this.edges.some(e => e.from === edge.from && e.to === edge.to && e.type === edge.type);
    if (exists) return;

    this.edges.push(edge);
    if (!this.edgesFromIdx.has(edge.from)) this.edgesFromIdx.set(edge.from, []);
    this.edgesFromIdx.get(edge.from)!.push(edge);
    if (!this.edgesToIdx.has(edge.to)) this.edgesToIdx.set(edge.to, []);
    this.edgesToIdx.get(edge.to)!.push(edge);
  }

  removeEdge(from: string, to: string): void {
    this.edges = this.edges.filter(e => !(e.from === from && e.to === to));
    const fromArr = this.edgesFromIdx.get(from);
    if (fromArr) {
      const idx = fromArr.findIndex(e => e.to === to);
      if (idx !== -1) fromArr.splice(idx, 1);
    }
    const toArr = this.edgesToIdx.get(to);
    if (toArr) {
      const idx = toArr.findIndex(e => e.from === from);
      if (idx !== -1) toArr.splice(idx, 1);
    }
  }

  updateEdge(from: string, to: string, updates: { weight?: number; type?: string }): void {
    const edge = this.edges.find(e => e.from === from && e.to === to);
    if (!edge) return;
    if (updates.weight !== undefined) edge.weight = updates.weight;
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
      .filter((n): n is MemoryNode => n != null);
  }

  /** Get direct parents of a node (via hierarchical edges where this node is child) */
  getParents(id: string): MemoryNode[] {
    return this.edgesTo(id)
      .filter(e => e.type === "hierarchical")
      .map(e => this.nodes.get(e.from))
      .filter((n): n is MemoryNode => n != null);
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
    const rewiredEdges: MemoryEdge[] = [];
    for (const id of survivors) {
      for (const edge of this.edgesFor(id)) {
        const from = survivors.includes(edge.from) ? mergedId : edge.from;
        const to = survivors.includes(edge.to) ? mergedId : edge.to;
        if (from === to) continue; // Self-loop
        if (!rewiredEdges.some(e => e.from === from && e.to === to && e.type === edge.type)) {
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
            this.addNode({
              id: op.id,
              type: op.type,
              content: op.content,
              tags: op.tags || [],
              strength: op.strength ?? 0.8,
              pinned: op.pinned ?? false,
              createdAt: now,
              lastAccessedAt: now,
              accessCount: 1,
            });
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
            applied++;
            break;
          }
          case "strengthen": {
            const node = this.nodes.get(op.id);
            if (!node) { skipped++; break; }
            node.strength = Math.min(1, node.strength + op.amount);
            node.lastAccessedAt = now;
            node.accessCount++;
            applied++;
            break;
          }
          case "weaken": {
            const node = this.nodes.get(op.id);
            if (!node) { skipped++; break; }
            node.strength = Math.max(0, node.strength - op.amount);
            applied++;
            break;
          }
          case "update_node": {
            if (!this.nodes.has(op.id)) { skipped++; break; }
            this.updateNode(op.id, { content: op.content, tags: op.tags, pinned: op.pinned });
            applied++;
            break;
          }
          case "update_edge": {
            const edge = this.edges.find(e => e.from === op.from && e.to === op.to);
            if (!edge) { skipped++; break; }
            this.updateEdge(op.from, op.to, { weight: op.weight, type: op.type });
            applied++;
            break;
          }
          case "merge_nodes": {
            const mergedId = this.mergeNodes(op.ids, op.into);
            if (mergedId) { applied++; } else { skipped++; }
            break;
          }
          case "remove_node": {
            if (!this.nodes.has(op.id)) { skipped++; break; }
            this.removeNode(op.id);
            applied++;
            break;
          }
          case "remove_edge": {
            this.removeEdge(op.from, op.to);
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

  // ── Stats ──

  getStats(): { nodeCount: number; edgeCount: number; byType: Record<string, number>; avgStrength: number } {
    const byType: Record<string, number> = {};
    let totalStrength = 0;

    for (const node of this.nodes.values()) {
      byType[node.type] = (byType[node.type] || 0) + 1;
      totalStrength += node.strength;
    }

    return {
      nodeCount: this.nodes.size,
      edgeCount: this.edges.length,
      byType,
      avgStrength: this.nodes.size > 0 ? totalStrength / this.nodes.size : 0,
    };
  }
}
