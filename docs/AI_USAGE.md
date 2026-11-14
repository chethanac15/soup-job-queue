# AI Usage Disclosure

ChatGPT was used as an engineering assistant during development.

Its assistance included:
- Explaining job queue concepts, PostgreSQL locking, leases, retries, idempotency and cancellation races.
- Reviewing implementation approaches and suggesting reliability tests.
- Helping diagnose integration-test failures and identify interference from concurrently running Docker workers.
- Reviewing chaos-test output and helping interpret claim attempts, persisted handler runs, interrupted attempts and persistent effects.
- Assisting with the design note, test documentation and final readiness assessment.

All code and test results were run in the local project environment. The reported test and chaos results are based on actual command output captured during development. AI-generated suggestions were reviewed and tested by the developer; AI assistance does not replace independent verification.