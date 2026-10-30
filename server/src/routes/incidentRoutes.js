import { Router } from "express";
import { body, query, validationResult } from "express-validator";
import {
  correlateIncident,
  getLiveVessels,
} from "../controllers/incidentController.js";

const router = Router();

// ── Shared validation helpers ─────────────────────────────────────────────────

/**
 * Validates that a GeoJSON Polygon ring is an array of at least 4 coordinate
 * pairs (3 unique vertices + closing vertex), where each pair is [lon, lat]
 * with lon ∈ [-180, 180] and lat ∈ [-90, 90].
 */
const isValidPolygonRing = (ring) => {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  return ring.every(
    (coord) =>
      Array.isArray(coord) &&
      coord.length === 2 &&
      typeof coord[0] === "number" &&
      typeof coord[1] === "number" &&
      coord[0] >= -180 &&
      coord[0] <= 180 &&
      coord[1] >= -90 &&
      coord[1] <= 90,
  );
};

/**
 * Validates that the first and last coordinate pairs in a ring are identical
 * (the GeoJSON "closed ring" requirement).
 */
const isClosedRing = (ring) => {
  if (!Array.isArray(ring) || ring.length < 2) return false;
  const first = ring[0];
  const last  = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1];
};

/**
 * Middleware that collects express-validator errors and short-circuits with
 * a structured 422 response if any validation failed.
 */
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      error: "Validation Failed",
      errors: errors.array().map((e) => ({
        field:   e.path,
        message: e.msg,
        value:   e.value,
      })),
    });
  }
  next();
};

// ── Validation chains ─────────────────────────────────────────────────────────

// POST /correlate
const validateCorrelateIncident = [
  // ── slickGeometry ──────────────────────────────────────────────────────────
  body("slickGeometry")
    .exists({ checkNull: true })
    .withMessage("slickGeometry is required.")
    .isObject()
    .withMessage("slickGeometry must be a GeoJSON object."),

  body("slickGeometry.type")
    .equals("Polygon")
    .withMessage('slickGeometry.type must be "Polygon".'),

  body("slickGeometry.coordinates")
    .isArray({ min: 1 })
    .withMessage(
      "slickGeometry.coordinates must be a non-empty array of rings.",
    )
    .custom((coordinates) => {
      for (let i = 0; i < coordinates.length; i++) {
        const ring = coordinates[i];
        if (!isValidPolygonRing(ring)) {
          throw new Error(
            `coordinates[${i}] must be an array of at least 4 [lon, lat] pairs ` +
              `with lon ∈ [-180, 180] and lat ∈ [-90, 90].`,
          );
        }
        if (!isClosedRing(ring)) {
          throw new Error(
            `coordinates[${i}] is not a closed ring — ` +
              `the first and last coordinate pairs must be identical.`,
          );
        }
      }
      return true;
    }),

  // ── timeWindow ─────────────────────────────────────────────────────────────
  body("timeWindow")
    .exists({ checkNull: true })
    .withMessage("timeWindow is required.")
    .isObject()
    .withMessage("timeWindow must be an object."),

  body("timeWindow.startTime")
    .exists({ checkNull: true })
    .withMessage("timeWindow.startTime is required.")
    .isISO8601({ strict: true })
    .withMessage("timeWindow.startTime must be a valid ISO 8601 date string.")
    .toDate(),

  body("timeWindow.endTime")
    .exists({ checkNull: true })
    .withMessage("timeWindow.endTime is required.")
    .isISO8601({ strict: true })
    .withMessage("timeWindow.endTime must be a valid ISO 8601 date string.")
    .toDate()
    .custom((endTime, { req }) => {
      const startTime = req.body?.timeWindow?.startTime;
      if (startTime && new Date(endTime) <= new Date(startTime)) {
        throw new Error("timeWindow.endTime must be after timeWindow.startTime.");
      }
      return true;
    }),

  // ── driftParams (all optional) ─────────────────────────────────────────────
  body("driftParams").optional().isObject().withMessage("driftParams must be an object."),
  body("driftParams.enabled").optional().isBoolean().withMessage("driftParams.enabled must be a boolean."),
  body("driftParams.hoursBacktrack").optional().isFloat({ min: 1, max: 48 }).withMessage("driftParams.hoursBacktrack must be between 1 and 48."),
  body("driftParams.wind").optional().isObject(),
  body("driftParams.wind.speedKts").optional().isFloat({ min: 0, max: 100 }),
  body("driftParams.wind.directionDeg").optional().isFloat({ min: 0, max: 360 }),
  body("driftParams.current").optional().isObject(),
  body("driftParams.current.speedKts").optional().isFloat({ min: 0, max: 10 }),
  body("driftParams.current.directionDeg").optional().isFloat({ min: 0, max: 360 }),
];

// GET /live-vessels
const validateLiveVessels = [
  query("lon")
    .exists({ checkNull: true })
    .withMessage("lon query parameter is required.")
    .isFloat({ min: -180, max: 180 })
    .withMessage("lon must be a number between -180 and 180."),

  query("lat")
    .exists({ checkNull: true })
    .withMessage("lat query parameter is required.")
    .isFloat({ min: -90, max: 90 })
    .withMessage("lat must be a number between -90 and 90."),

  query("radiusKm")
    .optional()
    .isFloat({ min: 0.1, max: 500 })
    .withMessage("radiusKm must be a number between 0.1 and 500."),
];

// ── Route definitions ─────────────────────────────────────────────────────────

/**
 * POST /api/v1/incidents/correlate
 *
 * Correlates AIS telemetry against a GeoJSON Polygon + time window.
 * Returns a GeoJSON FeatureCollection of vessel LineString trajectories.
 * Responses are cached in Redis for 60 seconds (X-Cache: HIT / MISS).
 */
router.post(
  "/correlate",
  validateCorrelateIncident,
  handleValidationErrors,
  correlateIncident,
);

/**
 * GET /api/v1/incidents/live-vessels?lon=<lon>&lat=<lat>&radiusKm=<radius>
 *
 * Returns all vessels currently tracked in the Redis geospatial index
 * within radiusKm kilometres of the given point.
 * Served entirely from Redis — zero MongoDB I/O.
 *
 * Example:
 *   GET /api/v1/incidents/live-vessels?lon=72.834&lat=18.905&radiusKm=15
 */
router.get(
  "/live-vessels",
  validateLiveVessels,
  handleValidationErrors,
  getLiveVessels,
);

export default router;
