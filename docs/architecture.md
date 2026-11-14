# System Architecture — Soup Job Queue

## Overview

The system is a distributed training-job queue built using Node.js, TypeScript, Express and PostgreSQL.

It consists of three primary components: an HTTP API server, a PostgreSQL database and multiple independent worker processes.

## 1. API Server

The API server provides four operations:

- POST /jobs — Create a job.
- GET /jobs/:id — Retrieve job status.
- GET /jobs — List jobs with pagination.
- POST /jobs/:id/cancel — Cancel a job.

The API server does not execute training jobs. It manages job creation, retrieval and cancellation.

## 2. PostgreSQL Database

PostgreSQL is the source of truth for job state, worker ownership, leases, idempotency keys and execution effects.

It provides transactional updates, unique constraints and row-level locking.

## 3. Worker Processes

The system runs at least four independent workers and supports eight workers during chaos testing.

Each worker:

1. Attempts to claim a queued job.
2. Atomically changes its state to running.
3. Records its worker ID and fencing token.
4. Renews its lease periodically.
5. Executes the simulated training operation.
6. Commits its result using a database transaction.

## 4. Job Recovery

Workers use periodic heartbeats to renew leases.

A recovery process identifies jobs whose leases have expired. Eligible jobs are returned to the queue for another attempt. Jobs exceeding the configured attempt limit are marked failed.

## 5. Execution Effects

A separate job_effects table stores committed execution effects.

The job completion transaction validates worker ownership and its fencing token, inserts the effect and marks the job succeeded atomically.

A unique constraint on job_id prevents multiple committed effects for one job.

## 6. Reliability Strategy

The system uses PostgreSQL row locking, atomic transactions, unique constraints, leases, fencing tokens and idempotency keys to protect against concurrent workers, retries and worker crashes.

## 7. Deployment

Docker Compose starts PostgreSQL, the API server and the worker processes. The chaos test can launch eight workers and terminate individual processes to verify recovery behaviour.