import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const project = 'booking-smoke-' + randomUUID().slice(0, 10);
const image = 'booking-api:' + project;
const env = { ...process.env, BOOKING_PORT_A: '0', BOOKING_PORT_B: '0', BOOKING_IMAGE: image };
function docker(args, capture = false) {
  return execFileSync('docker', args, {
    env,
    encoding: 'utf8',
    timeout: 300000,
    stdio: capture ? 'pipe' : 'inherit',
  });
}
function compose(args, capture = false) {
  return docker(['compose', '--project-name', project, ...args], capture);
}
function endpoint(service) {
  return 'http://' + compose(['port', service, '3000'], true).trim();
}
async function http(base, path, method = 'GET', body, key) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers['Idempotency-Key'] = key;
  const response = await fetch(base + path, {
    method,
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });
  return { status: response.status, data: await response.json() };
}
const up = ['up', '--detach', '--no-build', '--wait', '--wait-timeout', '120'];
const build = ['build', '--tag', image];
if (process.env.BOOKING_BUILD_CA) build.push('--secret', 'id=build_ca,src=' + process.env.BOOKING_BUILD_CA);
docker([...build, '.']);
try {
  compose(up);
  let a = endpoint('api-a');
  let b = endpoint('api-b');
  assert.notEqual(a, b);
  const rooms = await http(a, '/v1/resources');
  assert.equal(rooms.status, 200);
  assert.equal(rooms.data.length, 2);
  const body = {
    resourceId: rooms.data[0].id,
    startsAt: '2030-06-03T09:00:00Z',
    endsAt: '2030-06-03T10:00:00Z',
  };
  const key = randomUUID();
  const created = await http(a, '/v1/bookings', 'POST', body, key);
  assert.equal(created.status, 201);
  const replay = await http(b, '/v1/bookings', 'POST', body, key);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data, created.data);
  const conflict = await http(b, '/v1/bookings', 'POST', body, randomUUID());
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.code, 'slot_unavailable');
  // Removing the containers while retaining the named volume exercises fresh processes and a migration replay.
  compose(['down']);
  compose(up);
  a = endpoint('api-a');
  b = endpoint('api-b');
  const path = '/v1/bookings/' + created.data.id;
  const persisted = await http(b, path);
  assert.equal(persisted.status, 200);
  assert.deepEqual(persisted.data, created.data);
  const again = await http(a, '/v1/bookings', 'POST', body, key);
  assert.equal(again.status, 200);
  assert.equal(again.data.id, created.data.id);
  const cancelled = await http(b, path, 'DELETE');
  assert.equal(cancelled.status, 200);
  assert.ok(cancelled.data.cancelledAt);
  const { startsAt, endsAt } = body;
  const availability = await http(
    a,
    '/v1/resources/' + body.resourceId + '/availability?' + new URLSearchParams({ startsAt, endsAt }),
  );
  assert.equal(availability.data.available, true);
  console.log(
    JSON.stringify({
      compose: 'passed',
      instances: 2,
      persistedAfterRecreate: true,
      idempotencyAfterRecreate: true,
    }),
  );
} catch (error) {
  compose(['logs', '--tail', '25', '--no-color']);
  throw error;
} finally {
  compose(['down', '--volumes', '--remove-orphans']);
  docker(['image', 'rm', image]);
}
