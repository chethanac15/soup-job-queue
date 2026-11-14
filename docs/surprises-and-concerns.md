# Surprises and Concerns

The 10,000-job chaos run recorded 126 interrupted handler runs that were recovered, plus three claims without persisted handler-run records, consistent with a worker dying after claim but before handler entry was recorded. The run still ended with 10,000 terminal jobs, 8,983 successful effects, no duplicate effect rows and no active jobs. Claim attempts, handler entries and committed effects are therefore different measurements.

A test-isolation issue also surfaced: test files share a database, and workers claim the oldest queued job. Parallel test files could claim one another's jobs. Stopping Compose workers and running Vitest files sequentially produced 13 passing tests without weakening production claim logic.

The unique effect constraint protects the simulated PostgreSQL effect, not external API calls. An external action could be repeated if a worker crashes before recording completion. External integrations need idempotency or an outbox/inbox pattern.

This finite local experiment does not prove 100 RPS capacity, p95/p99 latency, database-outage recovery or long-duration reliability. Production needs queue-age, retry, lease-expiry, heartbeat, terminal-failure and connection-pool monitoring, plus sustained load tests.
