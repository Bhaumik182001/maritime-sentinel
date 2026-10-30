# Maritime Sentinel

> **Spatio-Temporal Trajectory Correlation Engine for Maritime Oil Spill Attribution Using High-Throughput AIS Telemetry**  
> *Reference Problem Statement: SIH26143 | National Technical Research Organisation (NTRO)*

[![Docker Compose](https://img.shields.io/badge/Docker-Compose_v2-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![Node.js](https://img.shields.io/badge/Node.js-v20_LTS-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MongoDB](https://img.shields.io/badge/MongoDB-2dsphere_v6.0-47A248?logo=mongodb&logoColor=white)](https://www.mongodb.com/)
[![Redis](https://img.shields.io/badge/Redis-7.0_Spatial-DC382D?logo=redis&logoColor=white)](https://redis.io/)
[![MapLibre GL](https://img.shields.io/badge/MapLibre_GL-v6.0_WebGL-396EB0?logo=maplibre&logoColor=white)](https://maplibre.org/)
[![Compliance](https://img.shields.io/badge/Standards-MARPOL_Annex_I-0A5C36)](https://www.imo.org/)

---

## Table of Contents
1. [Executive Summary](#1-executive-summary)
2. [Core Architecture & Data Flow](#2-core-architecture--data-flow)
3. [Mathematical Physics & Forensics](#3-mathematical-physics--forensics)
4. [Project Structure](#4-project-structure)
5. [Installation & Deployment](#5-installation--deployment)
6. [Operational Workflows](#6-operational-workflows)
7. [API Specification](#7-api-specification)
8. [Empirical Benchmarks](#8-empirical-benchmarks)
9. [Security & MARPOL Compliance](#9-security--marpol-compliance)
10. [Academic Affiliation & Authors](#10-academic-affiliation--authors)

---

## 1. Executive Summary

Synthetic Aperture Radar (SAR) satellites detect marine petroleum slicks across vast ocean expanses, but detection typically occurs hours after the actual discharge. During this elapsed window, ocean currents and surface winds transport the slick miles away from the origin point, allowing the culprit vessel to flee the scene undetected. 

Traditional relational database engines collapse under the immense disk I/O required to process high-frequency Automatic Identification System (AIS) telemetry (millions of pings daily) while simultaneously executing complex geospatial collision queries.

**Maritime Sentinel** solves the "hit-and-run" attribution problem through a defense-grade computational platform. By decoupling the architecture into a **hybrid in-memory (Redis) and persistent (MongoDB) tier**, the system ingests live and historical AIS data at $>2,100$ pings/second. It utilizes a custom **Lagrangian reverse-drift physics engine** to calculate backtrack corridors, running multi-stage `$geoIntersects` aggregations to isolate, score, and cryptographically seal suspect vessel trajectories for legal prosecution.

---

## 2. Core Architecture & Data Flow

The system employs a multi-tiered pipeline optimized for spatial computation and high availability:

```text
 ┌─────────────────────────────────────────────────────────────────────────┐
 │                       [ SATELLITE SAR DETECTION ]                       │
 │    Detected Slick GeoJSON Polygon + Detection Timestamp (T_spill)       │
 └────────────────────────────────────┬────────────────────────────────────┘
                                      ▼
 ┌─────────────────────────────────────────────────────────────────────────┐
 │ 1. HYBRID TELEMETRY INGESTION TIER                                      │
 │    ├─ Live Stream (WebSocket)  : aisstream.io (Commercial traffic)      │
 │    ├─ Static Archive Loader    : DMA / NOAA CSVs (Historical baseline)  │
 │    └─> ingestionService.js     : Asynchronous Micro-Batching Buffer     │
 └────────────────────────────────────┬────────────────────────────────────┘
                                      ▼
 ┌─────────────────────────────────────────────────────────────────────────┐
 │ 2. DUAL-TIER SPATIAL STORAGE                                            │
 │    ├─ In-Memory (Redis 7)      : GEOADD vessels:latest (Sub-2ms lookups)│
 │    └─ Persistent (MongoDB 6)   : bulkWrite({ ordered: false })          │
 │                                  2dsphere index on temporal LineStrings │
 └────────────────────────────────────┬────────────────────────────────────┘
                                      ▼
 ┌─────────────────────────────────────────────────────────────────────────┐
 │ 3. LAGRANGIAN BACKTRACK & CORRELATION ENGINE (driftService.js)          │
 │    ├─ Vector Math              : Current + Wind Leeway + Coriolis Drag  │
 │    ├─ Radial Expansion         : Models turbulent ocean diffusion       │
 │    └─ 6-Stage Aggregation      : $geoIntersects over temporal bounding  │
 └────────────────────────────────────┬────────────────────────────────────┘
                                      ▼
 ┌─────────────────────────────────────────────────────────────────────────┐
 │ 4. TACTICAL FORENSICS UI & EVIDENCE EXPORT                              │
 │    ├─ MapLibre GL v6           : 60 FPS WebGL Vector Rendering          │
 │    ├─ Attribution Scorer       : Spatial, Temporal, and Speed anomalies │
 │    └─ Dossier Generator        : SHA-256 Tamper-Evident PDF Export      │
 └─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Mathematical Physics & Forensics

### 3.1 Lagrangian Reverse-Drift Formulation
To determine the origin coordinates of a slick detected at time $T_{\text{spill}}$ and advected backward by duration $\Delta t$, the platform calculates the net hydrodynamic displacement vector:

$$\vec{V}_{\text{drift}} = \vec{U}_{\text{current}} + \alpha \cdot \mathbf{R}(\theta) \cdot \vec{W}_{10}$$

**Variables & Constants:**
* $\vec{U}_{\text{current}}$: Surface ocean current vector (knots, degrees).
* $\vec{W}_{10}$: 10-meter surface wind vector (knots, degrees).
* $\alpha = 0.032$: Standard aerodynamic wind leeway coefficient (3.2%).
* $\mathbf{R}(\theta)$: Coriolis deflection rotation matrix. For the Arabian Sea / Indian offshore corridor, $\theta = +10^\circ$ (Northern Hemisphere deflection to the right).

### 3.2 Dynamic Search Envelope Expansion
Turbulent diffusion and advection uncertainty cause the forensic search area to expand upstream. The radial boundary $R(t)$ at elapsed backtrack time $t$ is modeled as:

$$R(t) = R_0 + D \cdot t^{0.75}$$

* $R_0$: Initial radius of the detected SAR polygon centroid (km).
* $D$: Turbulent horizontal diffusion coefficient ($0.08\text{ km/hr}^{0.75}$).

### 3.3 Forensic Attribution Scoring Matrix (0–100 Scale)
Trajectories intersecting the reconstructed backtrack corridor are evaluated and scored:

| Forensic Metric | Max Points | Verification Criteria |
| :--- | :--- | :--- |
| **Spatial Proximity** | 40 | Geodesic distance to corridor centerline. 100% score for $\le 500\text{m}$, logarithmically decaying to 0 at the envelope boundary. |
| **Temporal Synchrony** | 35 | Transit timestamp intersection vs. the calculated theoretical release epoch. |
| **Behavioral Anomaly** | 25 | Detection of severe Speed Over Ground (SOG) drops (e.g., cruising at 14 kts, dropping to 3 kts during the envelope transit to conduct illegal bilge dumping). |

---

## 4. Project Structure

```text
maritime-sentinel/
├── docker-compose.yml             # Orchestration: API, Redis, MongoDB, Client
├── .gitignore                     # Strict GitGuardian exclusions (.env, etc.)
├── server/
│   ├── package.json
│   ├── .env.example               # Template for environment keys
│   └── src/
│       ├── server.js              # Express Gateway & App Bootstrap
│       ├── config/
│       │   ├── db.js              # MongoDB Mongoose connector
│       │   └── redis.js           # ioredis caching instance
│       ├── controllers/
│       │   └── incidentController.js # Core spatial correlation logic
│       ├── models/
│       │   └── Telemetry.js       # 2dsphere Schema (Point & LineString)
│       ├── routes/
│       │   └── incidentRoutes.js  # API Endpoint definitions
│       ├── services/
│       │   ├── ingestionService.js# High-throughput micro-batch buffer
│       │   └── driftService.js    # Geodesic reverse drift physics
│       └── scripts/
│           ├── replayGenerator.js # Historical scenario injection (Ground Truth)
│           ├── liveAisStream.js   # aisstream.io WebSocket consumer
│           └── benchmark.js       # Automated throughput/latency test harness
└── client/
    ├── package.json
    ├── vite.config.js
    └── src/
        ├── App.jsx                # Layout & Global State
        ├── components/
        │   ├── MapCanvas.jsx      # MapLibre GL Tactical UI
        │   └── Sidebar.jsx        # Scenario parameters & Suspect breakdown
        └── utils/
            └── forensicDossier.js # A4 Legal Export & SHA-256 Hash Generator
```

---

## 5. Installation & Deployment

### 5.1 System Prerequisites
* **Docker Engine** (v24+) and **Docker Compose** (v2)
* **Node.js** v20+ LTS (for optional local script execution)
* Open-Source API Key from [aisstream.io](https://aisstream.io/) (Free, no credit limit)

### 5.2 Environment Setup
Clone the repository and securely configure the environment variables:

```bash
git clone https://github.com/Bhaumik182001/maritime-sentinel.git
cd maritime-sentinel

# Copy the environment template
cp server/.env.example server/.env
```

Edit `server/.env` to include your secure variables:
```env
PORT=5000
MONGO_URI=mongodb://db:27017/maritime_surveillance
REDIS_URL=redis://redis:6379
AISSTREAM_API_KEY=insert_your_secure_api_key_here
NODE_ENV=development
```

### 5.3 Spin Up the Container Stack
Build and launch the complete microservices architecture in detached mode:

```bash
docker compose up -d --build
```

Verify service health and port bindings:
```bash
docker compose ps
```
* **Client UI**: `http://localhost:5173`
* **API Gateway**: `http://localhost:5000`
* **Redis Cache**: Port `6379`
* **MongoDB Store**: Port `27017`

---

## 6. Operational Workflows

### Scenario A: Historical Ground-Truth Validation (Demo Mode)
To validate the attribution logic against a known hit-and-run scenario in the Arabian Sea (featuring culprit tanker *GHOST TANKER II*):

```bash
# Ingest 1,980 highly curated multi-vessel telemetry points
docker compose exec api npm run replay
```

### Scenario B: Live Global Telemetry Fusion
To stream real-time commercial vessel traffic from the Arabian Sea and Strait of Malacca directly into the spatial pipeline:

```bash
# Start the WebSocket listener in the background
docker compose exec -d api npm run ingest:live

# Monitor incoming ingestion throughput
docker compose logs -f api
```

### Scenario C: Tactical UI Correlation
1. Open the UI at **`http://localhost:5173`**.
2. Select **Preset 3 ("Arabian Sea – Drift Backtrack")** in the sidebar.
3. Verify the auto-populated Hydrodynamic parameters (Wind: 15 kts, Current: 2 kts, Backtrack: 6 hours).
4. Click **Correlate Spatio-Temporal Intersections**.
5. Observe the map render the detected slick (Red), reverse-drift envelope (Translucent Cyan), estimated spill locus (Orange), and intersecting vessel trajectories (Yellow).
6. Expand the **Primary Suspect Card** for `GHOST TANKER II` and click **"Export Forensic Dossier"** to generate the legal PDF.

---

## 7. API Specification

### 7.1 Ingest Telemetry Ping
**`POST /api/v1/telemetry/ingest`**
```json
{
  "mmsi": "412999001",
  "vesselName": "GHOST TANKER II",
  "lon": 72.775,
  "lat": 18.855,
  "sog": 3.1,
  "cog": 42.0,
  "timestamp": "2026-10-29T05:45:00.000Z"
}
```

### 7.2 Execute Lagrangian Correlation
**`POST /api/v1/incidents/correlate`**
```json
{
  "slickGeometry": {
    "type": "Polygon",
    "coordinates": [[[72.820, 18.880], [72.840, 18.880], [72.840, 18.930], [72.820, 18.930], [72.820, 18.880]]]
  },
  "timeWindow": {
    "startTime": "2026-10-29T05:00:00.000Z",
    "endTime": "2026-10-29T08:00:00.000Z"
  },
  "driftParams": {
    "enabled": true,
    "hoursBacktrack": 6,
    "wind": { "speedKts": 15, "directionDeg": 45 },
    "current": { "speedKts": 2, "directionDeg": 45 }
  }
}
```
*Returns GeoJSON FeatureCollection including `driftEnvelope`, `driftPath`, `originZone`, and identified vessel trajectories with `attributionScore` properties.*

---

## 8. Empirical Benchmarks

Benchmarks recorded on standard 8-core virtualized development environments (Node v20 / MongoDB 6 / Redis 7). To replicate, run `docker compose exec api npm run bench`.

| Metric Category | Target Standard | Measured Result | Status |
| :--- | :--- | :--- | :--- |
| **Peak Ingestion Throughput** | > 1,000 pings/sec | **2,175 pings/sec** | Pass (2.1x target) |
| **Data Ingestion Loss** | 0.00% | **0.00% (1,980/1,980)** | Pass (Zero loss) |
| **Redis Spatial Lookup Latency** | < 5 ms | **0.8 – 1.4 ms** | Pass |
| **MongoDB $geoIntersects Pipeline** | < 100 ms | **38 – 52 ms** | Pass |
| **Payload Query Cache (`X-Cache: HIT`)**| < 5 ms | **1.1 ms** | Pass (SHA-256 Key) |
| **Vector Rendering Performance** | 60 FPS | **60 FPS** | Pass (WebGL Hardware) |

---

## 9. Security & MARPOL Compliance

* **Evidentiary Integrity (Non-Repudiation):** Legal audit dossiers exported by the system employ Web Crypto API (`crypto.subtle.digest("SHA-256")`) to generate an immutable, tamper-evident cryptographic fingerprint of the incident geometry, hydrodynamic parameters, and chain-of-custody coordinate breaches.
* **Secret Management:** Complies with GitGuardian standards. Zero hardcoded tokens; all configuration relies entirely on `.gitignore`-protected local `.env` runtime injection.
* **Law Enforcement Standards:** Architectural workflows align with the reporting requirements of **MARPOL Annex I** (Regulations for the Prevention of Pollution by Oil).

---

## 10. Academic Affiliation & Authors

**Capstone Engineering Team (SIH26143 / NTRO Project Stream)**  
*Department of Computer Science and Engineering*  
*Lovely Professional University (LPU), Punjab, India*

**Team Division of Labor:**
* **Lead Architect & Backend Systems:** Core Node.js API, Micro-Batch Ingestion Engine & Dual-Tier Storage Topology.
* **Spatial Algorithms & Physics:** Lagrangian Reverse Drift Implementation & Geodesic Calculations.
* **Frontend Engineering:** MapLibre WebGL UI, Reactive Layers & Tactical Workspace Architecture.
* **Forensic Analytics:** Legal Audit Dossier Generator & Chain-of-Custody Cryptographic Hashing.
* **Performance & Research:** Ingestion Benchmarks, k6/Node Stress Testing Harness & IEEE Publication Documentation.
* **Telemetry & Pipeline:** Real-time WebSocket Data Fusion and Redis geospatial caching strategy.
