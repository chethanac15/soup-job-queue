
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../database/db";

// --------------------------------------------------
// Types
// --------------------------------------------------

export interface CreateJobInput {
  idempotencyKey: string;
  payload: Record<string, unknown>;
  maxAttempts?: number;
}

export interface JobCursor {
  createdAt: string;
  id: string;
}

export interface JobRow {
  id: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  payload_hash: string;
  status: string;
  attempts: number;
  max_attempts: number;
  worker_id: string | null;
  lease_epoch: string;
  lease_expires_at: Date | null;
  cancel_requested: boolean;
  failure_reason: string | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

// --------------------------------------------------
// Stable JSON serialization for payload hashing
// --------------------------------------------------

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;

    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, canonicalize(object[key])])
    );
  }

  return value;
}

function hashPayload(payload: Record<string, unknown>): string {
  const normalized = JSON.stringify(canonicalize(payload));

  return createHash("sha256")
    .update(normalized)
    .digest("hex");
}

// --------------------------------------------------
// Create job with idempotency
// --------------------------------------------------

export async function createJob(input: CreateJobInput): Promise<{
  job: JobRow;
  created: boolean;
}> {
  const payloadHash = hashPayload(input.payload);
  const maxAttempts = input.maxAttempts ?? 5;

  const insertResult = await pool.query<JobRow>(
    `
    INSERT INTO jobs (
      idempotency_key,
      payload,
      payload_hash,
      max_attempts
    )
    VALUES ($1, $2::jsonb, $3, $4)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING *
    `,
    [
      input.idempotencyKey,
      JSON.stringify(input.payload),
      payloadHash,
      maxAttempts
    ]
  );

  if (insertResult.rowCount === 1) {
    return {
      job: insertResult.rows[0],
      created: true
    };
  }

  // The idempotency key already exists.
  const existingResult = await pool.query<JobRow>(
    `
    SELECT *
    FROM jobs
    WHERE idempotency_key = $1
    `,
    [input.idempotencyKey]
  );

  const existingJob = existingResult.rows[0];

  if (!existingJob) {
    throw new Error("Unable to retrieve existing idempotent job");
  }

  // Same key with a different payload is a conflict.
  if (existingJob.payload_hash !== payloadHash) {
    const error = new Error(
      "Idempotency key was already used with a different payload"
    );
    error.name = "IdempotencyConflictError";
    throw error;
  }

  return {
    job: existingJob,
    created: false
  };
}

// --------------------------------------------------
// Get job by ID
// --------------------------------------------------

export async function getJobById(
  id: string
): Promise<JobRow | null> {
  const result = await pool.query<JobRow>(
    `
    SELECT *
    FROM jobs
    WHERE id = $1
    `,
    [id]
  );

  return result.rows[0] ?? null;
}

// --------------------------------------------------
// List jobs with cursor pagination
// --------------------------------------------------

export async function listJobs(
  limit: number,
  cursor?: JobCursor
): Promise<{
  jobs: JobRow[];
  nextCursor: string | null;
}> {
  const result = cursor
    ? await pool.query<JobRow>(
        `
        SELECT *
        FROM jobs
        WHERE (created_at, id) < ($1::timestamptz, $2::uuid)
        ORDER BY created_at DESC, id DESC
        LIMIT $3
        `,
        [cursor.createdAt, cursor.id, limit + 1]
      )
    : await pool.query<JobRow>(
        `
        SELECT *
        FROM jobs
        ORDER BY created_at DESC, id DESC
        LIMIT $1
        `,
        [limit + 1]
      );

  const hasMore = result.rows.length > limit;
  const jobs = result.rows.slice(0, limit);

  let nextCursor: string | null = null;

  if (hasMore && jobs.length > 0) {
    const lastJob = jobs[jobs.length - 1];

    nextCursor = Buffer.from(
      JSON.stringify({
        createdAt: lastJob.created_at.toISOString(),
        id: lastJob.id
      })
    ).toString("base64url");
  }

  return {
    jobs,
    nextCursor
  };
}

// --------------------------------------------------
// Cancel job safely
// --------------------------------------------------

export async function cancelJob(
  id: string
): Promise<JobRow | null> {
  const client: PoolClient = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query<JobRow>(
      `
      SELECT *
      FROM jobs
      WHERE id = $1
      FOR UPDATE
      `,
      [id]
    );

    const job = result.rows[0];

    if (!job) {
      await client.query("ROLLBACK");
      return null;
    }

    let updatedJob = job;

    if (job.status === "queued") {
      const updateResult = await client.query<JobRow>(
        `
        UPDATE jobs
        SET
          status = 'cancelled',
          cancel_requested = TRUE,
          updated_at = NOW(),
          completed_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [id]
      );

      updatedJob = updateResult.rows[0];
    } else if (job.status === "running") {
      const updateResult = await client.query<JobRow>(
        `
        UPDATE jobs
        SET
          cancel_requested = TRUE,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [id]
      );

      updatedJob = updateResult.rows[0];
    }

    await client.query("COMMIT");

    return updatedJob;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
