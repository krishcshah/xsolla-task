import assert from "node:assert/strict";
import test from "node:test";
import { chunkDiff } from "../diff/chunk.js";
import { parseDiff, scanAddedLines, splitByFile } from "../diff/parse.js";
import { MockProvider } from "../providers/mock.js";
import { orderAndDedup } from "../providers/order.js";
import type { Finding } from "../types.js";
import { makeDiff } from "./helpers.js";

test("parseDiff: valid diffs pass, non-diffs throw", () => {
  assert.doesNotThrow(() => parseDiff(makeDiff("a.ts", ["b"])));
  assert.throws(() => parseDiff("hello world\n"));
  assert.throws(() => parseDiff(""));
  // bare ---/+++ header pair + hunk without diff --git is acceptable
  const bare = "--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,2 @@\n+a\n";
  assert.doesNotThrow(() => parseDiff(bare));
});

test("scanAddedLines: tracks new-file line numbers across hunks and skips the +++ header", () => {
  const diff = [
    "diff --git a/f.ts b/f.ts",
    "--- a/f.ts",
    "+++ b/f.ts",
    "@@ -1,2 +1,2 @@",
    " keep",
    "+added-one",
    "@@ -10,1 +10,3 @@",
    " ctx",
    "+added-two",
    "+added-three",
    ""
  ].join("\n");
  const seen: Array<{ content: string; path: string; line: number }> = [];
  scanAddedLines(diff, (content, path, line) => seen.push({ content, path, line }));
  assert.deepEqual(seen, [
    { content: "added-one", path: "f.ts", line: 2 },
    { content: "added-two", path: "f.ts", line: 11 },
    { content: "added-three", path: "f.ts", line: 12 }
  ]);
});

test("scanAddedLines: bare-header diffs (no diff --git) take path from +++", () => {
  const diff = "--- a/src/db.ts\n+++ b/src/db.ts\n@@ -0,0 +1,1 @@\n+eval(x)\n";
  const seen: Array<{ path: string; line: number }> = [];
  scanAddedLines(diff, (_c, path, line) => seen.push({ path, line }));
  assert.deepEqual(seen, [{ path: "src/db.ts", line: 1 }]);
});

test("scanAddedLines: CRLF endings are normalized", () => {
  const diff = "diff --git a/c.ts b/c.ts\r\n--- a/c.ts\r\n+++ b/c.ts\r\n@@ -0,0 +1,1 @@\r\n+eval(c)\r\n";
  const seen: string[] = [];
  scanAddedLines(diff, (content) => seen.push(content));
  assert.deepEqual(seen, ["eval(c)"]);
});

test("splitByFile: preamble is merged into the first section", () => {
  const diff = "commit message line\nanother line\n" + makeDiff("m.ts", ["eval(x);"]);
  const parts = splitByFile(diff);
  assert.equal(parts.length, 1);
  assert.ok(parts[0].startsWith("commit message line"));
  assert.ok(parts[0].includes("diff --git a/m.ts"));
});

test("chunkDiff: never splits a file across chunks even when tight", () => {
  // 5 sections of ~28 KiB: each chunk can only hold 2 sections (56 KiB).
  const big = Array.from({ length: 5 }, (_, i) => makeDiff(`f${i}.ts`, ["+" + "y".repeat(28_000)]).replace(/\n$/, "")).join("\n");
  const chunks = chunkDiff(big, 65_536);
  for (const c of chunks) {
    assert.ok(c.startsWith("diff --git "), `chunk starts mid-file: ${c.slice(0, 50)}`);
  }
  const joined = chunks.join("\n");
  assert.equal(joined, big);
});

test("mock provider: deterministic — same input twice yields identical findings", async () => {
  const p = new MockProvider(0);
  const diff = makeDiff("d.ts", ["eval(a);", "// TODO", "if (x == null) {}"]);
  const input = { jobId: "j", chunk: diff, chunkIndex: 0, totalChunks: 1, options: { provider: "mock", maxFindings: 100 } as const };
  const a = await p.scanChunk(input);
  const b = await p.scanChunk(input);
  assert.deepEqual(a.findings, b.findings);
});

test("orderAndDedup: path → line → ruleId, dedup by id", () => {
  const mk = (ruleId: string, path: string, line: number): Finding => ({
    id: `${ruleId}:${path}:${line}`,
    ruleId,
    path,
    line,
    severity: "low",
    category: "style",
    title: ruleId,
    evidence: "+x"
  });
  const unordered = [
    mk("MOCK-008", "b.ts", 5),
    mk("MOCK-001", "a.ts", 10),
    mk("MOCK-007", "a.ts", 10),
    mk("MOCK-001", "a.ts", 3),
    mk("MOCK-001", "a.ts", 3) // duplicate id → dropped
  ];
  const ordered = orderAndDedup(unordered);
  assert.deepEqual(
    ordered.map((f) => f.id),
    ["MOCK-001:a.ts:3", "MOCK-001:a.ts:10", "MOCK-007:a.ts:10", "MOCK-008:b.ts:5"]
  );
});
