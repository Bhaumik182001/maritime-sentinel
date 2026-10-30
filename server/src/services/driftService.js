/**
 * driftService.js — Lagrangian Oil Slick Backtracking Engine
 *
 * Physical model:
 *   V_drift = U_current + (alpha * W_wind_rotated)
 *   alpha = 0.032 (3.2% wind leeway factor)
 *   Leeway deflection = 10° clockwise (Northern Hemisphere Coriolis)
 *   Reverse step: centroid(t - dt) = centroid(t) - (V_drift * dt)
 *   Uncertainty buffer: +150 m per hour of backtrack
 *
 * Exports:
 *   backtrackSlick({ slickCentroid, windVector, currentVector, hoursBacktrack=6, stepMinutes=15 })
 *
 * Returns:
 *   {
 *     driftPath: GeoJSON LineString,       // reverse drift centerline
 *     originPolygon: GeoJSON Polygon,      // estimated origin zone at T_start
 *     driftEnvelope: GeoJSON Polygon,      // expanding corridor polygon (full swath)
 *     netDriftKmh: Number,                 // combined net drift speed in km/h
 *     netBearingDeg: Number,               // net drift bearing
 *     totalSteps: Number,
 *     backtrackHours: Number,
 *   }
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const EARTH_RADIUS_KM = 6371;
const ALPHA = 0.032; // Wind leeway factor (3.2%)
const LEEWAY_DEFLECTION_DEG = 10; // Clockwise deflection in Northern Hemisphere
const BUFFER_KM_PER_HOUR = 0.150; // 150 m/hr uncertainty growth
const ORIGIN_POLYGON_POINTS = 32; // Circle approximation resolution
const MIN_BUFFER_KM = 0.05; // Minimum corridor half-width

// ── Geodesic helpers ──────────────────────────────────────────────────────────

/**
 * Convert degrees to radians.
 * @param {number} deg
 * @returns {number}
 */
const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * Convert radians to degrees.
 * @param {number} rad
 * @returns {number}
 */
const toDeg = (rad) => (rad * 180) / Math.PI;

/**
 * Convert speed in knots to km/h.
 * @param {number} knots
 * @returns {number}
 */
export const knotsToKmh = (knots) => knots * 1.852;

/**
 * Compute the destination point given a start point, bearing, and distance.
 * Uses the spherical-Earth (haversine) forward geodesic formula.
 *
 * @param {number} lon       - Start longitude in decimal degrees
 * @param {number} lat       - Start latitude in decimal degrees
 * @param {number} bearingDeg - True bearing in degrees [0, 360)
 * @param {number} distanceKm - Distance to travel in kilometres
 * @returns {[number, number]} Destination [lon, lat] in decimal degrees
 */
export const destPoint = (lon, lat, bearingDeg, distanceKm) => {
  const φ1 = toRad(lat);
  const λ1 = toRad(lon);
  const θ  = toRad(bearingDeg);
  const d  = distanceKm / EARTH_RADIUS_KM; // angular distance in radians

  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(d) +
    Math.cos(φ1) * Math.sin(d) * Math.cos(θ),
  );

  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(d) * Math.cos(φ1),
      Math.cos(d) - Math.sin(φ1) * Math.sin(φ2),
    );

  return [toDeg(λ2), toDeg(φ2)];
};

/**
 * Compute the forward azimuth (bearing) between two geographic points.
 *
 * @param {number} lon1 - Origin longitude
 * @param {number} lat1 - Origin latitude
 * @param {number} lon2 - Destination longitude
 * @param {number} lat2 - Destination latitude
 * @returns {number} Bearing in degrees [0, 360)
 */
export const bearingBetween = (lon1, lat1, lon2, lat2) => {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

  const bearing = toDeg(Math.atan2(y, x));
  return (bearing + 360) % 360;
};

/**
 * Compute the great-circle distance between two geographic points (haversine).
 *
 * @param {number} lon1
 * @param {number} lat1
 * @param {number} lon2
 * @param {number} lat2
 * @returns {number} Distance in kilometres
 */
export const haversineDistKm = (lon1, lat1, lon2, lat2) => {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
};

// ── Vector helpers ────────────────────────────────────────────────────────────

/**
 * Convert a polar speed/bearing vector to Cartesian East/North components.
 * `directionDeg` is the direction the water/wind is moving TOWARD
 * (i.e., the bearing of motion).
 *
 * @param {number} speedKmh    - Speed in km/h
 * @param {number} directionDeg - Direction of travel (bearing toward) in degrees
 * @returns {{ vx: number, vy: number }} East (vx) and North (vy) components in km/h
 */
const polarToCartesian = (speedKmh, directionDeg) => {
  const θ = toRad(directionDeg);
  return {
    vx: speedKmh * Math.sin(θ), // East component
    vy: speedKmh * Math.cos(θ), // North component
  };
};

/**
 * Convert Cartesian (East, North) components back to polar (speed, bearing).
 *
 * @param {number} vx - East component in km/h
 * @param {number} vy - North component in km/h
 * @returns {{ speed: number, bearingDeg: number }}
 */
const cartesianToPolar = (vx, vy) => {
  const speed = Math.sqrt(vx * vx + vy * vy);
  // atan2(East, North) gives bearing from North, clockwise positive
  const bearingDeg = (toDeg(Math.atan2(vx, vy)) + 360) % 360;
  return { speed, bearingDeg };
};

// ── Main backtrack engine ─────────────────────────────────────────────────────

/**
 * Run the Lagrangian backtracking model for an oil slick.
 *
 * @param {object} params
 * @param {[number, number]} params.slickCentroid    - [lon, lat] of detected slick centroid
 * @param {{ speedKts: number, directionDeg: number }} params.windVector    - Wind speed and direction (toward)
 * @param {{ speedKts: number, directionDeg: number }} params.currentVector - Current speed and direction (toward)
 * @param {number} [params.hoursBacktrack=6]         - How many hours to backtrack
 * @param {number} [params.stepMinutes=15]           - Integration step size in minutes
 * @returns {object} Drift analysis result with GeoJSON features and scalar metrics
 */
export const backtrackSlick = ({
  slickCentroid,
  windVector,
  currentVector,
  hoursBacktrack = 6,
  stepMinutes = 15,
}) => {
  // ── Step 1: Compute net drift vector ────────────────────────────────────────

  // Convert wind speed to km/h and apply leeway factor + clockwise deflection.
  // The 10° clockwise deflection means the effective wind-driven drift direction
  // is rotated +10° from the wind direction (in bearing convention, clockwise is +).
  const windSpeedKmh = knotsToKmh(windVector.speedKts);
  const windEffectiveBearingDeg = (windVector.directionDeg + LEEWAY_DEFLECTION_DEG + 360) % 360;
  const windEffectiveSpeedKmh = windSpeedKmh * ALPHA;

  const windCartesian = polarToCartesian(windEffectiveSpeedKmh, windEffectiveBearingDeg);

  // Convert current speed to km/h (no deflection applied to current).
  const currentSpeedKmh = knotsToKmh(currentVector.speedKts);
  const currentCartesian = polarToCartesian(currentSpeedKmh, currentVector.directionDeg);

  // Sum to get net drift vector.
  const vxNet = windCartesian.vx + currentCartesian.vx;
  const vyNet = windCartesian.vy + currentCartesian.vy;

  const { speed: netDriftKmh, bearingDeg: netBearingDeg } = cartesianToPolar(vxNet, vyNet);

  // Reverse bearing: we step BACKWARD along the drift path.
  const bearingReverse = (netBearingDeg + 180) % 360;

  // ── Step 2: Backtrack loop ───────────────────────────────────────────────────

  const totalSteps = Math.round((hoursBacktrack * 60) / stepMinutes);
  const dt = stepMinutes / 60; // hours per step

  /** @type {[number, number][]} */
  const pathCoords = [slickCentroid]; // T_detect is index 0

  /** @type {{ point: [number, number], bufferRadiusKm: number, step: number }[]} */
  const stepData = [];

  // Push step data for t=0 (the slick detection point itself).
  // At t=0, elapsed = 0 h → buffer = 0 km (we use min buffer below).
  stepData.push({
    point: slickCentroid,
    bufferRadiusKm: 0, // will be clamped to MIN_BUFFER_KM in polygon construction
    step: 0,
  });

  let currentCentroid = slickCentroid;

  for (let step = 1; step <= totalSteps; step++) {
    const distanceKm = netDriftKmh * dt;

    // Move centroid backward along the reverse drift bearing.
    const nextCentroid = destPoint(
      currentCentroid[0],
      currentCentroid[1],
      bearingReverse,
      distanceKm,
    );

    const elapsedHours = step * dt;
    const bufferRadiusKm = elapsedHours * BUFFER_KM_PER_HOUR;

    pathCoords.push(nextCentroid);
    stepData.push({ point: nextCentroid, bufferRadiusKm, step });

    currentCentroid = nextCentroid;
  }

  // pathCoords[0] = slick detection point (T_detect)
  // pathCoords[last] = estimated origin point (T_start)
  const originPoint = pathCoords[pathCoords.length - 1];

  // ── Step 3: Build output polygons ────────────────────────────────────────────

  // Origin polygon: circle around the final backtrack point.
  const originRadiusKm = hoursBacktrack * BUFFER_KM_PER_HOUR;
  const originRing = [];
  const angleStep = 360 / ORIGIN_POLYGON_POINTS;
  for (let i = 0; i < ORIGIN_POLYGON_POINTS; i++) {
    originRing.push(destPoint(originPoint[0], originPoint[1], i * angleStep, originRadiusKm));
  }
  // Close the ring.
  originRing.push(originRing[0]);

  // Drift envelope: expanding corridor polygon.
  // Perpendicular bearings relative to the NET drift direction
  // (the actual travel direction of the slick while drifting forward).
  const perpRight = (netBearingDeg + 90) % 360;
  const perpLeft  = (netBearingDeg + 270) % 360;

  const rightPoints = stepData.map((s) =>
    destPoint(s.point[0], s.point[1], perpRight, Math.max(s.bufferRadiusKm, MIN_BUFFER_KM)),
  );
  const leftPoints = stepData.map((s) =>
    destPoint(s.point[0], s.point[1], perpLeft, Math.max(s.bufferRadiusKm, MIN_BUFFER_KM)),
  );

  // Closed ring: right side forward → left side reversed → close
  const envelopeRing = [
    ...rightPoints,
    ...leftPoints.reverse(),
    rightPoints[0],
  ];

  // ── Step 4: Assemble GeoJSON features ────────────────────────────────────────

  const driftPath = {
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: pathCoords,
    },
    properties: {
      type: 'drift-path',
      featureRole: 'drift-path',
      netDriftKmh,
      netBearingDeg,
      hoursBacktrack,
      stepMinutes,
    },
  };

  const originPolygon = {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [originRing],
    },
    properties: {
      type: 'origin-zone',
      featureRole: 'origin-zone',
      radiusKm: originRadiusKm,
      centroid: originPoint,
    },
  };

  const driftEnvelope = {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [envelopeRing],
    },
    properties: {
      type: 'drift-envelope',
      featureRole: 'drift-envelope',
      hoursBacktrack,
      bufferKmPerHour: BUFFER_KM_PER_HOUR,
    },
  };

  return {
    driftPath,
    originPolygon,
    driftEnvelope,
    netDriftKmh,
    netBearingDeg,
    totalSteps,
    backtrackHours: hoursBacktrack,
  };
};
