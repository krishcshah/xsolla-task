/**
 * In-process FIFO worker queue with a hard concurrency bound (semaphore).
 * At most `concurrency` jobs run at once; further submissions queue and wait
 * their turn. process() never rejects.
 */
export class JobQueue {
  private readonly pending: Array<() => Promise<void>> = [];
  private active = 0;

  constructor(private readonly concurrency: number) {}

  enqueue(task: () => Promise<void>): void {
    this.pending.push(task);
    this.kick();
  }

  private kick(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift()!;
      this.active++;
      void (async () => {
        try {
          await task();
        } finally {
          this.active--;
          this.kick();
        }
      })();
    }
  }

  get activeJobs(): number {
    return this.active;
  }

  get queuedJobs(): number {
    return this.pending.length;
  }
}
