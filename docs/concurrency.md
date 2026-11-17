# Concurrent reservations

Two clients can read that the same room is available before either sends its booking request. The create operation settles the race in PostgreSQL.

## What happens during a reservation

1. A transaction acquires an advisory lock derived from the idempotency key. If the key already has a booking, the API compares the room and normalized UTC instants. A match returns the stored booking, and a mismatch returns `409 idempotency_key_reused`.
2. A new request locks the selected room row with `FOR NO KEY UPDATE`. Other create transactions for this room wait, including bookings for a different time. Creates for a different room can proceed. This trades same-room write concurrency for predictable contention.
3. PostgreSQL inserts the booking. A partial GiST exclusion constraint rejects overlapping active intervals for the same room, including inserts from other SQL writers. The API translates that constraint violation to `409 slot_unavailable`. A conflict rolls back the transaction and leaves that key available for a later attempt.
4. Cancellation records a timestamp. The partial constraint immediately allows the released interval to be booked again once the cancellation commits. The original booking and its key remain available for lookup.

The unique key and overlap constraint live in the [database migration](../db/001_reservations.sql). The [reservation transaction](../src/bookings.ts) handles the corresponding HTTP outcomes.

## What was measured

The fixture launches two Node.js processes with distinct PostgreSQL application names. A third connection holds the room row while the test sends requests to alternating API instances. The fixture releases its lock only after `pg_stat_activity` reports both instances waiting. It then verifies the HTTP outcomes and queries the stored rows.

| Requests per round | Rounds | HTTP outcomes in each round | Database result |
| --- | ---: | --- | --- |
| 24 distinct keys, one room and interval | 3 | 1 created, 23 slot conflicts | 1 active booking |
| 24 requests with one key and one payload | 1 | 1 created, 23 replays with the same ID | 1 booking for the key |
| 24 requests with one key and two different payloads, 12 of each | 1 | 1 created, 11 replays, 12 key conflicts | 1 booking for the key |

These five rounds measure correctness under forced contention. The recorded run identifies its Git revision, Node.js version and PostgreSQL version. [Raw JSON](../reports/concurrency.json) · [Test fixture](../test/cluster.mjs) · [Assertions](../test/integration.test.mjs)

The integration suite also checks back-to-back intervals, cancellation, simultaneous migrations and a conflicting direct SQL insert. A separate Compose test stops and removes both API containers and the database container, recreates them with the same named volume and repeats the original request. [Container recreation test](../scripts/compose-smoke.mjs)
