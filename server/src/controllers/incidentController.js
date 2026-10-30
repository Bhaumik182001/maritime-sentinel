import crypto from "crypto";
import Telemetry from "../models/Telemetry.js";
import redis from "../config/redis.js";
import { backtrackSlick, haversineDistKm } from "../services/driftService.js";

/** TTL for cached correlation results in Redis (seconds). */
const CACHE_TTL_S = 60;

/** Redis key prefix for correlation response cache. */
const CACHE_PREFIX = "cache:incident:";

/** Redis key prefix for drift-enabled correlation response cache. */
const DRIFT_CACHE_PREFIX = "cache:incident:drift:";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Produce a stable SHA-256 hex hash of { slickGeometry, timeWindow, driftParams }
 * so that identical requests always map to the same cache key regardless of
 * property ordering in the JSON body.
 */
const hashRequest = ({ slickGeometry, timeWindow, driftParams }) => {
  const canonical = JSON.stringify({
    g: slickGeometry,
    s: timeWindow.startTime instanceof Date
      ? timeWindow.startTime.toISOString()
      : timeWindow.startTime,
    e: timeWindow.endTime instanceof Date
      ? timeWindow.endTime.toISOString()
      : timeWindow.endTime,
    d: driftParams ? {
      enabled: driftParams.enabled === true,
      hoursBacktrack: Number(driftParams.hoursBacktrack || 6),
      wind: driftParams.wind,
      current: driftParams.current,
    } : null,
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
    const { slickGeometry, timeWindow, driftParams } = req.body;

    const startTime = new Date(timeWindow.startTime);
    const endTime   = new Date(timeWindow.endTime);

    // ── Cache look-up ─────────────────────────────────────────────────────────
    const isDrift = driftParams?.enabled === true;
    const effectiveCachePrefix = isDrift ? DRIFT_CACHE_PREFIX : CACHE_PREFIX;
    const cacheKey = effectiveCachePrefix + hashRequest({
      slickGeometry,
      timeWindow,
      driftParams: isDrift ? driftParams : null,
    });

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

    // ── Drift backtrack computation (when enabled) ────────────────────────────

    let driftResult = null;
    let queryGeometry = slickGeometry; // default: query against the slick polygon itself

    if (isDrift) {
      // Compute slick centroid from outer ring (exclude closing duplicate vertex).
      const outerRing = slickGeometry.coordinates[0];
      const uniquePoints = outerRing.slice(0, outerRing.length - 1);
      const centroid = [
        uniquePoints.reduce((sum, c) => sum + c[0], 0) / uniquePoints.length,
        uniquePoints.reduce((sum, c) => sum + c[1], 0) / uniquePoints.length,
      ];

      driftResult = backtrackSlick({
        slickCentroid:  centroid,
        windVector:     driftParams.wind,
        currentVector:  driftParams.current,
        hoursBacktrack: driftParams.hoursBacktrack ?? 6,
        stepMinutes:    15,
      });

      // Use the drift envelope polygon for the MongoDB $geoIntersects query
      // so vessels in the upstream drift corridor are captured.
      queryGeometry = driftResult.driftEnvelope.geometry;
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
              $geometry: queryGeometry,
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
            timestamps: "$timestamps",
            sogValues:  "$sogValues",
          },
        },
      },

      // ── Stage 6: Sort final features by firstSeen for deterministic output ─
      {
        $sort: { "properties.firstSeen": 1 },
      },
    ];

    const features = await Telemetry.aggregate(pipeline);

    // ── Drift mode: Forensic Attribution Scoring ──────────────────────────────

    if (isDrift && driftResult) {
      const pathCoords = driftResult.driftPath.geometry.coordinates;
      const detectTime = new Date(timeWindow.endTime);
      const startBacktrack = new Date(
        detectTime.getTime() - (driftParams.hoursBacktrack ?? 6) * 3600 * 1000,
      );

      // Score each vessel feature and enrich its properties.
      const scoredFeatures = features.map((f) => {
        const coords    = f.geometry.coordinates;       // array of [lon, lat]
        const sogValues = f.properties.sogValues ?? [];

        // ── Proximity score (0–40) ──────────────────────────────────────────
        // Minimum haversine distance from any vessel point to any path point.
        let minDistKm = Infinity;
        for (const vPt of coords) {
          for (const pPt of pathCoords) {
            const d = haversineDistKm(vPt[0], vPt[1], pPt[0], pPt[1]);
            if (d < minDistKm) minDistKm = d;
          }
        }
        // 0 km → 40 pts; 4+ km → 0 pts
        const proximityScore = Math.max(0, 40 - minDistKm * 10);

        // ── Temporal alignment score (0–35) ────────────────────────────────
        // Check whether the vessel's observed window overlaps the backtrack interval.
        const firstSeen = new Date(f.properties.firstSeen);
        const lastSeen  = new Date(f.properties.lastSeen);
        const temporalOverlap = firstSeen <= detectTime && lastSeen >= startBacktrack;
        const temporalScore   = temporalOverlap ? 35 : 0;

        // ── SOG anomaly score (0–25) ────────────────────────────────────────
        // A significant speed drop suggests a possible dumping event.
        let sogScore = 0;
        let speedAnomalyDetected = false;
        if (sogValues.length >= 2) {
          const avgSog   = sogValues.reduce((a, b) => a + b, 0) / sogValues.length;
          const minSog   = Math.min(...sogValues);
          const speedDrop = avgSog > 0 ? (avgSog - minSog) / avgSog : 0;
          sogScore = Math.min(25, Math.round(speedDrop * 35));
          if (speedDrop >= 0.3 || sogScore >= 15) {
            speedAnomalyDetected = true;
          }
        }

        const attributionScore = Math.min(
          100,
          Math.round(proximityScore + temporalScore + sogScore),
        );

        // ── Evidence chips ──────────────────────────────────────────────────
        const chips = [];
        if (proximityScore >= 20) chips.push("Spatial Coincidence");
        if (temporalScore > 0)    chips.push("Temporal Synchrony");
        if (speedAnomalyDetected) chips.push("Speed Drop Detected");

        // ── Confidence tier ─────────────────────────────────────────────────
        let confidence = "Low Confidence";
        if (attributionScore >= 80)      confidence = "High Confidence";
        else if (attributionScore >= 55) confidence = "Medium Confidence";
        else if (attributionScore >= 30) confidence = "Low Confidence";

        return {
          ...f,
          properties: {
            ...f.properties,
            // Remove raw arrays from output to keep response lean
            timestamps: undefined,
            sogValues:  undefined,
            attributionScore,
            spatialScore: Math.round(proximityScore),
            temporalScore: Math.round(temporalScore),
            speedAnomaly: speedAnomalyDetected ? "Speed Drop Detected" : false,
            confidence,
            chips,
            proximityToPathKm: parseFloat(minDistKm.toFixed(3)),
            driftAnalysis: true,
          },
        };
      });

      // Sort by attribution score descending (primary suspects first).
      scoredFeatures.sort((a, b) => b.properties.attributionScore - a.properties.attributionScore);

      const featureCollection = {
        type: "FeatureCollection",
        metadata: {
          generatedAt: new Date().toISOString(),
          timeWindow: {
            startTime: startTime.toISOString(),
            endTime:   endTime.toISOString(),
          },
          vesselCount: scoredFeatures.length,
          slickGeometry,
          driftEnabled: true,
          driftParams: {
            hoursBacktrack: driftParams.hoursBacktrack ?? 6,
            wind:           driftParams.wind,
            current:        driftParams.current,
          },
          netDriftKmh:  driftResult.netDriftKmh,
          netBearingDeg: driftResult.netBearingDeg,
        },
        driftPath: driftResult.driftPath,
        driftEnvelope: driftResult.driftEnvelope,
        originZone: driftResult.originPolygon,
        features: [
          // Vessel trajectory features (attribution-scored)
          ...scoredFeatures,
          // Drift analysis overlay features
          driftResult.driftEnvelope,
          driftResult.driftPath,
          driftResult.originPolygon,
          // Original slick polygon for reference
          {
            type: "Feature",
            geometry: slickGeometry,
            properties: { type: "slickPolygon" },
          },
        ],
      };

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
    }

    // ── Standard (non-drift) response ─────────────────────────────────────────

    const cleanFeatures = features.map((f) => ({
      ...f,
      properties: {
        ...f.properties,
        timestamps: undefined,
        sogValues:  undefined,
      },
    }));

    const featureCollection = {
      type: "FeatureCollection",
      metadata: {
        generatedAt: new Date().toISOString(),
        timeWindow: {
          startTime: startTime.toISOString(),
          endTime:   endTime.toISOString(),
        },
        vesselCount: cleanFeatures.length,
        slickGeometry,
      },
      features: cleanFeatures,
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
