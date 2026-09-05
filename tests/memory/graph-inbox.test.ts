import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { existsSync, readdirSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "fs";

const { TEST_DIR } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return { TEST_DIR: mkdtempSync(join(tmpdir(), "graph-inbox-")) };
});

vi.mock("../../backend/config.js", () => ({ BRAIN_DIR: TEST_DIR, OWNER_NAME: "TestOwner" }));
vi.mock("../../backend/logger.js", () => ({
  createLogger: () => Object.assign((..._args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock("../../backend/providers/embedding-provider.js", () => ({ embedSingle: vi.fn().mockResolvedValue(null) }));

import { MemoryGraph } from "../../backend/memory/graph.js";
import {
  appendGraphOps,
  drainGraphInbox,
  requestGraphReload,
  consumeReloadRequest,
  GRAPH_INBOX_FILE,
  RELOAD_MARKER_FILE,
} from "../../backend/memory/graph-inbox.js";

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("appendGraphOps", () => {
  it("appends one JSON line per call and nothing for empty batches", () => {
    appendGraphOps([], "noop");
    expect(existsSync(GRAPH_INBOX_FILE)).toBe(false);
    appendGraphOps([{ op: "add_node", id: "n_1", type: "fact", content: "one", tags: [] }], "test");
    appendGraphOps([{ op: "add_node", id: "n_2", type: "fact", content: "two", tags: [] }], "test");
    const lines = readFileSync(GRAPH_INBOX_FILE, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0])).toMatchObject({ source: "test", ops: [{ id: "n_1" }] });
  });
});

describe("drainGraphInbox", () => {
  it("applies ops and goal ops, then removes the inbox", () => {
    const graph = new MemoryGraph();
    appendGraphOps([{ op: "add_node", id: "n_a", type: "meta", content: "from web", tags: ["x"] }], "web");
    appendGraphOps([], "web", [{ op: "create_goal", title: "Ship it", description: "d", priority: 1 }]);

    const result = drainGraphInbox(graph);
    expect(result).toMatchObject({ entries: 2, applied: 2, skipped: 0, malformed: 0 });
    expect(graph.getNode("n_a")?.content).toBe("from web");
    expect(graph.findByType("goal").length).toBe(1);
    expect(existsSync(GRAPH_INBOX_FILE)).toBe(false);
    expect(readdirSync(TEST_DIR).filter(f => f.includes("draining"))).toEqual([]);
  });

  it("skips malformed lines without losing the good ones", () => {
    writeFileSync(GRAPH_INBOX_FILE, 'garbage\n' + JSON.stringify({ ts: 1, source: "x", ops: [{ op: "add_node", id: "n_ok", type: "fact", content: "ok", tags: [] }] }) + "\n");
    const graph = new MemoryGraph();
    const result = drainGraphInbox(graph);
    expect(result.malformed).toBe(1);
    expect(result.applied).toBe(1);
    expect(graph.getNode("n_ok")).toBeDefined();
  });

  it("picks up a leftover .draining file from a crashed drain", () => {
    writeFileSync(`${GRAPH_INBOX_FILE}.1.99.abc.draining`, JSON.stringify({ ts: 1, source: "old", ops: [{ op: "add_node", id: "n_left", type: "fact", content: "leftover", tags: [] }] }) + "\n");
    const graph = new MemoryGraph();
    expect(drainGraphInbox(graph).applied).toBe(1);
    expect(graph.getNode("n_left")).toBeDefined();
    expect(readdirSync(TEST_DIR).filter(f => f.includes("draining"))).toEqual([]);
  });

  it("is a no-op when nothing is queued", () => {
    expect(drainGraphInbox(new MemoryGraph())).toEqual({ entries: 0, applied: 0, skipped: 0, malformed: 0 });
  });

  it("invalid ops in the inbox are counted as skipped, not thrown", () => {
    appendGraphOps([{ op: "add_node", id: "n_bad", type: "fact", content: "", tags: [] }], "web");
    const result = drainGraphInbox(new MemoryGraph());
    expect(result.skipped).toBe(1);
    expect(result.applied).toBe(0);
  });
});

describe("reload marker", () => {
  it("is consumed exactly once", () => {
    expect(consumeReloadRequest()).toBe(false);
    requestGraphReload("test");
    expect(existsSync(RELOAD_MARKER_FILE)).toBe(true);
    expect(consumeReloadRequest()).toBe(true);
    expect(consumeReloadRequest()).toBe(false);
  });
});
