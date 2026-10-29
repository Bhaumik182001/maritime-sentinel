import { useEffect, useRef, useCallback } from "react";
import * as maplibregl from "maplibre-gl";

// maplibre-gl v4+ no longer ships a CSP worker bundle.
// `import * as` creates a sealed Module Namespace object — direct property
// assignment throws "Cannot assign to property of [object Module]".
// Defence-in-depth: set config.WORKER_URL (the canonical v4+ API), then
// attempt the legacy workerUrl property inside a try/catch so frozen-
// namespace environments fail silently instead of crashing the app.
const maplibreglInstance = maplibregl.default || maplibregl;
const workerUrl = new URL("/maplibre-gl-worker.mjs", import.meta.url).href;

if (maplibreglInstance.config) {
  maplibreglInstance.config.WORKER_URL = workerUrl;
}
try {
  maplibreglInstance.workerUrl = workerUrl;
} catch {
  // Silently handled on frozen module namespaces
}

// ── Constants ────────────────────────────────────────────────────────────────

const BASEMAP_STYLE =
  'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'

// Dataset centre: Arabian Sea – offshore Mumbai (seeded test data)
const INITIAL_CENTER = [72.834, 18.905]
const INITIAL_ZOOM = 11

const SLICK_SOURCE_ID    = 'oil-slick-source'
const SLICK_FILL_LAYER   = 'oil-slick-fill'
const SLICK_LINE_LAYER   = 'oil-slick-line'

const TRAJ_SOURCE_ID     = 'vessel-trajectories-source'
const TRAJ_LINE_LAYER    = 'vessel-trajectories-line'
const TRAJ_POINT_LAYER   = 'vessel-trajectories-points'

const SELECTED_SOURCE_ID = 'selected-vessel-source'
const SELECTED_LINE_LAYER= 'selected-vessel-line'
const SELECTED_POINT_LAYER='selected-vessel-points'

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a GeoJSON FeatureCollection from the backend response features
 * filtered to only LineString geometries (trajectories).
 */
const buildTrajectoryFC = (features) => ({
  type: 'FeatureCollection',
  features: features.filter((f) => f.geometry?.type === 'LineString'),
})

/**
 * Compute the bounding box of a GeoJSON LineString feature and return a
 * maplibre LngLatBoundsLike array [[minLon, minLat], [maxLon, maxLat]].
 */
const linestringBounds = (feature) => {
  const coords = feature.geometry.coordinates
  let minLon = Infinity, minLat = Infinity
  let maxLon = -Infinity, maxLat = -Infinity
  for (const [lon, lat] of coords) {
    if (lon < minLon) minLon = lon
    if (lat < minLat) minLat = lat
    if (lon > maxLon) maxLon = lon
    if (lat > maxLat) maxLat = lat
  }
  return [[minLon, minLat], [maxLon, maxLat]]
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * MapCanvas
 *
 * Props:
 *  - slickGeometry   {GeoJSON Polygon | null}  The incident polygon to render.
 *  - incidentData    {GeoJSON FeatureCollection | null}  Vessel trajectories.
 *  - selectedVessel  {Feature | null}  The feature to fly to and highlight.
 *  - onMapReady      {(map: maplibregl.Map) => void}  Called once map loads.
 */
export default function MapCanvas({
  slickGeometry,
  incidentData,
  selectedVessel,
  onMapReady,
}) {
  const containerRef = useRef(null)
  const mapRef       = useRef(null)
  const readyRef     = useRef(false)

  // ── Initialise map once ─────────────────────────────────────────────────
  useEffect(() => {
    if (mapRef.current) return

    const map = new maplibreglInstance.Map({
      container: containerRef.current,
      style: BASEMAP_STYLE,
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
      attributionControl: false,
      antialias: true,
    })

    map.addControl(
      new maplibreglInstance.AttributionControl({ compact: true }),
      'bottom-right',
    )
    map.addControl(new maplibreglInstance.NavigationControl(), 'bottom-right')
    map.addControl(new maplibreglInstance.ScaleControl({ unit: 'nautical' }), 'bottom-left')

    map.on('load', () => {
      // ── Oil Slick sources & layers ─────────────────────────────────────
      map.addSource(SLICK_SOURCE_ID, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })

      map.addLayer({
        id: SLICK_FILL_LAYER,
        type: 'fill',
        source: SLICK_SOURCE_ID,
        paint: {
          'fill-color': '#ef4444',
          'fill-opacity': 0.35,
        },
      })

      map.addLayer({
        id: SLICK_LINE_LAYER,
        type: 'line',
        source: SLICK_SOURCE_ID,
        paint: {
          'line-color': '#dc2626',
          'line-width': 2,
          'line-dasharray': [4, 2],
        },
      })

      // ── Vessel trajectory sources & layers ────────────────────────────
      map.addSource(TRAJ_SOURCE_ID, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })

      map.addLayer({
        id: TRAJ_LINE_LAYER,
        type: 'line',
        source: TRAJ_SOURCE_ID,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#facc15',
          'line-width': 3.5,
          'line-opacity': 0.85,
        },
      })

      map.addLayer({
        id: TRAJ_POINT_LAYER,
        type: 'circle',
        source: TRAJ_SOURCE_ID,
        filter: ['==', '$type', 'LineString'],
        paint: {
          'circle-radius': 3,
          'circle-color': '#facc15',
          'circle-opacity': 0.9,
          'circle-stroke-color': '#1e293b',
          'circle-stroke-width': 1,
        },
      })

      // ── Selected vessel highlight sources & layers ────────────────────
      map.addSource(SELECTED_SOURCE_ID, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })

      map.addLayer({
        id: SELECTED_LINE_LAYER,
        type: 'line',
        source: SELECTED_SOURCE_ID,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': 5,
          'line-opacity': 1,
          'line-blur': 1,
        },
      })

      map.addLayer({
        id: SELECTED_POINT_LAYER,
        type: 'circle',
        source: SELECTED_SOURCE_ID,
        paint: {
          'circle-radius': 5,
          'circle-color': '#ffffff',
          'circle-stroke-color': '#facc15',
          'circle-stroke-width': 2,
        },
      })

      readyRef.current = true
      mapRef.current = map
      onMapReady?.(map)
    })

    mapRef.current = map

    return () => {
      map.remove()
      mapRef.current = null
      readyRef.current = false
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Update oil slick polygon ────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !readyRef.current) return

    const src = map.getSource(SLICK_SOURCE_ID)
    if (!src) return

    if (slickGeometry) {
      src.setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: slickGeometry, properties: {} }],
      })
    } else {
      src.setData({ type: 'FeatureCollection', features: [] })
    }
  }, [slickGeometry])

  // ── Update vessel trajectories ──────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !readyRef.current) return

    const src = map.getSource(TRAJ_SOURCE_ID)
    if (!src) return

    if (incidentData?.features?.length) {
      src.setData(buildTrajectoryFC(incidentData.features))
    } else {
      src.setData({ type: 'FeatureCollection', features: [] })
    }
  }, [incidentData])

  // ── Highlight selected vessel & fit bounds ──────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !readyRef.current) return

    const src = map.getSource(SELECTED_SOURCE_ID)
    if (!src) return

    if (selectedVessel) {
      src.setData({
        type: 'FeatureCollection',
        features: [selectedVessel],
      })

      try {
        const bounds = linestringBounds(selectedVessel)
        map.fitBounds(bounds, { padding: 120, duration: 900, maxZoom: 13 })
      } catch (_) { /* ignore degenerate geometries */ }
    } else {
      src.setData({ type: 'FeatureCollection', features: [] })
    }
  }, [selectedVessel])

  // ── Handle resize when container changes ───────────────────────────────
  const resizeObserver = useRef(null)
  const attachResize = useCallback((el) => {
    if (!el) return
    resizeObserver.current = new ResizeObserver(() => {
      mapRef.current?.resize()
    })
    resizeObserver.current.observe(el)
  }, [])

  return (
    <div
      ref={(el) => {
        containerRef.current = el
        attachResize(el)
      }}
      id="map-canvas"
      className="absolute inset-0 w-full h-full"
      aria-label="Maritime surveillance map"
    />
  )
}
