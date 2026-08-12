import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { app } = createApp(config);

const server = app.listen(config.port, () => {
  console.log(
    `ai-diff-review-service listening on :${config.port} ` +
      `(concurrency=${config.maxConcurrentJobs}, rate=${config.rateLimitPerMinute}/min, ` +
      `gemini=${config.geminiApiKey ? "configured" : "NOT configured"})`
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    // Never hang on open SSE connections.
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

// The process must never go down on background failures; jobs degrade to
// `failed` instead. Log and keep serving.
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
});
