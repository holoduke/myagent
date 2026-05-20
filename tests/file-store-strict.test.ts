import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { strictReadJSON, atomicWriteJSONAsync } from "../backend/utils/file-store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fs-strict-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("strictReadJSON", () => {
  it("returns null when file does not exist", () => {
    expect(strictReadJSON<unknown>(join(dir, "absent.json"))).toBeNull();
  });

  it("parses well-formed JSON", () => {
    const path = join(dir, "ok.json");
    writeFileSync(path, JSON.stringify({ a: 1 }));
    expect(strictReadJSON<{ a: number }>(path)).toEqual({ a: 1 });
  });

  it("THROWS on corrupted JSON instead of silently returning a default", () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, "{ this is not json");
    expect(() => strictReadJSON<unknown>(path)).toThrow(/Failed to parse JSON/);
  });

  it("throw includes the file path for debuggability", () => {
    const path = join(dir, "bad2.json");
    writeFileSync(path, "garbage");
    expect(() => strictReadJSON<unknown>(path)).toThrow(path);
  });
});

describe("atomicWriteJSONAsync", () => {
  it("serializes concurrent writes to the same path", async () => {
    const path = join(dir, "concurrent.json");
    // Fire 50 writes interleaved — final state must equal one of them, not garbage.
    const writes = Array.from({ length: 50 }, (_, i) =>
      atomicWriteJSONAsync(path, { i }),
    );
    await Promise.all(writes);
    const final = strictReadJSON<{ i: number }>(path);
    expect(final).not.toBeNull();
    expect(typeof final!.i).toBe("number");
    expect(final!.i).toBeGreaterThanOrEqual(0);
    expect(final!.i).toBeLessThan(50);
  });

  it("does not throw on subsequent writes if a prior write fails", async () => {
    // Path is a directory — first write fails with EISDIR
    await expect(atomicWriteJSONAsync(dir, { a: 1 })).rejects.toThrow();
    // But the chain machinery should let a later, valid write succeed
    const goodPath = join(dir, "good.json");
    await atomicWriteJSONAsync(goodPath, { a: 2 });
    expect(strictReadJSON(goodPath)).toEqual({ a: 2 });
  });
});
