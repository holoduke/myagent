type Task = () => Promise<void>;

interface QueueEntry {
  task: Task;
  resolve: () => void;
  reject: (err: unknown) => void;
}

export class MessageQueue {
  private queue: QueueEntry[] = [];
  private processing = false;

  get idle(): boolean {
    return !this.processing && this.queue.length === 0;
  }

  add<T = void>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        task: task as Task,
        resolve: resolve as () => void,
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
        await task();
        resolve();
      } catch (err) {
        console.error("[queue] Task failed:", err);
        reject(err);
      }
    }
    this.processing = false;
  }
}
