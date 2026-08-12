# AI Diff Review Service (Xsolla take-home)

Production-quality, single-process HTTP service: clients POST a unified diff,
the service reviews it asynchronously and returns structured findings.

- **Runtime:** Node.js (≥20) + TypeScript + Express. One long-running process;
  all state (jobs, findings, SSE event logs, idempotency keys, content-hash
  cache, rate-limit counters, concurrency tracking) lives in in-memory Maps.
  No external DB/Redis.
- **Providers:** `mock` (deterministic, no network; this is what gets scored)
  and `llm` (Google Gemini, same pipeline). Selected per request via
  `options.provider`, default `mock`.

## Quick start

```bash
npm install
npm run build
cp .env.example .env     # set API_BEARER_TOKEN (and GEMINI_API_KEY for the llm provider)
npm start                # listens on PORT (default 8080)
```

Run everything:

```bash
npm test                 # 41 tests: contract, mock rules, chunking, load, units
npm run smoke            # boots a real child process and exercises the flows end-to-end
```

## Environment variables

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `API_BEARER_TOKEN` | **yes** | — | Static bearer token for all `/v1/*` routes. |
| `GEMINI_API_KEY` | for `llm` | — | Google AI Studio key. Mock works without it. |
| `PORT` | no | `8080` | HTTP listen port. |

Optional tuning: `GEMINI_MODEL` (default `gemini-3.6-flash`), `LLM_TIMEOUT_MS`,
`LLM_MAX_ATTEMPTS`, `JOB_TIMEOUT_MS`, `MOCK_CHUNK_DELAY_MS` (test hook),
`LLM_CHUNK_DELAY_MS` (test hook), `RATE_LIMIT_HARD_CAP` (default 120).

## API

Every `/v1/*` route requires `Authorization: Bearer $API_BEARER_TOKEN`.
`/health` and `/spec` are public. All non-2xx responses use the error envelope
`{ "error": { "code", "message" } }`.

- `GET /health` → `{ status, version, uptimeSeconds }`
- `GET /spec` → self-declared limits (`maxPayloadBytes`, `chunkBytes`,
  `maxConcurrentJobs`, `rateLimitPerMinute`)
- `POST /v1/reviews` — `{ diff, options: { provider?, maxFindings? } }`
  → `202 { jobId, status: "queued" }`.
  `413` > 1 MiB · `400` invalid JSON · `422` invalid diff ·
  `Idempotency-Key` header replays the same `jobId` for a byte-identical body,
  `409` on reuse with a different body. Byte-identical `{diff, options}` returns
  a new job with `usage.cacheHit: true` and identical findings.
- `GET /v1/reviews/{jobId}` → `{ jobId, status, findings, usage: { inputBytes, chunks, cacheHit } }`
  (`404` unknown).
- `GET /v1/reviews/{jobId}/stream` → SSE: `status` on transitions, `finding`
  one per finding, then a terminal `done` (`{ total, usage }`) and close.
  Reconnecting to a finished job replays the full event sequence identically.

Example:

```bash
curl -s -X POST $BASE/v1/reviews \
  -H "Authorization: Bearer $API_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"diff": "..."}'            # → {"jobId":"...","status":"queued"}
curl -s -N $BASE/v1/reviews/<jobId>/stream -H "Authorization: Bearer $API_BEARER_TOKEN"
curl -s $BASE/v1/reviews/<jobId> -H "Authorization: Bearer $API_BEARER_TOKEN"
```

## The `llm` provider (Gemini)

`options.provider: "llm"` routes the same chunked pipeline through Google
Gemini (`gemini-3.6-flash`, `generateContent`, `x-goog-api-key` header, JSON-mode
structured output). Output is validated defensively; any network/timeout/HTTP/parse
failure transitions the job to `status: "failed"` with a clear `error` — it never
crashes the process. Without `GEMINI_API_KEY`, llm jobs fail immediately with a
clear error (the mock path is unaffected).

## Deployment

### Railway (recommended)

The repo includes `railway.json` (Dockerfile builder, `/health` healthcheck).

```bash
railway login && railway init
railway variables set API_BEARER_TOKEN=<secret> GEMINI_API_KEY=<key>
railway up
```

### Fly.io (alternative)

`fly.toml` is included.

```bash
fly launch --no-deploy
fly secrets set API_BEARER_TOKEN=<secret> GEMINI_API_KEY=<key>
fly deploy
```

### Any Docker host

```bash
docker build -t diff-review .
docker run -p 8080:8080 -e API_BEARER_TOKEN=<secret> -e GEMINI_API_KEY=<key> diff-review
```

## Design notes

- **Queue:** POST returns 202 immediately; an in-process FIFO queue runs at
  most 4 jobs concurrently (`maxConcurrentJobs`), the 5th waits its turn.
- **Chunking:** diffs > 64 KiB are split on file boundaries only (`chunkBytes`);
  a single oversized file is its own chunk. Chunk scans concatenate in file
  order, so chunked results are byte-identical to an unchunked scan.
- **Ordering/dedup:** findings are deduped by `id` and ordered by
  `path` (lexicographic) → `line` (asc) → `ruleId`. `maxFindings` truncates the
  ordered list; usage reflects the full scan.
- **SSE replay:** every emitted event is appended to the job's persisted event
  log; connect/reconnect replays the log and then subscribes live, so a finished
  job replays identically every time.
- **Rate limiting:** sliding-window per client (sustained 30/min + burst) plus a
  global hard cap; over the limit → `429` + `Retry-After` + envelope. Never 5xx.

See `SUBMISSION.md` for the architecture write-up and verification approach.
