import type { ChunkScanInput, ReviewProvider } from "./provider.js";
import { scanAllLines } from "../diff/parse.js";
import type { Finding, ReviewResult } from "../types.js";

/**
 * Deterministic mock provider. Implements the scored finding-rules table
 * exactly, on added (+) lines only, excluding the +++ header. No network.
 * Injection-looking content is reported as MOCK-INJ and is otherwise inert:
 * the rules are plain regex/string checks, the text is never interpreted.
 */

const CREDENTIAL_RE = /(api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i;
/** SQL keyword (SELECT/INSERT/UPDATE/DELETE) inside a string concatenated with +. */
const SQL_CONCAT_RE = /\+\s*("[^"]*(?:SELECT|INSERT|UPDATE|DELETE)[^"]*"|'[^']*(?:SELECT|INSERT|UPDATE|DELETE)[^']*')|("[^"]*(?:SELECT|INSERT|UPDATE|DELETE)[^"]*"|'[^']*(?:SELECT|INSERT|UPDATE|DELETE)[^']*')\s*\+/;
const INJECTION_RE = /ignore previous instructions|disregard all prior|you are now/i;
const EMPTY_CATCH_RE = /catch\b[^{}]*\{\s*\}/;
const CATCH_LINE_RE = /catch\b[^{}]*\{/;
// `== null` / `!= null` exactly — `===` / `!==` must not match.
const LOOSE_EQ_NULL_RE = /(?<![=!<>])(?:==|!=)(?![=!>])\s*null\b/;
const LOOSE_NULL_EQ_RE = /\bnull\s*(?<![=!<>])(?:==|!=)(?![=!>])/;

interface RuleMatch {
  ruleId: string;
  severity: Finding["severity"];
  category: Finding["category"];
  title: string;
}

/** Per-line triggers: one finding per matching line per rule. */
function lineRules(content: string): RuleMatch[] {
  const out: RuleMatch[] = [];
  if (content.includes("eval(")) out.push({ ruleId: "MOCK-001", severity: "critical", category: "security", title: "eval usage" });
  if (CREDENTIAL_RE.test(content)) out.push({ ruleId: "MOCK-002", severity: "critical", category: "security", title: "hardcoded credential" });
  if (SQL_CONCAT_RE.test(content)) out.push({ ruleId: "MOCK-003", severity: "high", category: "security", title: "SQL string concatenation" });
  if (LOOSE_EQ_NULL_RE.test(content) || LOOSE_NULL_EQ_RE.test(content)) out.push({ ruleId: "MOCK-005", severity: "medium", category: "correctness", title: "loose null comparison" });
  if (content.includes("JSON.parse(JSON.stringify(")) out.push({ ruleId: "MOCK-006", severity: "medium", category: "performance", title: "deep-clone via JSON" });
  if (content.includes("console.log(")) out.push({ ruleId: "MOCK-007", severity: "low", category: "style", title: "console.log left in" });
  if (content.includes("TODO") || content.includes("FIXME")) out.push({ ruleId: "MOCK-008", severity: "low", category: "style", title: "unresolved marker" });
  if (INJECTION_RE.test(content)) out.push({ ruleId: "MOCK-INJ", severity: "critical", category: "security", title: "prompt-injection content" });
  return out;
}

interface ScannedLine {
  content: string;
  raw: string;
  path: string;
  line: number;
  added: boolean;
}

export class MockProvider implements ReviewProvider {
  readonly name = "mock";
  constructor(private readonly chunkDelayMs: number = 0) {}

  async scanChunk(input: ChunkScanInput): Promise<ReviewResult> {
    if (this.chunkDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.chunkDelayMs));
    }

    const findings: Finding[] = [];
    const lines: ScannedLine[] = [];
    scanAllLines(input.chunk, (content, path, newLine, rawLine, added) => {
      lines.push({ content, raw: rawLine, path, line: newLine, added });
    });

    // MOCK-004 empty catch blocks may span lines (`catch (e) {` on one added
    // line, `}` on a later added or context line). Track which added line is a
    // catch opener, then look ahead for a close before any statement.
    const reportCatch = new Set<number>();

    for (let i = 0; i < lines.length; i++) {
      const { content, raw, path, line, added } = lines[i];
      if (!added) continue;

      // MOCK-004 single-line (`} catch (e) {}`) or multi-line (`catch (e) {` … `}`).
      if (EMPTY_CATCH_RE.test(content)) {
        reportCatch.add(i);
      } else {
        // Multi-line: a `catch … {` whose block does not close on this line.
        // Any `}` before `catch` (e.g. closing the `try { … }`) must be ignored,
        // so only inspect the text from `catch` onward.
        const catchIdx = content.search(/catch\b/);
        if (catchIdx >= 0) {
          const afterCatch = content.slice(catchIdx);
          if (CATCH_LINE_RE.test(afterCatch) && !afterCatch.includes("}")) {
            let empty = true;
            for (let j = i + 1; j < lines.length && j <= i + 25; j++) {
              const t = lines[j].content.trim();
              if (t === "}") break; // closed with nothing in between → empty
              if (t === "" || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) continue;
              empty = false;
              break;
            }
            if (empty) reportCatch.add(i);
          }
        }
      }

      // All other rules are per-added-line.
      for (const m of lineRules(content)) {
        findings.push(makeFinding(m, path, line, raw));
      }
    }

    for (const i of reportCatch) {
      const { raw, path, line } = lines[i];
      findings.push(makeFinding({ ruleId: "MOCK-004", severity: "high", category: "correctness", title: "swallowed exception" }, path, line, raw));
    }

    return { findings };
  }
}

function makeFinding(match: RuleMatch, path: string, line: number, rawLine: string): Finding {
  return {
    id: `${match.ruleId}:${path}:${line}`,
    ruleId: match.ruleId,
    path,
    line,
    severity: match.severity,
    category: match.category,
    title: match.title,
    evidence: rawLine
  };
}
