/**
 * Unified-diff parsing.
 *
 * parseDiff validates that input looks like a unified diff and counts how many
 * files it touches. scanAddedLines replays the diff, tracking the current file
 * path (from `+++ b/<path>`, or the `diff --git` line as fallback) and the
 * new-file line numbers from hunk headers, and invokes a callback for every
 * added line (`+`, excluding the `+++` header) with its new-file line number
 * and verbatim content.
 */

export interface ParsedDiff {
  /** Number of `diff --git` file sections (0 for bare-header diffs). */
  fileCount: number;
  /** All `+++ <target>` header values, in order of appearance. */
  paths: string[];
}

const DIFF_GIT_RE = /^diff --git a\/.+ b\/.+/;
const PLUS_HEADER_RE = /^\+\+\+ (.+)$/;

export function parseDiff(diff: string): ParsedDiff {
  if (typeof diff !== "string" || diff.length === 0) {
    throw new Error("diff is empty");
  }
  const lines = diff.split("\n");
  let fileCount = 0;
  let hasDiffGit = false;
  let hasPlusHeader = false;
  let hasHunk = false;
  const paths: string[] = [];

  for (const line of lines) {
    if (DIFF_GIT_RE.test(line)) {
      hasDiffGit = true;
      fileCount++;
      continue;
    }
    const plus = PLUS_HEADER_RE.exec(line);
    if (plus) {
      hasPlusHeader = true;
      paths.push(plus[1]);
      continue;
    }
    if (line.startsWith("@@")) {
      hasHunk = true;
    }
  }

  // "Parseable unified diff": needs the classic diff --git form, or at least
  // the ---/+++ header pair plus a hunk header.
  if (!hasDiffGit && !(hasPlusHeader && hasHunk)) {
    throw new Error("not a parseable unified diff");
  }
  return { fileCount, paths };
}

/** Strip one trailing \r so evidence content is stable on CRLF inputs. */
function stripCR(s: string): string {
  return s.endsWith("\r") ? s.slice(0, -1) : s;
}

/**
 * Walk `diff` and invoke `onAdded(verbatimContent, path, newLine, rawLine)`
 * for every added line. `rawLine` includes the leading `+`; `verbatimContent`
 * excludes it (CRLF endings normalized to LF).
 */
export function scanAddedLines(
  diff: string,
  onAdded: (content: string, path: string, newLine: number, rawLine: string) => void
): void {
  const lines = diff.split("\n");
  let currentPath = "";
  let newLineNo = 0;

  for (const raw of lines) {
    const line = stripCR(raw);

    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/.+ b\/(.+)$/.exec(line);
      if (m) currentPath = m[1];
      continue;
    }
    if (line.startsWith("+++ ")) {
      // +++ header: authoritative path for the upcoming hunks.
      const p = line.slice(4).trim();
      if (p === "/dev/null") {
        currentPath = currentPath || "/dev/null";
      } else if (p.startsWith("b/")) {
        currentPath = p.slice(2);
      } else if (p.length > 0) {
        currentPath = p;
      }
      continue;
    }
    if (line.startsWith("@@")) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) newLineNo = parseInt(m[1], 10);
      continue;
    }
    if (line.startsWith("+")) {
      // Any other leading '+' (the +++ header was handled above) is an added line.
      onAdded(line.slice(1), currentPath, newLineNo, "+" + line.slice(1));
      newLineNo++;
      continue;
    }
    if (line.startsWith("-")) {
      // removed line: does not advance the new-file counter
      continue;
    }
    if (line.startsWith("\\")) {
      // "\ No newline at end of file"
      continue;
    }
    // context line
    newLineNo++;
  }
}

/**
 * Walk `diff` and invoke `onLine(content, path, newLine, rawLine, added)` for
 * every line that exists in the new file (added `+` lines and context lines),
 * tracking the same path/line-number state as scanAddedLines. Used by rules
 * whose evidence spans multiple lines (e.g. empty catch blocks).
 */
export function scanAllLines(
  diff: string,
  onLine: (content: string, path: string, newLine: number, rawLine: string, added: boolean) => void
): void {
  const lines = diff.split("\n");
  let currentPath = "";
  let newLineNo = 0;

  for (const raw of lines) {
    const line = stripCR(raw);

    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/.+ b\/(.+)$/.exec(line);
      if (m) currentPath = m[1];
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      if (p === "/dev/null") {
        currentPath = currentPath || "/dev/null";
      } else if (p.startsWith("b/")) {
        currentPath = p.slice(2);
      } else if (p.length > 0) {
        currentPath = p;
      }
      continue;
    }
    if (line.startsWith("@@")) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) newLineNo = parseInt(m[1], 10);
      continue;
    }
    if (line.startsWith("+")) {
      onLine(line.slice(1), currentPath, newLineNo, "+" + line.slice(1), true);
      newLineNo++;
      continue;
    }
    if (line.startsWith("-")) continue; // removed line: gone from the new file
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    // context line (leading single space, or a bare empty line treated as context)
    const content = line.startsWith(" ") ? line.slice(1) : line;
    onLine(content, currentPath, newLineNo, " " + content, false);
    newLineNo++;
  }
}

/**
 * Split a diff into per-file sections on `diff --git` boundaries. A preamble
 * before the first `diff --git` (e.g. a commit message) is merged into the
 * first section so no bytes are dropped; a diff with no `diff --git` lines
 * (bare headers) is returned as a single section.
 */
export function splitByFile(diff: string): string[] {
  const lines = diff.split("\n");
  const sections: string[] = [];
  let current: string[] = [];
  let seenDiffGit = false;

  const flush = () => {
    if (current.length > 0) {
      sections.push(current.join("\n"));
      current = [];
    }
  };

  for (const raw of lines) {
    if (stripCR(raw).startsWith("diff --git ")) {
      flush();
      seenDiffGit = true;
    }
    current.push(raw);
  }
  flush();

  // Merge a preamble-only first section into the first real section so a
  // chunked scan yields byte-identical findings to an unchunked scan.
  if (seenDiffGit && sections.length > 1 && !stripCR(sections[0]).startsWith("diff --git ")) {
    const merged = sections[0] + "\n" + sections[1];
    sections.splice(0, 2, merged);
  }
  return sections.filter((s) => s.length > 0);
}
