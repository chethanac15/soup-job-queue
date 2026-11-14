# Failure Handling and Verification

## 1. Double claim
Risk: two workers claim one job.
Protection: transactional `FOR UPDATE SKIP LOCKED` and conditional state update.
Status: TESTED — concurrent worker claim test confirms only one worker claims the test job.

## 2. Zombie worker
Risk: an expired worker resumes after a new claim.
Protection: incrementing lease epoch and checking owner, epoch and lease before completion.
Status: PARTIALLY TESTED — expired lease recovery and stale completion rejection tested; no full OS-level pause/resume experiment.

## 3. Cancellation/completion race
Risk: cancellation and completion overlap.
Protection: row locks, transactional state checks and cancellation flag.
Status: PARTIALLY TESTED — cancellation during handler execution prevents effect; truly simultaneous race not independently stress-tested.

## 4. Duplicate request retry
Risk: client retries a committed request.
Protection: unique idempotency key and canonical payload hash.
Status: TESTED — same-payload retry, changed-payload HTTP 409 and 10,000 chaos duplicate checks passed.

## 5. Transaction isolation
Risk: concurrent state changes conflict.
Protection: PostgreSQL READ COMMITTED with explicit row locks, atomic updates and unique constraints.
Status: PARTIALLY TESTED — concurrent claim and cancellation paths tested; no exhaustive isolation/interleaving test.

## 6. Clock skew
Risk: worker clocks disagree.
Protection: lease decisions use PostgreSQL `clock_timestamp()`.
Status: PARTIALLY TESTED — database-time implementation verified; artificial clock offsets not injected.

External effects still require their own idempotency or outbox/inbox mechanism. Load and database-outage testing remain outstanding.
