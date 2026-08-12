import type { Finding, NormalizedOptions, ReviewResult } from "../types.js";

/** Per-chunk scan input handed to a provider. */
export interface ChunkScanInput {
  jobId: string;
  chunk: string;
  chunkIndex: number;
  totalChunks: number;
  options: NormalizedOptions;
}

/** A provider scans chunk-by-chunk; the pipeline handles ordering/streaming. */
export interface ReviewProvider {
  readonly name: string;
  scanChunk(input: ChunkScanInput): Promise<ReviewResult>;
}

/** Loose, untrusted finding shape as returned by an external model. */
export type MaybeFinding = Partial<Record<keyof Finding, unknown>> & Record<string, unknown>;

/**
 * Defensively coerce untrusted model output into a valid Finding list.
 * Anything malformed is dropped silently; throws only if `raw` is not an array.
 */
export function sanitizeFindings(raw: unknown): Finding[] {
  if (!Array.isArray(raw)) {
    throw new Error("model output is not a JSON array of findings");
  }
  const severities = new Set(["critical", "high", "medium", "low"]);
  const categories = new Set(["security", "correctness", "performance", "style"]);
  const out: Finding[] = [];
  for (const item of raw as MaybeFinding[]) {
    if (!item || typeof item !== "object") continue;
    const line = typeof item.line === "number" && Number.isInteger(item.line) && item.line > 0 ? item.line : NaN;
    const severity = typeof item.severity === "string" && severities.has(item.severity) ? item.severity : null;
    const category = typeof item.category === "string" && categories.has(item.category) ? item.category : null;
    if (Number.isNaN(line) || severity === null || category === null) continue;
    if (typeof item.id !== "string" || typeof item.ruleId !== "string") continue;
    if (typeof item.path !== "string" || item.path.length === 0) continue;
    if (typeof item.title !== "string" || typeof item.evidence !== "string") continue;
    out.push({
      id: item.id,
      ruleId: item.ruleId,
      path: item.path,
      line,
      severity: severity as Finding["severity"],
      category: category as Finding["category"],
      title: item.title,
      evidence: item.evidence
    });
  }
  return out;
}
