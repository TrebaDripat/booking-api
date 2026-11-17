import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join, parse } from 'node:path';
import { race } from './cluster.mjs';

// Run before any other POSTs, so each process must have recorded only its own response.
async function scrapeReservation(node, status, label) {
  const response = await fetch(node.base + '/metrics', { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const exposition = await response.text();
  const counters = [
    ...exposition.matchAll(/^booking_http_requests_total\{operation="reserve",status="(\d{3})"\} (\d+)$/gm),
  ];
  assert.deepEqual(
    counters.map(([, code, value]) => [Number(code), Number(value)]),
    [[status, 1]],
  );
  const duration = exposition.match(
    /^booking_http_request_duration_seconds_count\{operation="reserve"\} (\d+)$/m,
  );
  assert.ok(duration, 'Missing reserve duration histogram');
  assert.equal(Number(duration[1]), 1);

  if (process.env.BOOKING_REPORT) {
    const { dir, name } = parse(process.env.BOOKING_REPORT);
    await writeFile(join(dir, name + '-' + label + '.prom'), exposition);
  }
  return {
    instance: label,
    httpStatus: status,
    requestCounter: Number(counters[0][2]),
    durationObservations: Number(duration[1]),
  };
}

export async function measureSingleSlot(pool, nodes, resourceId, window, reserve) {
  assert.equal(nodes.length, 2);
  const keys = [randomUUID(), randomUUID()];
  const { replies, waitingProcesses } = await race(
    pool,
    nodes,
    resourceId,
    keys.map((key) => (node) => reserve(node, resourceId, key, window)),
  );
  const statuses = replies.map((reply) => reply.status);
  assert.deepEqual(statuses.toSorted(), [201, 409]);
  assert.equal(replies[statuses.indexOf(409)].data.code, 'slot_unavailable');
  const winner = statuses.indexOf(201);

  // This room is unique to this run. Count every row, including any unexpected cancelled booking.
  const saved = await pool.query(
    'SELECT id, request_key, starts_at, ends_at, cancelled_at FROM bookings WHERE resource_id = $1',
    [resourceId],
  );
  assert.deepEqual(saved.rows, [
    {
      id: replies[winner].data.id,
      request_key: keys[winner],
      starts_at: new Date(window.startsAt),
      ends_at: new Date(window.endsAt),
      cancelled_at: null,
    },
  ]);
  const metrics = await Promise.all(
    nodes.map((node, index) => scrapeReservation(node, statuses[index], ['api-a', 'api-b'][index])),
  );
  return { requests: replies.length, waitingProcesses, statuses, storedRows: saved.rowCount, metrics };
}
