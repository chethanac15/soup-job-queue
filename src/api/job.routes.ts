
import { Router } from "express";
import { z } from "zod";

import {
  cancelJob,
  createJob,
  getJobById,
  listJobs,
  type JobCursor
} from "../services/job.service";

const router = Router();

const createJobSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(255),
  payload: z.record(z.string(), z.unknown()),
  maxAttempts: z.number().int().min(1).max(100).optional()
});

const uuidSchema = z.string().uuid();

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(1024).optional()
});

const cursorSchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  id: z.string().uuid()
});

function decodeCursor(value: string): JobCursor {
  let decoded: unknown;

  try {
    decoded = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    );
  } catch {
    throw new Error("Invalid pagination cursor");
  }

  const result = cursorSchema.safeParse(decoded);

  if (!result.success) {
    throw new Error("Invalid pagination cursor");
  }

  return {
    createdAt: result.data.createdAt,
    id: result.data.id
  };
}

// Create a job
router.post("/", async (req, res) => {
  const parsed = createJobSchema.safeParse({
    idempotencyKey: req.get("Idempotency-Key"),
    payload: req.body?.payload,
    maxAttempts: req.body?.maxAttempts
  });

  if (!parsed.success) {
    return res.status(400).json({
      error: "VALIDATION_ERROR",
      details: parsed.error.issues
    });
  }

  const result = await createJob(parsed.data);

  return res.status(result.created ? 201 : 200).json({
    success: true,
    created: result.created,
    job: result.job
  });
});

// List jobs with pagination
router.get("/", async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    return res.status(400).json({
      error: "VALIDATION_ERROR",
      details: parsed.error.issues
    });
  }

  let cursor: JobCursor | undefined;

  if (parsed.data.cursor) {
    try {
      cursor = decodeCursor(parsed.data.cursor);
    } catch {
      return res.status(400).json({
        error: "INVALID_CURSOR",
        message: "The pagination cursor is invalid"
      });
    }
  }

  const result = await listJobs(parsed.data.limit, cursor);

  return res.status(200).json({
    success: true,
    count: result.jobs.length,
    jobs: result.jobs,
    nextCursor: result.nextCursor
  });
});

// Get one job
router.get("/:id", async (req, res) => {
  const parsed = uuidSchema.safeParse(req.params.id);

  if (!parsed.success) {
    return res.status(400).json({ error: "INVALID_JOB_ID" });
  }

  const job = await getJobById(parsed.data);

  if (!job) {
    return res.status(404).json({ error: "JOB_NOT_FOUND" });
  }

  return res.status(200).json({
    success: true,
    job
  });
});

// Cancel a job
router.post("/:id/cancel", async (req, res) => {
  const parsed = uuidSchema.safeParse(req.params.id);

  if (!parsed.success) {
    return res.status(400).json({ error: "INVALID_JOB_ID" });
  }

  const job = await cancelJob(parsed.data);

  if (!job) {
    return res.status(404).json({ error: "JOB_NOT_FOUND" });
  }

  return res.status(200).json({
    success: true,
    job
  });
});

export default router;
