import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp, type AppContext } from "../app.js";
import { loadConfig, type ServiceConfig } from "../config.js";
import type { Finding } from "../types.js";

export const TOKEN = "test-token-0123456789abcdef";

export interface TestServer {
  base: string;
  server: Server;
  ctx: AppContext;
  close: () => Promise<void>;
}

export function makeEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    API_BEARER_TOKEN: TOKEN,
    GEMINI_API_KEY: "",
    PORT: "0",
    MOCK_CHUNK_DELAY_MS: "0",
    ...overrides
  };
}

export async function startTestServer(envOverrides: Record<string, string> = {}): Promise<TestServer> {
  const config = loadConfig(makeEnv(envOverrides));
  const ctx = createApp(config);
  const server = ctx.app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    server,
    ctx,
    close: () =>
      new Promise<void>((resolve) => {
        // trackAndDestroy every connection so SSE streams cannot keep the suite alive
        for (const socket of socketsOf(server)) socket.destroy();
        server.close(() => resolve());
      })
  };
}

const sockets = new WeakMap<Server, Set<import("node:net").Socket>>();
function socketsOf(server: Server): Set<import("node:net").Socket> {
  let set = sockets.get(server);
  if (!set) {
    set = new Set();
    sockets.set(server, set);
    server.on("connection", (s) => {
      set!.add(s);
      s.on("close", () => set!.delete(s));
    });
  }
  return set;
}

export function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, ...extra };
}

export function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return auth({ "Content-Type": "application/json", ...extra });
}

/** Build a valid unified diff for a single file with the given added lines. */
export function makeDiff(
  path: string,
  addedContents: string[],
  opts: { start?: number; contextBefore?: number } = {}
): string {
  const start = opts.start ?? 10;
  const ctxLines = opts.contextBefore ?? 0;
  const ctx: string[] = [];
  for (let i = 0; i < ctxLines; i++) ctx.push(` context-${i}`);
  const oldCount = ctx.length;
  const newCount = addedContents.length + ctx.length;
  const lines = [
    `diff --git a/${path} b/${path}`,
    `index 1111111..2222222 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${start},${oldCount} +${start},${newCount} @@`,
    ...ctx,
    ...addedContents.map((c) => `+${c}`)
  ];
  return lines.join("\n") + "\n";
}

/** Concatenate multiple single-file diffs into one multi-file diff string. */
export function concatDiffs(...diffs: string[]): string {
  return diffs.map((d) => d.replace(/\n$/, "")).join("\n") + "\n";
}

export interface PostResult {
  status: number;
  headers: Headers;
  body: unknown;
}

export async function postRaw(
  base: string,
  rawBody: string | Buffer,
  headers: Record<string, string> = {}
): Promise<PostResult> {
  const res = await fetch(`${base}/v1/reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, ...headers },
    body: rawBody
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep raw text
  }
  return { status: res.status, headers: res.headers, body };
}

export async function postReview(
  base: string,
  diff: string,
  options: Record<string, unknown> = {},
  headers: Record<string, string> = {}
): Promise<{ status: number; body: { jobId?: string; status?: string } }> {
  const res = await postRaw(base, JSON.stringify({ diff, options }), headers);
  return { status: res.status, body: res.body as { jobId?: string; status?: string } };
}

export interface JobView {
  jobId: string;
  status: string;
  findings: Finding[];
  usage: { inputBytes: number; chunks: number; cacheHit: boolean };
  error?: string;
}

export async function getJob(base: string, jobId: string, headers: Record<string, string> = {}): Promise<JobView> {
  const res = await fetch(`${base}/v1/reviews/${jobId}`, { headers: auth(headers) });
  return (await res.json()) as JobView;
}

export async function waitForTerminal(
  base: string,
  jobId: string,
  timeoutMs = 25_000
): Promise<JobView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await getJob(base, jobId);
    if (job.status === "done" || job.status === "failed") return job;
    if (Date.now() > deadline) {
      throw new Error(`job ${jobId} stuck in ${job.status} for ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

export interface SseEvent {
  id: string | null;
  event: string;
  data: unknown;
}

/** Collect the full SSE stream of a job until the server closes it. */
export async function collectStream(base: string, jobId: string): Promise<SseEvent[]> {
  const res = await fetch(`${base}/v1/reviews/${jobId}/stream`, { headers: auth() });
  const text = await res.text();
  return parseSse(text);
}

/**
 * Connect and stop reading after the first event (simulates a dropped client),
 * returning the partial event list.
 */
export async function collectStreamPrefix(base: string, jobId: string, abortAfterFirstEvent = true): Promise<SseEvent[]> {
  const controller = new AbortController();
  const res = await fetch(`${base}/v1/reviews/${jobId}/stream`, { headers: auth(), signal: controller.signal });
  if (!res.body) throw new Error("no SSE body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: SseEvent[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("event:") && abortAfterFirstEvent) {
        events.push(...parseSse(buffer));
        controller.abort();
        break;
      }
    }
  } catch {
    // aborted on purpose
  }
  return events;
}

export function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split("\n\n")) {
    let id: string | null = null;
    let event: string | null = null;
    let data: string | null = null;
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("id: ")) id = line.slice(4);
      else if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data = line.slice(6);
    }
    if (event !== null && data !== null) {
      events.push({ id, event, data: JSON.parse(data) });
    }
  }
  return events;
}

/** Convenience: unique-ish suffix so parallel tests never share cache keys. */
let counter = 0;
export function uniqueTag(): string {
  return `${Date.now().toString(36)}-${process.pid.toString(36)}-${counter++}`;
}
