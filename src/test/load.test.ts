import assert from "node:assert/strict";
import test from "node:test";
import { JobQueue } from "../jobs/queue.js";
import { auth, jsonHeaders, makeDiff, postRaw, postReview, startTestServer, uniqueTag, waitForTerminal } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("rate limiting: 65 unique rapid submissions → some succeed then 429 + Retry-After, never 5xx", async () => {
  const srv = await startTestServer();
  try {
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    let envelopeCode: string | null = null;
    for (let i = 0; i < 65; i++) {
      const res = await fetch(`${srv.base}/v1/reviews`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ diff: makeDiff(`rl-${uniqueTag()}-${i}.ts`, [`eval(${i});`]) })
      });
      statuses.push(res.status);
      assert.ok(res.status < 500, `5xx under burst: ${res.status}`);
      if (res.status === 429) {
        retryAfter = res.headers.get("Retry-After");
        const body = (await res.json()) as { error: { code: string } };
        envelopeCode = body.error.code;
      } else {
        await res.arrayBuffer().catch(() => undefined); // drain
      }
    }
    assert.ok(statuses.includes(202), "expected some 202s");
    assert.ok(statuses.includes(429), "expected 429 beyond the burst");
    assert.ok(retryAfter !== null && Number(retryAfter) >= 1, `Retry-After missing or invalid: ${retryAfter}`);
    assert.equal(envelopeCode, "rate_limited");

    // the limiter is only on POST /v1/reviews: GETs still fine
    const health = await fetch(`${srv.base}/v1/reviews/anything`, { headers: auth() });
    assert.equal(health.status, 404);
  } finally {
    await srv.close();
  }
});

test("rate limiting: 30 sustained submissions succeed", async () => {
  const srv = await startTestServer();
  try {
    // 30 unique submissions at a steady-but-fast pace: all must be accepted
    // (sustained budget) — none may be 429 or 5xx.
    const results: number[] = [];
    for (let i = 0; i < 30; i++) {
      const { status } = await postReview(srv.base, makeDiff(`sr-${uniqueTag()}-${i}.ts`, [`eval(${i});`]));
      results.push(status);
    }
    for (const s of results) {
      assert.equal(s, 202, `expected 202, got ${s}`);
    }
  } finally {
    await srv.close();
  }
});

test("concurrency: 5 simultaneous submissions — cap of 4, 5th queues and still completes", async () => {
  // (a) All five submissions are accepted (202) and all complete.
  const srv = await startTestServer();
  try {
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        postReview(srv.base, makeDiff(`cc-${uniqueTag()}-${i}.ts`, [`eval(${i});`, `console.log(${i});`]))
      )
    );
    for (const r of responses) {
      assert.equal(r.status, 202, "5th submission must be accepted (202), not rejected");
      assert.equal(r.body.status, "queued");
    }
    const states = await Promise.all(responses.map((r) => waitForTerminal(srv.base, r.body.jobId!, 25_000)));
    for (const s of states) assert.equal(s.status, "done", s.error);
    for (const s of states) assert.equal(s.findings.length, 2);

    // also: many parallel health checks never compete with the job queue
    const healths = await Promise.all(Array.from({ length: 10 }, () => fetch(`${srv.base}/health`)));
    for (const h of healths) assert.equal(h.status, 200);
  } finally {
    await srv.close();
  }

  // (b) The queue itself caps parallelism at 4 and never runs a 5th early.
  const queue = new JobQueue(4);
  let running = 0;
  let maxRunning = 0;
  let completed = 0;
  await new Promise<void>((resolveAll) => {
    for (let i = 0; i < 5; i++) {
      queue.enqueue(async () => {
        running++;
        if (running > maxRunning) maxRunning = running;
        await sleep(120);
        running--;
        completed++;
        if (completed === 5) resolveAll();
      });
    }
  });
  assert.equal(maxRunning, 4, `queue ran ${maxRunning} concurrently, expected exactly 4`);

  // (c) End-to-end with a slow mock: the 5th waits for the first wave.
  const srv2 = await startTestServer({ MOCK_CHUNK_DELAY_MS: "500" });
  try {
    const t0 = Date.now();
    const responses2 = await Promise.all(
      Array.from({ length: 5 }, (_, i) => postReview(srv2.base, makeDiff(`cc2-${uniqueTag()}-${i}.ts`, [`eval(${i});`])))
    );
    await Promise.all(responses2.map((r) => waitForTerminal(srv2.base, r.body.jobId!, 25_000)));
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 900, `expected two waves of 4+1, finished in ${elapsed}ms`);
    assert.ok(elapsed < 8000, `too slow: ${elapsed}ms`);
  } finally {
    await srv2.close();
  }
});

test("429 envelope shape and Retry-After are correct (small hard cap, hazard paths)", async () => {
  // Hard cap of 3 and diff bodies that always miss the cache (a/*, b/* are not
  // valid hex, so nothing else in this run could have scanned the same bytes).
  const srv = await startTestServer({ RATE_LIMIT_HARD_CAP: "3" });
  try {
    const statuses: number[] = [];
    let observed: { code?: string; retryAfter?: string | null } = {};
    for (let i = 0; i < 5; i++) {
      const res = await postRaw(
        srv.base,
        JSON.stringify({ diff: makeDiff(`z-lim/hc-${i}.txt`, [`eval(${i});`]) }),
        jsonHeaders()
      );
      statuses.push(res.status);
      if (res.status === 429) {
        observed.retryAfter = res.headers.get("Retry-After");
        observed.code = (res.body as { error: { code: string } }).error.code;
      }
    }
    assert.deepEqual(statuses.slice(0, 3), [202, 202, 202]);
    assert.deepEqual(statuses.slice(3), [429, 429]);
    assert.equal(observed.code, "rate_limited");
    assert.ok(observed.retryAfter !== null && Number(observed.retryAfter) >= 1);
  } finally {
    await srv.close();
  }
});
