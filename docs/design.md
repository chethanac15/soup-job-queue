# Soup Job Queue — System Design

## 1. Technology Choices

The system uses Node.js, TypeScript, Express and PostgreSQL. Docker Compose provides a reproducible environment for the API, database and multiple workers.

PostgreSQL is selected because the system requires concurrent job claiming, row-level locking, transactions and unique constraints.

## 2. Architecture

The application consists of an API server, PostgreSQL database and independent worker processes.

The API handles job creation, status retrieval, pagination and cancellation. Workers independently claim and execute jobs. PostgreSQL is the source of truth for job state and execution effects.

## 3. Job Claiming

Workers claim jobs through an atomic database transaction using SELECT FOR UPDATE SKIP LOCKED.

A successful claim changes the job from queued to running, assigns a worker ID, increments its fencing token and establishes a lease expiry.

## 4. Worker Failure Detection

Workers periodically renew their leases using heartbeats.

A recovery process identifies running jobs whose leases have expired. Such jobs can be retried if their attempt limit has not been reached.

## 5. Zombie Worker Protection

Every successful claim increments a fencing token. A worker must present its current token when attempting to commit a result.

A stale worker with an expired token cannot commit an effect or update the job's final state.

## 6. Cancellation Semantics

Queued jobs can be cancelled directly. For running jobs, the API records a cancellation request.

Completion and cancellation are coordinated through database transactions and conditional state transitions. The transaction that wins determines the final state.

## 7. Execution Guarantee

The system permits at-least-once execution attempts, but aims to guarantee at-most-once committed database side effects.

The effect insertion and successful job-state update occur atomically in one transaction. A unique constraint on the job ID in the effects table provides an additional safeguard.

This guarantee applies to database effects, not arbitrary external side effects.

## 8. Known Limitations

The system's reliability and performance will be evaluated through concurrent integration tests, worker crash injection and a 100 RPS benchmark.

Results and remaining limitations will be documented after testing.

## Database Choice

I selected PostgreSQL over SQLite because the system requires multiple concurrent workers to claim and update jobs safely.

PostgreSQL provides row-level locking, SELECT FOR UPDATE SKIP LOCKED, transactional state changes, unique constraints and configurable transaction isolation.

These capabilities are particularly relevant to preventing double claims, coordinating cancellation and completion, and recovering jobs after worker failures.

The database is the source of truth for job ownership and execution effects.

# Soup Job Queue — Design

## Architecture and storage choice

The queue uses Node.js, TypeScript, Express and PostgreSQL. PostgreSQL was chosen over SQLite because the system needs concurrent worker claims, row-level locking, transactional state changes, unique constraints and durable job history. PostgreSQL's `FOR UPDATE SKIP LOCKED` allows multiple workers to claim different jobs without waiting on the same queued row.

## Job lifecycle

Jobs move through `queued`, `running`, and one terminal state: `succeeded`, `failed`, or `cancelled`.

The API supports:
- `POST /jobs` — create a job using an idempotency key.
- `GET /jobs/:id` — retrieve job status.
- `GET /jobs` — list jobs using cursor pagination.
- `POST /jobs/:id/cancel` — request cancellation.

An idempotency key has a unique database constraint. The payload is canonicalized and hashed. Repeating the same key and payload returns the existing job; reusing the key with a different payload returns HTTP 409.

## Claiming and worker recovery

Workers claim jobs inside a database transaction using `SELECT ... FOR UPDATE SKIP LOCKED`. The claim updates the job to `running`, assigns a worker ID, increments the attempt count and lease epoch, and sets a lease expiration using PostgreSQL's clock.

Workers periodically renew their leases. A recovery loop finds expired leases, marks recorded attempts as interrupted, and either requeues the job or marks it terminally failed when the retry limit is reached.

The lease epoch is a fencing token. A stale worker whose lease has expired cannot complete a job using an old epoch. Ownership and lease validity are checked during completion.

## Cancellation and completion races

Cancelling a queued job changes it directly to `cancelled`. Cancelling a running job sets `cancel_requested`. The worker checks this flag during processing and before completion.

Cancellation and completion use database transactions and row locking. Whichever transaction successfully obtains and commits the relevant state transition first determines the outcome. A completed job is not retroactively cancelled.

## Side effects and delivery guarantee

The queue provides **at-least-once execution**, not exactly-once execution.

The simulated database effect is inserted in the same transaction as successful job completion. A unique constraint on `job_effects.job_id` prevents duplicate effect rows. This protects the tested database effect from duplicate commits.

This does not make arbitrary external side effects exactly once. Email, payment, or third-party API integrations would require their own idempotency mechanism or transactional outbox/inbox design.

## Reliability test results

The integration suite passed 13 tests.

The 10,000-job chaos run recorded:
- 10,000 jobs and 10,000 successful duplicate checks.
- 1,017 cancellations and 8,983 successful jobs.
- 9,109 persisted handler runs, including 126 interrupted runs.
- 8,983 persistent effects and zero duplicate effects.
- Zero active jobs remaining and all harness checks passing.

The crash controller recorded 132 confirmed worker-process SIGKILL signals during the run, with no controller errors.

Raw output: `docs/chaos-results-2026-11-14T11-47-48-648Z.json`

## Limitations and production readiness

The harness validates the database-backed simulated effect, not arbitrary external side effects. The 100 RPS throughput target has not yet been benchmarked, and production latency, database saturation, connection-pool behavior and long-duration recovery still need measurement.

**Verdict: DON'T SHIP at 100 RPS until load testing and production observability are completed.**