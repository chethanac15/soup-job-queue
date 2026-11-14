# Soup Job Queue

PostgreSQL-backed job queue using Node.js, TypeScript and Express.

Features: idempotent creation, status and pagination APIs, cancellation, concurrent workers, leases, heartbeats, fencing tokens, recovery and persistent effects.

## Start
Requirements: Docker Desktop and Node.js.

    npm install
    Copy-Item .env.example .env
    docker compose up --build -d

API: http://localhost:3001
Health: http://localhost:3001/health

## API
- POST /jobs
- GET /jobs/:id
- GET /jobs?limit=20
- POST /jobs/:id/cancel

Same idempotency key and payload returns the original job; a changed payload returns HTTP 409.

## Tests
Stop Compose workers before tests because integration tests share a database.

    docker compose stop worker
    npm run build
    npm test

Vitest runs test files sequentially. Test logs:
- docs/test-results-success-2026-11-14.log
- docs/test-results-failed-cancellation-2026-11-14.log

## Chaos test
The harness defaults to API port 3001 and 10,000 jobs.

Start database and API:
    docker compose up -d --build postgres api

Set the API URL:
    $env:API_URL = "http://localhost:3001"

Start eight workers:
    docker compose -f docker-compose.yml -f docker-compose.workers.yml up --build -d --scale worker=8

In one PowerShell window:
    .\scripts\chaos-kill-workers.ps1 -DurationMinutes 30 -IntervalSeconds 2

In another:
    $env:API_URL = "http://localhost:3001"
    npm run chaos

The controller checks for eight workers, waits 10 seconds, then attempts SIGKILL approximately every two seconds. Successful reports are docs/chaos-results-*.json; early failures attempt docs/chaos-failure-*.json.

Recorded run: docs/chaos-results-2026-11-14T11-47-48-648Z.json.
Kill log: docs/worker-kills-2026-11-14_17-18-18.log.

## Guarantee and verdict
Execution is at least once. The simulated PostgreSQL effect is committed atomically with completion and protected by a unique job_id constraint. This does not guarantee exactly-once external effects.

DON'T SHIP at 100 RPS until sustained load, latency, database saturation and observability testing are completed.
