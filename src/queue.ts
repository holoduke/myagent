type Task = () => Promise<void>;

export class MessageQueue {
  private queue: Task[] = [];
  private processing = false;

  async add(task: Task): Promise<void> {
    this.queue.push(task);
    if (!this.processing) {
      await this.process();
    }
  }

  private async process(): Promise<void> {
    this.processing = true;
    while (this.queue.length > 0) {
      const task = this.queue.shift()!;
      try {
        await task();
      } catch (err) {
        console.error("[queue] Task failed:", err);
      }
    }
    this.processing = false;
  }
}
