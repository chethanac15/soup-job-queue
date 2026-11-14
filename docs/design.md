# System Design

The system consists of an Express API, PostgreSQL and independent Node.js workers. PostgreSQL was chosen over SQLite for row-level locking, transactions, unique constraints and `FOR UPDATE SKIP LOCKED`, which lets workers claim different jobs concurrently.

Jobs move from queued to running and then succeeded, failed or cancelled. The API supports idempotent creation, status retrieval, cursor pagination and cancellation. An idempotency key is unique; its canonical payload hash detects conflicting reuse.

Workers claim jobs transactionally using `FOR UPDATE SKIP LOCKED`. A claim assigns worker ownership, increments attempts and a lease epoch, and sets lease expiry using PostgreSQL `clock_timestamp()`. Heartbeats renew leases. Recovery marks expired attempts interrupted and requeues jobs or fails them at the attempt limit.

The lease epoch is a fencing token. Completion validates worker ownership, epoch and lease validity so stale workers cannot commit. Queued jobs can be cancelled directly; running jobs receive a cancellation request that the worker checks before completion. Cancellation and completion use transactional state checks.

Execution is at least once, not exactly once. The simulated PostgreSQL effect is inserted in the completion transaction and protected by a unique job_id constraint. External APIs require their own idempotency or an outbox/inbox design.

## Recorded results

The integration suite passed 13 tests with sequential test-file execution. The 10,000-job chaos run recorded 10,000 successful duplicate checks, 1,017 cancellations, 8,983 successful jobs, 126 interrupted handler runs, 8,983 effects, zero duplicate effects and zero active jobs. All 15 harness checks passed. The crash controller recorded 132 confirmed SIGKILL signals, zero unconfirmed attempts and zero controller errors.

Evidence: `chaos-results-2026-11-14T11-47-48-648Z.json`, `worker-kills-2026-11-14_17-18-18.log`, and `test-results-success-2026-11-14.log`.

The experiment is not a 100 RPS benchmark and does not establish latency, long-duration stability or database-outage behavior.

**Verdict: DON'T SHIP at 100 RPS** until load, latency, dependency-failure and observability testing are completed.
