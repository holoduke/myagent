import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign(
    (..._args: unknown[]) => {},
    { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  ),
}));

vi.mock("../backend/config.js", () => ({ BRAIN_DIR: "/tmp/unused-brain" }));

import {
  parseInbox,
  pendingEntries,
  serializeInbox,
  createOwnerInbox,
  REPLAY_MAX_AGE_MS,
  type InboxRecord,
} from "../backend/owner-inbox.js";

const received = (id: string, receivedAt: number, text = `msg ${id}`): InboxRecord =>
  ({ id, jid: "owner@s.whatsapp.net", text, receivedAt, status: "received" });
const done = (id: string, doneAt: number): InboxRecord => ({ id, status: "done", doneAt });

describe("parseInbox", () => {
  it("parses one record per line and skips blanks and corrupt lines", () => {
    const content = [
      JSON.stringify(received("a", 1)),
      "",
      "{ broken",
      JSON.stringify({ id: "x", status: "weird" }),
      JSON.stringify(done("a", 2)),
    ].join("\n");
    expect(parseInbox(content)).toEqual([received("a", 1), done("a", 2)]);
  });

  it("round-trips through serializeInbox", () => {
    const records = [received("a", 1), done("a", 2)];
    expect(parseInbox(serializeInbox(records))).toEqual(records);
    expect(serializeInbox([])).toBe("");
  });
});

describe("pendingEntries", () => {
  const now = 1_000_000;

  it("keeps received entries without a done record, in order", () => {
    const records = [received("a", now - 10), received("b", now - 5), done("a", now - 1)];
    expect(pendingEntries(records, now).map((r) => r.id)).toEqual(["b"]);
  });

  it("drops entries older than the replay window", () => {
    const records = [received("old", now - REPLAY_MAX_AGE_MS - 1), received("fresh", now - REPLAY_MAX_AGE_MS)];
    expect(pendingEntries(records, now).map((r) => r.id)).toEqual(["fresh"]);
  });

  it("dedupes by id, first occurrence wins", () => {
    const records = [received("a", now - 10, "first"), received("a", now - 5, "second")];
    const pending = pendingEntries(records, now);
    expect(pending).toHaveLength(1);
    expect(pending[0].text).toBe("first");
  });

  it("honours a done record that precedes the received one", () => {
    expect(pendingEntries([done("a", now), received("a", now)], now)).toEqual([]);
  });
});

describe("createOwnerInbox (file-backed)", () => {
  let dir: string;
  let path: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "inbox-")); path = join(dir, "sub", "owner-inbox.jsonl"); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("appends received and done records and reports pending", () => {
    const inbox = createOwnerInbox(path);
    const now = Date.now();
    inbox.recordReceived({ id: "m1", jid: "o@s.whatsapp.net", text: "hi", receivedAt: now });
    inbox.recordReceived({ id: "m2", jid: "o@s.whatsapp.net", text: "there", receivedAt: now });
    inbox.recordDone("m1");

    expect(readFileSync(path, "utf-8").trim().split("\n")).toHaveLength(3);
    expect(inbox.pending(now).map((e) => e.id)).toEqual(["m2"]);
  });

  it("compacts to only the pending entries", () => {
    const inbox = createOwnerInbox(path);
    const now = Date.now();
    inbox.recordReceived({ id: "m1", jid: "o", text: "a", receivedAt: now });
    inbox.recordDone("m1");
    inbox.recordReceived({ id: "m2", jid: "o", text: "b", receivedAt: now });
    inbox.recordReceived({ id: "old", jid: "o", text: "c", receivedAt: now - REPLAY_MAX_AGE_MS - 1 });

    const kept = inbox.compact(now);
    expect(kept.map((e) => e.id)).toEqual(["m2"]);
    expect(parseInbox(readFileSync(path, "utf-8"))).toEqual([
      { id: "m2", jid: "o", text: "b", receivedAt: now, status: "received" },
    ]);
  });

  it("returns nothing for a missing or corrupt file", () => {
    const inbox = createOwnerInbox(path);
    expect(inbox.pending()).toEqual([]);
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(path, "garbage\n");
    expect(inbox.pending()).toEqual([]);
  });
});
