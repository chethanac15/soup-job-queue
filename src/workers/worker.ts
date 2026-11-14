import { pool } from "../database/db";
import type { PoolClient } from "pg";

export interface ClaimedJob {
  id: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  max_attempts: number;
  worker_id: string;
  lease_epoch: string;
  lease_expires_at: Date;
  cancel_requested: boolean;
}

export interface JobResult {
  jobId: string;
  workerId: string;
  attempt: number;
  message: string;
  processedAt: string;
}

const DEFAULT_LEASE_SECONDS = 15;
const POLL_INTERVAL_MS = 250;
const MAX_SIMULATION_MS = 120000;

/**
 * Claim one queued job.
 *
 * SKIP LOCKED allows multiple workers to claim different jobs
 * without waiting for one another.
 */
export async function claimNextJob(
  workerId: string,
  leaseSeconds = DEFAULT_LEASE_SECONDS
): Promise<ClaimedJob | null> {
  if (!workerId.trim()) {
    throw new Error("Worker ID cannot be empty");
  }

  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1) {
    throw new Error("Lease duration must be a positive integer");
  }

  const result = await pool.query<ClaimedJob>(
    `
      WITH candidate AS (
        SELECT id
        FROM jobs
        WHERE status = 'queued'
          AND attempts < max_attempts
        ORDER BY created_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE jobs AS j
      SET
        status = 'running',
        worker_id = $1,
        attempts = j.attempts + 1,
        lease_epoch = j.lease_epoch + 1,
        lease_expires_at =
          clock_timestamp() + ($2 * INTERVAL '1 second'),
        started_at = COALESCE(j.started_at, clock_timestamp()),
        updated_at = clock_timestamp()
      FROM candidate
      WHERE j.id = candidate.id
      RETURNING j.*
    `,
    [workerId, leaseSeconds]
  );

  return result.rows[0] ?? null;
}

/**
 * Record the moment the handler actually starts.
 *
 * The ownership check and run insertion happen in one transaction.
 * A worker that has already lost its lease cannot start a recorded run.
 */
async function startJobRun(job: ClaimedJob): Promise<boolean> {
  const client: PoolClient = await pool.connect();

  try {
    await client.query("BEGIN");

    const ownership = await client.query(
      `
        SELECT id
        FROM jobs
        WHERE id = $1
          AND status = 'running'
          AND worker_id = $2
          AND lease_epoch = $3
          AND lease_expires_at > clock_timestamp()
          AND cancel_requested = FALSE
        FOR UPDATE
      `,
      [job.id, job.worker_id, job.lease_epoch]
    );

    if (ownership.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }

    const inserted = await client.query(
      `
        INSERT INTO job_runs (
          job_id,
          attempt,
          worker_id,
          lease_epoch,
          status
        )
        VALUES ($1, $2, $3, $4, 'started')
        ON CONFLICT (job_id, attempt) DO NOTHING
        RETURNING id
      `,
      [job.id, job.attempts, job.worker_id, job.lease_epoch]
    );

    await client.query("COMMIT");
    return inserted.rowCount === 1;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Extend a worker's lease.
 *
 * The worker must still own an unexpired lease and cancellation
 * must not have been requested.
 */
export async function renewLease(
  jobId: string,
  workerId: string,
  leaseEpoch: string,
  leaseSeconds = DEFAULT_LEASE_SECONDS
): Promise<boolean> {
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1) {
    throw new Error("Lease duration must be a positive integer");
  }

  const result = await pool.query(
    `
      UPDATE jobs
      SET
        lease_expires_at =
          clock_timestamp() + ($4 * INTERVAL '1 second'),
        updated_at = clock_timestamp()
      WHERE id = $1
        AND status = 'running'
        AND worker_id = $2
        AND lease_epoch = $3
        AND lease_expires_at > clock_timestamp()
        AND cancel_requested = FALSE
      RETURNING id
    `,
    [jobId, workerId, leaseEpoch, leaseSeconds]
  );

  return result.rowCount === 1;
}

/**
 * Acknowledge a running job's cancellation.
 *
 * The job and its run record are updated in the same transaction.
 */
export async function acknowledgeCancellation(
  job: ClaimedJob
): Promise<boolean> {
  const client: PoolClient = await pool.connect();

  try {
    await client.query("BEGIN");

    const ownership = await client.query(
      `
        SELECT id
        FROM jobs
        WHERE id = $1
          AND status = 'running'
          AND worker_id = $2
          AND lease_epoch = $3
          AND lease_expires_at > clock_timestamp()
          AND cancel_requested = TRUE
        FOR UPDATE
      `,
      [job.id, job.worker_id, job.lease_epoch]
    );

    if (ownership.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }

    await client.query(
      `
        UPDATE job_runs
        SET
          status = 'cancelled',
          finished_at = clock_timestamp()
        WHERE job_id = $1
          AND attempt = $2
          AND lease_epoch = $3
          AND status = 'started'
      `,
      [job.id, job.attempts, job.lease_epoch]
    );

    await client.query(
      `
        UPDATE jobs
        SET
          status = 'cancelled',
          worker_id = NULL,
          lease_expires_at = NULL,
          completed_at = clock_timestamp(),
          updated_at = clock_timestamp()
        WHERE id = $1
      `,
      [job.id]
    );

    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Commit the persistent effect and mark the job/run successful.
 *
 * The lease ownership check, effect insertion, run update, and
 * job completion are atomic.
 */
export async function completeJob(
  job: ClaimedJob,
  resultData: JobResult
): Promise<boolean> {
  const client: PoolClient = await pool.connect();

  try {
    await client.query("BEGIN");

    const ownership = await client.query(
      `
        SELECT id
        FROM jobs
        WHERE id = $1
          AND status = 'running'
          AND worker_id = $2
          AND lease_epoch = $3
          AND lease_expires_at > clock_timestamp()
          AND cancel_requested = FALSE
        FOR UPDATE
      `,
      [job.id, job.worker_id, job.lease_epoch]
    );

    if (ownership.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }

    const effect = await client.query(
      `
        INSERT INTO job_effects (job_id, result)
        VALUES ($1, $2::jsonb)
        ON CONFLICT (job_id) DO NOTHING
        RETURNING id
      `,
      [job.id, JSON.stringify(resultData)]
    );

    if (effect.rowCount !== 1) {
      throw new Error(
        `An effect already exists for job ${job.id}`
      );
    }

    const run = await client.query(
      `
        UPDATE job_runs
        SET
          status = 'succeeded',
          finished_at = clock_timestamp()
        WHERE job_id = $1
          AND attempt = $2
          AND worker_id = $3
          AND lease_epoch = $4
          AND status = 'started'
        RETURNING id
      `,
      [job.id, job.attempts, job.worker_id, job.lease_epoch]
    );

    if (run.rowCount !== 1) {
      throw new Error(
        `Could not find the active run for job ${job.id}`
      );
    }

    const completion = await client.query(
      `
        UPDATE jobs
        SET
          status = 'succeeded',
          worker_id = NULL,
          lease_expires_at = NULL,
          completed_at = clock_timestamp(),
          updated_at = clock_timestamp()
        WHERE id = $1
          AND status = 'running'
          AND worker_id = $2
          AND lease_epoch = $3
          AND cancel_requested = FALSE
        RETURNING id
      `,
      [job.id, job.worker_id, job.lease_epoch]
    );

    if (completion.rowCount !== 1) {
      throw new Error("Job ownership changed during completion");
    }

    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Record a handler failure and release the job for retry,
 * or mark it terminally failed when attempts are exhausted.
 */
async function failJobRun(
  job: ClaimedJob,
  error: unknown
): Promise<boolean> {
  const client: PoolClient = await pool.connect();

  const errorMessage =
    error instanceof Error ? error.message : String(error);

  try {
    await client.query("BEGIN");

    const ownership = await client.query(
      `
        SELECT id
        FROM jobs
        WHERE id = $1
          AND status = 'running'
          AND worker_id = $2
          AND lease_epoch = $3
          AND lease_expires_at > clock_timestamp()
        FOR UPDATE
      `,
      [job.id, job.worker_id, job.lease_epoch]
    );

    if (ownership.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }

    const run = await client.query(
      `
        UPDATE job_runs
        SET
          status = 'failed',
          finished_at = clock_timestamp(),
          error_message = $5
        WHERE job_id = $1
          AND attempt = $2
          AND worker_id = $3
          AND lease_epoch = $4
          AND status = 'started'
        RETURNING id
      `,
      [
        job.id,
        job.attempts,
        job.worker_id,
        job.lease_epoch,
        errorMessage.slice(0, 4000),
      ]
    );

    if (run.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }

    const terminalFailure = job.attempts >= job.max_attempts;

    await client.query(
      `
        UPDATE jobs
        SET
          status = $4,
          worker_id = NULL,
          lease_expires_at = NULL,
          completed_at = CASE
            WHEN $4 = 'failed' THEN clock_timestamp()
            ELSE NULL
          END,
          failure_reason = CASE
            WHEN $4 = 'failed' THEN $5
            ELSE failure_reason
          END,
          last_error = $5,
          updated_at = clock_timestamp()
        WHERE id = $1
          AND status = 'running'
          AND worker_id = $2
          AND lease_epoch = $3
      `,
      [
        job.id,
        job.worker_id,
        job.lease_epoch,
        terminalFailure ? "failed" : "queued",
        errorMessage.slice(0, 4000),
      ]
    );

    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Requeue jobs whose worker leases expired.
 *
 * Any handler run still marked "started" becomes "interrupted".
 * The job is then requeued, cancelled, or failed according to
 * its cancellation flag and remaining attempts.
 */
export async function recoverExpiredJobs(): Promise<number> {
  const client: PoolClient = await pool.connect();

  try {
    await client.query("BEGIN");

    const expired = await client.query<{
      id: string;
      attempts: number;
      max_attempts: number;
      cancel_requested: boolean;
      lease_epoch: string;
    }>(
      `
        SELECT
          id,
          attempts,
          max_attempts,
          cancel_requested,
          lease_epoch
        FROM jobs
        WHERE status = 'running'
          AND lease_expires_at <= clock_timestamp()
        ORDER BY lease_expires_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 100
      `
    );

    for (const job of expired.rows) {
      await client.query(
        `
          UPDATE job_runs
          SET
            status = 'interrupted',
            finished_at = clock_timestamp(),
            error_message = 'Worker lease expired before handler completion'
          WHERE job_id = $1
            AND attempt = $2
            AND lease_epoch = $3
            AND status = 'started'
        `,
        [job.id, job.attempts, job.lease_epoch]
      );

      const nextStatus = job.cancel_requested
        ? "cancelled"
        : job.attempts >= job.max_attempts
          ? "failed"
          : "queued";

      const failureMessage =
        "Worker lease expired before handler completion";

      await client.query(
        `
          UPDATE jobs
          SET
            status = $2,
            worker_id = NULL,
            lease_expires_at = NULL,
            completed_at = CASE
              WHEN $2 IN ('cancelled', 'failed')
              THEN clock_timestamp()
              ELSE NULL
            END,
            failure_reason = CASE
              WHEN $2 = 'failed' THEN $3
              ELSE failure_reason
            END,
            last_error = $3,
            updated_at = clock_timestamp()
          WHERE id = $1
        `,
        [job.id, nextStatus, failureMessage]
      );
    }

    await client.query("COMMIT");
    return expired.rowCount ?? 0;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Run one claimed job.
 *
 * A run record is created only after ownership is verified.
 * If this worker is killed, its run remains "started" until
 * lease recovery marks it "interrupted".
 */
export async function processClaimedJob(
  job: ClaimedJob,
  signal: AbortSignal,
  leaseSeconds = DEFAULT_LEASE_SECONDS
): Promise<void> {
  const runStarted = await startJobRun(job);

  if (!runStarted) {
    await acknowledgeCancellation(job);
    console.log(
      `Worker ${job.worker_id} could not start run for ${job.id}; ownership or cancellation changed`
    );
    return;
  }

  const requestedDuration = Number(job.payload.durationMs);

  const durationMs =
    Number.isFinite(requestedDuration) && requestedDuration >= 0
      ? Math.min(requestedDuration, MAX_SIMULATION_MS)
      : 500;

  console.log(
    `Worker ${job.worker_id} executing ${job.id}, attempt ${job.attempts}, for ${durationMs}ms`
  );

  try {
    const startedAt = Date.now();
    let nextHeartbeatAt =
      startedAt + Math.floor((leaseSeconds * 1000) / 3);

    while (Date.now() - startedAt < durationMs) {
      if (signal.aborted) {
        console.log(
          `Worker ${job.worker_id} interrupted during ${job.id}`
        );
        // Leave the run as "started".
        // Lease recovery will mark it "interrupted".
        return;
      }

      await new Promise<void>((resolve) =>
        setTimeout(resolve, 100)
      );

      if (Date.now() >= nextHeartbeatAt) {
        const renewed = await renewLease(
          job.id,
          job.worker_id,
          job.lease_epoch,
          leaseSeconds
        );

        if (!renewed) {
          await acknowledgeCancellation(job);
          console.log(
            `Worker ${job.worker_id} lost ownership of ${job.id}`
          );
          return;
        }

        nextHeartbeatAt =
          Date.now() + Math.floor((leaseSeconds * 1000) / 3);
      }
    }

    if (signal.aborted) {
      return;
    }

    const resultData: JobResult = {
      jobId: job.id,
      workerId: job.worker_id,
      attempt: job.attempts,
      message:
        typeof job.payload.message === "string"
          ? job.payload.message
          : "Job processed successfully",
      processedAt: new Date().toISOString(),
    };

    const completed = await completeJob(job, resultData);

    if (!completed) {
      await acknowledgeCancellation(job);
    } else {
      console.log(
        `Worker ${job.worker_id} completed job ${job.id}`
      );
    }
  } catch (error) {
    console.error(
      `Worker ${job.worker_id} failed while executing ${job.id}:`,
      error
    );

    const recorded = await failJobRun(job, error);

    if (!recorded) {
      console.log(
        `Worker ${job.worker_id} no longer owns ${job.id}; lease recovery will handle it`
      );
    }
  }
}

/**
 * Main polling loop for one worker.
 */
export async function runWorkerLoop(
  workerId: string,
  signal: AbortSignal
): Promise<void> {
  console.log(`Worker ${workerId} started`);

  let nextRecoveryAt = 0;

  while (!signal.aborted) {
    try {
      if (Date.now() >= nextRecoveryAt) {
        const recovered = await recoverExpiredJobs();

        if (recovered > 0) {
          console.log(
            `Worker ${workerId} recovered ${recovered} expired job(s)`
          );
        }

        nextRecoveryAt = Date.now() + 1000;
      }

      const job = await claimNextJob(workerId);

      if (!job) {
        await new Promise((resolve) =>
          setTimeout(resolve, POLL_INTERVAL_MS)
        );
        continue;
      }

      console.log(
        `Worker ${workerId} claimed job ${job.id}, attempt ${job.attempts}`
      );

      await processClaimedJob(job, signal);
    } catch (error) {
      console.error(`Worker ${workerId} error:`, error);

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  console.log(`Worker ${workerId} stopped`);
}