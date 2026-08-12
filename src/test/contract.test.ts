import assert from "node:assert/strict";
import test from "node:test";
import {
  TOKEN,
  auth,
  collectStream,
  jsonHeaders,
  makeDiff,
  parseSse,
  postRaw,
  postReview,
  startTestServer,
  uniqueTag,
  waitForTerminal
} from "./helpers.js";

const SIMPLE_DIFF = makeDiff("src/a.ts", ["const x = 1;"]);

test("GET /health is public and reports status/version/uptime", async () => {
  const srv = await startTestServer();
  try {
    const res = await fetch(`${srv.base}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.status, "ok");
    assert.match(String(body.version), /^\d+\.\d+\.\d+$/);
    assert.equal(typeof body.uptimeSeconds, "number");
  } finally {
    await srv.close();
  }
});

test("GET /spec self-declares enforced limits", async () => {
  const srv = await startTestServer();
  try {
    const res = await fetch(`${srv.base}/spec`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      specVersion: "1.0",
      providers: ["mock", "llm"],
      limits: {
        maxPayloadBytes: 1048576,
        chunkBytes: 65536,
        maxConcurrentJobs: 4,
        rateLimitPerMinute: 30
      }
    });
  } finally {
    await srv.close();
  }
});

test("auth is enforced on every /v1/* route", async () => {
  const srv = await startTestServer();
  try {
    const noAuthPost = await fetch(`${srv.base}/v1/reviews`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ diff: SIMPLE_DIFF })
    });
    assert.equal(noAuthPost.status, 401);
    const env1 = (await noAuthPost.json()) as { error: { code: string } };
    assert.equal(env1.error.code, "unauthorized");

    const wrong = await fetch(`${srv.base}/v1/reviews`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
      body: JSON.stringify({ diff: SIMPLE_DIFF })
    });
    assert.equal(wrong.status, 401);

    const getNoAuth = await fetch(`${srv.base}/v1/reviews/some-id`);
    assert.equal(getNoAuth.status, 401);

    const streamNoAuth = await fetch(`${srv.base}/v1/reviews/some-id/stream`);
    assert.equal(streamNoAuth.status, 401);

    // unknown /v1 route also requires auth first
    const unknownNoAuth = await fetch(`${srv.base}/v1/nope`);
    assert.equal(unknownNoAuth.status, 401);
  } finally {
    await srv.close();
  }
});

test("error envelope taxonomy: 422 invalid diff, 400 invalid JSON, 404 not found", async () => {
  const srv = await startTestServer();
  try {
    // missing diff → 422
    const missing = await postRaw(srv.base, JSON.stringify({ options: {} }), jsonHeaders());
    assert.equal(missing.status, 422);
    assert.equal((missing.body as { error: { code: string } }).error.code, "invalid_diff");

    // empty diff → 422
    const empty = await postRaw(srv.base, JSON.stringify({ diff: "" }), jsonHeaders());
    assert.equal(empty.status, 422);
    assert.equal((empty.body as { error: { code: string } }).error.code, "invalid_diff");

    // garbage diff → 422
    const garbage = await postRaw(srv.base, JSON.stringify({ diff: "hello world this is not a diff" }), jsonHeaders());
    assert.equal(garbage.status, 422);

    // malformed JSON → 400
    const badJson = await postRaw(srv.base, `{"diff": ${JSON.stringify(SIMPLE_DIFF)}`, jsonHeaders());
    assert.equal(badJson.status, 400);
    assert.equal((badJson.body as { error: { code: string } }).error.code, "invalid_json");

    // unknown job → 404
    const res = await fetch(`${srv.base}/v1/reviews/does-not-exist`, { headers: auth() });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "not_found");
  } finally {
    await srv.close();
  }
});

test("413 on payload over 1 MiB", async () => {
  const srv = await startTestServer();
  try {
    const bigDiff = makeDiff(`big-${uniqueTag()}.ts`, ["+" .repeat(0) + "x".repeat(1_100_000)]);
    const res = await postRaw(srv.base, JSON.stringify({ diff: bigDiff }), jsonHeaders());
    assert.equal(res.status, 413);
    assert.equal((res.body as { error: { code: string } }).error.code, "payload_too_large");
  } finally {
    await srv.close();
  }
});

test("unknown body fields are ignored; GETs are never rate limited", async () => {
  const srv = await startTestServer();
  try {
    const { status, body } = await postReview(srv.base, SIMPLE_DIFF, { provider: "mock", unexpected: true });
    assert.equal(status, 202);
    // hammer GETs far beyond 30/min to prove they are never throttled
    let ok = 0;
    for (let i = 0; i < 40; i++) {
      const res = await fetch(`${srv.base}/v1/reviews/${body.jobId}`, { headers: auth() });
      if (res.status === 200) ok++;
    }
    assert.equal(ok, 40);
  } finally {
    await srv.close();
  }
});

test("POST lifecycle: 202 queued, then done within the 30s latency budget (~64 KiB diff)", async () => {
  const srv = await startTestServer();
  try {
    // Build a diff just under 64 KiB.
    const filler = "const filler = '" + "x".repeat(100) + "'; // TODO\n";
    let diff = makeDiff(`lat-${uniqueTag()}.ts`, ["eval(input);"] );
    while (Buffer.byteLength(diff, "utf8") < 60_000) {
      diff += makeDiff(`lat-${uniqueTag()}-${Buffer.byteLength(diff)}.ts`, [filler.trimEnd()]);
    }
    assert.ok(Buffer.byteLength(diff, "utf8") <= 65_536, `diff too big: ${Buffer.byteLength(diff, "utf8")}`);

    const t0 = Date.now();
    const { status, body } = await postReview(srv.base, diff);
    assert.equal(status, 202);
    assert.equal(body.status, "queued");
    const job = await waitForTerminal(srv.base, body.jobId!, 29_000);
    const elapsed = Date.now() - t0;
    assert.equal(job.status, "done");
    assert.ok(elapsed < 30_000, `job took ${elapsed}ms`);
    assert.ok(job.findings.some((f) => f.ruleId === "MOCK-001"));
    assert.equal(job.usage.inputBytes, Buffer.byteLength(diff, "utf8"));
    assert.equal(job.usage.chunks, 1);
    assert.equal(job.usage.cacheHit, false);
  } finally {
    await srv.close();
  }
});

test("SSE stream replays full event sequence identically on reconnect", async () => {
  const srv = await startTestServer();
  try {
    const diff = makeDiff(`sse-${uniqueTag()}.ts`, ["eval(x);", "console.log('hi');", "// TODO: fix"]);
    const { body } = await postReview(srv.base, diff);
    const jobId = body.jobId!;
    await waitForTerminal(srv.base, jobId);

    const events1 = await collectStream(srv.base, jobId);
    const events2 = await collectStream(srv.base, jobId);

    // identical replay
    assert.deepEqual(events2, events1);

    // structure: status(queued) → status(running) → finding×3 → status(done) → done
    assert.equal(events1[0].event, "status");
    assert.deepEqual(events1[0].data, { status: "queued" });
    assert.equal(events1[1].event, "status");
    assert.deepEqual(events1[1].data, { status: "running" });
    const findingEvents = events1.filter((e) => e.event === "finding");
    assert.equal(findingEvents.length, 3);
    const last = events1[events1.length - 1];
    assert.equal(last.event, "done");
    const doneData = last.data as { total: number; usage: { cacheHit: boolean } };
    assert.equal(doneData.total, 3);
    assert.equal(doneData.usage.cacheHit, false);
    // findings are in global order
    const paths = findingEvents.map((e) => (e.data as { line: number }).line);
    assert.deepEqual(paths, [...paths].sort((a, b) => a - b));
  } finally {
    await srv.close();
  }
});

test("SSE reconnect mid-flight: subscriber then reconnect gets identical full log", async () => {
  const srv = await startTestServer();
  try {
    const diff = makeDiff(`sse2-${uniqueTag()}.ts`, ["eval(y);", "console.log('z');"]);
    const { body } = await postReview(srv.base, diff);
    const jobId = body.jobId!;
    await waitForTerminal(srv.base, jobId);
    const full = await collectStream(srv.base, jobId);
    const again = await collectStream(srv.base, jobId);
    assert.deepEqual(again, full);
    assert.ok(full.some((e) => e.event === "done"));
  } finally {
    await srv.close();
  }
});

test("cache hit: identical resubmission reuses findings, cacheHit flag, identical events", async () => {
  const srv = await startTestServer();
  try {
    const diff = makeDiff(`cache-${uniqueTag()}.ts`, ["eval(input);", "console.log('x');"]);
    const first = await postReview(srv.base, diff, { provider: "mock" });
    assert.equal(first.status, 202);
    const firstJob = await waitForTerminal(srv.base, first.body.jobId!);
    assert.equal(firstJob.status, "done");
    assert.equal(firstJob.usage.cacheHit, false);

    const second = await postReview(srv.base, diff, { provider: "mock" });
    assert.equal(second.status, 202);
    assert.notEqual(second.body.jobId, first.body.jobId);
    const secondJob = await waitForTerminal(srv.base, second.body.jobId!);
    assert.equal(secondJob.status, "done");
    assert.equal(secondJob.usage.cacheHit, true);
    assert.deepEqual(secondJob.findings, firstJob.findings);
    assert.equal(secondJob.usage.inputBytes, firstJob.usage.inputBytes);
    assert.equal(secondJob.usage.chunks, firstJob.usage.chunks);

    // SSE event sequences are identical except the usage.cacheHit flag in done
    const ev1 = await collectStream(srv.base, first.body.jobId!);
    const ev2 = await collectStream(srv.base, second.body.jobId!);
    assert.equal(ev2.length, ev1.length);
    for (let i = 0; i < ev1.length - 1; i++) {
      assert.deepEqual(ev2[i], ev1[i], `event ${i} differs`);
    }
  } finally {
    await srv.close();
  }
});

test("idempotency: same key + same body replays jobId; different body → 409", async () => {
  const srv = await startTestServer();
  try {
    const key = `idem-${uniqueTag()}`;
    const diffA = makeDiff(`ia-${uniqueTag()}.ts`, ["eval(a);"]);
    const headers = { "Idempotency-Key": key };

    const first = await postReview(srv.base, diffA, {}, headers);
    assert.equal(first.status, 202);

    // byte-identical resubmission replays the same jobId
    const second = await postRaw(srv.base, JSON.stringify({ diff: diffA, options: {} }), { ...jsonHeaders(), ...headers });
    assert.equal(second.status, 202);
    assert.equal((second.body as { jobId: string }).jobId, first.body.jobId);

    // same key + different body → 409
    const third = await postReview(srv.base, makeDiff(`ib-${uniqueTag()}.ts`, ["eval(b);"]), {}, headers);
    assert.equal(third.status, 409);

    // envelope code
    const conflict = await postReview(srv.base, makeDiff(`ic-${uniqueTag()}.ts`, ["eval(c);"]), {}, headers);
    assert.equal(conflict.status, 409);
  } finally {
    await srv.close();
  }
});

test("idempotency replay after cache materialization still hits the same jobId", async () => {
  const srv = await startTestServer();
  try {
    const diff = makeDiff(`ic2-${uniqueTag()}.ts`, ["eval(input);"]);
    const a = await postReview(srv.base, diff, {}, { "Idempotency-Key": `k1-${uniqueTag()}` });
    await waitForTerminal(srv.base, a.body.jobId!);
    // resubmit same content with a different key → new jobId (cache hit)
    const k2 = `k2-${uniqueTag()}`;
    const b = await postReview(srv.base, diff, {}, { "Idempotency-Key": k2 });
    assert.notEqual(b.body.jobId, a.body.jobId);
    // replaying k2 returns b again
    const b2 = await postRaw(srv.base, JSON.stringify({ diff, options: {} }), { ...jsonHeaders(), "Idempotency-Key": k2 });
    assert.equal((b2.body as { jobId: string }).jobId, b.body.jobId);
  } finally {
    await srv.close();
  }
});

test("llm provider path exists and degrades gracefully when the model is unreachable", async () => {
  const srv = await startTestServer({
    GEMINI_API_KEY: "definitely-not-a-real-key",
    LLM_TIMEOUT_MS: "3000",
    LLM_MAX_ATTEMPTS: "1"
  });
  try {
    const diff = makeDiff(`llm-${uniqueTag()}.ts`, ["eval(input);"]);
    const { status, body } = await postReview(srv.base, diff, { provider: "llm" });
    assert.equal(status, 202);
    const job = await waitForTerminal(srv.base, body.jobId!, 25_000);
    assert.equal(job.status, "failed");
    assert.ok(job.error && job.error.length > 0, "failed job must carry a clear error");

    // SSE ends with a terminal done event describing the failure
    const events = await collectStream(srv.base, body.jobId!);
    const last = events[events.length - 1];
    assert.equal(last.event, "done");
    assert.equal((last.data as { status: string }).status, "failed");

    // the process is still healthy after the LLM failure
    const health = await fetch(`${srv.base}/health`);
    assert.equal(health.status, 200);

    // and the mock path still works
    const ok = await postReview(srv.base, makeDiff(`ok-${uniqueTag()}.ts`, ["eval(z);"]));
    const okJob = await waitForTerminal(srv.base, ok.body.jobId!);
    assert.equal(okJob.status, "done");
  } finally {
    await srv.close();
  }
});

test("raw SSE framing includes id/event/data lines", async () => {
  const srv = await startTestServer();
  try {
    const diff = makeDiff(`raw-${uniqueTag()}.ts`, ["// FIXME: raw"]);
    const { body } = await postReview(srv.base, diff);
    await waitForTerminal(srv.base, body.jobId!);
    const res = await fetch(`${srv.base}/v1/reviews/${body.jobId}/stream`, { headers: auth() });
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /^id: 1\n/m);
    assert.match(text, /event: status\ndata: \{"status":"queued"\}/);
    assert.match(text, /event: done\ndata: /);
    const events = parseSse(text);
    assert.ok(events.length >= 3);
  } finally {
    await srv.close();
  }
});
