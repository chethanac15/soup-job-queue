# Crash Recovery Test — SIGKILL

**Result: PASS**

## Test details

- Job ID: `deeba996-48c1-41d8-b3a5-361a48e372c9`
- Worker: `soup-job-queue-worker-8`
- Crash method: `SIGKILL` sent to the Node.js worker process (PID 7)
- Docker restart count: `1`
- Final job status: `succeeded`
- Attempts: `2`
- Lease epoch: `2`
- Persistent effect rows: `1`

## Observed behavior

1. Worker 8 claimed the job.
2. The Node.js worker process was terminated using `SIGKILL`.
3. Docker automatically restarted the worker container.
4. The original job lease expired.
5. Another worker reclaimed the job.
6. The job completed successfully.
7. Exactly one persistent database effect was recorded.

## Conclusion

The test demonstrates recovery after abrupt worker-process termination. The job was executed at least once and retried after the worker crash. The database contains exactly one persistent effect for this job.

This test supports an at-least-once execution guarantee with an exactly-once database effect for the tested job. It does not establish exactly-once execution.

## Verification query

```sql
SELECT
    j.id,
    j.status,
    j.attempts,
    j.lease_epoch,
    COUNT(e.id) AS effect_count
FROM jobs j
LEFT JOIN job_effects e ON e.job_id = j.id
WHERE j.id = 'deeba996-48c1-41d8-b3a5-361a48e372c9'
GROUP BY j.id, j.status, j.attempts, j.lease_epoch;
```

## Final observed output

```text
status       = succeeded
attempts     = 2
lease_epoch  = 2
effect_count = 1
```
