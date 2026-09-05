/**
 * Memory backup system — creates full, restorable snapshots of the memory graph.
 *
 * Unlike the lightweight metadata-only snapshots in reconstruction.ts (used for
 * delta audits), these are complete copies of all graph files that can be used
 * to fully restore the memory state.
 *
 * Backups are stored as plain JSON copies in /data/brain/backups/backup_<timestamp>/
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync, statSync, copyFileSync, renameSync, unlinkSync } from "fs";
import { join } from "path";
import { createLogger } from "../logger.js";
import { BRAIN_DIR } from "../config.js";
import { ensureDir, strictReadJSON, uniqueTmpPath } from "../utils/file-store.js";
import { readGeneration, writeGeneration } from "./graph-persistence.js";
import { requestGraphReload } from "./graph-inbox.js";

const log = createLogger("backup");

// ── Constants ──

const BACKUP_DIR = `${BRAIN_DIR}/backups`;
const GRAPH_DIR = `${BRAIN_DIR}/graph`;
const MAX_BACKUPS = 30;
export const BACKUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

// Source files to back up
const GRAPH_FILES = ["nodes.json", "edges.json"];
const OPTIONAL_GRAPH_FILES = ["archive.json", "ghost-graph.json"];
const WM_FILE = `${BRAIN_DIR}/working-memory.json`;

// ── Types ──

export interface BackupMeta {
  timestamp: number;
  date: string;
  nodeCount: number;
  edgeCount: number;
  archiveCount: number;
  ghostCount: number;
  totalSizeBytes: number;
  createdBy: "auto" | "manual";
}

export interface BackupDetail extends BackupMeta {
  nodeTypeBreakdown: Record<string, number>;
  pinnedNodes: { id: string; type: string; content: string }[];
}

// ── Helpers ──

function backupDirForTimestamp(ts: number): string {
  return join(BACKUP_DIR, `backup_${ts}`);
}

function getFileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function countJsonKeys(filePath: string): number {
  try {
    if (!existsSync(filePath)) return 0;
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    if (Array.isArray(data)) return data.length;
    if (data && typeof data === "object") return Object.keys(data).length;
    return 0;
  } catch {
    return 0;
  }
}

// ── Core Functions ──

/**
 * Create a full backup of the memory graph, working memory, and related files.
 */
export function createBackup(reason: "auto" | "manual"): BackupMeta {
  const now = Date.now();
  const dir = backupDirForTimestamp(now);

  ensureDir(dir);

  let totalSize = 0;

  // Copy required graph files
  for (const file of GRAPH_FILES) {
    const src = join(GRAPH_DIR, file);
    const dst = join(dir, file);
    if (existsSync(src)) {
      copyFileSync(src, dst);
      totalSize += getFileSize(dst);
    }
  }

  // Copy optional graph files
  for (const file of OPTIONAL_GRAPH_FILES) {
    const src = join(GRAPH_DIR, file);
    const dst = join(dir, file);
    if (existsSync(src)) {
      copyFileSync(src, dst);
      totalSize += getFileSize(dst);
    }
  }

  // Copy working memory
  if (existsSync(WM_FILE)) {
    const dst = join(dir, "working-memory.json");
    copyFileSync(WM_FILE, dst);
    totalSize += getFileSize(dst);
  }

  // Count entities
  const nodeCount = countJsonKeys(join(dir, "nodes.json"));
  const edgeCount = countJsonKeys(join(dir, "edges.json"));
  const archiveCount = countJsonKeys(join(dir, "archive.json"));
  const ghostCount = countJsonKeys(join(dir, "ghost-graph.json"));

  // Write meta
  const meta: BackupMeta = {
    timestamp: now,
    date: new Date(now).toISOString(),
    nodeCount,
    edgeCount,
    archiveCount,
    ghostCount,
    totalSizeBytes: totalSize,
    createdBy: reason,
  };

  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));

  log(`Backup created: ${dir} (${nodeCount} nodes, ${edgeCount} edges, ${formatBytes(totalSize)}, reason=${reason})`);

  // Prune old backups
  pruneBackups();

  return meta;
}

/**
 * List all backups, sorted newest first.
 */
export function listBackups(): BackupMeta[] {
  ensureDir(BACKUP_DIR);

  const entries = readdirSync(BACKUP_DIR).filter(d => d.startsWith("backup_"));
  const metas: BackupMeta[] = [];

  for (const entry of entries) {
    const metaFile = join(BACKUP_DIR, entry, "meta.json");
    try {
      if (existsSync(metaFile)) {
        const meta = JSON.parse(readFileSync(metaFile, "utf-8")) as BackupMeta;
        metas.push(meta);
      }
    } catch {
      // Skip corrupted backup metadata
    }
  }

  return metas.sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Get detailed info about a specific backup.
 */
export function getBackup(timestamp: string): BackupDetail | null {
  const ts = Number(timestamp);
  if (isNaN(ts)) return null;

  const dir = backupDirForTimestamp(ts);
  const metaFile = join(dir, "meta.json");

  if (!existsSync(metaFile)) return null;

  try {
    const meta = JSON.parse(readFileSync(metaFile, "utf-8")) as BackupMeta;

    // Build node type breakdown and pinned list
    const nodeTypeBreakdown: Record<string, number> = {};
    const pinnedNodes: { id: string; type: string; content: string }[] = [];

    const nodesFile = join(dir, "nodes.json");
    if (existsSync(nodesFile)) {
      const nodes = JSON.parse(readFileSync(nodesFile, "utf-8")) as Record<string, { type: string; content: string; pinned?: boolean }>;
      for (const [id, node] of Object.entries(nodes)) {
        nodeTypeBreakdown[node.type] = (nodeTypeBreakdown[node.type] || 0) + 1;
        if (node.pinned) {
          pinnedNodes.push({ id, type: node.type, content: node.content.slice(0, 120) });
        }
      }
    }

    return {
      ...meta,
      nodeTypeBreakdown,
      pinnedNodes,
    };
  } catch {
    return null;
  }
}

interface StagedCopy {
  src: string;
  tmp: string;
  dst: string;
}

/** Plan which backup files exist and where they go. */
function planRestore(dir: string): { src: string; dst: string }[] {
  const graphCopies = [...GRAPH_FILES, ...OPTIONAL_GRAPH_FILES]
    .map(file => ({ src: join(dir, file), dst: join(GRAPH_DIR, file) }));
  const wmCopy = { src: join(dir, "working-memory.json"), dst: WM_FILE };
  return [...graphCopies, wmCopy].filter(c => existsSync(c.src));
}

/** Copy every source next to its destination (same filesystem) so the final step is a pure rename. */
function stageCopies(copies: { src: string; dst: string }[]): StagedCopy[] {
  const staged: StagedCopy[] = [];
  try {
    for (const { src, dst } of copies) {
      strictReadJSON(src); // a backup file that doesn't parse must never replace a live one
      const tmp = uniqueTmpPath(dst);
      copyFileSync(src, tmp);
      staged.push({ src, tmp, dst });
    }
    return staged;
  } catch (err) {
    for (const s of staged) {
      try { unlinkSync(s.tmp); } catch { /* already gone */ }
    }
    throw new Error(`Restore aborted before touching live files — could not stage an atomic copy: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

/**
 * Restore a backup. Every file is first copied to a temp path beside its
 * destination (validated as JSON on the way), and only when all copies are
 * staged are they renamed into place — so a failure part-way leaves the live
 * graph untouched. The graph generation is bumped so any process still
 * holding the old graph refuses to save over the restore, and a reload marker
 * tells the brain to pick up the restored files at its next tick.
 */
export function restoreBackup(timestamp: string): void {
  const ts = Number(timestamp);
  if (isNaN(ts)) throw new Error("Invalid timestamp");

  const dir = backupDirForTimestamp(ts);
  if (!existsSync(dir)) throw new Error("Backup not found");
  if (!existsSync(join(dir, "meta.json"))) throw new Error("Backup meta not found");

  ensureDir(GRAPH_DIR);
  const staged = stageCopies(planRestore(dir));
  for (const { tmp, dst } of staged) {
    renameSync(tmp, dst);
  }

  writeGeneration(readGeneration() + 1);
  requestGraphReload(`restore backup_${ts}`);
  log(`Backup restored from ${dir} (timestamp=${ts}, ${staged.length} files) — brain reload requested`);
}

/**
 * Delete a specific backup.
 */
export function deleteBackup(timestamp: string): void {
  const ts = Number(timestamp);
  if (isNaN(ts)) throw new Error("Invalid timestamp");

  const dir = backupDirForTimestamp(ts);
  if (!existsSync(dir)) throw new Error("Backup not found");

  rmSync(dir, { recursive: true, force: true });
  log(`Backup deleted: ${dir}`);
}

/**
 * Check whether a backup should run based on time elapsed.
 */
export function shouldRunBackup(lastBackupTime: number): boolean {
  return Date.now() - lastBackupTime >= BACKUP_INTERVAL;
}

// ── Internal Helpers ──

function pruneBackups(): void {
  const backups = listBackups();
  if (backups.length <= MAX_BACKUPS) return;

  // Remove oldest backups beyond the limit
  const toRemove = backups.slice(MAX_BACKUPS);
  for (const backup of toRemove) {
    try {
      const dir = backupDirForTimestamp(backup.timestamp);
      rmSync(dir, { recursive: true, force: true });
      log(`Pruned old backup: ${backup.date}`);
    } catch (err) {
      log(`Failed to prune backup ${backup.timestamp}: ${err}`);
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
