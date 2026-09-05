import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync } from "fs";

const { TEST_DIR } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return { TEST_DIR: mkdtempSync(join(tmpdir(), "backup-")) };
});

vi.mock("../../backend/config.js", () => ({ BRAIN_DIR: TEST_DIR, OWNER_NAME: "TestOwner" }));
vi.mock("../../backend/logger.js", () => ({
  createLogger: () => Object.assign((..._args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock("../../backend/providers/embedding-provider.js", () => ({ embedSingle: vi.fn().mockResolvedValue(null) }));

import { createBackup, restoreBackup } from "../../backend/memory/backup.js";
import { readGeneration, NODES_FILE, EDGES_FILE, GRAPH_DIR } from "../../backend/memory/graph-persistence.js";
import { RELOAD_MARKER_FILE } from "../../backend/memory/graph-inbox.js";

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(GRAPH_DIR, { recursive: true });
  writeFileSync(NODES_FILE, JSON.stringify({ n_1: { id: "n_1", type: "fact", content: "original", tags: [] } }));
  writeFileSync(EDGES_FILE, JSON.stringify([]));
});
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("restoreBackup", () => {
  it("restores files atomically, bumps the generation and requests a reload", () => {
    const meta = createBackup("manual");
    writeFileSync(NODES_FILE, JSON.stringify({ n_2: { id: "n_2", type: "fact", content: "changed", tags: [] } }));
    const genBefore = readGeneration();

    restoreBackup(String(meta.timestamp));

    expect(Object.keys(JSON.parse(readFileSync(NODES_FILE, "utf-8")))).toEqual(["n_1"]);
    expect(readGeneration()).toBe(genBefore + 1);
    expect(existsSync(RELOAD_MARKER_FILE)).toBe(true);
    expect(readdirSync(GRAPH_DIR).filter(f => f.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses to restore when a backup file is not valid JSON and leaves live files untouched", () => {
    const meta = createBackup("manual");
    writeFileSync(`${TEST_DIR}/backups/backup_${meta.timestamp}/edges.json`, "{ corrupt");
    const liveNodes = readFileSync(NODES_FILE, "utf-8");
    const liveEdges = readFileSync(EDGES_FILE, "utf-8");

    expect(() => restoreBackup(String(meta.timestamp))).toThrow(/Restore aborted/);

    expect(readFileSync(NODES_FILE, "utf-8")).toBe(liveNodes);
    expect(readFileSync(EDGES_FILE, "utf-8")).toBe(liveEdges);
    expect(readdirSync(GRAPH_DIR).filter(f => f.endsWith(".tmp"))).toEqual([]);
    expect(existsSync(RELOAD_MARKER_FILE)).toBe(false);
  });

  it("rejects unknown backups", () => {
    expect(() => restoreBackup("nope")).toThrow(/Invalid timestamp/);
    expect(() => restoreBackup("123")).toThrow(/Backup not found/);
  });
});
