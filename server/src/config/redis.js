import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

/**
 * Singleton ioredis client.
 *
 * Reconnection strategy: exponential back-off capped at 30 s.
 * The client is lazily connected on first use — no blocking await needed.
 * Import this module anywhere and the same socket is reused.
 */
const redis = new Redis(REDIS_URL, {
  // Exponential back-off: 2^attempt * 50 ms, max 30 000 ms
  retryStrategy(attempt) {
    const delay = Math.min(Math.pow(2, attempt) * 50, 30_000);
    console.warn(
      `[Redis] Reconnection attempt #${attempt} — retrying in ${delay} ms`,
    );
    return delay;
  },

  // Surface connection errors without crashing the process
  lazyConnect: false,

  // Keep-alive so the OS doesn't drop idle connections in Docker
  keepAlive: 10_000,

  // How long to wait on a command before rejecting (ms)
  commandTimeout: 5_000,

  // Do not abort reconnection attempts on ECONNREFUSED — Redis may
  // start after the API container in Docker Compose.
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

redis.on("connect", () => {
  console.log("[Redis] Socket connected.");
});

redis.on("ready", () => {
  console.log(`[Redis] Client ready — ${REDIS_URL}`);
});

redis.on("error", (err) => {
  // Log but never throw — the rest of the app degrades gracefully.
  console.error("[Redis] Error:", err.message);
});

redis.on("close", () => {
  console.warn("[Redis] Connection closed.");
});

redis.on("reconnecting", (ms) => {
  console.warn(`[Redis] Reconnecting in ${ms} ms…`);
});

// Graceful shutdown: flush pending commands and close the socket cleanly.
const gracefulShutdown = async () => {
  try {
    await redis.quit();
    console.log("[Redis] Connection closed gracefully.");
  } catch {
    redis.disconnect();
  }
};
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

export default redis;
