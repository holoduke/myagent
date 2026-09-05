import { describe, it, expect, vi, afterAll } from "vitest";
import { readFileSync, writeFileSync, rmSync } from "fs";

const { TEST_DIR } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return { TEST_DIR: mkdtempSync(join(tmpdir(), "embeddings-")) };
});

vi.mock("../../backend/config.js", () => ({ BRAIN_DIR: TEST_DIR }));
vi.mock("../../backend/logger.js", () => ({
  createLogger: () => Object.assign((..._args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock("../../backend/providers/embedding-provider.js", () => ({
  embedSingle: vi.fn().mockImplementation(async (text: string) => [text.length, 1, 0]),
}));

import { embedNode, removeEmbedding, flushEmbeddings, getEmbeddingCount } from "../../backend/memory/embeddings.js";

const FILE = `${TEST_DIR}/graph/embeddings.json`;
const read = (): Record<string, number[]> => JSON.parse(readFileSync(FILE, "utf-8"));

afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("merge-on-save", () => {
  it("keeps entries another process wrote, applies our removals, and flushes on demand", async () => {
    await embedNode("a", "aaa");
    flushEmbeddings();
    expect(Object.keys(read())).toEqual(["a"]);

    // Another process adds "b" behind our back
    writeFileSync(FILE, JSON.stringify({ ...read(), b: [9, 9, 9] }));

    await embedNode("c", "cc");
    removeEmbedding("a");
    flushEmbeddings();

    const onDisk = read();
    expect(Object.keys(onDisk).sort()).toEqual(["b", "c"]);
    expect(onDisk.b).toEqual([9, 9, 9]);
    expect(onDisk.c).toEqual([2, 1, 0]);
    expect(getEmbeddingCount()).toBe(1); // only "c" in our cache
  });

  it("flushEmbeddings never throws", () => {
    expect(() => flushEmbeddings()).not.toThrow();
  });
});
