import Telemetry from "../models/Telemetry.js";
import redis from "../config/redis.js";

// ── Tuning constants ──────────────────────────────────────────────────────────

/** Flush to MongoDB after this many buffered records. */
const FLUSH_THRESHOLD = 500;

/** Flush to MongoDB after this many milliseconds even if buffer is not full. */
const FLUSH_INTERVAL_MS = 1_000;

/** Redis key holding the live GEODATA set (vessels:latest). */
const GEO_KEY = "vessels:latest";

/** TTL for per-vessel metadata hashes in Redis (seconds). */
const VESSEL_TTL_S = 300; // 5 minutes

// ── In-memory write buffer ────────────────────────────────────────────────────

let buffer = [];
let flushTimer = null;
let totalIngested = 0;
let startEpoch = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Write a single AIS ping to Redis:
 *   1. GEOADD vessels:latest <lon> <lat> <mmsi>  — live position index
 *   2. HSET vessel:<mmsi>  — metadata hash with a rolling 5-minute TTL
 *
 * Both commands are pipelined in a single round-trip.
 */
const writeToRedis = async (ping) => {
  const { mmsi, vesselName, sog, cog, timestamp, location } = ping;
  const [lon, lat] = location.coordinates;
  const metaKey = `vessel:${mmsi}`;

  const pipeline = redis.pipeline();

  // Geospatial index — GEORADIUS / GEOSEARCH queries read from here
  pipeline.geoadd(GEO_KEY, lon, lat, mmsi);

  // Per-vessel metadata hash
  pipeline.hset(metaKey, {
    mmsi,
    vesselName: vesselName ?? "Unknown",
    sog: sog ?? 0,
    cog: cog ?? 0,
    lastSeen: timestamp instanceof Date ? timestamp.toISOString() : timestamp,
    lon,
    lat,
  });
  pipeline.expire(metaKey, VESSEL_TTL_S);

  await pipeline.exec();
};

// ── Flush logic ───────────────────────────────────────────────────────────────

/**
 * Flush the in-memory buffer to MongoDB via bulkWrite.
 * Uses { ordered: false } to maximise throughput — failed individual
 * documents do not abort the rest of the batch.
 */
const flushBuffer = async () => {
  if (buffer.length === 0) return;

  const batch = buffer.splice(0, buffer.length); // drain atomically

  const ops = batch.map((doc) => ({
    insertOne: { document: doc },
  }));

  try {
    await Telemetry.bulkWrite(ops, { ordered: false });
    totalIngested += batch.length;

    if (startEpoch) {
      const elapsedS = (Date.now() - startEpoch) / 1_000;
      const rate = (totalIngested / elapsedS).toFixed(0);
      process.stdout.write(
        `\r[Ingestion] ${totalIngested} pings in ${elapsedS.toFixed(2)}s — ${rate} pings/sec   `,
      );
    }
  } catch (err) {
    // BulkWriteError is expected for duplicate-key on ordered:false; log and continue
    if (err.name !== "BulkWriteError") {
      console.error("[IngestionService] bulkWrite fatal error:", err.message);
    }
  }
};

/**
 * Arm (or re-arm) the time-based flush timer.
 * A new timer is only created when the buffer goes from empty → non-empty,
 * preventing multiple concurrent timers.
 */
const armTimer = () => {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    await flushBuffer();
  }, FLUSH_INTERVAL_MS);
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Ingest a single AIS ping.
 *
 * 1. Write to Redis immediately (geospatial index + metadata hash).
 * 2. Push into the in-memory write buffer.
 * 3. Flush to MongoDB if the buffer has reached FLUSH_THRESHOLD.
 *    Otherwise, arm the time-based timer.
 *
 * @param {object} ping  Raw AIS record matching the Telemetry schema.
 */
export const ingestPing = async (ping) => {
  // Redis write is fire-and-forget — failures are logged, not thrown
  writeToRedis(ping).catch((err) =>
    console.error("[IngestionService] Redis write error:", err.message),
  );

  buffer.push(ping);

  if (buffer.length >= FLUSH_THRESHOLD) {
    // Cancel the timer — we are flushing now
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await flushBuffer();
  } else {
    armTimer();
  }
};

/**
 * Ingest an array of AIS pings in one call.
 * Sequential to preserve chronological buffer order.
 *
 * @param {object[]} pings
 */
export const ingestBatch = async (pings) => {
  for (const ping of pings) {
    await ingestPing(ping);
  }
};

/**
 * Force-flush any remaining buffered records and return throughput stats.
 * Call this at the end of a replay/seed run to ensure zero data loss.
 *
 * @returns {{ totalIngested: number, elapsedS: number, rate: number }}
 */
export const finalFlush = async () => {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushBuffer();

  const elapsedS = startEpoch ? (Date.now() - startEpoch) / 1_000 : 0;
  const rate = elapsedS > 0 ? Math.round(totalIngested / elapsedS) : 0;
  return { totalIngested, elapsedS, rate };
};

/**
 * Reset ingestion counters. Call before starting a new replay session.
 */
export const resetCounters = () => {
  totalIngested = 0;
  startEpoch = Date.now();
};
