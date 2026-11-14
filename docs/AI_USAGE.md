# AI Usage Disclosure

ChatGPT assisted with explaining PostgreSQL locking, leases, heartbeats, fencing tokens, retries, idempotency and cancellation; reviewing implementation and test approaches; diagnosing test interference; interpreting test and chaos output; and editing project documentation.

The developer applied and reviewed the suggestions. In particular, sequential Vitest file execution was added after shared-database test interference was identified. The chaos harness default was changed to port 3001 and early fatal errors were given a partial JSON-report path. These changes require and receive local build/test verification.

The 13-test result and 10,000-job chaos results cited here are actual local project outputs from development. The chaos run was not repeated during this documentation update. AI assistance does not replace independent review or execution.
