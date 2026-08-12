import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../errors.js";

const WINDOW_MS = 60_000;

/**
 * Sliding-window rate limiter for POST /v1/reviews.
 * - Per client key (derived from the bearer token): sustained budget of
 *   `sustainedPerMinute` requests in any 60s window. A burst allowance of up
 *   to `sustainedPerMinute` extra requests is available so even a 60-request
 *   burst of cache-hit resubmissions succeeds without any 429.
 * - A separate global counter caps total submissions in the window at
 *   `hardCapPerMinute` as a guardrail against abuse.
 * Exceeding either yields 429 + Retry-After + error envelope. Never 5xx.
 */
export function makeRateLimiter(sustainedPerMinute: number, hardCapPerMinute: number) {
  const perClient = new Map<string, number[]>();
  const globalHits: number[] = [];

  // Bound memory: prune inactive client keys periodically.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, hits] of perClient) {
      const kept = prune(hits, now);
      if (kept.length === 0) perClient.delete(key);
      else perClient.set(key, kept);
    }
    prune(globalHits, now);
  }, WINDOW_MS);
  sweeper.unref?.();

  return function rateLimit(req: Request, _res: Response, next: NextFunction): void {
    try {
      const now = Date.now();
      const clientKey = clientKeyFrom(req);

      prune(globalHits, now);
      let hits = perClient.get(clientKey) ?? [];
      hits = prune(hits, now);
      perClient.set(clientKey, hits);

      const perClientLimit = sustainedPerMinute * 2; // sustained + burst allowance
      const hitsAfter = hits.length + 1;
      const globalAfter = globalHits.length + 1;

      if (hitsAfter > perClientLimit || globalAfter > hardCapPerMinute) {
        const oldestRelevant =
          globalAfter > hardCapPerMinute && globalHits.length > hits.length
            ? globalHits[0]
            : hits[0];
        const retryAfter = Math.max(1, Math.ceil((oldestRelevant + WINDOW_MS - now) / 1000));
        next(ApiError.rateLimited(retryAfter));
        return;
      }

      hits.push(now);
      globalHits.push(now);
      next();
    } catch (err) {
      next(err instanceof Error ? err : ApiError.internal());
    }
  };
}

function prune(hits: number[], now: number): number[] {
  const cutoff = now - WINDOW_MS;
  let i = 0;
  while (i < hits.length && hits[i] <= cutoff) i++;
  return i === 0 ? hits : hits.slice(i);
}

/** Derive the rate-limit client key from the bearer token (falls back to unknown). */
function clientKeyFrom(req: Request): string {
  const header = req.get("Authorization") ?? "";
  const m = /^Bearer (.+)$/.exec(header.trim());
  return m ? m[1] : "anonymous";
}
