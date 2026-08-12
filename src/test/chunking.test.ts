import assert from "node:assert/strict";
import test from "node:test";
import { chunkDiff } from "../diff/chunk.js";
import { splitByFile } from "../diff/parse.js";
import { MockProvider } from "../providers/mock.js";
import { orderAndDedup } from "../providers/order.js";
import type { Finding } from "../types.js";
import { concatDiffs, makeDiff, postReview, startTestServer, uniqueTag, waitForTerminal } from "./helpers.js";

const CHUNK = 65_536;

/** File section with exactly bodySize bytes of `+` payload (plus triggers). */
function fileSection(path: string, bodySize: number, trigger?: string): string {
  const filler = "+" + "x".repeat(Math.max(1, bodySize));
  const lines = [
    `diff --git a/${path} b/${path}`,
    "index 1..2 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -0,0 +1,3 @@",
    ...(trigger ? [`+${trigger}`] : []),
    filler
  ];
  return lines.join("\n");
}

async function scanDirect(diff: string): Promise<Finding[]> {
  // Unchunked: single call.
  const provider = new MockProvider(0);
  const res = await provider.scanChunk({ jobId: "t", chunk: diff, chunkIndex: 0, totalChunks: 1, options: { provider: "mock", maxFindings: 1000 } });
  return orderAndDedup(res.findings);
}

async function scanDirectChunked(diff: string, chunkBytes: number): Promise<Finding[]> {
  const provider = new MockProvider(0);
  const chunks = chunkDiff(diff, chunkBytes);
  const all: Finding[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const res = await provider.scanChunk({ jobId: "t", chunk: chunks[i], chunkIndex: i, totalChunks: chunks.length, options: { provider: "mock", maxFindings: 1000 } });
    all.push(...res.findings);
  }
  return orderAndDedup(all);
}

test("chunkDiff: ≤64 KiB stays a single chunk; splits only on file boundaries", async () => {
  const small = makeDiff("a.ts", ["eval(x);"]);
  assert.deepEqual(chunkDiff(small, CHUNK), [small]);

  // 10 files x 16 KiB of payload → ~5 chunks of ≤64 KiB each
  const sections = Array.from({ length: 10 }, (_, i) => fileSection(`f${i}.ts`, 16_384));
  const diff = concatDiffs(...sections.map((s) => s + "\n"));
  const chunks = chunkDiff(diff, CHUNK);
  assert.ok(chunks.length >= 3 && chunks.length <= 7, `chunks=${chunks.length}`);
  for (const c of chunks) {
    assert.ok(Buffer.byteLength(c, "utf8") <= CHUNK, `chunk too big: ${Buffer.byteLength(c, "utf8")}`);
    // every chunk starts on a file boundary
    assert.ok(c.startsWith("diff --git "), `chunk does not start on a file boundary: ${c.slice(0, 40)}`);
  }
  // every file section appears in exactly one chunk, complete
  for (let i = 0; i < 10; i++) {
    const occurrences = chunks.filter((c) => c.includes(`diff --git a/f${i}.ts `)).length;
    assert.equal(occurrences, 1, `file f${i} spans chunks`);
  }
});

test("chunkDiff: a single file over 64 KiB is its own oversized chunk", async () => {
  const big = fileSection("huge.ts", 100_000, "eval(x);") + "\n";
  const small = fileSection("tiny.ts", 100, "// TODO") + "\n";
  const diff = concatDiffs(big, small);
  const chunks = chunkDiff(diff, CHUNK);
  assert.equal(chunks.length, 2);
  assert.ok(Buffer.byteLength(chunks[0], "utf8") > CHUNK); // oversized single-file chunk
  assert.ok(chunks[0].includes("huge.ts") && chunks[1].includes("tiny.ts"));
});

test("chunked vs unchunked scans are byte-identical (large multi-file diff)", async () => {
  // 12 files ≈ 192 KiB, each with a distinct trigger spread around.
  const sections = Array.from({ length: 12 }, (_, i) =>
    fileSection(`mod/file-${String(i).padStart(2, "0")}.ts`, 16_000 + i * 17, "eval(src); // TODO")
  );
  const diff = concatDiffs(...sections.map((s) => s + "\n"));
  assert.ok(Buffer.byteLength(diff, "utf8") > 128_000);

  const whole = await scanDirect(diff);
  const chunked = await scanDirectChunked(diff, CHUNK);
  assert.equal(chunked.length, whole.length);
  assert.deepEqual(chunked, whole);
});

test("service: >64 KiB diff chunks correctly and matches the unchunked reference exactly", async () => {
  const srv = await startTestServer();
  try {
    const sections = Array.from({ length: 8 }, (_, i) =>
      fileSection(`svc/f-${i}-${uniqueTag()}.ts`, 20_000, "eval(src);" + " // pad")
    );
    const diff = concatDiffs(...sections.map((s) => s + "\n"));
    assert.ok(Buffer.byteLength(diff, "utf8") > CHUNK);

    const { body } = await postReview(srv.base, diff);
    const job = await waitForTerminal(srv.base, body.jobId!, 29_000);
    assert.equal(job.status, "done");
    const expectedChunks = chunkDiff(diff, CHUNK).length;
    assert.equal(job.usage.chunks, expectedChunks);
    assert.ok(job.usage.chunks > 1, "expected multiple chunks");

    const reference = await scanDirect(diff);
    assert.deepEqual(job.findings, reference);
  } finally {
    await srv.close();
  }
});

test("splitByFile keeps sections intact and preserves order", async () => {
  const d1 = makeDiff("a/x.ts", ["eval(1);"]);
  const d2 = makeDiff("b/y.ts", ["eval(2);"]);
  const diff = concatDiffs(d1, d2);
  const parts = splitByFile(diff);
  assert.equal(parts.length, 2);
  assert.ok(parts[0].includes("a/x.ts"));
  assert.ok(parts[1].includes("b/y.ts"));
});
