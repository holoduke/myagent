import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MergedStore } from "../../backend/utils/merged-store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "merged-store-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Simulate another instance writing the file with a distinct mtime. */
function externalWrite(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value));
  const future = new Date(Date.now() + 5_000);
  utimesSync(path, future, future);
}

describe("MergedStore", () => {
  it("returns the default when the file is missing and persists updates", () => {
    const store = new MergedStore<string[]>({ filePath: join(dir, "a.json"), defaultValue: () => [] });
    expect(store.get()).toEqual([]);
    store.update(list => [...list, "x"]);
    expect(JSON.parse(readFileSync(join(dir, "a.json"), "utf-8"))).toEqual(["x"]);
    expect(store.get()).toEqual(["x"]);
  });

  it("applies an update on top of changes another instance wrote", () => {
    const path = join(dir, "b.json");
    const store = new MergedStore<Record<string, number>>({ filePath: path, defaultValue: () => ({}) });
    store.update(() => ({ a: 1 }));

    externalWrite(path, { a: 1, b: 2 }); // other instance added b

    store.update(current => ({ ...current, c: 3 }));
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("get() re-reads when the file changed on disk", () => {
    const path = join(dir, "c.json");
    const store = new MergedStore<{ v: number }>({ filePath: path, defaultValue: () => ({ v: 0 }) });
    store.update(() => ({ v: 1 }));
    externalWrite(path, { v: 42 });
    expect(store.changedOnDisk()).toBe(true);
    expect(store.get()).toEqual({ v: 42 });
    expect(store.changedOnDisk()).toBe(false);
  });

  it("saveMerged merges only when the file changed underneath", () => {
    const path = join(dir, "d.json");
    const store = new MergedStore<Record<string, number>>({ filePath: path, defaultValue: () => ({}) });
    const merge = (disk: Record<string, number>, mem: Record<string, number>) => ({ ...disk, ...mem });

    store.saveMerged({ a: 1 }, merge);
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ a: 1 });

    externalWrite(path, { a: 1, other: 9 });
    store.saveMerged({ a: 2 }, merge);
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ a: 2, other: 9 });
  });

  it("peek() does not touch the disk and invalidate() forces a reload", () => {
    const path = join(dir, "e.json");
    const store = new MergedStore<number[]>({ filePath: path, defaultValue: () => [] });
    expect(store.peek()).toBeNull();
    store.get();
    expect(store.peek()).toEqual([]);
    externalWrite(path, [7]);
    store.invalidate();
    expect(store.peek()).toBeNull();
    expect(store.get()).toEqual([7]);
  });
});
