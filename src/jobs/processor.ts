import type { ServiceConfig } from "../config.js";
import { chunkDiff } from "../diff/chunk.js";
import type { JobStore } from "./store.js";
import { orderAndDedup } from "../providers/order.js";
import type { ChunkScanInput, ReviewProvider } from "../providers/provider.js";
import type { Finding, Job } from "../types.js";

/**
 * Process one job through the pipeline:
 * queued -> running, chunk the diff, scan each chunk via the provider in
 * order, dedupe + globally order the merged findings, truncate to maxFindings
 * (usage still reflects the full scan), fan out finding events, then a
 * terminal done/failed event. This function never throws: any provider/pipeline
 * error becomes a `failed` job, never an unhandled rejection or a crash.
 */
export async function processJob(
  job: Job,
  store: JobStore,
  providers: Record<string, ReviewProvider>,
  config: ServiceConfig
): Promise<void> {
  const started = Date.now();
  const finish = (fn: () => void) => {
    try {
      fn();
    } finally {
      // mark settled so the route can snapshot safely
      (job as unknown as { resolveSettled?: () => void }).resolveSettled?.();
      console.log(`[job ${job.id}] ${job.status} in ${Date.now() - started}ms (provider=${job.options.provider})`);
    }
  };

  try {
    job.status = "running";
    store.recordEvent(job, "status", { status: "running" });

    const provider = providers[job.options.provider];
    if (!provider) {
      throw new Error(`provider "${job.options.provider}" is not available`);
    }

    const chunks = chunkDiff(job.diff, config.chunkBytes);
    job.usage.chunks = chunks.length;

    const seen = new Map<string, Finding>();
    const emitted = new Set<string>(); // finding ids beyond maxFindings still stream
    let fullCount = 0;
    let truncated = false;
    const maxFindings = job.options.maxFindings;

    for (let i = 0; i < chunks.length; i++) {
      const input: ChunkScanInput = {
        jobId: job.id,
        chunk: chunks[i],
        chunkIndex: i,
        totalChunks: chunks.length,
        options: job.options
      };
      const result = await withOverallTimeout(provider.scanChunk(input), config.jobOverallTimeoutMs, started);

      for (const f of orderAndDedup(result.findings)) {
        if (seen.has(f.id)) {
          fullCount++; // duplicate across chunks: still counts toward full scan
          continue;
        }
        seen.set(f.id, f);
        fullCount++;
        job.findings.push(f); // kept in global order: chunks are in file order
        if (!truncated) {
          if (emitted.size < maxFindings) {
            emitted.add(f.id);
            store.recordEvent(job, "finding", f);
          } else {
            truncated = true;
          }
        }
      }
    }

    job.usage.totalFindings = fullCount;
    // usage reflects the full scan; the persisted list is truncated to maxFindings
    const truncatedFindings = job.findings.slice(0, maxFindings);
    job.findings.length = 0;
    job.findings.push(...truncatedFindings);

    job.status = "done";
    store.recordEvent(job, "status", { status: "done" });
    finish(() => {
      // terminal event emitted last, then subscribers close their streams
      store.recordEvent(job, "done", {
        total: job.findings.length,
        usage: publicUsage(job)
      });
    });
  } catch (err) {
    job.status = "failed";
    job.error = err instanceof Error ? err.message : String(err);
    store.recordEvent(job, "status", { status: "failed" });
    finish(() => {
      store.recordEvent(job, "done", {
        status: "failed",
        error: job.error,
        total: job.findings.length,
        usage: publicUsage(job)
      });
    });
  }
}

function publicUsage(job: Job): { inputBytes: number; chunks: number; cacheHit: boolean } {
  return { inputBytes: job.usage.inputBytes, chunks: job.usage.chunks, cacheHit: false };
}

/**
 * Enforce the per-job wall-clock budget: if the provider is still working when
 * the budget is exhausted, the job fails gracefully instead of hanging.
 */
function withOverallTimeout<T>(p: Promise<T>, budgetMs: number, started: number): Promise<T> {
  const remaining = budgetMs - (Date.now() - started);
  if (remaining <= 0) {
    return Promise.reject(new Error(`job exceeded its ${budgetMs}ms time budget`));
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`job exceeded its ${budgetMs}ms time budget`)), remaining);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
