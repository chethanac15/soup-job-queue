
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pool } from "../src/database/db";

const API_URL = process.env.API_URL ?? "http://localhost:3001";

const TOTAL_JOBS = Number(process.env.CHAOS_TOTAL_JOBS ?? 10_000);
const REQUEST_CONCURRENCY = Number(
  process.env.CHAOS_REQUEST_CONCURRENCY ?? 40
);
const CANCEL_PERCENT = Number(process.env.CHAOS_CANCEL_PERCENT ?? 10);
const JOB_DURATION_MS = Number(process.env.CHAOS_JOB_DURATION_MS ?? 250);
const MAX_WAIT_MS = Number(
  process.env.CHAOS_MAX_WAIT_MS ?? 30 * 60 * 1000
);

const MAX_REQUEST_RETRIES = 4;

if (
  !Number.isInteger(TOTAL_JOBS) ||
  TOTAL_JOBS < 1 ||
  !Number.isInteger(REQUEST_CONCURRENCY) ||
  REQUEST_CONCURRENCY < 1 ||
  CANCEL_PERCENT < 0 ||
  CANCEL_PERCENT > 100 ||
  !Number.isInteger(JOB_DURATION_MS) ||
  JOB_DURATION_MS < 0 ||
  !Number.isFinite(MAX_WAIT_MS) ||
  MAX_WAIT_MS < 1
) {
  throw new Error("Invalid chaos-test configuration.");
}

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const keyPrefix = `chaos-${runId}`;

type ApiResponse = {
  job: { id: string };
  created: boolean;
};

type RequestFailure = {
  index: number;
  message: string;
};

const requestFailures: RequestFailure[] = [];

let duplicateChecksPassed = 0;
let duplicateChecksFailed = 0;
let cancellationRequests = 0;
let cancellationErrors = 0;
let completedSubmissions = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  options: RequestInit
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_REQUEST_RETRIES; attempt++) {
    try {
      const response = await fetch(url, options);

      if (response.status !== 429 && response.status < 500) {
        return response;
      }

      lastError = new Error(`HTTP ${response.status}`);

      if (attempt < MAX_REQUEST_RETRIES) {
        await sleep(250 * attempt);
      }
    } catch (error) {
      lastError = error;

      if (attempt < MAX_REQUEST_RETRIES) {
        await sleep(250 * attempt);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Request failed after retries.");
}

async function postJob(
  key: string,
  payload: Record<string, unknown>
): Promise<ApiResponse> {
  const response = await fetchWithRetry(`${API_URL}/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify({
      payload,
      maxAttempts: 5,
    }),
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `POST /jobs failed (${response.status}): ${responseText}`
    );
  }

  return JSON.parse(responseText) as ApiResponse;
}

async function cancelJob(id: string): Promise<void> {
  const response = await fetchWithRetry(
    `${API_URL}/jobs/${id}/cancel`,
    { method: "POST" }
  );

  if (!response.ok) {
    const responseText = await response.text();

    throw new Error(
      `Cancellation failed (${response.status}): ${responseText}`
    );
  }
}

async function forEachLimit<T>(
  items: T[],
  limit: number,
  action: (item: T, index: number) => Promise<void>
): Promise<void> {
  let nextIndex = 0;

  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const index = nextIndex++;

        if (index >= items.length) {
          return;
        }

        await action(items[index], index);
      }
    }
  );

  await Promise.all(runners);
}

async function waitForCompletion(): Promise<boolean> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < MAX_WAIT_MS) {
    const result = await pool.query(
      `SELECT
         COUNT(*) FILTER (
           WHERE status IN ('queued', 'running')
         )::int AS active,
         COUNT(*)::int AS total
       FROM jobs
       WHERE idempotency_key LIKE $1`,
      [`${keyPrefix}-%`]
    );

    const active = Number(result.rows[0].active);
    const total = Number(result.rows[0].total);

    console.log(
      `Progress: ${total}/${TOTAL_JOBS} jobs recorded; ${active} active`
    );

    if (total === TOTAL_JOBS && active === 0) {
      return true;
    }

    await sleep(3000);
  }

  return false;
}

async function collectReport(completedWithinTimeout: boolean) {
  const states = await pool.query(
    `SELECT status, COUNT(*)::int AS count
     FROM jobs
     WHERE idempotency_key LIKE $1
     GROUP BY status
     ORDER BY status`,
    [`${keyPrefix}-%`]
  );

  // Claim attempts are not the same as actual handler executions.
  const attempts = await pool.query(
    `SELECT
       COUNT(*)::int AS total_jobs,
       COALESCE(SUM(attempts), 0)::int AS total_claim_attempts,
       COUNT(*) FILTER (
         WHERE status = 'failed'
       )::int AS failed_jobs,
       COUNT(*) FILTER (
         WHERE status IN ('queued', 'running')
       )::int AS active_jobs
     FROM jobs
     WHERE idempotency_key LIKE $1`,
    [`${keyPrefix}-%`]
  );

  // Each job_runs row represents a handler entry recorded by startJobRun.
  const runs = await pool.query(
    `SELECT
       COUNT(*)::int AS total_handler_runs,
       COUNT(DISTINCT r.job_id)::int AS jobs_with_handler_runs,
       COUNT(*) FILTER (
         WHERE r.status = 'started'
       )::int AS started_runs,
       COUNT(*) FILTER (
         WHERE r.status = 'succeeded'
       )::int AS succeeded_runs,
       COUNT(*) FILTER (
         WHERE r.status = 'failed'
       )::int AS failed_runs,
       COUNT(*) FILTER (
         WHERE r.status = 'interrupted'
       )::int AS interrupted_runs,
       COUNT(*) FILTER (
         WHERE r.status = 'cancelled'
       )::int AS cancelled_runs
     FROM job_runs r
     JOIN jobs j ON j.id = r.job_id
     WHERE j.idempotency_key LIKE $1`,
    [`${keyPrefix}-%`]
  );

  // Verify that run history agrees with the final job state.
  const runIntegrity = await pool.query(
    `SELECT
       COUNT(*) FILTER (
         WHERE r.attempt > j.attempts
            OR r.lease_epoch > j.lease_epoch
       )::int AS future_run_records,

       COUNT(*) FILTER (
         WHERE r.status = 'succeeded'
           AND j.status <> 'succeeded'
       )::int AS successful_runs_for_non_successful_jobs,

       COUNT(*) FILTER (
         WHERE r.status = 'started'
       )::int AS unfinished_runs,

       COUNT(*) FILTER (
         WHERE r.status NOT IN (
           'started',
           'succeeded',
           'failed',
           'interrupted',
           'cancelled'
         )
       )::int AS invalid_run_statuses

     FROM job_runs r
     JOIN jobs j ON j.id = r.job_id
     WHERE j.idempotency_key LIKE $1`,
    [`${keyPrefix}-%`]
  );

  const successfulJobsWithoutRun = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM jobs j
     WHERE j.idempotency_key LIKE $1
       AND j.status = 'succeeded'
       AND NOT EXISTS (
         SELECT 1
         FROM job_runs r
         WHERE r.job_id = j.id
           AND r.status = 'succeeded'
       )`,
    [`${keyPrefix}-%`]
  );

  const effects = await pool.query(
    `SELECT
       COUNT(e.id)::int AS effect_rows,

       COUNT(*) FILTER (
         WHERE j.status = 'succeeded'
           AND e.id IS NULL
       )::int AS succeeded_without_effect,

       COUNT(*) FILTER (
         WHERE j.status <> 'succeeded'
           AND e.id IS NOT NULL
       )::int AS effect_without_success

     FROM jobs j
     LEFT JOIN job_effects e ON e.job_id = j.id
     WHERE j.idempotency_key LIKE $1`,
    [`${keyPrefix}-%`]
  );

  const duplicateEffects = await pool.query(
    `SELECT COUNT(*)::int AS duplicate_groups
     FROM (
       SELECT e.job_id
       FROM job_effects e
       JOIN jobs j ON j.id = e.job_id
       WHERE j.idempotency_key LIKE $1
       GROUP BY e.job_id
       HAVING COUNT(*) > 1
     ) duplicates`,
    [`${keyPrefix}-%`]
  );

  const totalJobs = Number(attempts.rows[0].total_jobs);
  const activeJobs = Number(attempts.rows[0].active_jobs);

  const totalClaimAttempts = Number(
    attempts.rows[0].total_claim_attempts
  );

  const totalHandlerRuns = Number(
    runs.rows[0].total_handler_runs
  );

  const startedRuns = Number(runs.rows[0].started_runs);
  const succeededRuns = Number(runs.rows[0].succeeded_runs);
  const failedRuns = Number(runs.rows[0].failed_runs);
  const interruptedRuns = Number(runs.rows[0].interrupted_runs);
  const cancelledRuns = Number(runs.rows[0].cancelled_runs);

  const missingEffects = Number(
    effects.rows[0].succeeded_without_effect
  );

  const effectsOnUnsuccessfulJobs = Number(
    effects.rows[0].effect_without_success
  );

  const duplicateEffectGroups = Number(
    duplicateEffects.rows[0].duplicate_groups
  );

  const futureRunRecords = Number(
    runIntegrity.rows[0].future_run_records
  );

  const successfulRunsForNonSuccessfulJobs = Number(
    runIntegrity.rows[0].successful_runs_for_non_successful_jobs
  );

  const unfinishedRuns = Number(
    runIntegrity.rows[0].unfinished_runs
  );

  const invalidRunStatuses = Number(
    runIntegrity.rows[0].invalid_run_statuses
  );

  const succeededJobsWithoutRun = Number(
    successfulJobsWithoutRun.rows[0].count
  );

  const checks = {
    allJobsRecorded: totalJobs === TOTAL_JOBS,

    duplicateRetriesCorrect:
      duplicateChecksPassed === TOTAL_JOBS &&
      duplicateChecksFailed === 0,

    noActiveJobs: activeJobs === 0,

    completedWithinTimeout,

    succeededJobsHaveEffects: missingEffects === 0,

    noEffectsOnUnsuccessfulJobs:
      effectsOnUnsuccessfulJobs === 0,

    noDuplicateEffects: duplicateEffectGroups === 0,

    noSubmissionErrors: requestFailures.length === 0,

    noCancellationErrors: cancellationErrors === 0,

    noUnfinishedHandlerRuns: unfinishedRuns === 0,

    noSuccessfulJobsMissingSuccessfulRun:
      succeededJobsWithoutRun === 0,

    noSuccessfulRunsForUnsuccessfulJobs:
      successfulRunsForNonSuccessfulJobs === 0,

    noFutureRunRecords: futureRunRecords === 0,

    noInvalidRunStatuses: invalidRunStatuses === 0,

    handlerRunsDoNotExceedClaims:
      totalHandlerRuns <= totalClaimAttempts,
  };

  return {
    runId,
    createdAt: new Date().toISOString(),

    configuration: {
      targetJobs: TOTAL_JOBS,
      requestConcurrency: REQUEST_CONCURRENCY,
      cancellationPercent: CANCEL_PERCENT,
      jobDurationMs: JOB_DURATION_MS,
      apiUrl: API_URL,
    },

    recordedJobs: totalJobs,
    completedSubmissions,

    duplicateChecksPassed,
    duplicateChecksFailed,

    cancellationRequests,
    cancellationErrors,

    completedWithinTimeout,
    statusCounts: states.rows,

    // Claims and actual handler entries are deliberately separate.
    totalClaimAttempts,

    handlerRuns: {
      total: totalHandlerRuns,
      jobsWithHandlerRuns: Number(
        runs.rows[0].jobs_with_handler_runs
      ),
      started: startedRuns,
      succeeded: succeededRuns,
      failed: failedRuns,
      interrupted: interruptedRuns,
      cancelled: cancelledRuns,
    },

    failedJobs: Number(attempts.rows[0].failed_jobs),
    activeJobs,

    effectRows: Number(effects.rows[0].effect_rows),
    succeededWithoutEffect: missingEffects,
    effectsOnUnsuccessfulJobs,
    duplicateEffectGroups,

    runIntegrity: {
      unfinishedRuns,
      successfulJobsWithoutSuccessfulRun: succeededJobsWithoutRun,
      successfulRunsForNonSuccessfulJobs,
      futureRunRecords,
      invalidRunStatuses,
    },

    submissionErrors: requestFailures,

    checks,
    allChecksPassed: Object.values(checks).every(Boolean),

    interpretation: {
      claimAttempts:
        "SUM(jobs.attempts) counts successful claims. It is not the number of handler executions.",

      handlerRuns:
        "COUNT(job_runs) records handler entries successfully persisted by startJobRun. A worker killed after claiming but before recording its handler entry is not counted as a handler run. A recorded run killed before completion is marked interrupted after lease recovery.",

      executionGuarantee:
        "The queue provides at-least-once execution. The unique job_effects.job_id constraint and fenced completion transaction protect the tested database effect from duplicate commits.",

      limitation:
        "This harness validates the database-backed simulated effect. It does not prove exactly-once behavior for external side effects such as sending email or calling third-party APIs.",
    },
  };
}

async function main(): Promise<void> {
  console.log("\n====================================");
  console.log("          SOUP CHAOS TEST");
  console.log("====================================");

  console.log(`Run ID: ${runId}`);
  console.log(`Target jobs: ${TOTAL_JOBS}`);
  console.log(`Request concurrency: ${REQUEST_CONCURRENCY}`);
  console.log(`Cancellation percentage: ${CANCEL_PERCENT}%`);
  console.log(`Job duration: ${JOB_DURATION_MS}ms`);
  console.log(`API: ${API_URL}\n`);

  const health = await fetch(`${API_URL}/health`);

  if (!health.ok) {
    throw new Error(`API health check failed: ${health.status}`);
  }

  console.log("API health check passed.");

  await forEachLimit(
    Array.from({ length: TOTAL_JOBS }, (_, index) => index),
    REQUEST_CONCURRENCY,
    async (index) => {
      const key = `${keyPrefix}-${index}`;

      const payload = {
        task: "chaos-test",
        message: `Chaos job ${index}`,
        durationMs: JOB_DURATION_MS,
      };

      let duplicateCheckRecorded = false;

      try {
        // Send both requests concurrently to test idempotency races.
        const [first, second] = await Promise.all([
          postJob(key, payload),
          postJob(key, payload),
        ]);

        const correctDuplicate =
          first.job.id === second.job.id &&
          first.created !== second.created;

        if (correctDuplicate) {
          duplicateChecksPassed++;
        } else {
          duplicateChecksFailed++;
        }

        duplicateCheckRecorded = true;

        // Randomly cancel some jobs while submissions are still running.
        if (Math.random() * 100 < CANCEL_PERCENT) {
          cancellationRequests++;

          try {
            await cancelJob(first.job.id);
          } catch (error) {
            cancellationErrors++;

            console.error(
              `Cancellation error for job ${first.job.id}:`,
              error
            );
          }
        }
      } catch (error) {
        if (!duplicateCheckRecorded) {
          duplicateChecksFailed++;
        }

        requestFailures.push({
          index,
          message:
            error instanceof Error ? error.message : String(error),
        });

        console.error(`Job ${index} submission failed:`, error);
      } finally {
        completedSubmissions++;

        if (completedSubmissions % 500 === 0) {
          console.log(
            `Submission pairs completed: ${completedSubmissions}/${TOTAL_JOBS}`
          );
        }
      }
    }
  );

  console.log("\nAll submission pairs finished.");
  console.log(`Duplicate checks passed: ${duplicateChecksPassed}`);
  console.log(`Duplicate checks failed: ${duplicateChecksFailed}`);
  console.log(`Cancellation requests: ${cancellationRequests}`);
  console.log(`Cancellation errors: ${cancellationErrors}`);
  console.log(`Submission errors: ${requestFailures.length}`);

  console.log("\nWaiting for all jobs to finish...");

  const completedWithinTimeout = await waitForCompletion();

  console.log("\nCollecting database verification results...");

  const report = await collectReport(completedWithinTimeout);

  await mkdir("docs", { recursive: true });

  const filename = join(
    "docs",
    `chaos-results-${runId}.json`
  );

  await writeFile(filename, JSON.stringify(report, null, 2), "utf8");

  console.log("\n====================================");
  console.log("        FINAL CHAOS TEST REPORT");
  console.log("====================================");

  console.log(JSON.stringify(report, null, 2));
  console.log(`\nRaw JSON report saved to: ${filename}`);

  if (!report.allChecksPassed) {
    console.error("\nSome chaos-test checks failed.");
    process.exitCode = 1;
  } else {
    console.log("\nAll chaos-test checks passed.");
  }
}

main()
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);

    console.error("\nChaos test failed:", error);

    const failureReport = {
      runId,
      recordedAt: new Date().toISOString(),
      apiUrl: API_URL,
      targetJobs: TOTAL_JOBS,
      requestConcurrency: REQUEST_CONCURRENCY,
      cancelPercent: CANCEL_PERCENT,
      jobDurationMs: JOB_DURATION_MS,
      completedSubmissions,
      duplicateChecksPassed,
      duplicateChecksFailed,
      cancellationRequests,
      cancellationErrors,
      submissionFailures: requestFailures,
      error: message,
      note: "Partial failure report. Database verification may not have completed."
    };

    try {
      await mkdir("docs", { recursive: true });

      const filename = join("docs", `chaos-failure-${runId}.json`);

      await writeFile(
        filename,
        JSON.stringify(failureReport, null, 2),
        "utf8"
      );

      console.error(`Partial failure report saved to: ${filename}`);
    } catch (reportError) {
      console.error("Could not save chaos failure report:", reportError);
    }

    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
