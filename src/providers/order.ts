import type { Finding } from "../types.js";

/**
 * Global ordering, deduplicated by id: path (lexicographic, by UTF-16 code
 * unit — JS default <=> and Array.prototype.sort), then line ascending,
 * then ruleId. Stable, deterministic, shared by the pipeline and tests.
 */
export function orderAndDedup(findings: Iterable<Finding>): Finding[] {
  const byId = new Map<string, Finding>();
  for (const f of findings) {
    if (!byId.has(f.id)) byId.set(f.id, f);
  }
  const arr = Array.from(byId.values());
  arr.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
    return 0;
  });
  return arr;
}
