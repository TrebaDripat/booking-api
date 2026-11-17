# Worklog

## 2026-11-17 — Verify a two-request booking race

Added a two-request case to the PostgreSQL integration suite. Each NestJS process receives its own idempotency key for the same room and interval. The test holds the room lock until both processes are waiting, then verifies the winner's ID, request key and interval against every row stored for the test room. Each process's Prometheus request counter must agree with its actual HTTP response, and its duration histogram must record one reservation attempt.

The CI artifact now includes the generated OpenAPI document, contention report and a raw Prometheus export per process. Local verification on Node 24.12.0 and PostgreSQL 17.12 passed both unit tests and all nine integration test entries, including the parent test. The generated OpenAPI matched the checked-in document.

Both jobs passed on GitHub's Ubuntu runner. Published the measured JSON and per-instance Prometheus exports from the successful run in `reports/` and documented how to reproduce the test with a disposable database. [CI evidence](https://github.com/TrebaDripat/booking-api/actions/runs/44154690877)
