import { SERVICE_VERSION } from "./constants.js";

export interface ServiceConfig {
  /** Bearer token required on all /v1/* routes. */
  apiToken: string;
  /** Google Gemini API key for the "llm" provider. May be empty (llm jobs then fail gracefully). */
  geminiApiKey: string;
  /** Gemini model id. */
  geminiModel: string;
  /** HTTP port. */
  port: number;
  /** Max JSON body for POST /v1/reviews (bytes). 413 above this. */
  maxPayloadBytes: number;
  /** Chunk size for large diffs (bytes). */
  chunkBytes: number;
  /** Max concurrently processing jobs. */
  maxConcurrentJobs: number;
  /** Sustained POST /v1/reviews budget per 60s window (per client key). */
  rateLimitPerMinute: number;
  /** Hard total cap on POST submissions in any 60s window (DDoS guardrail). */
  rateLimitHardCap: number;
  /** Network timeout for a single Gemini HTTP call (ms). */
  llmTimeoutMs: number;
  /** Gemini attempts per chunk (first try + retries). */
  llmMaxAttempts: number;
  /** Per-job wall clock budget; jobs exceeding it fail gracefully. */
  jobOverallTimeoutMs: number;
  /** Artificial delay per chunk for the mock provider (ms); keeps mock fast by default. */
  mockChunkDelayMs: number;
  /** Artificial delay per chunk for the llm provider beyond real latency (ms). */
  llmChunkDelayMs: number;
}

function intFrom(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  return {
    apiToken: env.API_BEARER_TOKEN ?? "",
    geminiApiKey: env.GEMINI_API_KEY ?? "",
    geminiModel: env.GEMINI_MODEL ?? "gemini-3.6-flash",
    port: intFrom(env, "PORT", 8080) || 8080,
    maxPayloadBytes: 1_048_576,
    chunkBytes: 65_536,
    maxConcurrentJobs: 4,
    rateLimitPerMinute: 30,
    rateLimitHardCap: intFrom(env, "RATE_LIMIT_HARD_CAP", 120),
    llmTimeoutMs: intFrom(env, "LLM_TIMEOUT_MS", 20_000),
    llmMaxAttempts: intFrom(env, "LLM_MAX_ATTEMPTS", 2) || 2,
    jobOverallTimeoutMs: intFrom(env, "JOB_TIMEOUT_MS", 120_000),
    mockChunkDelayMs: intFrom(env, "MOCK_CHUNK_DELAY_MS", 0),
    llmChunkDelayMs: intFrom(env, "LLM_CHUNK_DELAY_MS", 0)
  };
}

export { SERVICE_VERSION };
