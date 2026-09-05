/**
 * Raised by withTimeout when the timer fires before the wrapped promise
 * settles. Callers can distinguish "the work is still running somewhere"
 * (orphaned) from a genuine failure of the work itself.
 */
export class TimeoutError extends Error {
  readonly label: string;
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs / 1000}s`);
    this.name = "TimeoutError";
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Race a promise against a timeout. Rejects with a TimeoutError if the timer
 * fires first. The label is included in the error message for diagnostics.
 *
 * Note: rejecting does NOT stop the underlying work — a promise cannot be
 * cancelled from the outside. When a `controller` is supplied it is aborted on
 * timeout so cooperative work (anything that reads `controller.signal`) can
 * stop or at least know its result arrived late.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  controller?: AbortController,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new TimeoutError(label, ms);
      if (controller && !controller.signal.aborted) controller.abort(err);
      reject(err);
    }, ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
