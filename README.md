# Soup Job Queue

PostgreSQL-backed job queue using Node.js, TypeScript and Express.

## Features
- Idempotent job creation
- Job status, pagination and cancellation APIs
- Multiple workers using PostgreSQL SKIP LOCKED
- Worker leases, heartbeats and recovery
- Fencing tokens to reject stale workers
- Persistent job effects and execution history

## Start

Requirements: Docker Desktop.

    docker compose up --build

API health: http://localhost:3001/health

## API
- POST /jobs
- GET /jobs/:id
- GET /jobs?limit=20
- POST /jobs/:id/cancel

## Tests

    npm install
    npm run build
    npm test

## Chaos testing

See scripts/chaos-test.ts and scripts/chaos-kill-workers.ps1.
Raw results and logs are in docs/.

The recorded 10,000-job chaos test passed, with 132 confirmed worker SIGKILL signals during the test window.

## Guarantee

At-least-once execution. The simulated PostgreSQL effect is protected against duplicate committed rows using a unique job_id constraint and a transaction.

External side effects are not guaranteed exactly once.

## Production verdict

DON'T SHIP at 100 RPS until load testing, latency measurement and production observability are completed.

See docs/design.md, docs/failure-strategy.md, docs/test-results.md and docs/surprises-and-concerns.md.

## AI usage

See docs/AI_USAGE.md.
