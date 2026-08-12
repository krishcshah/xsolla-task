import { Router, type Request, type Response, type NextFunction } from "express";
import type { ServiceConfig } from "../config.js";
import { parseDiff } from "../diff/parse.js";
import { ApiError } from "../errors.js";
import type { JobQueue } from "../jobs/queue.js";
import { processJob } from "../jobs/processor.js";
import { JobStore } from "../jobs/store.js";
import type { ReviewProvider } from "../providers/provider.js";
import type { CacheOptions, Job, NormalizedOptions, StoredEvent } from "../types.js";

export interface ReviewsDeps {
  store: JobStore;
  queue: JobQueue;
  providers: Record<string, ReviewProvider>;
  config: ServiceConfig;
}

const DEFAULT_MAX_FINDINGS = 100;

export function makeReviewsRouter(deps: ReviewsDeps): Router {
  const router = Router();

  router.post("/", (req: Request, res: Response, next: NextFunction) => {
    try {
      handlePost(deps, req, res);
    } catch (err) {
      next(err);
    }
  });

  router.get("/:jobId", (req: Request, res: Response, next: NextFunction) => {
    try {
      const job = mustGet(deps.store, req.params.jobId);
      res.status(200).json(serializeJob(job));
    } catch (err) {
      next(err);
    }
  });

  router.get("/:jobId/stream", (req: Request, res: Response, next: NextFunction) => {
    try {
      const job = mustGet(deps.store, req.params.jobId);
      streamJob(deps.store, job, req, res);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function handlePost(deps: ReviewsDeps, req: Request, res: Response): void {
  const { store, queue, providers, config } = deps;

  // Express mounted this router with `strict routing` enabled, so the router
  // path "/" also matches the mounted "" — POST /v1/reviews works either way.

  const parsedBody = req.body as unknown;
  if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
    throw ApiError.invalidJson("Request body must be a JSON object");
  }
  const body = parsedBody as Record<string, unknown>;

  // Validate diff first (422 before option validation).
  if (typeof body.diff !== "string" || body.diff.length === 0) {
    throw ApiError.invalidDiff("diff is required and must be a non-empty unified diff string");
  }
  try {
    parseDiff(body.diff);
  } catch (err) {
    throw ApiError.invalidDiff(`diff is not a parseable unified diff: ${(err as Error).message}`);
  }

  // Normalize options (unknown fields ignored).
  const options = normalizeOptions(body.options);

  // Raw buffered body (captured by the content-sha256 verify during JSON parsing)
  // drives byte-identical idempotency hashing.
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(body), "utf8");
  const bodyHash = JobStore.bodyHash(rawBody);

  const cacheKey = JobStore.cacheKey(body.diff, cacheOptionsOf(body.options, options));
  const idempotencyKey = req.get("Idempotency-Key");

  // 1) Idempotency: same key + byte-identical body replays the same jobId;
  //    same key + different body is a 409.
  if (idempotencyKey !== undefined && idempotencyKey !== "") {
    const existing = store.idempotency.get(idempotencyKey);
    if (existing) {
      if (existing.bodyHash === bodyHash) {
        res.status(202).json({ jobId: existing.jobId, status: "queued" });
        return;
      }
      throw ApiError.idempotencyConflict();
    }
  }

  // 2) Cache: byte-identical {diff, options} returns the original job's
  //    findings without redoing any work (usage.cacheHit = true).
  const cachedJobId = store.cache.get(cacheKey);
  if (cachedJobId) {
    const original = store.get(cachedJobId);
    if (original && original.status === "done") {
      const replay = materializeCachedRun(store, original);
      if (idempotencyKey !== undefined && idempotencyKey !== "") {
        store.idempotency.set(idempotencyKey, { bodyHash, jobId: replay.id });
      }
      res.status(202).json({ jobId: replay.id, status: "queued" });
      return;
    }
    if (!original || original.status === "failed") {
      // Never pin a cache key to a dead run.
      store.cache.delete(cacheKey);
    }
    // If the original is still queued/running, this submission creates its own
    // job and takes over the key when it finishes scanning (below).
  }

  // 3) New work: create the job, index it, enqueue it, respond 202.
  const job = store.create(body.diff, options, cacheKey);
  store.recordEvent(job, "status", { status: "queued" });
  store.cache.set(cacheKey, job.id);
  if (idempotencyKey !== undefined && idempotencyKey !== "") {
    store.idempotency.set(idempotencyKey, { bodyHash, jobId: job.id });
  }

  queue.enqueue(async () => {
    await processJob(job, store, providers, config).catch((err) => {
      // processJob never throws; belt-and-suspenders so the queue can never die.
      console.error(`[job ${job.id}] unexpected processor error`, err);
    });
  });
  res.status(202).json({ jobId: job.id, status: "queued" });
}

/**
 * Cache-hit replay: build a fresh job whose event log mirrors an original run
 * byte-for-byte, except the terminal done event carries usage.cacheHit=true.
 */
function materializeCachedRun(store: JobStore, original: Job): Job {
  const replay = store.create(original.diff, { ...original.options }, original.cacheKey);
  for (const evt of original.events) {
    if (evt.event === "done") {
      const data = JSON.parse(evt.data) as { total: number; usage: { inputBytes: number; chunks: number; cacheHit: boolean } };
      data.usage = { ...data.usage, cacheHit: true };
      replay.usage = {
        inputBytes: data.usage.inputBytes,
        chunks: data.usage.chunks,
        totalFindings: original.usage.totalFindings
      };
      store.recordEvent(replay, "done", data);
      continue;
    }
    replay.events.push({ seq: replay.events.length + 1, event: evt.event, data: evt.data });
  }
  replay.status = "done";
  replay.findings = original.findings.map((f) => ({ ...f }));
  (replay as unknown as { resolveSettled?: () => void }).resolveSettled?.();
  return replay;
}

/** Best-effort immediate flush of the underlying socket for SSE. */
function socketFlush(req: Request): void {
  const sock = (req.socket ?? null) as (import("node:net").Socket & { flush?: () => void }) | null;
  if (sock && typeof sock.flush === "function") {
    try {
      sock.flush();
    } catch {
      // ignore
    }
  }
}

function mustGet(store: JobStore, jobId: string): Job {
  const job = store.get(jobId);
  if (!job) throw ApiError.notFound(`job ${jobId} not found`);
  return job;
}

/**
 * SSE: replay the job's full persisted event log, then (if the job is still
 * live) subscribe for subsequent events. The subscription is registered before
 * the replay is flushed so no event can be lost between replay and attach; a
 * seen-seq set suppresses any overlap so every event is delivered exactly once
 * and reconnecting to a finished job replays the sequence identically.
 */
function streamJob(store: JobStore, job: Job, req: Request, res: Response): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable proxy buffering (nginx/Railway)
  res.flushHeaders?.();
  const flush = () => socketFlush(req);
  res.write(`: job ${job.id} event stream\n\n`);
  flush();

  const seen = new Set<number>();
  let ended = false;

  const writeEvent = (evt: StoredEvent): boolean => {
    // returns true when this event is terminal for the stream
    res.write(`id: ${evt.seq}\n`);
    res.write(`event: ${evt.event}\n`);
    res.write(`data: ${evt.data}\n\n`);
    flush();
    return evt.event === "done";
  };

  const finish = () => {
    if (ended) return;
    ended = true;
    unsubscribe();
    res.end();
  };

  const unsubscribe = store.subscribe(job, (evt) => {
    if (ended || seen.has(evt.seq)) return;
    seen.add(evt.seq);
    let terminal = false;
    try {
      terminal = writeEvent(evt);
    } catch {
      // client went away mid-write; close quietly
      finish();
      return;
    }
    if (terminal) {
      // Deliver the terminal event, then close on the next tick so the
      // client observes a clean end of stream.
      setImmediate(finish);
    }
  });

  // Replay everything persisted so far (subscription is already active, and
  // every replayed seq is recorded so a concurrent live event is not sent twice).
  for (const evt of job.events) {
    if (seen.has(evt.seq)) continue;
    seen.add(evt.seq);
    const terminal = writeEvent(evt);
    if (terminal) {
      setImmediate(finish);
    }
  }

  req.on("close", () => {
    finish();
  });
}

function serializeJob(job: Job) {
  const usage = {
    inputBytes: job.usage.inputBytes,
    chunks: job.usage.chunks,
    cacheHit: cacheHitOf(job)
  };
  const out: Record<string, unknown> = {
    jobId: job.id,
    status: job.status,
    findings: job.findings,
    usage,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString()
  };
  if (job.status === "failed" && job.error) {
    out.error = job.error;
  }
  return out;
}

function cacheHitOf(job: Job): boolean {
  for (let i = job.events.length - 1; i >= 0; i--) {
    const evt = job.events[i];
    if (evt.event !== "done") continue;
    try {
      const data = JSON.parse(evt.data) as { usage?: { cacheHit?: boolean } };
      return data.usage?.cacheHit === true;
    } catch {
      return false;
    }
  }
  return false;
}

export function normalizeOptions(raw: unknown): NormalizedOptions {
  if (raw === undefined || raw === null) {
    return { provider: "mock", maxFindings: DEFAULT_MAX_FINDINGS };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw ApiError.invalidDiff("options must be an object when provided");
  }
  const opts = raw as Record<string, unknown>;

  let provider: NormalizedOptions["provider"] = "mock";
  if (opts.provider !== undefined) {
    if (opts.provider !== "mock" && opts.provider !== "llm") {
      throw ApiError.invalidDiff(`options.provider must be "mock" or "llm"`);
    }
    provider = opts.provider;
  }

  let maxFindings = DEFAULT_MAX_FINDINGS;
  if (opts.maxFindings !== undefined) {
    const n = opts.maxFindings;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
      throw ApiError.invalidDiff("options.maxFindings must be a non-negative integer");
    }
    maxFindings = n;
  }

  return { provider, maxFindings };
}

function cacheOptionsOf(raw: unknown, normalized: NormalizedOptions): CacheOptions {
  const provider =
    raw && typeof raw === "object" && !Array.isArray(raw) && (raw as Record<string, unknown>).provider !== undefined
      ? normalized.provider
      : null;
  return { provider, maxFindings: normalized.maxFindings };
}
