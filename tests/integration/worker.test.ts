
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { pool } from "../../src/database/db";
import { createJob, cancelJob } from "../../src/services/job.service";
import {
  claimNextJob,
  completeJob,
  processClaimedJob,
  recoverExpiredJobs,
  type JobResult
} from "../../src/workers/worker";

const testPrefix = `vitest-worker-${randomUUID()}-`;

function key(label: string): string {
  return `${testPrefix}${label}`;
}

async function waitForRun(jobId: string): Promise<void> {
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    const result = await pool.query(
      `
        SELECT id
        FROM job_runs
        WHERE job_id = $1
          AND status = 'started'
        LIMIT 1
      `,
      [jobId]
    );

    if (result.rowCount === 1) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for job run to start: ${jobId}`);
}

describe("Worker reliability integration tests", () => {
  afterAll(async () => {
    await pool.query(
      `
        DELETE FROM job_runs
        WHERE job_id IN (
          SELECT id FROM jobs WHERE idempotency_key LIKE $1
        )
      `,
      [`${testPrefix}%`]
    );

    await pool.query(
      `
        DELETE FROM job_effects
        WHERE job_id IN (
          SELECT id FROM jobs WHERE idempotency_key LIKE $1
        )
      `,
      [`${testPrefix}%`]
    );

    await pool.query(
      "DELETE FROM jobs WHERE idempotency_key LIKE $1",
      [`${testPrefix}%`]
    );

    await pool.end();
  });

  it("allows only one worker to claim a single queued job", async () => {
    const created = await createJob({
      idempotencyKey: key("single-claim"),
      payload: { durationMs: 0 }
    });

    const [workerA, workerB] = await Promise.all([
      claimNextJob("vitest-worker-A"),
      claimNextJob("vitest-worker-B")
    ]);

    const claims = [workerA, workerB].filter(
      (job) => job?.id === created.job.id
    );

    expect(claims).toHaveLength(1);

    const stored = await pool.query(
      "SELECT status, worker_id, attempts FROM jobs WHERE id = $1",
      [created.job.id]
    );

    expect(stored.rows[0].status).toBe("running");
    expect(stored.rows[0].attempts).toBe(1);
    expect(["vitest-worker-A", "vitest-worker-B"]).toContain(
      stored.rows[0].worker_id
    );
  });

  it("records one successful handler run and one persistent effect", async () => {
    const created = await createJob({
      idempotencyKey: key("successful-run"),
      payload: {
        durationMs: 0,
        message: "worker integration test succeeded"
      }
    });

    const claimed = await claimNextJob("vitest-success-worker");

    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(created.job.id);

    await processClaimedJob(claimed!, new AbortController().signal, 3);

    const job = await pool.query(
      "SELECT status FROM jobs WHERE id = $1",
      [created.job.id]
    );

    const runs = await pool.query(
      `
        SELECT status, attempt, worker_id
        FROM job_runs
        WHERE job_id = $1
      `,
      [created.job.id]
    );

    const effects = await pool.query(
      "SELECT COUNT(*)::int AS count FROM job_effects WHERE job_id = $1",
      [created.job.id]
    );

    expect(job.rows[0].status).toBe("succeeded");
    expect(runs.rowCount).toBe(1);
    expect(runs.rows[0].status).toBe("succeeded");
    expect(runs.rows[0].attempt).toBe(1);
    expect(runs.rows[0].worker_id).toBe("vitest-success-worker");
    expect(effects.rows[0].count).toBe(1);
  });

  it(
    "recovers an expired lease and rejects completion by the stale worker",
    async () => {
      const created = await createJob({
        idempotencyKey: key("expired-lease"),
        payload: { durationMs: 500 }
      });

      const oldClaim = await claimNextJob("vitest-old-worker", 3);

      expect(oldClaim).not.toBeNull();
      expect(oldClaim!.id).toBe(created.job.id);

      const controller = new AbortController();
      const processing = processClaimedJob(
        oldClaim!,
        controller.signal,
        3
      );

      // Wait until the handler has actually started before expiring its lease.
      await waitForRun(created.job.id);

      await pool.query(
        `
          UPDATE jobs
          SET lease_expires_at = clock_timestamp() - INTERVAL '1 second'
          WHERE id = $1
        `,
        [created.job.id]
      );

      const recoveredCount = await recoverExpiredJobs();

      expect(recoveredCount).toBeGreaterThanOrEqual(1);

      const recoveredJob = await pool.query(
        "SELECT status, worker_id, lease_expires_at FROM jobs WHERE id = $1",
        [created.job.id]
      );

      expect(recoveredJob.rows[0].status).toBe("queued");
      expect(recoveredJob.rows[0].worker_id).toBeNull();
      expect(recoveredJob.rows[0].lease_expires_at).toBeNull();

      const interruptedRun = await pool.query(
        "SELECT status FROM job_runs WHERE job_id = $1 AND attempt = 1",
        [created.job.id]
      );

      expect(interruptedRun.rows[0].status).toBe("interrupted");

      // Stop the old simulated handler and wait for it to exit.
      controller.abort();
      await processing;

      const staleResult: JobResult = {
        jobId: oldClaim!.id,
        workerId: oldClaim!.worker_id,
        attempt: oldClaim!.attempts,
        message: "This stale worker must not commit",
        processedAt: new Date().toISOString()
      };

      const staleCompletion = await completeJob(oldClaim!, staleResult);

      expect(staleCompletion).toBe(false);

      const effectsBeforeRetry = await pool.query(
        "SELECT COUNT(*)::int AS count FROM job_effects WHERE job_id = $1",
        [created.job.id]
      );

      expect(effectsBeforeRetry.rows[0].count).toBe(0);

      // A new worker can claim and finish the recovered job.
      const newClaim = await claimNextJob("vitest-new-worker", 3);

      expect(newClaim).not.toBeNull();
      expect(newClaim!.id).toBe(created.job.id);
      expect(newClaim!.attempts).toBe(2);
      expect(newClaim!.lease_epoch).not.toBe(oldClaim!.lease_epoch);

      await processClaimedJob(
        newClaim!,
        new AbortController().signal,
        3
      );

      const finalJob = await pool.query(
        "SELECT status, attempts FROM jobs WHERE id = $1",
        [created.job.id]
      );

      const finalRuns = await pool.query(
        "SELECT status FROM job_runs WHERE job_id = $1 ORDER BY attempt",
        [created.job.id]
      );

      const finalEffects = await pool.query(
        "SELECT COUNT(*)::int AS count FROM job_effects WHERE job_id = $1",
        [created.job.id]
      );

      expect(finalJob.rows[0].status).toBe("succeeded");
      expect(finalJob.rows[0].attempts).toBe(2);
      expect(finalRuns.rows.map((run) => run.status)).toEqual([
        "interrupted",
        "succeeded"
      ]);
      expect(finalEffects.rows[0].count).toBe(1);
    },
    20000
  );

  it("lets cancellation win when requested before completion", async () => {
    const created = await createJob({
      idempotencyKey: key("cancel-race"),
      payload: {
        durationMs: 400,
        message: "This result must not be committed"
      }
    });

    const claimed = await claimNextJob("vitest-cancel-worker", 3);

    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(created.job.id);

    const processing = processClaimedJob(
      claimed!,
      new AbortController().signal,
      3
    );

    await waitForRun(created.job.id);

    // Request cancellation while the handler is still executing.
    const cancellation = await cancelJob(created.job.id);

    expect(cancellation).not.toBeNull();
    expect(cancellation!.status).toBe("running");
    expect(cancellation!.cancel_requested).toBe(true);

    await processing;

    const finalJob = await pool.query(
      "SELECT status, cancel_requested FROM jobs WHERE id = $1",
      [created.job.id]
    );

    const run = await pool.query(
      "SELECT status FROM job_runs WHERE job_id = $1",
      [created.job.id]
    );

    const effects = await pool.query(
      "SELECT COUNT(*)::int AS count FROM job_effects WHERE job_id = $1",
      [created.job.id]
    );

    expect(finalJob.rows[0].status).toBe("cancelled");
    expect(finalJob.rows[0].cancel_requested).toBe(true);
    expect(run.rows[0].status).toBe("cancelled");
    expect(effects.rows[0].count).toBe(0);
  });
});
