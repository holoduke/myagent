import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign(
    (..._args: unknown[]) => {},
    { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  ),
}));
vi.mock("../backend/config.js", () => ({ BRAIN_DIR: "/tmp/unused-brain" }));

import { MessageQueue } from "../backend/queue.js";
import { createOwnerInbox } from "../backend/owner-inbox.js";
import { createOwnerIngest, syntheticMessage } from "../backend/owner-ingest.js";

const flush = () => new Promise((r) => setTimeout(r, 5));
const msg = (id: string) => ({ key: { remoteJid: "owner@s.whatsapp.net", fromMe: false, id } });

describe("createOwnerIngest", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ingest-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("journals before handling and marks done after a delivered reply", async () => {
    const inbox = createOwnerInbox(join(dir, "inbox.jsonl"));
    const seen: string[] = [];
    const handler = vi.fn(async (_jid: string, text: string) => {
      seen.push(text);
      expect(inbox.pending().map((e) => e.text)).toContain(text); // journaled before handler ran
      return true;
    });
    const ingest = createOwnerIngest(new MessageQueue(), inbox, handler);

    expect(ingest.enqueue("owner@s.whatsapp.net", "hello", msg("m1"))).toBe(true);
    await flush();
    expect(seen).toEqual(["hello"]);
    expect(inbox.pending()).toEqual([]);
  });

  it("leaves the entry pending when the reply was not confirmed", async () => {
    const inbox = createOwnerInbox(join(dir, "inbox.jsonl"));
    const ingest = createOwnerIngest(new MessageQueue(), inbox, async () => false);
    ingest.enqueue("owner@s.whatsapp.net", "unconfirmed", msg("m2"));
    await flush();
    expect(inbox.pending().map((e) => e.id)).toEqual(["m2"]);
  });

  it("does not throw when the queue is full; the message stays pending for replay", async () => {
    const inbox = createOwnerInbox(join(dir, "inbox.jsonl"));
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const queue = new MessageQueue(1);
    const ingest = createOwnerIngest(queue, inbox, async () => { await gate; return true; });

    expect(ingest.enqueue("o", "in-flight", msg("a"))).toBe(true);
    expect(ingest.enqueue("o", "queued", msg("b"))).toBe(true);
    expect(ingest.enqueue("o", "dropped", msg("c"))).toBe(false);
    expect(inbox.pending().map((e) => e.id)).toEqual(["a", "b", "c"]);

    release();
    await flush();
    expect(inbox.pending().map((e) => e.id)).toEqual(["c"]);
  });

  it("replays pending entries once with synthetic messages", async () => {
    const inbox = createOwnerInbox(join(dir, "inbox.jsonl"));
    inbox.recordReceived({ id: "r1", jid: "o", text: "lost during deploy", receivedAt: Date.now() });
    inbox.recordReceived({ id: "r1", jid: "o", text: "duplicate delivery", receivedAt: Date.now() });
    const handler = vi.fn(async () => true);
    const ingest = createOwnerIngest(new MessageQueue(), inbox, handler);

    expect(ingest.replay()).toBe(1);
    await flush();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1]).toBe("lost during deploy");
    expect(handler.mock.calls[0][2]).toEqual(syntheticMessage({ id: "r1", jid: "o", text: "lost during deploy", receivedAt: expect.any(Number), status: "received" }));
    expect(inbox.pending()).toEqual([]);
    expect(ingest.replay()).toBe(0);
  });
});
