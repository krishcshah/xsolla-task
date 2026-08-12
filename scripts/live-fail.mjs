#!/usr/bin/env node
/* Verify the llm provider degrades to a clean `failed` job (no crash/hang) when Gemini is misconfigured.
   Usage: node scripts/live-fail.mjs <base-url> <bearer-token>            — current (misconfigured) key
          node scripts/live-fail.mjs <base-url> <bearer-token> --expect-fail
*/
const BASE = (process.argv[2] || "").replace(/\/$/, "");
const TOKEN = process.argv[3] || "";
if (!BASE || !TOKEN) { console.error("usage: node scripts/live-fail.mjs <base-url> <token>"); process.exit(2); }

const auth = { Authorization: `Bearer ${TOKEN}` };
const json = { "Content-Type": "application/json", ...auth };
const uid = Math.random().toString(36).slice(2, 10);
const llmDiff = `diff --git a/llmf-${uid}.ts b/llmf-${uid}.ts\nindex 1..2 100644\n--- a/llmf-${uid}.ts\n+++ b/llmf-${uid}.ts\n@@ -1,0 +1,1 @@\n+eval(x);\n`;
const mockDiff = `diff --git a/mok-${uid}.ts b/mok-${uid}.ts\nindex 1..2 100644\n--- a/mok-${uid}.ts\n+++ b/mok-${uid}.ts\n@@ -1,0 +1,1 @@\n+console.log(1);\n`;

async function waitTerminal(id, timeoutMs = 75_000) {
  const t0 = Date.now();
  for (;;) {
    const res = await fetch(`${BASE}/v1/reviews/${id}`, { headers: auth });
    const job = await res.json();
    if (job.status === "done" || job.status === "failed") return job;
    if (Date.now() - t0 > timeoutMs) throw new Error(`job ${id} stuck in ${job.status}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

console.log(`base: ${BASE}\n`);

// 1) llm job with the current (bad) key — expect a clean `failed`
const r = await fetch(`${BASE}/v1/reviews`, { method: "POST", headers: json, body: JSON.stringify({ diff: llmDiff, options: { provider: "llm" } }) });
const post = await r.json();
console.log(`llm POST → ${r.status}`, post);
if (r.status !== 202) { console.log("FAIL: llm POST not accepted"); process.exit(1); }

const t0 = Date.now();
const job = await waitTerminal(post.jobId).catch((e) => ({ error: String(e) }));
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`terminal status: ${job.status}  (${elapsed}s)`);
console.log(`error field: ${job.error}`);
console.log(`findings: ${JSON.stringify(job.findings)}`);

// 2) SSE stream of the failed job must end in a terminal done
const sse = await (await fetch(`${BASE}/v1/reviews/${post.jobId}/stream`, { headers: auth })).text();
const doneBlocks = sse.split("\n\n").filter((b) => b.includes("event: done"));
console.log(`SSE done event: ${(doneBlocks.pop() || "").replace(/\n/g, " | ") || "(none)"}`);

// 3) service must still be healthy; mock must still work
const health = await (await fetch(`${BASE}/health`)).json();
console.log(`service healthy: ${health.status === "ok"}`);
const mockRes = await fetch(`${BASE}/v1/reviews`, { method: "POST", headers: json, body: JSON.stringify({ diff: mockDiff, options: { provider: "mock" } }) });
console.log(`mock POST after llm failure → ${mockRes.status}`);
const mockJob = mockRes.status === 202 ? await waitTerminal((await mockRes.json()).jobId).catch(() => ({ status: "?" })) : { status: "?" };
console.log(`mock job status: ${mockJob.status}`);

const pass =
  job.status === "failed" &&
  typeof job.error === "string" && job.error.length > 0 &&
  (doneBlocks.length > 0 || sse.includes("event: done")) &&
  health.status === "ok" &&
  mockJob.status === "done";

console.log(pass ? "\nFAILURE-PATH OK — llm degrades to a failed job with a clear error; service and mock path unaffected" : "\nFAILURE-PATH PROBLEM — see lines above");
process.exit(pass ? 0 : 1);
