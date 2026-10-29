import crypto from "crypto";
import Telemetry from "../models/Telemetry.js";
import redis from "../config/redis.js";

/** TTL for cached correlation results in Redis (seconds). */
const CACHE_TTL_S = 60;

/** Redis key prefix for correlation response cache. */
const CACHE_PREFIX = "cache:incident:";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Produce a stable SHA-256 hex hash of { slickGeometry, timeWindow } so that
 * identical requests always map to the same cache key regardless of property
 * ordering in the JSON body.
 */
const hashRequest = ({ slickGeometry, timeWindow }) => {
  const canonical = JSON.stringify({
    g: slickGeometry,
    s: timeWindow.startTime instanceof Date
      ? timeWindow.startTime.toISOString()
      : timeWindow.startTime,
    e: timeWindow.endTime instanceof Date
      ? timeWindow.endTime.toISOString()
      : timeWindow.endTime,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
};

// ── Controllers ───────────────────────────────────────────────────────────────

/**
 * POST /api/v1/incidents/correlate
 *
 * Correlates AIS telemetry data against a GeoJSON Polygon (slick geometry)
 * and a time window to produce a GeoJSON FeatureCollection of vessel
 * trajectories (LineString features) for vessels that intersected the area.
 *
 * Redis caching layer:
 *   • HIT  → return cached JSON immediately (X-Cache: HIT)
 *   • MISS → run 6-stage MongoDB aggregation, cache result for 60 s
 *            (X-Cache: MISS)
 *
 * Request body:
 *   - slickGeometry  {GeoJSON Polygon}  The incident boundary polygon.
 *   - timeWindow     {{ startTime: string, endTime: string }}  ISO 8601 strings.
 */
export const correlateIncident = async (req, res) => {
  try {
    const { slickGeometry, timeWindow } = req.body;

    const startTime = new Date(timeWindow.startTime);
    const endTime   = new Date(timeWindow.endTime);

    // ── Cache look-up ─────────────────────────────────────────────────────────
    const cacheKey = CACHE_PREFIX + hashRequest({ slickGeometry, timeWindow });

    let cached = null;
    try {
      cached = await redis.get(cacheKey);
    } catch (redisErr) {
      // Redis unavailable — degrade gracefully, proceed to MongoDB
      console.warn("[correlateIncident] Redis GET failed:", redisErr.message);
    }

    if (cached) {
      return res
        .status(200)
        .set("X-Cache", "HIT")
        .set("Content-Type", "application/json")
        .send(cached);
    }

    // ── MongoDB aggregation pipeline ──────────────────────────────────────────

    /**
     * Stage 1 – $match with $geoIntersects
     *   MongoDB uses the 2dsphere compound index to efficiently pre-filter
     *   documents whose `location` Point falls within the slick polygon AND
     *   whose `timestamp` falls within the requested window.
     *
     * Stage 2 – $sort (pre-group)
     *   Sort by mmsi then timestamp ascending so that $push in $group produces
     *   coordinates in chronological order without a post-sort.
     *
     * Stage 3 – $group by mmsi
     *   Accumulate per-vessel: coordinates, sog values, firstSeen, lastSeen.
     *
     * Stage 4 – $match (post-group)
     *   Discard vessels with fewer than 2 points (invalid LineString).
     *
     * Stage 5 – $project
     *   Shape into GeoJSON Feature objects.
     *
     * Stage 6 – $sort
     *   Deterministic ordering by firstSeen.
     */
    const pipeline = [
      // ── Stage 1: Spatio-temporal filter ──────────────────────────────────
      {
        $match: {
          location: {
            $geoIntersects: {
              $geometry: slickGeometry,
            },
          },
          timestamp: {
            $gte: startTime,
            $lte: endTime,
          },
        },
      },

      // ── Stage 2: Pre-sort for ordered accumulation ────────────────────────
      {
        $sort: {
          mmsi: 1,
          timestamp: 1,
        },
      },

      // ── Stage 3: Group by vessel ──────────────────────────────────────────
      {
        $group: {
          _id: "$mmsi",
          vesselName: { $first: "$vesselName" },
          coordinates: { $push: "$location.coordinates" },
          timestamps:  { $push: "$timestamp" },
          sogValues:   { $push: "$sog" },
          firstSeen:   { $min: "$timestamp" },
          lastSeen:    { $max: "$timestamp" },
          pointCount:  { $sum: 1 },
        },
      },

      // ── Stage 4: Require at least 2 points for a valid LineString ─────────
      {
        $match: {
          pointCount: { $gte: 2 },
        },
      },

      // ── Stage 5: Project into GeoJSON Feature shape ───────────────────────
      {
        $project: {
          _id: 0,
          type: { $literal: "Feature" },
          geometry: {
            type: { $literal: "LineString" },
            coordinates: "$coordinates",
          },
          properties: {
            mmsi:       "$_id",
            vesselName: "$vesselName",
            avgSpeed:   { $avg: "$sogValues" },
            firstSeen:  "$firstSeen",
            lastSeen:   "$lastSeen",
            pointCount: "$pointCount",
          },
        },
      },

      // ── Stage 6: Sort final features by firstSeen for deterministic output ─
      {
        $sort: { "properties.firstSeen": 1 },
      },
    ];

    const features = await Telemetry.aggregate(pipeline);

    const featureCollection = {
      type: "FeatureCollection",
      metadata: {
        generatedAt: new Date().toISOString(),
        timeWindow: {
          startTime: startTime.toISOString(),
          endTime:   endTime.toISOString(),
        },
        vesselCount: features.length,
        slickGeometry,
      },
      features,
    };

    // ── Cache the result ──────────────────────────────────────────────────────
    const payload = JSON.stringify(featureCollection);
    try {
      await redis.set(cacheKey, payload, "EX", CACHE_TTL_S);
    } catch (redisErr) {
      console.warn("[correlateIncident] Redis SET failed:", redisErr.message);
    }

    return res
      .status(200)
      .set("X-Cache", "MISS")
      .set("Content-Type", "application/json")
      .send(payload);

  } catch (error) {
    console.error("[incidentController] correlateIncident error:", error);

    if (
      error.message?.includes("Point must only contain numeric elements") ||
      error.message?.includes("unknown geo near query type") ||
      error.codeName === "BadValue"
    ) {
      return res.status(400).json({
        error: "Invalid geometry",
        message:
          "slickGeometry contains invalid coordinates or an unsupported GeoJSON type.",
        detail: error.message,
      });
    }

    return res.status(500).json({
      error: "Internal Server Error",
      message: "An unexpected error occurred while correlating the incident.",
    });
  }
};

/**
 * GET /api/v1/incidents/live-vessels?lon=<lon>&lat=<lat>&radiusKm=<radius>
 *
 * Returns all vessels currently tracked in the Redis geospatial index
 * (vessels:latest) within <radiusKm> kilometres of the given point.
 *
 * Queries Redis directly — zero MongoDB I/O, sub-millisecond latency.
 * Enriches each result with the per-vessel metadata hash from vessel:<mmsi>.
 */
export const getLiveVessels = async (req, res) => {
  try {
    const lon      = parseFloat(req.query.lon);
    const lat      = parseFloat(req.query.lat);
    const radiusKm = parseFloat(req.query.radiusKm ?? "10");

    if (isNaN(lon) || isNaN(lat) || isNaN(radiusKm)) {
      return res.status(400).json({
        error: "Bad Request",
        message: "lon, lat, and radiusKm must be numeric query parameters.",
      });
    }

    // GEOSEARCH vessels:latest FROMLONLAT <lon> <lat> BYRADIUS <r> km
    //   WITHCOORD WITHDIST ASC COUNT 200
    // Returns: [ [mmsi, distKm, [lon, lat]], ... ]
    const raw = await redis.call(
      "GEOSEARCH",
      "vessels:latest",
      "FROMLONLAT", lon, lat,
      "BYRADIUS", radiusKm, "km",
      "ASC",
      "COUNT", 200,
      "WITHCOORD",
      "WITHDIST",
    );

    if (!raw || raw.length === 0) {
      return res.status(200).json({
        vessels: [],
        meta: { lon, lat, radiusKm, count: 0 },
      });
    }

    // Enrich each entry with the metadata hash stored at vessel:<mmsi>
    const pipeline = redis.pipeline();
    for (const entry of raw) {
      const mmsi = entry[0];
      pipeline.hgetall(`vessel:${mmsi}`);
    }
    const metaResults = await pipeline.exec();

    const vessels = raw.map(([mmsi, distKm, [vLon, vLat]], i) => {
      const meta = metaResults[i]?.[1] ?? {};
      return {
        mmsi,
        vesselName: meta.vesselName ?? "Unknown",
        distanceKm: parseFloat(parseFloat(distKm).toFixed(3)),
        sog:        parseFloat(meta.sog ?? 0),
        cog:        parseFloat(meta.cog ?? 0),
        lastSeen:   meta.lastSeen ?? null,
        position:   { lon: parseFloat(vLon), lat: parseFloat(vLat) },
      };
    });

    return res.status(200).json({
      vessels,
      meta: { lon, lat, radiusKm, count: vessels.length },
    });

  } catch (error) {
    console.error("[incidentController] getLiveVessels error:", error);
    return res.status(500).json({
      error: "Internal Server Error",
      message: "Failed to query live vessel positions from Redis.",
    });
  }
};
