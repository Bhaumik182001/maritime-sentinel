/**
 * replayGenerator.js — Realistic Synthetic AIS Replay Engine
 *
 * Simulates maritime traffic off the Mumbai coast (Arabian Sea) and pipes
 * every ping through ingestionService for dual-write to Redis + MongoDB.
 *
 * Usage:  npm run replay
 *         REPLAY_PINGS=5000 npm run replay   (override ping count)
 *
 * Fleet:
 *   • 1 Culprit tanker   (TMT_PACIFIC / 412345678) — crosses the slick polygon
 *   • 1 Near-miss cargo  (INDIRA GLORY / 419876543) — passes 1.5 km west
 *   • 8 Background ships (tugs, containers, anchored bulkers)
 */

import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mongoose from "mongoose";
import {
  ingestBatch,
  finalFlush,
  resetCounters,
} from "../services/ingestionService.js";

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const MONGO_URI =
  process.env.MONGO_URI || "mongodb://localhost:27017/maritime_surveillance";

// ── Bounding box: Arabian Sea offshore Mumbai ─────────────────────────────────

const LON_MIN = 72.75;
const LON_MAX = 72.90;
const LAT_MIN = 18.80;
const LAT_MAX = 19.00;

// ── Replay window (matches preset 1 in Sidebar.jsx) ──────────────────────────

const WINDOW_START = new Date("2026-10-29T05:00:00Z");
const WINDOW_END   = new Date("2026-10-29T08:00:00Z"); // 3-hour window
const INTERVAL_MS  = 60_000; // 1-minute AIS ping interval

// Total minutes in window → max pings per vessel
const WINDOW_MINUTES = Math.round((WINDOW_END - WINDOW_START) / INTERVAL_MS);

// ── Slick polygon centre ──────────────────────────────────────────────────────

const SLICK_LON_MIN = 72.820;
const SLICK_LON_MAX = 72.840;
const SLICK_LAT_MIN = 18.880;
const SLICK_LAT_MAX = 18.930;
const SLICK_LON_MID = (SLICK_LON_MIN + SLICK_LON_MAX) / 2; // 72.830
const SLICK_LAT_MID = (SLICK_LAT_MIN + SLICK_LAT_MAX) / 2; // 18.905

// ── Helpers ───────────────────────────────────────────────────────────────────

const clamp  = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const lerp   = (a, b, t)   => a + (b - a) * t;
const jitter = (scale)     => (Math.random() - 0.5) * 2 * scale;

/**
 * Interpolate a vessel from [startLon, startLat] to [endLon, endLat] over the
 * full replay window, emitting one ping per minute with realistic SOG noise.
 */
const buildLinearTrack = (vessel, startLon, startLat, endLon, endLat) => {
  const pings = [];
  for (let m = 0; m < WINDOW_MINUTES; m++) {
    const t   = m / Math.max(WINDOW_MINUTES - 1, 1);
    const lon = clamp(lerp(startLon, endLon, t) + jitter(0.0005), LON_MIN, LON_MAX);
    const lat = clamp(lerp(startLat, endLat, t) + jitter(0.0005), LAT_MIN, LAT_MAX);
    const sog = clamp(vessel.baseSog + jitter(1.0), 0, 25);
    const cog = vessel.baseCog + jitter(3);

    pings.push({
      mmsi:       vessel.mmsi,
      vesselName: vessel.name,
      timestamp:  new Date(WINDOW_START.getTime() + m * INTERVAL_MS),
      sog,
      cog: (cog + 360) % 360,
      location: { type: "Point", coordinates: [lon, lat] },
    });
  }
  return pings;
};

/**
 * Build an anchored vessel that jitters around a fixed position.
 */
const buildAnchoredTrack = (vessel, anchorLon, anchorLat) => {
  const pings = [];
  for (let m = 0; m < WINDOW_MINUTES; m++) {
    pings.push({
      mmsi:       vessel.mmsi,
      vesselName: vessel.name,
      timestamp:  new Date(WINDOW_START.getTime() + m * INTERVAL_MS),
      sog:        clamp(jitter(0.3), 0, 1),
      cog:        Math.random() * 360,
      location: {
        type: "Point",
        coordinates: [
          clamp(anchorLon + jitter(0.0003), LON_MIN, LON_MAX),
          clamp(anchorLat + jitter(0.0003), LAT_MIN, LAT_MAX),
        ],
      },
    });
  }
  return pings;
};

// ── Fleet definition ──────────────────────────────────────────────────────────

/*
 * Culprit tanker: enters from south-west at t=0, crosses through the slick
 * polygon centre around t=0.33 (1-hour mark), exits north-east.
 */
const CULPRIT = { mmsi: "412345678", name: "TMT PACIFIC", baseSog: 9.5, baseCog: 45 };

/*
 * Near-miss cargo: parallel track 1.5 km west of the slick (Δlon ≈ -0.014°).
 * 1° longitude ≈ 109 km at 19°N  →  1.5 km ≈ 0.0138°.
 */
const NEAR_MISS = { mmsi: "419876543", name: "INDIRA GLORY", baseSog: 12.0, baseCog: 20 };

const BACKGROUND = [
  { mmsi: "419000001", name: "MUMBAI TUG 1",       baseSog: 6.0,  baseCog: 90  },
  { mmsi: "419000002", name: "MUMBAI TUG 2",       baseSog: 5.5,  baseCog: 270 },
  { mmsi: "419000003", name: "EVER LOTUS",         baseSog: 14.0, baseCog: 180 },
  { mmsi: "419000004", name: "MSC RANI",           baseSog: 13.5, baseCog: 355 },
  { mmsi: "419000005", name: "APL DECCAN",         baseSog: 11.0, baseCog: 200 },
  { mmsi: "419000006", name: "NHAVA SHEVA SPIRIT", baseSog: 8.0,  baseCog: 130 },
  // Two anchored bulkers — near shipping anchorage north of the slick
  { mmsi: "419000007", name: "IRON BULKER I",      baseSog: 0,    baseCog: 0,  anchored: true, anchorLon: 72.870, anchorLat: 18.970 },
  { mmsi: "419000008", name: "IRON BULKER II",     baseSog: 0,    baseCog: 0,  anchored: true, anchorLon: 72.855, anchorLat: 18.960 },
];

// ── Track generation ──────────────────────────────────────────────────────────

const generateAllPings = () => {
  const all = [];

  // Culprit: enters SW corner [72.760, 18.820], exits NE [72.880, 18.960]
  // Mid-point at t≈0.33 lands squarely on [SLICK_LON_MID, SLICK_LAT_MID]
  all.push(...buildLinearTrack(CULPRIT, 72.760, 18.820, 72.880, 18.960));

  // Near-miss: parallel track 0.014° west of slick centre
  all.push(
    ...buildLinearTrack(
      NEAR_MISS,
      72.760 - 0.014, 18.820,
      72.870 - 0.014, 18.960,
    ),
  );

  // Background vessels — spread across the bounding box
  const tracks = [
    [[72.750, 18.850], [72.890, 18.850]],  // tug 1: E–W transit
    [[72.890, 18.900], [72.760, 18.900]],  // tug 2: W–E transit
    [[72.800, 18.800], [72.800, 19.000]],  // EVER LOTUS: N transit
    [[72.820, 19.000], [72.820, 18.800]],  // MSC RANI:   S transit
    [[72.850, 18.810], [72.760, 18.990]],  // APL DECCAN: diagonal
    [[72.760, 18.950], [72.880, 18.830]],  // NHAVA SHEVA: diagonal
  ];

  BACKGROUND.forEach((vessel, i) => {
    if (vessel.anchored) {
      all.push(...buildAnchoredTrack(vessel, vessel.anchorLon, vessel.anchorLat));
    } else {
      const [[sLon, sLat], [eLon, eLat]] = tracks[i];
      all.push(...buildLinearTrack(vessel, sLon, sLat, eLon, eLat));
    }
  });

  // Sort chronologically before ingestion so the buffer is always ordered
  all.sort((a, b) => a.timestamp - b.timestamp);
  return all;
};

// ── Main ──────────────────────────────────────────────────────────────────────

const run = async () => {
  console.log("[Replay] Connecting to MongoDB…");
  await mongoose.connect(MONGO_URI);
  console.log("[Replay] Connected.");

  const pings = generateAllPings();
  const totalPings = pings.length;

  console.log(
    `[Replay] Generating ${totalPings} AIS pings across ${10} vessels ` +
    `(window: ${WINDOW_START.toISOString()} → ${WINDOW_END.toISOString()})`,
  );
  console.log("[Replay] Piping through ingestionService…\n");

  resetCounters();
  await ingestBatch(pings);
  const { totalIngested, elapsedS, rate } = await finalFlush();

  console.log(
    `\n\n[Replay Complete] Ingested ${totalIngested} / ${totalPings} pings ` +
    `in ${elapsedS.toFixed(2)}s — ${rate} pings/sec`,
  );

  if (totalIngested !== totalPings) {
    console.warn(
      `[Replay] ⚠  Data loss detected: ${totalPings - totalIngested} pings not confirmed.`,
    );
  } else {
    console.log("[Replay] ✓  Zero data loss confirmed.");
  }

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error("[Replay Fatal]:", err.message);
  process.exit(1);
});
