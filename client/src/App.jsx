import { useState, useCallback } from 'react'
import MapCanvas from './components/MapCanvas.jsx'
import Sidebar from './components/Sidebar.jsx'

const API_BASE = '/api/v1'

export default function App() {
  const [incidentData,   setIncidentData]   = useState(null)
  const [slickGeometry,  setSlickGeometry]  = useState(null)
  const [selectedVessel, setSelectedVessel] = useState(null)
  const [loading,        setLoading]        = useState(false)
  const [error,          setError]          = useState(null)

  /**
   * Called by Sidebar when the user clicks "Correlate".
   * Fires the POST request and updates shared state.
   */
  const handleCorrelate = useCallback(async (geometry, timeWindow) => {
    setLoading(true)
    setError(null)
    setIncidentData(null)
    setSelectedVessel(null)
    setSlickGeometry(geometry)

    try {
      const res = await fetch(`${API_BASE}/incidents/correlate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slickGeometry: geometry, timeWindow }),
      })

      const data = await res.json()

      if (!res.ok) {
        // Surface validation or server errors clearly
        const msg =
          data?.errors?.[0]?.message ??
          data?.message ??
          `Server returned ${res.status}`
        throw new Error(msg)
      }

      setIncidentData(data)
    } catch (err) {
      setError(err.message ?? 'An unexpected error occurred.')
    } finally {
      setLoading(false)
    }
  }, [])

  return (
    <div className="relative w-full h-full overflow-hidden bg-slate-950">
      {/* Full-screen map */}
      <MapCanvas
        slickGeometry={slickGeometry}
        incidentData={incidentData}
        selectedVessel={selectedVessel}
      />

      {/* Tactical forensics sidebar overlay */}
      <Sidebar
        loading={loading}
        error={error}
        incidentData={incidentData}
        selectedVessel={selectedVessel}
        onCorrelate={handleCorrelate}
        onSelectVessel={setSelectedVessel}
      />
    </div>
  )
}
