# Docker smoke-test results

Date: 2026-11-14

The Docker Compose stack was started with PostgreSQL, the API, and four workers.

## API and successful job

- API health check: `http://localhost:3001/health` returned success.
- A job submitted through `POST /jobs` reached `succeeded`.
- The database contained exactly one `job_effects` row and one successful `job_runs` row for that job.
- Repeating the same idempotency key and payload returned the original job.
- Reusing that key with a different payload returned HTTP 409.

## Cancellation

- Job: `879637cb-cdf1-437c-ae41-62e1e7ac6382`
- The job entered `running` before cancellation was requested.
- The cancellation endpoint returned `cancel_requested: true`.
- The final job status was `cancelled`.
- A database query confirmed `effect_count = 0` for this job.

These are manual Docker smoke checks, not a throughput or 100 RPS benchmark.

## Test isolation note

Stop the Compose worker replicas before running the integration test suite (docker compose stop worker). Otherwise, background workers can claim jobs created by the tests and make the lease-recovery test fail nondeterministically. The suite passed all 13 tests with the Compose workers stopped.
