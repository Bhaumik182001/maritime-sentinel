import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { connectDB } from "./config/db.js";
import incidentRoutes from "./routes/incidentRoutes.js";

// Load environment variables from server/.env
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// ── Global middleware ─────────────────────────────────────────────────────────

// Parse JSON bodies. The 2 MB limit is generous enough for large GeoJSON polygons.
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── API routes ────────────────────────────────────────────────────────────────
app.use("/api/v1/incidents", incidentRoutes);

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "Not Found", message: "Route does not exist." });
});

// ── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error("[Unhandled Error]:", err);
  res.status(500).json({
    error: "Internal Server Error",
    message: err.message || "An unexpected error occurred.",
  });
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────
const startServer = async () => {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`[Server]: Maritime Sentinel API running on port ${PORT}`);
    console.log(
      `[Server]: Incident correlate endpoint → POST http://localhost:${PORT}/api/v1/incidents/correlate`,
    );
  });
};

startServer();
