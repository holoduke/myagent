import { describe, it, expect, vi } from "vitest";

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign(
    (..._args: unknown[]) => {},
    { info: () => {}, warn: () => {}, error: () => {} },
  ),
}));

import { MessageQueue } from "../backend/queue.js";

describe("MessageQueue", () => {
  it("starts idle with size 0", () => {
    const q = new MessageQueue();
    expect(q.idle).toBe(true);
    expect(q.size).toBe(0);
    expect(q.isProcessing).toBe(false);
  });

  it("processes a single task", async () => {
    const q = new MessageQueue();
    const result = await q.add(async () => 42);
    expect(result).toBe(42);
  });

  it("processes tasks in FIFO order", async () => {
    const q = new MessageQueue();
    const order: number[] = [];

    const p1 = q.add(async () => { order.push(1); return 1; });
    const p2 = q.add(async () => { order.push(2); return 2; });
    const p3 = q.add(async () => { order.push(3); return 3; });

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("reports correct size while tasks are queued", async () => {
    const q = new MessageQueue();
    let resolveFirst: () => void;
    const blockingPromise = new Promise<void>(r => { resolveFirst = r; });

    const p1 = q.add(async () => { await blockingPromise; });
    // While first task is running, add more
    const p2 = q.add(async () => "second");

    expect(q.size).toBeGreaterThanOrEqual(1);
    expect(q.isProcessing).toBe(true);

    resolveFirst!();
    await Promise.all([p1, p2]);

    expect(q.idle).toBe(true);
  });

  it("rejects when queue is full", async () => {
    const q = new MessageQueue(2);
    let resolveFirst: () => void;
    const blockingPromise = new Promise<void>(r => { resolveFirst = r; });

    q.add(async () => { await blockingPromise; }); // processing slot
    q.add(async () => {}); // queue slot 1
    q.add(async () => {}); // queue slot 2

    // Queue is at capacity (2 queued + 1 processing)
    await expect(q.add(async () => {})).rejects.toThrow("Queue full");

    resolveFirst!();
  });

  it("handles task errors without breaking the queue", async () => {
    const q = new MessageQueue();

    const p1 = q.add(async () => { throw new Error("boom"); });
    const p2 = q.add(async () => "success");

    await expect(p1).rejects.toThrow("boom");
    expect(await p2).toBe("success");
    expect(q.idle).toBe(true);
  });

  it("processes tasks sequentially", async () => {
    const q = new MessageQueue();
    let concurrent = 0;
    let maxConcurrent = 0;

    const makeTask = () => async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 10));
      concurrent--;
    };

    await Promise.all([
      q.add(makeTask()),
      q.add(makeTask()),
      q.add(makeTask()),
    ]);

    expect(maxConcurrent).toBe(1);
  });

  it("returns to idle after all tasks complete", async () => {
    const q = new MessageQueue();
    await q.add(async () => {});
    await q.add(async () => {});
    expect(q.idle).toBe(true);
    expect(q.size).toBe(0);
    expect(q.isProcessing).toBe(false);
  });
});

describe("MessageQueue.offer / drain", () => {
  it("offer reports 'full' instead of rejecting", () => {
    const q = new MessageQueue(1);
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    expect(q.offer(async () => { await gate; }).accepted).toBe(true);
    expect(q.offer(async () => {}).accepted).toBe(true);
    expect(q.offer(async () => {})).toEqual({ accepted: false, reason: "full" });
    release();
  });

  it("drain waits for the in-flight task and rejects queued ones", async () => {
    const q = new MessageQueue();
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    const inFlight = q.add(async () => { await gate; return "done"; });
    const queued = q.add(async () => "never");

    const drainPromise = q.drain(1_000);
    await expect(queued).rejects.toThrow("draining");
    expect(q.offer(async () => {})).toEqual({ accepted: false, reason: "closed" });

    release();
    expect(await drainPromise).toBe(true);
    expect(await inFlight).toBe("done");
  });

  it("drain returns false when the in-flight task outlives the deadline", async () => {
    const q = new MessageQueue();
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    q.add(async () => { await gate; }).catch(() => {});
    expect(await q.drain(20)).toBe(false);
    release();
  });

  it("drain on an idle queue resolves immediately", async () => {
    const q = new MessageQueue();
    expect(await q.drain(10)).toBe(true);
    expect(q.isClosed).toBe(true);
  });
});
