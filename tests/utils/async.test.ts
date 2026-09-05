import { describe, it, expect, vi } from "vitest";
import { withTimeout, TimeoutError } from "../../backend/utils/async.js";

describe("withTimeout", () => {
  it("resolves with the promise value when it settles in time", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, "fast")).resolves.toBe(42);
  });

  it("propagates the promise's own rejection", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 1000, "failing")).rejects.toThrow("boom");
  });

  it("rejects with a TimeoutError carrying the label when the timer fires first", async () => {
    vi.useFakeTimers();
    const never = new Promise<void>(() => {});
    const racing = withTimeout(never, 5_000, "thinkTick");
    const assertion = expect(racing).rejects.toMatchObject({ name: "TimeoutError", label: "thinkTick", timeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    vi.useRealTimers();
  });

  it("aborts the supplied controller on timeout, not on success", async () => {
    vi.useFakeTimers();
    const okController = new AbortController();
    await withTimeout(Promise.resolve("ok"), 1000, "ok", okController);
    expect(okController.signal.aborted).toBe(false);

    const controller = new AbortController();
    const never = new Promise<void>(() => {});
    const racing = withTimeout(never, 100, "slow", controller).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(100);
    const err = await racing;
    expect(err).toBeInstanceOf(TimeoutError);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe(err);
    vi.useRealTimers();
  });
});
