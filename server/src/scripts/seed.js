import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import csv from "csv-parser";
import mongoose from "mongoose";
import dotenv from "dotenv";
import Telemetry from "../models/Telemetry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const MONGO_URI =
  process.env.MONGO_URI || "mongodb://localhost:27017/maritime_surveillance";
const CSV_FILE_PATH = path.resolve(__dirname, "./data/sample_ais.csv");
const BATCH_SIZE = 1000;

const runSeeder = async () => {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("[Seeder]: Connected to MongoDB.");

    // Ensure 2dsphere indexes are built
    await Telemetry.init();
    console.log("[Seeder]: 2dsphere indexes synchronized.");

    if (!fs.existsSync(CSV_FILE_PATH)) {
      console.error(`[Seeder Error]: Missing CSV file at ${CSV_FILE_PATH}`);
      process.exit(1);
    }

    let batch = [];
    let totalInserted = 0;

    const stream = fs.createReadStream(CSV_FILE_PATH).pipe(csv());

    for await (const row of stream) {
      // Parse standard MarineCadastre / open AIS column names
      const lat = parseFloat(row.LAT || row.latitude || row.lat);
      const lon = parseFloat(row.LON || row.longitude || row.lon);
      const mmsi = String(row.MMSI || row.mmsi || "").trim();
      const rawTimestamp = row.BaseDateTime || row.timestamp || row.Timestamp;
      const sog = parseFloat(row.SOG || row.sog || 0);
      const cog = parseFloat(row.COG || row.cog || 0);
      const vesselName = row.VesselName || row.vessel_name || "Vessel " + mmsi;

      // Coordinate sanity check
      if (!isNaN(lat) && !isNaN(lon) && mmsi && rawTimestamp) {
        if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
          batch.push({
            mmsi,
            vesselName,
            timestamp: new Date(rawTimestamp),
            sog,
            cog,
            location: {
              type: "Point",
              coordinates: [lon, lat], // Order: [Longitude, Latitude]
            },
          });
        }
      }

      if (batch.length >= BATCH_SIZE) {
        await Telemetry.insertMany(batch, { ordered: false });
        totalInserted += batch.length;
        process.stdout.write(
          `\r[Seeder]: Ingested ${totalInserted} records...`,
        );
        batch = [];
      }
    }

    if (batch.length > 0) {
      await Telemetry.insertMany(batch, { ordered: false });
      totalInserted += batch.length;
    }

    console.log(
      `\n[Seeder Complete]: Successfully seeded ${totalInserted} telemetry documents.`,
    );
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error(`\n[Seeder Fatal]: ${err.message}`);
    await mongoose.disconnect();
    process.exit(1);
  }
};

runSeeder();
