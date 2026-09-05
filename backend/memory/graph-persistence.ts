/**
 * On-disk layout of the memory graph and the single-writer guard.
 *
 * Files under `${BRAIN_DIR}/graph/`:
 *   nodes.json, edges.json         — canonical, read strictly (corruption refuses boot)
 *   archive.json, ghost-graph.json — read strictly too, but a corrupt file only
 *                                    disables *writing* that file (never emptied)
 *   rejected-edges.json            — derivable, lenient
 *   generation.json                — monotonically increasing save counter
 *
 * The generation counter is the single-writer guard: a process remembers the
 * generation it loaded and refuses to save when the on-disk generation has
 * moved past it (another instance saved in between — e.g. the 1-3 minute
 * overlap during a redeploy). Missing file ⇒ generation 0, so existing
 * installs need no migration.
 *
 * Save order is archive → ghosts → edges → nodes → generation: a crash
 * mid-save can leave an archived copy of a node that is also still active
 * (harmless, repaired on load) but never a node that vanished from both.
 */

import { existsSync } from "fs";
import { safeReadJSON, strictReadJSON, atomicWriteJSON, ensureDir } from "../utils/file-store.js";
import type { MemoryNode, MemoryEdge, ArchivedNode, GhostNode, RejectedEdge } from "./types.js";
import { createLogger } from "../logger.js";
import { BRAIN_DIR } from "../config.js";

const log = createLogger("graph");

export const GRAPH_DIR = `${BRAIN_DIR}/graph`;
export const NODES_FILE = `${GRAPH_DIR}/nodes.json`;
export const EDGES_FILE = `${GRAPH_DIR}/edges.json`;
export const ARCHIVE_FILE = `${GRAPH_DIR}/archive.json`;
export const GHOST_FILE = `${GRAPH_DIR}/ghost-graph.json`;
export const REJECTED_EDGES_FILE = `${GRAPH_DIR}/rejected-edges.json`;
export const GENERATION_FILE = `${GRAPH_DIR}/generation.json`;

export interface GenerationRecord {
  generation: number;
  savedAt: number;
  pid: number;
}

export interface GraphFiles {
  nodes: Map<string, MemoryNode>;
  edges: MemoryEdge[];
  archive: Map<string, ArchivedNode>;
  ghosts: Map<string, GhostNode>;
  rejectedEdges: Map<string, RejectedEdge>;
  /** Generation on disk at load time */
  generation: number;
  /** archive.json existed but did not parse — never overwrite it */
  archiveLoadFailed: boolean;
  /** ghost-graph.json existed but did not parse — never overwrite it */
  ghostLoadFailed: boolean;
}

// ── Reading ──

/** Current on-disk generation (0 when the file is missing or unreadable). */
export function readGeneration(): number {
  const rec = safeReadJSON<Partial<GenerationRecord>>(GENERATION_FILE, {});
  return Number.isFinite(rec.generation) ? Number(rec.generation) : 0;
}

function readCanonical<T>(file: string, label: string): T | null {
  try {
    return strictReadJSON<T>(file);
  } catch (err) {
    log(`!! REFUSING TO LOAD: ${label} file corrupted at ${file}. Restore from ${BRAIN_DIR}/backups/ before restart.`);
    throw err;
  }
}

/** Strict read that degrades to "empty + write-protected" instead of throwing. */
function readProtected<T>(file: string, label: string): { data: Record<string, T>; failed: boolean } {
  if (!existsSync(file)) return { data: {}, failed: false };
  try {
    return { data: strictReadJSON<Record<string, T>>(file) ?? {}, failed: false };
  } catch (err) {
    log(`!! ${label} file corrupted at ${file} — loading empty and REFUSING TO OVERWRITE it. Repair or restore it by hand. (${err})`);
    return { data: {}, failed: true };
  }
}

export function loadGraphFiles(): GraphFiles {
  ensureDir(GRAPH_DIR);
  const nodesRaw = readCanonical<Record<string, MemoryNode>>(NODES_FILE, "nodes") ?? {};
  const edgesRaw = readCanonical<MemoryEdge[]>(EDGES_FILE, "edges") ?? [];
  const archive = readProtected<ArchivedNode>(ARCHIVE_FILE, "archive");
  const ghosts = readProtected<GhostNode>(GHOST_FILE, "ghost graph");
  const rejectedRaw = safeReadJSON<Record<string, RejectedEdge>>(REJECTED_EDGES_FILE, {});

  return {
    nodes: new Map(Object.entries(nodesRaw)),
    edges: Array.isArray(edgesRaw) ? edgesRaw : [],
    archive: new Map(Object.entries(archive.data)),
    ghosts: new Map(Object.entries(ghosts.data)),
    rejectedEdges: new Map(Object.entries(rejectedRaw)),
    generation: readGeneration(),
    archiveLoadFailed: archive.failed,
    ghostLoadFailed: ghosts.failed,
  };
}

// ── Writing ──

function writeMap<T>(file: string, map: Map<string, T>, label: string): void {
  try {
    atomicWriteJSON(file, Object.fromEntries(map), 0);
  } catch (err) {
    log(`Failed to save ${label} — aborting remaining saves: ${err}`);
    throw err;
  }
}

/** Bump the on-disk generation (used by save and by restore-from-backup). */
export function writeGeneration(generation: number): void {
  atomicWriteJSON(GENERATION_FILE, { generation, savedAt: Date.now(), pid: process.pid } satisfies GenerationRecord);
}

/**
 * Persist all graph files. Returns the new generation, or null when the save
 * was refused because another writer has saved since `loadedGeneration`.
 * Throws when a canonical file cannot be written.
 */
export function saveGraphFiles(data: GraphFiles, loadedGeneration: number): number | null {
  ensureDir(GRAPH_DIR);
  const onDisk = readGeneration();
  if (onDisk > loadedGeneration) {
    log(`!! REFUSING TO SAVE: on-disk generation ${onDisk} is newer than loaded ${loadedGeneration} — another writer saved in between. Keeping changes in memory only.`);
    return null;
  }

  if (data.archiveLoadFailed) {
    log("!! Skipping archive.json write — it failed to parse at load and must not be emptied");
  } else {
    writeMap(ARCHIVE_FILE, data.archive, "archive");
  }
  if (data.ghostLoadFailed) {
    log("!! Skipping ghost-graph.json write — it failed to parse at load and must not be emptied");
  } else {
    writeMap(GHOST_FILE, data.ghosts, "ghost graph");
  }

  try {
    atomicWriteJSON(EDGES_FILE, data.edges, 0);
  } catch (err) {
    log(`Failed to save edges — aborting remaining saves: ${err}`);
    throw err;
  }
  writeMap(NODES_FILE, data.nodes, "nodes");

  try {
    writeMap(REJECTED_EDGES_FILE, data.rejectedEdges, "rejected edges");
  } catch (err) {
    log(`Failed to save rejected edges (non-fatal): ${err}`);
  }

  const next = onDisk + 1;
  writeGeneration(next);
  return next;
}
