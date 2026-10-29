import { useState } from 'react'
import {
  Radar,
  Clock,
  Layers,
  Ship,
  Gauge,
  CalendarClock,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ChevronRight,
  MapPin,
} from 'lucide-react'

// ── Preset scenarios (so the demo works without manual input) ────────────────

const PRESETS = [
  {
    label: 'Arabian Sea – Mumbai Offshore (Oct 2026)',
    slickGeometry: {
      type: 'Polygon',
      coordinates: [[
        [72.820, 18.880],
        [72.840, 18.880],
        [72.840, 18.930],
        [72.820, 18.930],
        [72.820, 18.880]
      ]],
    },
    timeWindow: {
      startTime: '2026-10-29T05:00:00Z',
      endTime:   '2026-10-29T08:00:00Z',
    },
  },
  {
    label: 'Arabian Sea – Extended Zone (Oct 2026)',
    slickGeometry: {
      type: 'Polygon',
      coordinates: [[
        [72.790, 18.870],
        [72.870, 18.870],
        [72.870, 18.950],
        [72.790, 18.950],
        [72.790, 18.870],
      ]],
    },
    timeWindow: {
      startTime: '2026-10-29T05:00:00Z',
      endTime:   '2026-10-29T08:00:00Z',
    },
  },
]

// ── Helpers ──────────────────────────────────────────────────────────────────

const fmtTime = (iso) => {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hour12: false, timeZone: 'UTC',
      timeZoneName: 'short',
    })
  } catch {
    return iso
  }
}

const fmtSpeed = (knots) =>
  knots != null ? `${Number(knots).toFixed(1)} kn` : '—'

// ── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  if (status === 'correlated') {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-yellow-400/10 border border-yellow-400/30 text-yellow-300 text-xs font-medium">
        <span className="w-2 h-2 rounded-full bg-yellow-400 pulse-ring" />
        Incident Correlated — High Confidence
        <CheckCircle2 size={13} />
      </div>
    )
  }
  if (status === 'loading') {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-700/50 border border-slate-600/40 text-slate-400 text-xs font-medium">
        <Loader2 size={13} className="radar-spin" />
        Correlating Trajectories…
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-800/70 border border-slate-700/50 text-slate-400 text-xs font-medium">
      <span className="w-2 h-2 rounded-full bg-slate-500" />
      Awaiting Analysis
    </div>
  )
}

function VesselCard({ feature, index, isSelected, onClick }) {
  const p = feature.properties ?? {}
  return (
    <button
      id={`vessel-card-${p.mmsi ?? index}`}
      onClick={onClick}
      className={[
        'card-in w-full text-left rounded-xl border p-4 transition-all duration-200 cursor-pointer group',
        isSelected
          ? 'bg-yellow-400/10 border-yellow-400/40 shadow-[0_0_16px_rgba(250,204,21,0.15)]'
          : 'bg-slate-800/50 border-slate-700/40 hover:bg-slate-700/50 hover:border-slate-600/60',
      ].join(' ')}
      style={{ animationDelay: `${index * 60}ms` }}
      aria-pressed={isSelected}
      aria-label={`Select vessel ${p.vesselName ?? p.mmsi}`}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <div
            className={[
              'flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center',
              isSelected ? 'bg-yellow-400/20' : 'bg-slate-700/70',
            ].join(' ')}
          >
            <Ship
              size={15}
              className={isSelected ? 'text-yellow-400' : 'text-slate-400'}
            />
          </div>
          <div className="min-w-0">
            <p className={[
              'font-semibold text-sm truncate leading-tight',
              isSelected ? 'text-yellow-200' : 'text-slate-100',
            ].join(' ')}>
              {p.vesselName ?? 'Unknown Vessel'}
            </p>
            <p className="text-xs text-slate-500 font-mono mt-0.5">{p.mmsi ?? '—'}</p>
          </div>
        </div>
        <ChevronRight
          size={14}
          className={[
            'flex-shrink-0 mt-1 transition-transform duration-200',
            isSelected
              ? 'text-yellow-400 translate-x-0.5'
              : 'text-slate-600 group-hover:translate-x-0.5 group-hover:text-slate-400',
          ].join(' ')}
        />
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-2">
        <Stat icon={<Gauge size={11} />} label="Avg Speed" value={fmtSpeed(p.avgSpeed)} accent={isSelected} />
        <Stat icon={<Layers size={11} />} label="AIS Points" value={p.pointCount ?? '—'} accent={isSelected} />
        <Stat icon={<CalendarClock size={11} />} label="First Seen" value={fmtTime(p.firstSeen)} accent={isSelected} wide />
        <Stat icon={<CalendarClock size={11} />} label="Last Seen"  value={fmtTime(p.lastSeen)}  accent={isSelected} wide />
      </div>
    </button>
  )
}

function Stat({ icon, label, value, accent, wide }) {
  return (
    <div className={[
      'rounded-lg px-2.5 py-2',
      accent ? 'bg-yellow-400/5' : 'bg-slate-900/60',
      wide ? 'col-span-2' : '',
    ].join(' ')}>
      <div className="flex items-center gap-1 mb-0.5">
        <span className="text-slate-500">{icon}</span>
        <span className="text-slate-500 text-[10px] uppercase tracking-wide">{label}</span>
      </div>
      <p className={[
        'text-xs font-mono font-medium truncate',
        accent ? 'text-yellow-300' : 'text-slate-300',
      ].join(' ')}>
        {value}
      </p>
    </div>
  )
}

function Divider({ label }) {
  return (
    <div className="flex items-center gap-2 my-1">
      <div className="flex-1 h-px bg-slate-800" />
      <span className="text-[10px] text-slate-600 uppercase tracking-widest shrink-0">{label}</span>
      <div className="flex-1 h-px bg-slate-800" />
    </div>
  )
}

// ── Main Component ───────────────────────────────────────────────────────────

/**
 * Sidebar
 *
 * Props:
 *  - loading         {boolean}
 *  - error           {string|null}
 *  - incidentData    {GeoJSON FeatureCollection | null}
 *  - selectedVessel  {Feature | null}
 *  - onCorrelate     {(slickGeometry, timeWindow) => void}
 *  - onSelectVessel  {(Feature | null) => void}
 */
export default function Sidebar({
  loading,
  error,
  incidentData,
  selectedVessel,
  onCorrelate,
  onSelectVessel,
}) {
  const [presetIndex, setPresetIndex] = useState(0)

  const preset = PRESETS[presetIndex]

  const handleCorrelate = () => {
    onCorrelate(preset.slickGeometry, preset.timeWindow)
  }

  const vessels = incidentData?.features?.filter(
    (f) => f.geometry?.type === 'LineString',
  ) ?? []

  const status = loading
    ? 'loading'
    : vessels.length > 0
    ? 'correlated'
    : 'idle'

  return (
    <aside
      id="forensics-sidebar"
      className="
        absolute left-4 top-4 bottom-4 z-10
        w-[340px] flex flex-col
        rounded-2xl overflow-hidden
        border border-slate-800/80
        shadow-[0_8px_48px_rgba(0,0,0,0.6)]
      "
      style={{
        background: 'rgba(2, 8, 23, 0.92)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
      }}
    >
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="px-5 pt-5 pb-4 border-b border-slate-800/80 flex-shrink-0">
        <div className="flex items-center gap-2.5 mb-1">
          <div className="w-8 h-8 rounded-lg bg-yellow-400/10 border border-yellow-400/20 flex items-center justify-center flex-shrink-0">
            <Radar size={16} className="text-yellow-400" />
          </div>
          <div>
            <h1 className="text-[11px] font-semibold text-yellow-400 uppercase tracking-[0.18em] leading-none">
              NTRO Maritime Sentinel
            </h1>
            <p className="text-[10px] text-slate-500 mt-0.5 leading-none">
              Spatio-Temporal Attribution Engine
            </p>
          </div>
        </div>
      </div>

      {/* ── Scrollable Body ─────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto sidebar-scroll px-4 py-4 space-y-4">

        {/* Status */}
        <div className="flex justify-center">
          <StatusBadge status={status} />
        </div>

        <Divider label="Incident Configuration" />

        {/* Preset selector */}
        <div>
          <label className="block text-[10px] text-slate-500 uppercase tracking-widest mb-1.5">
            SAR Slick Scenario
          </label>
          <div className="space-y-1.5">
            {PRESETS.map((p, i) => (
              <button
                key={i}
                id={`preset-${i}`}
                onClick={() => setPresetIndex(i)}
                className={[
                  'w-full text-left px-3 py-2.5 rounded-lg border text-xs transition-all duration-150',
                  i === presetIndex
                    ? 'bg-yellow-400/10 border-yellow-400/30 text-yellow-200'
                    : 'bg-slate-800/50 border-slate-700/40 text-slate-400 hover:bg-slate-700/40 hover:text-slate-300',
                ].join(' ')}
              >
                <div className="flex items-center gap-2">
                  <MapPin size={11} className={i === presetIndex ? 'text-yellow-400' : 'text-slate-600'} />
                  {p.label}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Geometry preview */}
        <div className="rounded-lg bg-slate-900/70 border border-slate-800/60 p-3">
          <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-2">Slick Boundary</p>
          <p className="text-xs font-mono text-slate-400 leading-relaxed break-all line-clamp-3">
            {JSON.stringify(preset.slickGeometry.coordinates[0].map(
              ([ln, lt]) => `[${ln.toFixed(2)}, ${lt.toFixed(2)}]`
            ))}
          </p>
        </div>

        {/* Time window */}
        <div className="rounded-lg bg-slate-900/70 border border-slate-800/60 p-3 space-y-2">
          <p className="text-[10px] text-slate-500 uppercase tracking-widest">Analysis Window</p>
          <div className="flex items-center gap-2 text-xs">
            <Clock size={11} className="text-slate-500 flex-shrink-0" />
            <span className="font-mono text-slate-400">{preset.timeWindow.startTime}</span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <Clock size={11} className="text-slate-500 flex-shrink-0" />
            <span className="font-mono text-slate-400">{preset.timeWindow.endTime}</span>
          </div>
        </div>

        {/* Correlate button */}
        <button
          id="correlate-btn"
          onClick={handleCorrelate}
          disabled={loading}
          className="
            w-full flex items-center justify-center gap-2.5
            py-3 px-4 rounded-xl
            bg-yellow-400 hover:bg-yellow-300
            disabled:bg-yellow-400/30 disabled:cursor-not-allowed
            text-slate-900 font-semibold text-sm
            transition-all duration-200
            shadow-[0_0_20px_rgba(250,204,21,0.25)]
            hover:shadow-[0_0_28px_rgba(250,204,21,0.4)]
            active:scale-[0.98]
          "
        >
          {loading ? (
            <>
              <Loader2 size={15} className="radar-spin" />
              Correlating…
            </>
          ) : (
            <>
              <Radar size={15} />
              Correlate Spatio-Temporal Intersections
            </>
          )}
        </button>

        {/* Error state */}
        {error && (
          <div className="flex items-start gap-2.5 rounded-lg bg-red-500/10 border border-red-500/30 p-3 card-in">
            <AlertTriangle size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-red-400 leading-relaxed">{error}</p>
          </div>
        )}

        {/* Metadata summary */}
        {incidentData?.metadata && !loading && (
          <>
            <Divider label="Correlation Results" />
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-slate-900/70 border border-slate-800/60 p-3 text-center">
                <p className="text-2xl font-bold text-yellow-400">{incidentData.metadata.vesselCount ?? 0}</p>
                <p className="text-[10px] text-slate-500 mt-0.5 uppercase tracking-wide">Suspects</p>
              </div>
              <div className="rounded-lg bg-slate-900/70 border border-slate-800/60 p-3 text-center">
                <p className="text-2xl font-bold text-slate-200">
                  {vessels.reduce((s, f) => s + (f.properties?.pointCount ?? 0), 0)}
                </p>
                <p className="text-[10px] text-slate-500 mt-0.5 uppercase tracking-wide">AIS Points</p>
              </div>
            </div>
          </>
        )}

        {/* Vessel cards */}
        {vessels.length > 0 && !loading && (
          <>
            <Divider label="Suspect Vessels" />
            <div className="space-y-2">
              {vessels.map((feature, i) => (
                <VesselCard
                  key={feature.properties?.mmsi ?? i}
                  feature={feature}
                  index={i}
                  isSelected={
                    selectedVessel?.properties?.mmsi === feature.properties?.mmsi
                  }
                  onClick={() => {
                    onSelectVessel(
                      selectedVessel?.properties?.mmsi === feature.properties?.mmsi
                        ? null
                        : feature
                    )
                  }}
                />
              ))}
            </div>
          </>
        )}

        {/* Empty state after correlation */}
        {!loading && !error && incidentData && vessels.length === 0 && (
          <div className="rounded-xl border border-slate-800/60 bg-slate-900/40 p-6 text-center">
            <Ship size={28} className="text-slate-600 mx-auto mb-2" />
            <p className="text-sm text-slate-500">No vessels intersected this zone during the selected window.</p>
          </div>
        )}
      </div>

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <div className="px-5 py-3 border-t border-slate-800/80 flex-shrink-0">
        <p className="text-[10px] text-slate-600 text-center">
          Maritime Sentinel v3.0 · NTRO Classified · {new Date().getFullYear()}
        </p>
      </div>
    </aside>
  )
}
