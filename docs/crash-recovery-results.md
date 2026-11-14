# Crash Recovery Test

## Test setup
- Workers started: 4
- Simulated job duration: 60 seconds
- Lease duration: 15 seconds
- Job ID: `c00d80ec-55d0-41be-b503-6e06e68718e6`

## Procedure
1. Submitted a job with idempotency key `crash-recovery-002`.
2. Verified that `worker-4` claimed it on attempt 1, lease epoch 1.
3. Interrupted `worker-4` while it was processing the job.
4. Waited for the lease to expire.
5. Verified that another worker reclaimed and completed the job.

## Observed result
- Final status: `succeeded`
- Attempts: `2`
- Lease epoch: `2`
- Completing worker: `worker-1`
- Persistent effect rows: `1`

## Conclusion
The test demonstrated recovery from an interrupted worker through lease expiry and job reclamation. The job was executed on a second attempt and completed successfully. The database contained exactly one persistent effect row for this job.

This is evidence of at-least-once execution with an exactly-once database effect for this test case. It does not prove exactly-once behavior for arbitrary external side effects or all crash scenarios.

## Limitation
The worker was interrupted using Ctrl+C, not forcibly terminated with `kill -9`. A separate hard-kill chaos test is still required.


# Running Cancellation Test

## Test setup
- Job ID: `d9cdb7a4-66e1-4ac5-80e3-eabacb91e321`
- Worker: `worker-1`
- Simulated duration: 60 seconds

## Procedure
1. Submitted a job and verified it was running.
2. Sent a cancellation request while it was running.
3. Verified `cancel_requested` became true.
4. Waited for the worker to observe cancellation through its heartbeat.
5. Queried the final job state and persistent effects.

## Observed result
- Final status: `cancelled`
- Attempts: `1`
- Worker ID: cleared
- Cancellation flag: `true`
- Completion timestamp: present
- Persistent effect rows: `0`

## Conclusion
The running cancellation flow worked as expected. The API recorded the cancellation request, the worker observed it during lease renewal, and the job transitioned to cancelled without creating a persistent effect.
