import { describe, it, expect, vi } from "vitest";
import { createSendChain } from "../backend/send-chain.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createSendChain", () => {
  it("sends strictly in order even when earlier sends are slower", async () => {
    const order: string[] = [];
    const send = vi.fn(async (text: string) => {
      await sleep(text === "first" ? 20 : 1);
      order.push(text);
    });
    const chain = createSendChain(send);
    void chain.enqueue("first");
    void chain.enqueue("second");
    void chain.enqueue("third");
    const result = await chain.settle();
    expect(order).toEqual(["first", "second", "third"]);
    expect(result).toEqual({ sent: 3, failed: [] });
  });

  it("retries a failed send once and succeeds", async () => {
    let calls = 0;
    const send = vi.fn(async () => { calls++; if (calls === 1) throw new Error("flaky"); });
    const onError = vi.fn();
    const chain = createSendChain(send, { onError });
    await chain.enqueue("x");
    expect(calls).toBe(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(await chain.settle()).toEqual({ sent: 1, failed: [] });
  });

  it("collects a chunk that fails twice instead of throwing", async () => {
    const send = vi.fn(async (text: string) => { if (text === "bad") throw new Error("down"); });
    const chain = createSendChain(send);
    await chain.enqueue("ok");
    await expect(chain.enqueue("bad")).resolves.toBeUndefined();
    await chain.enqueue("after");
    expect(send).toHaveBeenCalledTimes(4);
    expect(await chain.settle()).toEqual({ sent: 2, failed: ["bad"] });
  });
});
