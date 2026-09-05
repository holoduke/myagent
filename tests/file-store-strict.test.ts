import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { strictReadJSON, atomicWriteFile, atomicWriteJSON, appendRollingJsonl, readJsonl, uniqueTmpPath } from "../backend/utils/file-store.js";

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

describe("atomicWriteFile", () => {
  it("writes the content and leaves no temp file behind", () => {
    const path = join(dir, "nested", "out.txt");
    atomicWriteFile(path, "hello");
    expect(readFileSync(path, "utf-8")).toBe("hello");
    expect(readdirSync(join(dir, "nested"))).toEqual(["out.txt"]);
  });

  it("uses a pid + random temp name so concurrent processes never share one", () => {
    const a = uniqueTmpPath(join(dir, "x.json"));
    const b = uniqueTmpPath(join(dir, "x.json"));
    expect(a).not.toBe(b);
    expect(a).toMatch(new RegExp(`x\\.json\\.${process.pid}\\.[0-9a-f]{8}\\.tmp$`));
  });

  it("replaces existing content atomically (old content never mixed with new)", () => {
    const path = join(dir, "swap.json");
    atomicWriteJSON(path, { v: 1 });
    atomicWriteJSON(path, { v: 2, extra: "x".repeat(1000) });
    expect(strictReadJSON(path)).toEqual({ v: 2, extra: "x".repeat(1000) });
  });

  it("propagates write failures and cleans up its temp file", () => {
    expect(() => atomicWriteFile(dir, "nope")).toThrow();
    expect(readdirSync(dir).filter(f => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("appendRollingJsonl", () => {
  it("appends entries and trims to the newest maxEntries", () => {
    const path = join(dir, "log.jsonl");
    for (let i = 0; i < 7; i++) appendRollingJsonl(path, { i }, 3);
    const { entries, malformed } = readJsonl<{ i: number }>(path);
    expect(entries.map(e => e.i)).toEqual([4, 5, 6]);
    expect(malformed).toBe(0);
    expect(readFileSync(path, "utf-8").endsWith("\n")).toBe(true);
  });

  it("readJsonl skips malformed lines and counts them", () => {
    const path = join(dir, "mixed.jsonl");
    writeFileSync(path, '{"ok":1}\nnot json\n\n{"ok":2}\n');
    const { entries, malformed } = readJsonl<{ ok: number }>(path);
    expect(entries).toEqual([{ ok: 1 }, { ok: 2 }]);
    expect(malformed).toBe(1);
  });

  it("readJsonl returns empty for a missing file", () => {
    expect(readJsonl(join(dir, "absent.jsonl"))).toEqual({ entries: [], malformed: 0 });
    expect(existsSync(join(dir, "absent.jsonl"))).toBe(false);
  });
});
