#!/usr/bin/env node
/**
 * Smoke: boot the app as a child process and exercise the main flows.
 * Run: npm run smoke
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 18080;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = process.env.API_BEARER_TOKEN || "smoke-token-0123456789";

const child = spawn(process.execPath, [path.join(ROOT, "dist", "index.js")], {
  env: { ...process.env, PORT: String(PORT), API_BEARER_TOKEN: TOKEN, GEMINI_API_KEY: "" },
  stdio: ["ignore", "pipe", "pipe"]
});
child.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
child.stderr.on("data", (d) => process.stderr.write(`[server:err] ${d}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = { Authorization: `Bearer ${TOKEN}` };

function check(name, cond, extra = "") {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) process.exitCode = 1;
  return ok;
}

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("server did not become ready");
}

function makeDiff(pathName, lines, start = 10) {
  return [
    `diff --git a/${pathName} b/${pathName}`,
    "index 1..2 100644",
    `--- a/${pathName}`,
    `+++ b/${pathName}`,
    `@@ -${start},0 +${start},${lines.length} @@`,
    ...lines.map((l) => `+${l}`)
  ].join("\n") + "\n";
}

async function postReview(diff, options = {}, headers = {}) {
  const res = await fetch(`${BASE}/v1/reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth, ...headers },
    body: JSON.stringify({ diff, options })
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

async function waitDone(jobId) {
  for (let i = 0; i < 200; i++) {
    const res = await fetch(`${BASE}/v1/reviews/${jobId}`, { headers: auth });
    const body = await res.json();
    if (body.status === "done" || body.status === "failed") return body;
    await sleep(50);
  }
  throw new Error(`job ${jobId} did not finish`);
}

try {
  await waitReady();

  const health = await (await fetch(`${BASE}/health`)).json();
  check("GET /health", health.status === "ok");

  const spec = await (await fetch(`${BASE}/spec`)).json();
  check("GET /spec limits", spec.limits?.maxConcurrentJobs === 4 && spec.limits?.rateLimitPerMinute === 30);

  const noAuth = await fetch(`${BASE}/v1/reviews`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check("401 without token", noAuth.status === 401);

  const diff = makeDiff("src/demo.ts", ["eval(userInput);", 'const apiKey = "abcdef1234567890";', "console.log('x');", "// TODO: ship"]);
  const r1 = await postReview(diff, { provider: "mock" });
  check("POST 202 queued", r1.status === 202 && r1.body.status === "queued");
  const j1 = await waitDone(r1.body.jobId);
  check("job done", j1.status === "done");
  check("mock findings present", j1.findings.length === 4, `got ${j1.findings.length}`);
  check("global ordering", JSON.stringify(j1.findings.map((f) => f.line)) === JSON.stringify([10, 11, 12, 13]));

  // cache
  const r2 = await postReview(diff, { provider: "mock" });
  const j2 = await waitDone(r2.body.jobId);
  check("cacheHit=true on resubmission", j2.usage.cacheHit === true && j2.findings.length === 4);

  // idempotency
  const key = `smoke-${Date.now()}`;
  const a = await postReview(makeDiff("src/i1.ts", ["eval(a);"]), {}, { "Idempotency-Key": key });
  const b = await postReview(makeDiff("src/i1.ts", ["eval(a);"]), {}, { "Idempotency-Key": key });
  check("idempotent replay (same body)", b.status === 202 && b.body.jobId === a.body.jobId);
  const c = await postReview(makeDiff("src/i2.ts", ["eval(b);"]), {}, { "Idempotency-Key": key });
  check("409 on key reuse with different body", c.status === 409);

  // SSE
  const sse = await fetch(`${BASE}/v1/reviews/${r1.body.jobId}/stream`, { headers: auth });
  const sseText = await sse.text();
  check("SSE content-type", (sse.headers.get("content-type") || "").includes("text/event-stream"));
  check("SSE has status/finding/done", /event: status/.test(sseText) && /event: finding/.test(sseText) && /event: done/.test(sseText));
  const sse2 = await fetch(`${BASE}/v1/reviews/${r1.body.jobId}/stream`, { headers: auth });
  check("SSE replay identical", (await sse2.text()) === sseText);

  // llm path exists, degrades gracefully with no key
  const lr = await postReview(makeDiff("src/llm.ts", ["eval(x);"]), { provider: "llm" });
  const lj = await waitDone(lr.body.jobId);
  check("llm job fails gracefully", lj.status === "failed" && typeof lj.error === "string" && lj.error.length > 0, lj.error);

  // payload too large
  const big = makeDiff("src/big.ts", ["x".repeat(1_100_000)]);
  const pr = await postReview(big);
  check("413 over 1 MiB", pr.status === 413 && pr.body.error?.code === "payload_too_large");

  console.log(process.exitCode ? "\nSMOKE FAILED" : "\nSMOKE OK");
} catch (err) {
  console.error("SMOKE ERROR:", err);
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 1500).unref();
}
