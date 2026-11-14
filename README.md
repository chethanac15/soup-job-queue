# Soup Job Queue

A PostgreSQL-backed job queue built with Node.js, TypeScript and Express. This project explores reliable job processing under worker crashes, retries, duplicate requests and cancellation.

**Repository:** https://github.com/chethanac15/soup-job-queue

## Quick start

You only need Git and Docker Desktop with Docker Compose enabled to run the application locally.

### 1. Clone the repository

```bash
git clone https://github.com/chethanac15/soup-job-queue.git
cd soup-job-queue
```

### 2. Build and start everything

```bash
docker compose up --build -d
```

That's it. Docker builds the application image and starts:

- PostgreSQL 17
- Express API
- Four background workers

No host Node.js installation, `npm install`, or manual database setup is required for the Dockerized application.

### 3. Verify that everything is running

```bash
docker compose ps
```

Check the API health endpoint:

```bash
curl http://localhost:3001/health
```

The API is available at:

**http://localhost:3001**

### 4. View application logs

```bash
docker compose logs -f api
```

In another terminal:

```bash
docker compose logs -f worker
```

To stop the application without deleting stored data:

```bash
docker compose down
```

To remove the database volume and start with a fresh database:

```bash
docker compose down -v
```

**Warning:** `docker compose down -v` deletes the local PostgreSQL volume, including jobs, execution history and effects.

---

## 1. Features

- Job creation with idempotency keys and payload-conflict detection.
- Job status retrieval and cursor-based pagination.
- Job cancellation.
- Multiple workers claiming jobs concurrently.
- PostgreSQL row locking with `FOR UPDATE SKIP LOCKED`.
- Worker leases, heartbeats and expired-lease recovery.
- Fencing tokens to reject stale worker completions.
- Per-attempt execution history in `job_runs`.
- Persistent simulated side effects in `job_effects`.
- Chaos testing with concurrent submissions, retries, cancellations and worker crashes.

## 2. Architecture

The system has three main components:

| Component | Responsibility |
|---|---|
| Express API | Creates, retrieves, lists and cancels jobs |
| PostgreSQL 17 | Stores jobs, idempotency keys, worker leases, execution history and effects |
| Node.js workers | Claim jobs, execute handlers, send heartbeats and complete or fail jobs |

PostgreSQL is the source of truth for job state. Workers use `FOR UPDATE SKIP LOCKED` to claim different queued jobs concurrently.

A lease expiry allows recovery to detect workers that have stopped responding. A monotonically increasing lease epoch acts as a fencing token so that an old worker cannot commit a stale completion.

### Execution guarantee

The queue provides **at-least-once execution**. A job can be executed again after a worker crash.

The simulated PostgreSQL effect is committed in the same transaction as successful job completion and protected by a unique constraint on `job_id`. This gives at-most-one committed database effect per job.

This does not guarantee exactly-once effects in external systems. External APIs need their own idempotency mechanism or an outbox/inbox design.

## 3. Technology

- Node.js and TypeScript
- Express 5
- PostgreSQL 17
- `pg` for PostgreSQL access
- Zod for request validation
- Vitest and Supertest for integration tests
- Docker and Docker Compose for local services and workers

## 4. API reference

All endpoints use JSON where a request body is required.

| Method | Endpoint | Description |
|---|---|---|
| POST | `/jobs` | Create a job |
| GET | `/jobs/:id` | Retrieve a job |
| GET | `/jobs?limit=20` | List jobs |
| POST | `/jobs/:id/cancel` | Cancel a job |

### Create a job

The idempotency key is supplied in the `Idempotency-Key` header. The request body contains a JSON payload object and an optional `maxAttempts` value.

PowerShell example:

```powershell
$headers = @{
    "Idempotency-Key" = "reviewer-demo-001"
}

$body = @{
    payload = @{
        task = "reviewer-demo"
        message = "Hello from the reviewer demo"
        durationMs = 1000
    }
    maxAttempts = 5
} | ConvertTo-Json -Depth 10

$response = Invoke-RestMethod `
    -Method Post `
    -Uri "http://localhost:3001/jobs" `
    -Headers $headers `
    -ContentType "application/json" `
    -Body $body

$response
$jobId = $response.job.id
```

The response contains the job ID and whether a new job was created.

Sending the same key and same payload again returns the existing job. Reusing the key with a different payload returns HTTP `409 Conflict`.

### Retrieve a job

```powershell
Invoke-RestMethod "http://localhost:3001/jobs/$jobId"
```

### List jobs

```powershell
Invoke-RestMethod "http://localhost:3001/jobs?limit=20"
```

The list endpoint supports cursor-based pagination through the `cursor` query parameter returned as `nextCursor`.

### Cancel a job

```powershell
Invoke-RestMethod `
    -Method Post `
    -Uri "http://localhost:3001/jobs/$jobId/cancel"
```

## 5. Verify job execution and persistent effects

With the API and workers running, create a job using the example above.

Watch the worker logs:

```bash
docker compose logs -f worker
```

The worker logs show when a job starts and completes.

Inspect job records in PostgreSQL:

```bash
docker compose exec postgres psql -U postgres -d soup_queue -c "SELECT id, status, attempts, worker_id, lease_epoch FROM jobs ORDER BY created_at DESC LIMIT 10;"
```

Inspect recorded handler runs:

```bash
docker compose exec postgres psql -U postgres -d soup_queue -c "SELECT job_id, attempt, status FROM job_runs ORDER BY job_id LIMIT 10;"
```

Inspect persistent effects:

```bash
docker compose exec postgres psql -U postgres -d soup_queue -c "SELECT job_id, result, created_at FROM job_effects ORDER BY created_at DESC LIMIT 10;"
```

The `job_runs` table records handler execution attempts. The `job_effects` table records the simulated persistent side effect.

This makes it possible to distinguish a job claim from an actual handler entry and a committed effect.

## 6. Build and integration tests

The integration tests use PostgreSQL. They should be run without background Compose workers or the API consuming test jobs.

### Prerequisites for host-side tests

- Node.js and npm
- Docker Desktop with Docker Compose enabled

Install dependencies:

```bash
npm ci
```

Copy the example environment file:

PowerShell:

```powershell
Copy-Item .env.example .env
```

Stop background workers and the API, leaving PostgreSQL available:

```bash
docker compose stop worker api
docker compose up -d postgres
```

Run the TypeScript build:

```bash
npm run build
```

Run integration tests:

```bash
npm test
```

Vitest is configured to run test files sequentially because parallel test files previously interfered with one another through the shared database.

**Recorded result:** 13 tests passed across two integration test files.

Test output is preserved in:

- `docs/test-results-success-2026-11-14.log`
- `docs/test-results-failed-cancellation-2026-11-14.log`

The earlier failed output is intentionally retained. The cancellation test initially failed because parallel test files shared a database and a background worker claimed another test's job. Sequential test execution resolved the test interference.

## 7. Reproduce the chaos test

The chaos harness defaults to:

| Setting | Default |
|---|---:|
| Jobs | 10,000 |
| Request concurrency | 40 |
| Cancellation probability | 10% |
| Simulated job duration | 250 ms |
| Maximum wait | 30 minutes |
| Workers for the assignment run | 8 |
| Worker-kill interval | Approximately 2 seconds |

The harness sends two concurrent POST requests with the same idempotency key for each job, checks that both requests resolve to the same job, and randomly requests cancellations while submissions are in progress.

A separate PowerShell controller selects a random running worker and sends SIGKILL to its Node.js worker process. Docker's restart policy restarts the killed worker.

### Prerequisites

- Docker Desktop with Docker Compose enabled
- Node.js and npm installed on the host
- PowerShell on Windows
- Dependencies installed with `npm ci`

### Start eight workers

From the repository root:

```powershell
docker compose -f docker-compose.yml -f docker-compose.workers.yml up --build -d --scale worker=8
```

Confirm that eight workers are running:

```powershell
docker compose ps
```

### Terminal 1: Start the worker-kill controller

```powershell
.\scripts\chaos-kill-workers.ps1 -DurationMinutes 30 -IntervalSeconds 2
```

The controller checks that exactly eight workers are running, waits 10 seconds, then attempts a random worker kill approximately every two seconds.

It records confirmed kills, unconfirmed attempts and controller errors in a timestamped log under `docs/`.

### Terminal 2: Run the chaos harness

The API is exposed by Docker Compose on port `3001`. Set the harness URL explicitly before running it:

```powershell
$env:API_URL = "http://localhost:3001"
npm run chaos
```

The harness checks:

- All submitted jobs are recorded.
- Duplicate requests resolve to the same job.
- No jobs remain queued or running after the completion wait.
- Successful jobs have persistent effects.
- Unsuccessful jobs do not have effects.
- No job has duplicate effect rows.
- Handler-run records agree with final job states.
- No unfinished handler runs or invalid run states remain.
- No request or cancellation errors occurred.

The harness writes a timestamped JSON report under `docs/`. If it exits early, it attempts to write a partial failure report under `docs/`.

After the harness finishes, stop the kill controller with Ctrl+C. Its `finally` block records the final controller totals.

**Port note:** The chaos script's built-in API default is port `3000`; the explicit `API_URL` setting above is required when using the Docker Compose host port `3001`.

## 8. Recorded chaos results

One full 10,000-job chaos run is recorded. Smaller smoke-test runs are also preserved.

The full run recorded:

- 10,000 jobs submitted.
- 10,000 successful duplicate-request checks.
- 1,017 cancelled jobs.
- 8,983 successful jobs.
- 126 interrupted handler runs.
- 8,983 persistent effects.
- Zero duplicate effects.
- Zero active jobs remaining.
- All 15 harness checks passed.

The worker-kill controller recorded 132 confirmed SIGKILL signals, zero unconfirmed attempts and zero controller errors.

Three claims had no corresponding persisted handler-run record. This is consistent with workers being killed after claiming a job but before recording handler entry; the exact timing cannot be confirmed from those records alone.

### Evidence in the repository

The repository preserves the recorded reports and test output, including failed results:

| File | Description |
|---|---|
| `docs/chaos-results-2026-11-14T11-47-48-648Z.json` | Full 10,000-job run |
| `docs/chaos-results-2026-11-14T11-46-58-929Z.json` | Smoke run |
| `docs/chaos-results-2026-11-13T11-57-58-329Z.json` | Recorded run |
| `docs/chaos-results-2026-11-13T12-09-09-247Z.json` | Recorded run |
| `docs/worker-kills-2026-11-14_17-18-18.log` | Worker-kill controller output |
| `docs/test-results-success-2026-11-14.log` | Successful integration test output |
| `docs/test-results-failed-cancellation-2026-11-14.log` | Earlier failed integration test output |

The 10,000-job experiment was not rerun during the final documentation update. The historical reports are retained as recorded evidence, not presented as new runs.

## 9. What the chaos test does not prove

The experiment does not establish:

- Capacity at 100 requests per second.
- p95 or p99 request latency.
- Long-duration reliability under sustained load.
- Recovery from PostgreSQL outages.
- Every possible cancellation/completion interleaving.
- Full operating-system pause/resume behavior for stale workers.
- Exactly-once effects in external systems.

## 10. Silent failures and verification

| Scenario | Verification |
|---|---|
| Double claim | Concurrent worker claim integration test using `FOR UPDATE SKIP LOCKED` |
| Zombie worker | Expired lease recovery and rejection of stale completion using the lease epoch; full process pause/resume remains untested |
| Cancellation/completion race | Cancellation during handler execution; simultaneous race stress testing remains outstanding |
| Duplicate request retry | Same-key/same-payload retry and changed-payload HTTP 409; chaos duplicate checks |
| Transaction isolation | Concurrent claim and cancellation paths; exhaustive interleaving tests remain outstanding |
| Clock skew | Lease decisions use PostgreSQL `clock_timestamp()`; artificial clock offsets were not injected |

See `docs/failure-strategy.md` for the detailed verification notes.

## 11. Design, concerns and AI disclosure

Additional assignment documentation:

- `docs/design.md` — one-page system design.
- `docs/surprises-and-concerns.md` — what the chaos experiment revealed and remaining concerns.
- `docs/failure-strategy.md` — silent-failure verification.
- `docs/AI_USAGE.md` — AI assistance, accepted suggestions and verification.

ChatGPT assisted with design review, test diagnosis, interpretation of chaos results and documentation. The developer reviewed and applied changes, addressed shared-database test interference, ran the build and integration tests, and preserved failed test output.

The historical 10,000-job chaos run was not repeated during the final documentation update.

## 12. Verdict

**DON'T SHIP at 100 requests per second yet.**

Before shipping:

- Run sustained load tests and measure throughput and latency.
- Check PostgreSQL saturation and connection-pool behavior.
- Test database-outage recovery.
- Improve operational monitoring.
- Stress cancellation/completion interleavings.

The recorded chaos run provides evidence of worker recovery and protection against duplicate committed PostgreSQL effects. It is not a performance benchmark.

---

## Repository structure

```text
soup-job-queue/
├── docs/
│   ├── AI_USAGE.md
│   ├── architecture.md
│   ├── design.md
│   ├── failure-strategy.md
│   ├── surprises-and-concerns.md
│   ├── test-results.md
│   └── ... chaos and test evidence
├── scripts/
│   ├── chaos-test.ts
│   └── chaos-kill-workers.ps1
├── src/
├── tests/
│   └── integration/
├── Dockerfile
├── docker-compose.yml
├── docker-compose.workers.yml
├── package.json
└── README.md
```

## Further reading

- `docs/design.md` — design decisions and execution guarantees.
- `docs/failure-strategy.md` — failure scenarios and verification.
- `docs/surprises-and-concerns.md` — observations from chaos testing.
- `docs/AI_USAGE.md` — AI usage disclosure.
