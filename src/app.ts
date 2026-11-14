
import express, {
  type NextFunction,
  type Request,
  type Response
} from "express";

import jobRoutes from "./api/job.routes";

export const app = express();

app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  return res.status(200).json({
    success: true,
    message: "Soup Job Queue API is running",
    timestamp: new Date().toISOString()
  });
});

// Register job endpoints
app.use("/jobs", jobRoutes);

// Handle unknown routes
app.use((_req, res) => {
  return res.status(404).json({ error: "ROUTE_NOT_FOUND" });
});

// Central error handler
app.use((
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction
) => {
  if (res.headersSent) return next(error);

  if (
    error instanceof Error &&
    error.name === "IdempotencyConflictError"
  ) {
    return res.status(409).json({
      error: "IDEMPOTENCY_CONFLICT",
      message: error.message
    });
  }

  if (
    error instanceof SyntaxError &&
    "status" in error &&
    error.status === 400
  ) {
    return res.status(400).json({
      error: "INVALID_JSON",
      message: "Request body contains invalid JSON"
    });
  }

  console.error("API error:", error);

  return res.status(500).json({
    error: "INTERNAL_SERVER_ERROR"
  });
});
