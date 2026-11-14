# Failure Handling Strategy

## 1. Double Claim

Risk: Two workers may attempt to claim the same job simultaneously.

Protection: PostgreSQL row-level locking with FOR UPDATE SKIP LOCKED, atomic claim transactions and conditional state updates.

Verification: Concurrent worker claim tests and ownership inspection.

## 2. Zombie Worker

Risk: A worker may resume after its lease expires and another worker has claimed the same job.

Protection: Incrementing fencing tokens and validating the current token before committing any effect or final state.

Verification: Pause a worker, expire its lease, allow another worker to claim the job, then resume the original worker.

## 3. Cancellation and Completion Race

Risk: Cancellation and successful completion may occur concurrently.

Protection: Row locking, conditional state transitions and an atomic completion transaction.

Verification: Run concurrent cancellation and completion requests and inspect the final state and effects table.

## 4. Duplicate Request Retry

Risk: A client may retry a request after the original request has already committed.

Protection: A unique idempotency key and payload hash comparison.

Verification: Send concurrent requests with identical keys and payloads. Confirm that one job is created. Reuse the key with a different payload and verify HTTP 409.

## 5. Transaction Isolation

Risk: Concurrent transactions may observe or modify job state in unsafe ways.

Protection: Explicit row locks, atomic updates, unique constraints and a documented PostgreSQL READ COMMITTED isolation strategy.

Verification: Run concurrent claim, completion and cancellation tests.

## 6. Clock Skew

Risk: Worker machines may have different system clocks.

Protection: PostgreSQL database time is used for lease creation, renewal and expiry decisions.

Verification: Introduce artificial worker clock offsets and verify that recovery decisions remain based on database time.

## Remaining Limitations

The protections will be validated through integration tests and fault-injection experiments. External side effects outside PostgreSQL require separate idempotency and recovery mechanisms.