import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { contractClient, race, startNode, stopNode } from './cluster.mjs';

const exec = promisify(execFile);
const createPath = '/v1/bookings';
const itemPath = '/v1/bookings/{id}';
const availabilityPath = '/v1/resources/{id}/availability';
const window = { startsAt: '2030-06-03T09:00:00.000Z', endsAt: '2030-06-03T10:00:00.000Z' };

test('PostgreSQL booking contract across two independent NestJS processes', { timeout: 90000 }, async (t) => {
  const dsn = process.env.TEST_DATABASE_URL;
  assert.ok(dsn, 'Set TEST_DATABASE_URL to a disposable PostgreSQL database');
  const pool = new Pool({ connectionString: dsn, connectionTimeoutMillis: 4000 });
  const nodes = [];
  const rooms = Array.from({ length: 5 }, () => randomUUID());
  let insertedRooms = false;
  t.after(async () => {
    try {
      await Promise.all(nodes.map(stopNode));
      if (insertedRooms) {
        await pool.query('DELETE FROM bookings WHERE resource_id = ANY($1::uuid[])', [rooms]);
        await pool.query('DELETE FROM resources WHERE id = ANY($1::uuid[])', [rooms]);
      }
    } finally {
      await pool.end();
    }
  });

  await t.test('concurrent migration commands converge and replay safely', async () => {
    const run = () =>
      exec(process.execPath, ['dist/migrate.js'], { env: { ...process.env, DATABASE_URL: dsn } });
    const migrations = await Promise.all([run(), run()]);
    const outcomes = migrations.map((r) => JSON.parse(r.stdout).result);
    assert.ok(outcomes.includes('current'));
    assert.ok(outcomes.every((s) => ['applied', 'current'].includes(s)));
    assert.equal(JSON.parse((await run()).stdout).result, 'current');
  });
  await pool.query(
    "INSERT INTO resources(id, name) SELECT id, 'Ephemeral test room' FROM unnest($1::uuid[]) AS id",
    [rooms],
  );
  insertedRooms = true;
  const prefix = 'booking-test-' + randomUUID().slice(0, 8);
  nodes.push(await startNode(dsn, prefix + '-a'));
  nodes.push(await startNode(dsn, prefix + '-b'));
  assert.notEqual(nodes[0].child.pid, nodes[1].child.pid);
  const spec = JSON.parse(await readFile('docs/openapi.json', 'utf8'));
  const call = contractClient(spec);
  const reserve = (node, resourceId, key = randomUUID(), dates = window) =>
    call(node, 'POST', createPath, { key, body: { resourceId, ...dates } });
  const totals = (replies) =>
    replies.reduce((counts, r) => {
      counts[r.status] = (counts[r.status] ?? 0) + 1;
      return counts;
    }, {});

  await t.test('live OpenAPI, Swagger UI, resources and healthy instances', async () => {
    for (const node of nodes) {
      assert.deepEqual(await (await fetch(node.base + '/openapi.json')).json(), spec);
      assert.equal((await call(node, 'GET', '/health/live')).status, 200);
      assert.equal((await call(node, 'GET', '/health/ready')).status, 200);
    }
    const ui = await fetch(nodes[0].base + '/docs');
    assert.equal(ui.status, 200);
    assert.match(await ui.text(), /swagger-ui/i);
    const resources = await call(nodes[1], 'GET', '/v1/resources');
    assert.equal(resources.status, 200);
    assert.ok(resources.data.some((room) => room.id === rooms[0]));
  });

  await t.test('distinct-key races and same-key retries persist exactly one winner per window', async () => {
    const burst = 24;
    const rounds = [];
    for (const day of ['07', '08', '09']) {
      const dates = { startsAt: '2030-07-' + day + 'T09:00:00Z', endsAt: '2030-07-' + day + 'T10:00:00Z' };
      const jobs = Array.from(
        { length: burst },
        () => (node) => reserve(node, rooms[0], randomUUID(), dates),
      );
      const { replies, waitingProcesses } = await race(pool, nodes, rooms[0], jobs);
      const statuses = totals(replies);
      assert.deepEqual(statuses, { 201: 1, 409: burst - 1 });
      assert.ok(replies.filter((r) => r.status === 409).every((r) => r.data.code === 'slot_unavailable'));
      const saved = await pool.query(
        'SELECT id FROM bookings WHERE resource_id = $1 AND starts_at = $2 AND cancelled_at IS NULL',
        [rooms[0], dates.startsAt],
      );
      assert.deepEqual(saved.rows, [{ id: replies.find((r) => r.status === 201).data.id }]);
      rounds.push({ requests: burst, waitingProcesses, statuses, activeRows: saved.rowCount });
    }
    const key = randomUUID();
    const retries = Array.from({ length: burst }, () => (node) => reserve(node, rooms[1], key));
    const { replies, waitingProcesses } = await race(pool, nodes, rooms[1], retries);
    assert.deepEqual(totals(replies), { 200: burst - 1, 201: 1 });
    assert.equal(new Set(replies.map((r) => r.data.id)).size, 1);
    assert.ok(replies.every((r) => r.location === '/v1/bookings/' + r.data.id));
    const sameKey = await pool.query('SELECT id FROM bookings WHERE request_key = $1', [key]);
    assert.deepEqual(sameKey.rows, [{ id: replies[0].data.id }]);
    const sharedKey = randomUUID();
    const later = { startsAt: '2030-06-03T12:00:00Z', endsAt: '2030-06-03T13:00:00Z' };
    const differentPayloads = Array.from(
      { length: burst },
      (_, i) => (node) => reserve(node, rooms[4], sharedKey, i % 2 ? later : window),
    );
    const mixed = await race(pool, nodes, rooms[4], differentPayloads);
    const mixedStatuses = totals(mixed.replies);
    assert.deepEqual(mixedStatuses, { 200: burst / 2 - 1, 201: 1, 409: burst / 2 });
    const winningBooking = mixed.replies.find((r) => r.status === 201).data;
    for (const [i, reply] of mixed.replies.entries()) {
      const sentStart = new Date(i % 2 ? later.startsAt : window.startsAt).toISOString();
      if (sentStart === winningBooking.startsAt) assert.equal(reply.data.id, winningBooking.id);
      else assert.equal(reply.data.code, 'idempotency_key_reused');
    }
    const mixedRows = await pool.query('SELECT id FROM bookings WHERE request_key = $1', [sharedKey]);
    assert.deepEqual(mixedRows.rows, [{ id: winningBooking.id }]);
    if (process.env.BOOKING_REPORT) {
      const revision = (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
      const dirty = (await exec('git', ['status', '--porcelain'])).stdout.trim();
      const report = {
        measuredAt: new Date().toISOString(),
        revision,
        workingTreeClean: !dirty,
        node: process.version,
        postgres: (await pool.query('SHOW server_version')).rows[0].server_version,
        independentNodeProcesses: nodes.length,
        distinctKeyRounds: rounds,
        sameKeyRound: {
          requests: burst,
          waitingProcesses,
          statuses: totals(replies),
          distinctBookingIds: 1,
          storedRows: sameKey.rowCount,
        },
        differentPayloadsOneKey: {
          requests: burst,
          waitingProcesses: mixed.waitingProcesses,
          statuses: mixedStatuses,
          storedRows: mixedRows.rowCount,
        },
        scope:
          'Synthetic local contention test. Each round released a row lock after both API processes were observed waiting in PostgreSQL.',
      };
      await writeFile(process.env.BOOKING_REPORT, JSON.stringify(report, null, 2) + '\n');
    }
  });

  await t.test(
    'cancellation, adjacent intervals, normalized retries and cross-resource key reuse',
    async () => {
      const room = rooms[2];
      const key = randomUUID();
      const available = () => call(nodes[1], 'GET', availabilityPath, { id: room, query: window });
      assert.equal((await available()).data.available, true);
      const first = await reserve(nodes[0], room, key);
      assert.equal(first.status, 201);
      assert.equal((await available()).data.available, false);
      const replay = await reserve(nodes[1], room.toUpperCase(), key.toUpperCase(), {
        startsAt: '2030-06-03T11:00:00+02:00',
        endsAt: '2030-06-03T12:00:00+02:00',
      });
      assert.equal(replay.status, 200);
      assert.deepEqual(replay.data, first.data);
      const mismatched = await reserve(nodes[1], rooms[3], key);
      assert.equal(mismatched.status, 409);
      assert.equal(mismatched.data.code, 'idempotency_key_reused');
      for (const [start, end] of [
        ['08:59:00', '09:01:00'],
        ['09:10:00', '09:59:00'],
        ['08:00:00', '11:00:00'],
      ]) {
        const overlap = await reserve(nodes[1], room, randomUUID(), {
          startsAt: '2030-06-03T' + start + 'Z',
          endsAt: '2030-06-03T' + end + 'Z',
        });
        assert.equal(overlap.data.code, 'slot_unavailable');
      }
      assert.equal(
        (
          await reserve(nodes[1], room, randomUUID(), {
            startsAt: window.endsAt,
            endsAt: '2030-06-03T11:00:00Z',
          })
        ).status,
        201,
      );
      const rejectedKey = randomUUID();
      assert.equal((await reserve(nodes[0], room, rejectedKey)).status, 409);
      const lookup = { id: first.data.id };
      assert.deepEqual((await call(nodes[1], 'GET', itemPath, lookup)).data, first.data);
      const cancelled = await call(nodes[1], 'DELETE', itemPath, lookup);
      assert.ok(cancelled.data.cancelledAt);
      assert.deepEqual((await call(nodes[0], 'DELETE', itemPath, lookup)).data, cancelled.data);
      assert.equal((await available()).data.available, true);
      assert.deepEqual((await reserve(nodes[1], room, key)).data, cancelled.data);
      const replacement = await reserve(nodes[0], room, rejectedKey);
      assert.equal(replacement.status, 201);
      assert.notEqual(replacement.data.id, first.data.id);
    },
  );

  await t.test(
    'invalid requests, missing rows and PostgreSQL constraint errors have distinct outcomes',
    async () => {
      const node = nodes[0];
      for (const body of [
        { ...window, resourceId: 'bad-id' },
        { ...window, resourceId: rooms[3], extra: true },
        { ...window, resourceId: rooms[3], startsAt: '2030-06-03T09:00:00' },
        { ...window, resourceId: rooms[3], startsAt: '2030-02-30T09:00:00Z' },
        { ...window, resourceId: rooms[3], startsAt: '2030-06-03T09:00:00.12345Z' },
        { ...window, resourceId: rooms[3], endsAt: window.startsAt },
      ])
        assert.equal((await call(node, 'POST', createPath, { key: randomUUID(), body })).status, 400);
      for (const key of [undefined, 'invalid']) {
        assert.equal(
          (await call(node, 'POST', createPath, { key, body: { ...window, resourceId: rooms[3] } })).status,
          400,
        );
      }
      assert.equal((await reserve(node, randomUUID())).data.code, 'resource_not_found');
      assert.equal(
        (await call(node, 'GET', availabilityPath, { id: randomUUID(), query: window })).status,
        404,
      );
      for (const method of ['GET', 'DELETE']) {
        assert.equal(
          (await call(node, method, itemPath, { id: randomUUID() })).data.code,
          'booking_not_found',
        );
        assert.equal((await call(node, method, itemPath, { id: 'oops' })).status, 400);
      }
      await assert.rejects(
        pool.query(
          'INSERT INTO bookings(resource_id, request_key, starts_at, ends_at) VALUES ($1,$2,$3,$4)',
          [rooms[1], randomUUID(), window.startsAt, window.endsAt],
        ),
        (error) => error.code === '23P01' && error.constraint === 'bookings_no_active_overlap',
      );
    },
  );

  await t.test(
    'a locked room leaves other resources bookable; metrics use bounded operation labels',
    async () => {
      const blocker = await pool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM resources WHERE id = $1 FOR UPDATE', [rooms[0]]);
        assert.equal((await reserve(nodes[1], rooms[3])).status, 201);
      } finally {
        try {
          await blocker.query('ROLLBACK');
        } finally {
          blocker.release();
        }
      }
      for (const node of nodes) {
        const metrics = await fetch(node.base + '/metrics');
        assert.match(metrics.headers.get('content-type'), /text\/plain/);
        const exposition = await metrics.text();
        assert.match(exposition, /booking_http_requests_total\{operation="reserve",status="409"\} [1-9]/);
        assert.match(exposition, /booking_http_request_duration_seconds_bucket/);
        assert.ok(rooms.every((id) => !exposition.includes(id)));
      }
    },
  );

  await t.test('liveness remains observable when storage is unavailable', async () => {
    const offline = await startNode('postgresql://unused@127.0.0.1:1/unavailable', prefix + '-offline');
    try {
      assert.equal((await call(offline, 'GET', '/health/live')).status, 200);
      const ready = await call(offline, 'GET', '/health/ready');
      assert.equal(ready.status, 503);
      assert.equal(ready.data.code, 'database_unavailable');
    } finally {
      await stopNode(offline);
    }
  });
});
