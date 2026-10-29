import mongoose from "mongoose";

const TelemetrySchema = new mongoose.Schema(
  {
    mmsi: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    vesselName: {
      type: String,
      default: "Unknown Vessel",
      trim: true,
    },
    timestamp: {
      type: Date,
      required: true,
      index: true,
    },
    sog: {
      type: Number, // Speed Over Ground in knots
      required: true,
      default: 0.0,
    },
    cog: {
      type: Number, // Course Over Ground in degrees
      required: true,
      default: 0.0,
    },
    location: {
      type: {
        type: String,
        enum: ["Point"],
        required: true,
        default: "Point",
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        required: true,
      },
    },
  },
  {
    timestamps: true,
  },
);

// Compound 2dsphere index for fast spatio-temporal boundary filtering
TelemetrySchema.index({ location: "2dsphere", timestamp: -1, mmsi: 1 });

export default mongoose.model("Telemetry", TelemetrySchema);
