import type { ServiceConfig } from "../config.js";
import type { ChunkScanInput, ReviewProvider } from "./provider.js";
import { sanitizeFindings } from "./provider.js";
import type { Finding, ReviewResult } from "../types.js";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const RETRYABLE = (status: number) => status === 408 || status === 429 || status >= 500;

const FINDING_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      id: { type: "STRING" },
      ruleId: { type: "STRING" },
      path: { type: "STRING" },
      line: { type: "INTEGER" },
      severity: { type: "STRING", enum: ["critical", "high", "medium", "low"] },
      category: { type: "STRING", enum: ["security", "correctness", "performance", "style"] },
      title: { type: "STRING" },
      evidence: { type: "STRING" }
    },
    required: ["id", "ruleId", "path", "line", "severity", "category", "title", "evidence"]
  }
} as const;

function buildPrompt(chunk: string): string {
  return [
    "You are a senior code reviewer performing a single pass over one unified-diff file section.",
    "Review ONLY the added lines (lines starting with '+', excluding the '+++' header).",
    "Identify real bugs, security vulnerabilities, performance problems, and style issues.",
    "Return ONLY a JSON array of finding objects through the configured structured output.",
    "Each finding must have: id (\"<ruleId>:<path>:<line>\" with a short UPPER-SNAKE ruleId of your choosing),",
    "ruleId, path (the file path from the +++ header), line (line number in the NEW file, from the @@ hunk header),",
    "severity (critical|high|medium|low), category (security|correctness|performance|style),",
    "title (short), evidence (the exact offending added line, verbatim, including the leading '+').",
    "If there are no issues, return an empty JSON array [].",
    "",
    "Unified diff chunk:",
    chunk
  ].join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Real-LLM provider: Google Gemini generateContent with JSON-mode structured
 * output, behind the same chunking/schema pipeline as the mock provider.
 * Any failure (network, timeout, HTTP error, malformed output) throws, and the
 * pipeline converts that into a `failed` job — the process never crashes.
 */
export class LlmProvider implements ReviewProvider {
  readonly name = "llm";
  constructor(private readonly config: ServiceConfig) {}

  async scanChunk(input: ChunkScanInput): Promise<ReviewResult> {
    if (!this.config.geminiApiKey) {
      throw new Error("Gemini API key is not configured on this server (GEMINI_API_KEY)");
    }

    if (input.totalChunks > 1) {
      console.log(`[job ${input.jobId}] llm chunk ${input.chunkIndex + 1}/${input.totalChunks} (${Buffer.byteLength(input.chunk)} B)`);
    }

    const raw = await this.callWithRetry(buildPrompt(input.chunk));
    let findings: Finding[];
    try {
      findings = sanitizeFindings(raw);
    } catch (err) {
      throw new Error(`Gemini returned malformed output: ${(err as Error).message}`);
    }
    if (this.config.llmChunkDelayMs > 0) {
      await sleep(this.config.llmChunkDelayMs);
    }
    return { findings };
  }

  private async callWithRetry(prompt: string): Promise<unknown> {
    let lastErr: Error | null = null;
    const attempts = Math.max(1, this.config.llmMaxAttempts);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.callOnce(prompt);
      } catch (err) {
        lastErr = err as Error;
        const retryable = (err as { retryable?: boolean }).retryable !== false;
        if (!retryable || attempt === attempts) break;
        await sleep(300 * attempt + Math.floor(Math.random() * 150));
      }
    }
    throw lastErr ?? new Error("Gemini call failed");
  }

  private async callOnce(prompt: string): Promise<unknown> {
    const url = `${API_BASE}/${this.config.geminiModel}:generateContent`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.llmTimeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.config.geminiApiKey
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 8192,
            responseMimeType: "application/json",
            responseSchema: FINDING_SCHEMA
          }
        }),
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(timer);
      const e = new Error(`Gemini request failed (${this.config.geminiModel}): ${(err as Error).message}`);
      (e as { retryable?: boolean }).retryable = true; // network/timeout
      throw e;
    }
    clearTimeout(timer);

    const text = await res.text();
    if (!res.ok) {
      const e = new Error(`Gemini API error ${res.status} (${this.config.geminiModel}): ${text.slice(0, 300)}`);
      (e as { retryable?: boolean }).retryable = RETRYABLE(res.status);
      throw e;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      const e = new Error("Gemini returned non-JSON HTTP body");
      (e as { retryable?: boolean }).retryable = true;
      throw e;
    }

    const content = extractText(payload);
    if (content === null) {
      throw new Error("Gemini response contained no text content (blocked or empty)");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      // Defensive fallback: model wrapped JSON in a code fence despite JSON mode.
      const cleaned = content.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        throw new Error("Gemini returned unparseable findings JSON");
      }
    }
    return parsed;
  }
}

function extractText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const candidates = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const parts = (candidates[0] as { content?: { parts?: unknown } })?.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) return null;
  const texts: string[] = [];
  for (const p of parts) {
    const t = (p as { text?: unknown })?.text;
    if (typeof t === "string") texts.push(t);
  }
  const joined = texts.join("");
  return joined.length > 0 ? joined : null;
}
