type Task = () => Promise<unknown>;

interface QueueEntry {
  task: Task;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

export class MessageQueue {
  private queue: QueueEntry[] = [];
  private processing = false;
  private readonly maxSize: number;

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

  add<T = void>(task: () => Promise<T>): Promise<T> {
    if (this.queue.length >= this.maxSize) {
      return Promise.reject(new Error(`Queue full (max ${this.maxSize}). Try again later.`));
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        task: task as Task,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      if (!this.processing) {
        this.process();
      }
    });
  }

  private async process(): Promise<void> {
    this.processing = true;
    while (this.queue.length > 0) {
      const { task, resolve, reject } = this.queue.shift()!;
      try {
        const result = await task();
        resolve(result);
      } catch (err) {
        console.error("[queue] Task failed:", err);
        reject(err);
      }
    }
    this.processing = false;
  }
}
