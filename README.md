# Booking API

A NestJS and PostgreSQL service for reserving meeting rooms. Two independent API instances can accept requests for the same room. PostgreSQL commits one overlapping reservation, and a client retry with the same idempotency key retrieves the original booking.

This is a new portfolio implementation built in November 2026 with synthetic rooms. The original source is unavailable.

## Try it on two instances

From the repository root, start Docker Compose. It creates two rooms, runs the migration and exposes the API on local ports 3000 and 3001.

```sh
docker compose up --build --detach --wait --wait-timeout 120
curl -sS http://127.0.0.1:3000/v1/resources
```

On a fresh database, this example reserves Cedar through the first instance and retries through the second. The first response is `201 Created`. The second is `200 OK` with the same booking ID and `Location`.

```sh
key='20a10000-0000-4000-8000-000000000001'
booking='{"resourceId":"10000000-0000-4000-8000-000000000001","startsAt":"2030-06-03T09:00:00Z","endsAt":"2030-06-03T10:00:00Z"}'
for port in 3000 3001; do
  curl -si "http://127.0.0.1:$port/v1/bookings" \
    -H 'Content-Type: application/json' -H "Idempotency-Key: $key" \
    --data "$booking"
  echo
done
```

Use a fresh key for the same reservation to see `409 slot_unavailable`. Explore the rest of the API interactively at [Swagger UI](http://127.0.0.1:3000/docs). Run `docker compose down` to stop the service and retain the bookings in its named volume.

## Contract

| Request | Result |
| --- | --- |
| `GET /v1/resources` | List room IDs and names. |
| `GET /v1/resources/{id}/availability?startsAt=…&endsAt=…` | Read whether the interval is free at the time of the query. Only a successful create reserves it. |
| `POST /v1/bookings` | Supply a UUID in `Idempotency-Key` and a JSON body with `resourceId`, `startsAt` and `endsAt`. Returns `201` for a new booking or `200` for a replay. |
| `GET /v1/bookings/{id}` | Retrieve the booking, including its cancellation timestamp when applicable. |
| `DELETE /v1/bookings/{id}` | Cancel the booking and release the slot. Repeated cancellations preserve the first timestamp. |

Intervals include their start and exclude their end, so a room can host back-to-back bookings. Supply an explicit time zone and up to three fractional digits. Responses use UTC. A successful request binds its key to the room and the two instants. Changing any of them returns `409 idempotency_key_reused`. Retrying the original request after cancellation returns the cancelled booking.

Browse the full request and response schemas in the [committed OpenAPI document](docs/openapi.json). Each instance also serves it at `/openapi.json`.

## Verification

One request from each NestJS process targeted the same empty slot with different idempotency keys. PostgreSQL observed both processes waiting before the test released the room lock. One client received `201 Created`, the other received `409 slot_unavailable`, and the test found exactly one row for the room. Its booking ID and request key matched the winner. Each process's Prometheus counter recorded its own HTTP outcome. [CI run](https://github.com/TrebaDripat/booking-api/actions/runs/44154690877) · [Measured results](reports/concurrency.json) · [Prometheus A](reports/booking-races-api-a.prom) · [Prometheus B](reports/booking-races-api-b.prom)

In three rounds of 24 requests for one slot, each round produced one `201`, 23 conflicts and one active database row. With a shared key, all 24 responses carried the same booking ID. Every round started with both API processes observed waiting for a lock in PostgreSQL. [Recorded results](reports/concurrency.json) · [Design and test procedure](docs/concurrency.md)

To reproduce the checks with Node.js 24 and Docker, run the following from the repository root in a POSIX shell. The disposable database is separate from the Compose demo. The suite applies the migration, creates temporary rooms and writes the report and both Prometheus exports to `/tmp`.

```sh
docker run --detach --rm --name booking-race-db -p 127.0.0.1:55432:5432 \
  -e POSTGRES_USER=booking -e POSTGRES_PASSWORD=booking-demo-local -e POSTGRES_DB=booking_test \
  postgres:17-bookworm
npm ci
npm test
docker exec booking-race-db pg_isready -h 127.0.0.1 -U booking -d booking_test
TEST_DATABASE_URL='postgresql://booking:booking-demo-local@127.0.0.1:55432/booking_test' \
  BOOKING_REPORT=/tmp/booking-races.json npm run test:integration
docker stop booking-race-db
```

With Docker available, `node scripts/compose-smoke.mjs` starts its own isolated Compose project and verifies that bookings and idempotency keys survive container recreation. GitHub Actions runs both suites and checks that the published OpenAPI document matches the API. [CI runs](https://github.com/TrebaDripat/booking-api/actions/workflows/ci.yml)

## Operations

`/health/live` reports process liveness. `/health/ready` checks database connectivity and the installed migration. Scrape `/metrics` on each instance for request counts by operation and status, and latency histograms by operation. The Compose demo binds the unauthenticated API to loopback.
