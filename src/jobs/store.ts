import { createHash, randomUUID } from "node:crypto";
import type { Job, NormalizedOptions, StoredEvent, CacheOptions } from "../types.js";

/**
 * In-memory job store. Holds job records (including the full ordered SSE event
 * log for replay) and the two intake indexes: Idempotency-Key -> jobId and
 * content-hash({diff, options}) -> jobId. Everything lives for the lifetime of
 * the process; restarts lose state, which the spec explicitly tolerates.
 */
export class JobStore {
  readonly jobs = new Map<string, Job>();
  readonly idempotency = new Map<string, { bodyHash: string; jobId: string }>();
  readonly cache = new Map<string, string>();

  static bodyHash(rawBody: Buffer): string {
    return createHash("sha256").update(rawBody).digest("hex");
  }

  static cacheKey(diff: string, options: CacheOptions): string {
    const h = createHash("sha256");
    h.update(diff, "utf8");
    h.update("\u0000");
    h.update(JSON.stringify(options), "utf8");
    return h.digest("hex");
  }

  create(diff: string, options: NormalizedOptions, cacheKey: string): Job {
    const id = randomUUID();
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const now = Date.now();
    const job: Job = {
      id,
      status: "queued",
      diff,
      options,
      cacheKey,
      findings: [],
      usage: { inputBytes: Buffer.byteLength(diff, "utf8"), chunks: 0, totalFindings: 0 },
      createdAt: now,
      updatedAt: now,
      events: [],
      listeners: new Set(),
      settled
    };
    (job as { resolveSettled?: () => void }).resolveSettled = resolveSettled;
    this.jobs.set(id, job);
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Append-and-fanout an event: the single writer of the per-job event log. */
  recordEvent(job: Job, event: string, data: unknown): void {
    const stored: StoredEvent = {
      seq: job.events.length + 1,
      event,
      data: JSON.stringify(data)
    };
    job.events.push(stored);
    for (const listener of job.listeners) {
      try {
        listener(stored);
      } catch {
        // a broken listener must never affect the job
      }
    }
    job.updatedAt = Date.now();
  }

  subscribe(job: Job, listener: (evt: StoredEvent) => void): () => void {
    job.listeners.add(listener);
    return () => {
      job.listeners.delete(listener);
    };
  }
}
