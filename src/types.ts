export type Severity = "critical" | "high" | "medium" | "low";
export type Category = "security" | "correctness" | "performance" | "style";
export type ProviderName = "mock" | "llm";
export type JobStatus = "queued" | "running" | "done" | "failed";

/** Options as normalized at intake (what the server actually uses). */
export interface NormalizedOptions {
  provider: ProviderName;
  maxFindings: number;
}

/**
 * Options as used for cache identity: provider is null when the client omitted
 * it (server default applies). Requests that omit provider and requests that
 * pass provider:"mock" explicitly resolve identically but keep distinct cache
 * entries to keep "byte-identical {diff, options}" semantics exact.
 */
export interface CacheOptions {
  provider: ProviderName | null;
  maxFindings: number;
}

export interface Finding {
  id: string;
  ruleId: string;
  path: string;
  line: number;
  severity: Severity;
  category: Category;
  title: string;
  evidence: string;
}

export interface Usage {
  inputBytes: number;
  chunks: number;
  /** Number of findings produced by the full scan, before maxFindings truncation. */
  totalFindings: number;
}

export interface StoredEvent {
  seq: number;
  event: string;
  data: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  diff: string;
  /** Options actually used for the scan. */
  options: NormalizedOptions;
  /** Cache identity key material. */
  cacheKey: string;
  findings: Finding[];
  usage: Usage;
  createdAt: number;
  updatedAt: number;
  error?: string;
  /** Full ordered SSE event log; replayed verbatim to (re)connecting streams. */
  events: StoredEvent[];
  /** Listeners receiving live events (SSE connections attached while running). */
  listeners: Set<(evt: StoredEvent) => void>;
  /** Fulfilled when the job reaches a terminal state (worker-completion signal). */
  settled: Promise<void>;
}

export interface ReviewRequest {
  /** Job-scoped logger-ish hook kept minimal: usage so far, for provider info. */
  jobId: string;
  chunks: string[];
  options: NormalizedOptions;
}

export interface ReviewResult {
  findings: Finding[];
}
