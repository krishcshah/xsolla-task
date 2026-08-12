import express, { type NextFunction, type Request, type Response } from "express";
import type { ServiceConfig } from "./config.js";
import { SERVICE_VERSION } from "./constants.js";
import { ApiError, type ErrorCode } from "./errors.js";
import { JobQueue } from "./jobs/queue.js";
import { JobStore } from "./jobs/store.js";
import { makeAuthMiddleware } from "./middleware/auth.js";
import { makeRateLimiter } from "./middleware/rateLimit.js";
import { LlmProvider } from "./providers/llm.js";
import { MockProvider } from "./providers/mock.js";
import type { ReviewProvider } from "./providers/provider.js";
import { makeReviewsRouter } from "./routes/reviews.js";

export interface AppContext {
  app: express.Express;
  store: JobStore;
  queue: JobQueue;
  providers: Record<string, ReviewProvider>;
  startedAt: number;
}

export function createApp(config: ServiceConfig): AppContext {
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);
  app.set("strict routing", true); // treat /v1/reviews and /v1/reviews/ the same

  const store = new JobStore();
  const queue = new JobQueue(config.maxConcurrentJobs);
  const providers: Record<string, ReviewProvider> = {
    mock: new MockProvider(config.mockChunkDelayMs),
    llm: new LlmProvider(config)
  };
  const startedAt = Date.now();

  // Capture the raw body for byte-identical idempotency hashing, and map any
  // body-parser failure (too large / malformed JSON) to the error envelope.
  app.use(
    express.json({
      limit: config.maxPayloadBytes,
      inflate: true,
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      }
    })
  );

  // Public endpoints.
  app.get("/health", (_req, res) => {
    res.status(200).json({
      status: "ok",
      version: SERVICE_VERSION,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000)
    });
  });

  app.get("/spec", (_req, res) => {
    res.status(200).json({
      specVersion: "1.0",
      providers: ["mock", "llm"],
      limits: {
        maxPayloadBytes: config.maxPayloadBytes,
        chunkBytes: config.chunkBytes,
        maxConcurrentJobs: config.maxConcurrentJobs,
        rateLimitPerMinute: config.rateLimitPerMinute
      }
    });
  });

  // Everything under /v1 requires auth (every method), before any other
  // handling — so even unknown /v1 routes yield 401, not 404.
  app.use("/v1", makeAuthMiddleware(config.apiToken));

  // Rate limiting applies to POST /v1/reviews only (never GETs), after auth.
  app.post("/v1/reviews", makeRateLimiter(config.rateLimitPerMinute, config.rateLimitHardCap));

  app.use("/v1/reviews", makeReviewsRouter({ store, queue, providers, config }));

  // 404 for everything else (only non-/v1 paths reach here; /v1 misses were
  // already rejected by auth).
  app.use((_req, _res, next) => {
    next(ApiError.notFound("route not found"));
  });

  // Single error mapper: every non-2xx response uses the error envelope.
  // Body-parser failures are rewritten to the contract's codes.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    void _next;
    const mapped = mapError(err);
    for (const [k, v] of Object.entries(mapped.headers)) {
      res.setHeader(k, v);
    }
    res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message } });
  });

  return { app, store, queue, providers, startedAt };
}

interface RawHttpError {
  status?: number;
  statusCode?: number;
  type?: string;
  message?: string;
}

function mapError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const raw = (err ?? {}) as RawHttpError;
  const status = raw.status ?? raw.statusCode;

  if (status === 413 || raw.type === "entity.too.large") {
    return ApiError.payloadTooLarge(1_048_576);
  }
  if (status === 400) {
    if (
      raw.type === "entity.parse.failed" ||
      raw.type === "entity.verify.failed" ||
      /JSON/i.test(String(raw.message ?? ""))
    ) {
      return ApiError.invalidJson("Request body is not valid JSON");
    }
    return new ApiError(400, "invalid_json", typeof raw.message === "string" ? raw.message : "Bad request");
  }
  if (typeof status === "number" && status >= 400 && status < 600) {
    const code: ErrorCode = status === 404 ? "not_found" : status === 401 ? "unauthorized" : "internal";
    return new ApiError(status, code, typeof raw.message === "string" && raw.message ? raw.message : "Request failed");
  }
  return ApiError.internal();
}
