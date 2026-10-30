/**
 * liveAisStream.js — Live AIS Telemetry Ingestion Client
 *
 * Connects to the AISStream WebSocket stream and ingests real-time position
 * reports for high-density shipping lanes into the Maritime Sentinel ingestion
 * pipeline (Redis geospatial cache + micro-batched MongoDB persistence).
 *
 * Security note:
 *   Reads API key exclusively from process.env.AISSTREAM_API_KEY.
 *   Never hardcode credentials or commit keys.
 *
 * Usage:
 *   npm run ingest:live
 */

import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import WebSocket from "ws";
import mongoose from "mongoose";
import { ingestPing, finalFlush, resetCounters } from "../services/ingestionService.js";

// ── Bootstrap environment ─────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Check both local server/.env and workspace root .env
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config();

const AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream";
const MONGO_URI =
  process.env.MONGO_URI || "mongodb://localhost:27017/maritime_surveillance";

const API_KEY = process.env.AISSTREAM_API_KEY;
if (!API_KEY) {
  console.error(
    "\n[AISStream Fatal]: AISSTREAM_API_KEY environment variable is required.\n" +
    "Please define AISSTREAM_API_KEY in server/.env or your environment variables.\n"
  );
  process.exit(1);
}

// ── Bounding boxes ────────────────────────────────────────────────────────────

// 1. Arabian Sea / Mumbai offshore: [[[17.5, 71.0], [20.5, 74.0]]]
// 2. Singapore / Malacca Strait:    [[[1.0, 102.5], [2.5, 104.8]]] (continuous high density)
const BOUNDING_BOXES = [
  [[17.5, 71.0], [20.5, 74.0]],
  [[1.0, 102.5], [2.5, 104.8]],
];

// ── Stream state & metrics ────────────────────────────────────────────────────

let ws = null;
let reconnectTimer = null;
let metricsTimer = null;
let retryCount = 0;
const INITIAL_RETRY_MS = 1000;
const MAX_RETRY_MS = 30000;

let totalProcessed = 0;
let windowProcessed = 0;
let streamStartTime = null;
let isShuttingDown = false;

// ── Metrics reporter (every 10s) ──────────────────────────────────────────────

const startMetricsTimer = () => {
  if (metricsTimer) clearInterval(metricsTimer);
  metricsTimer = setInterval(() => {
    if (!streamStartTime) return;
    const elapsedTotalS = (Date.now() - streamStartTime) / 1000;
    const overallRate = elapsedTotalS > 0 ? (totalProcessed / elapsedTotalS).toFixed(1) : "0.0";
    const windowRate = (windowProcessed / 10).toFixed(1);

    console.log(
      `[Live AIS Stream] Total Ingested: ${totalProcessed} | ` +
      `Last 10s: ${windowRate} pings/sec | ` +
      `Avg: ${overallRate} pings/sec | ` +
      `Status: Connected`
    );
    windowProcessed = 0;
  }, 10000);
};

// ── Normalization & Ingestion ─────────────────────────────────────────────────

const processMessage = async (rawMessage) => {
  try {
    const data = JSON.parse(rawMessage);

    // Filter exclusively for PositionReport message types
    if (data.MessageType !== "PositionReport") {
      return;
    }

    const metadata = data.MetaData || data.metadata || {};
    const report = data.Message?.PositionReport || data.PositionReport || {};

    const mmsi = String(metadata.MMSI || report.UserID || "").trim();
    const vesselName = (metadata.ShipName || "UNKNOWN").trim();
    const lon = parseFloat(report.Longitude ?? metadata.longitude);
    const lat = parseFloat(report.Latitude ?? metadata.latitude);
    const sog = parseFloat(report.Sog ?? 0);
    const cog = parseFloat(report.Cog ?? 0);

    let timestamp = new Date(metadata.time_utc || Date.now());
    if (isNaN(timestamp.getTime())) {
      timestamp = new Date();
    }

    // Validate coordinates (-180 <= lon <= 180, -90 <= lat <= 90)
    if (!mmsi || isNaN(lon) || isNaN(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
      return;
    }

    const ping = {
      mmsi,
      vesselName,
      timestamp,
      sog: isNaN(sog) ? 0 : Math.max(0, sog),
      cog: isNaN(cog) ? 0 : (cog + 360) % 360,
      location: {
        type: "Point",
        coordinates: [lon, lat], // GeoJSON order: [longitude, latitude]
      },
    };

    // Forward to ingestion pipeline (writes to Redis vessels:latest + micro-batched MongoDB)
    await ingestPing(ping);

    totalProcessed++;
    windowProcessed++;
  } catch (err) {
    // Malformed JSON or socket frame error
    console.warn("[Live AIS Stream] Message processing error:", err.message);
  }
};

// ── WebSocket Connection Manager ──────────────────────────────────────────────

const connectWebSocket = () => {
  if (isShuttingDown) return;

  console.log(`[Live AIS Stream] Connecting to ${AISSTREAM_URL}...`);

  ws = new WebSocket(AISSTREAM_URL);

  ws.on("open", () => {
    console.log("[Live AIS Stream] ✓ WebSocket connected. Authenticating and subscribing...");
    retryCount = 0;
    if (!streamStartTime) {
      streamStartTime = Date.now();
      resetCounters();
    }

    // Subscription payload with APIKey, BoundingBoxes, and FilterMessageTypes
    const subscriptionMessage = {
      APIKey: API_KEY,
      BoundingBoxes: BOUNDING_BOXES,
      FilterMessageTypes: ["PositionReport"],
    };

    ws.send(JSON.stringify(subscriptionMessage));
    console.log(
      `[Live AIS Stream] Subscribed to ${BOUNDING_BOXES.length} commercial corridors:\n` +
      `  • Arabian Sea / Mumbai offshore: [[[17.5, 71.0], [20.5, 74.0]]]\n` +
      `  • Singapore / Malacca Strait:    [[[1.0, 102.5], [2.5, 104.8]]]`
    );

    startMetricsTimer();
  });

  ws.on("message", (rawMessage) => {
    processMessage(rawMessage);
  });

  ws.on("error", (err) => {
    console.error(`[Live AIS Stream Error]: ${err.message}`);
  });

  ws.on("close", (code, reason) => {
    if (metricsTimer) clearInterval(metricsTimer);
    if (isShuttingDown) return;

    const reasonStr = reason ? reason.toString() : "Socket dropped";
    console.warn(`[Live AIS Stream] Connection closed (code: ${code}, reason: ${reasonStr}).`);

    // Automatic reconnection with exponential backoff
    retryCount++;
    const delay = Math.min(
      Math.round(INITIAL_RETRY_MS * Math.pow(1.5, retryCount - 1)),
      MAX_RETRY_MS
    );
    console.log(`[Live AIS Stream] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${retryCount})...`);

    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      connectWebSocket();
    }, delay);
  });
};

// ── Graceful Shutdown ─────────────────────────────────────────────────────────

const handleShutdown = async (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[Live AIS Stream] Received ${signal}. Shutting down gracefully...`);

  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (metricsTimer) clearInterval(metricsTimer);

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }

  try {
    console.log("[Live AIS Stream] Flushing pending telemetry buffer...");
    const flushStats = await finalFlush();
    console.log(`[Live AIS Stream] Final flush complete: ${flushStats.totalIngested} pings persisted.`);
  } catch (err) {
    console.error("[Live AIS Stream] Error during final flush:", err.message);
  }

  try {
    await mongoose.disconnect();
    console.log("[Live AIS Stream] MongoDB disconnected.");
  } catch (_) {
    // Ignore error
  }

  console.log(`[Live AIS Stream] Session summary: ${totalProcessed} total pings processed.`);
  process.exit(0);
};

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));

// ── Main Entrypoint ───────────────────────────────────────────────────────────

const start = async () => {
  try {
    console.log("[Live AIS Stream] Connecting to MongoDB...");
    await mongoose.connect(MONGO_URI);
    console.log("[Live AIS Stream] ✓ MongoDB connected.");

    connectWebSocket();
  } catch (err) {
    console.error("[Live AIS Stream Fatal]:", err.message);
    process.exit(1);
  }
};

start();

