import { createLogger } from "./logger.js";

const log = createLogger("queue");

type Task = () => Promise<unknown>;

interface QueueEntry {
  task: Task;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

export class QueueFullError extends Error {
  constructor(maxSize: number) {
    super(`Queue full (max ${maxSize}). Try again later.`);
    this.name = "QueueFullError";
  }
}

export type OfferResult<T> =
  | { accepted: true; result: Promise<T> }
  | { accepted: false; reason: "full" | "closed" };

export class MessageQueue {
  private queue: QueueEntry[] = [];
  private processing = false;
  private closed = false;
  private readonly maxSize: number;
  private current: Promise<unknown> | null = null;

  constructor(maxSize = 50) {
    this.maxSize = maxSize;
  }

  get idle(): boolean {
    return !this.processing && this.queue.length === 0;
  }

  get size(): number {
    return this.queue.length;
  }

  get isProcessing(): boolean {
    return this.processing;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  add<T = void>(task: () => Promise<T>): Promise<T> {
    const offered = this.offer(task);
    if (offered.accepted) return offered.result;
    return Promise.reject(
      offered.reason === "full" ? new QueueFullError(this.maxSize) : new Error("Queue closed"),
    );
  }

  /**
   * Non-throwing enqueue: tells the caller whether the task was accepted so
   * an ingest loop can log a drop and carry on with the next message.
   */
  offer<T = void>(task: () => Promise<T>): OfferResult<T> {
    if (this.closed) return { accepted: false, reason: "closed" };
    if (this.queue.length >= this.maxSize) return { accepted: false, reason: "full" };
    const result = new Promise<T>((resolve, reject) => {
      this.queue.push({
        task: task as Task,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      if (!this.processing) {
        this.process();
      }
    });
    return { accepted: true, result };
  }

  /**
   * Stop accepting new tasks and wait (up to `deadlineMs`) for the task in
   * flight to finish. Queued-but-unstarted tasks are rejected so their
   * durable records stay "not done" and get replayed by the next instance.
   * Returns true when the queue fully drained inside the deadline.
   */
  async drain(deadlineMs: number): Promise<boolean> {
    this.closed = true;
    const pending = this.queue;
    this.queue = [];
    for (const entry of pending) entry.reject(new Error("Queue draining for shutdown"));
    if (pending.length > 0) log.warn(`Drain: ${pending.length} queued task(s) rejected before start`);

    if (!this.current) return true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), deadlineMs);
    });
    const finished = this.current.then(() => true, () => true);
    const drained = await Promise.race([finished, timeout]);
    if (timer) clearTimeout(timer);
    if (!drained) log.warn(`Drain: in-flight task did not finish within ${deadlineMs}ms`);
    return drained;
  }

  private async process(): Promise<void> {
    this.processing = true;
    while (this.queue.length > 0) {
      const { task, resolve, reject } = this.queue.shift()!;
      try {
        this.current = task();
        const result = await this.current;
        resolve(result);
      } catch (err) {
        log.error(`Task failed: ${err}`);
        reject(err);
      } finally {
        this.current = null;
      }
    }
    this.processing = false;
  }
}
