import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

export async function startNode(databaseUrl, applicationName) {
  const child = spawn(process.execPath, ['dist/main.js'], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PGAPPNAME: applicationName,
      PORT: '0',
      HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stderr.on('data', (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-1500);
  });
  const lines = createInterface({ input: child.stdout });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
  try {
    for await (const line of lines) {
      if (!line.startsWith('{')) continue;
      const message = JSON.parse(line);
      if (message.event === 'listening') {
        assert.equal(message.pid, child.pid);
        return { child, base: 'http://127.0.0.1:' + message.port, name: applicationName };
      }
    }
    throw new Error('API exited before announcing its port. ' + diagnostics);
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  } finally {
    clearTimeout(timer);
    lines.close();
  }
}

export async function stopNode(instance) {
  const child = instance.child;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const stopped = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  child.kill('SIGTERM');
  try {
    await stopped;
  } finally {
    clearTimeout(timer);
  }
}

export function contractClient(spec) {
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  const validators = new Map();
  return async function call(instance, method, route, { id, body, key, query } = {}) {
    const path = route.replace('{id}', encodeURIComponent(id ?? ''));
    const url = new URL(path, instance.base);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (key !== undefined) headers['Idempotency-Key'] = key;
    const response = await fetch(url, {
      method,
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    const operation = method + ' ' + route + ' ' + response.status;
    if (!validators.has(operation)) {
      const declared = spec.paths[route]?.[method.toLowerCase()]?.responses[response.status];
      const schema = declared?.content?.['application/json']?.schema;
      assert.ok(schema, 'Missing response contract for ' + operation);
      validators.set(operation, ajv.compile({ components: spec.components, ...schema }));
    }
    const validate = validators.get(operation);
    assert.ok(validate(data), operation + ' ' + ajv.errorsText(validate.errors));
    return { status: response.status, data, location: response.headers.get('location') };
  };
}

// Hold the resource row until PostgreSQL shows BOTH independent API processes waiting.
// This makes contention observable even on hosts that schedule the HTTP clients slowly.
export async function race(pool, nodes, resourceId, requests) {
  const blocker = await pool.connect();
  let batch;
  let waiting = [];
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM resources WHERE id = $1 FOR UPDATE', [resourceId]);
    batch = Promise.allSettled(requests.map((send, i) => send(nodes[i % nodes.length])));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const result = await pool.query(
        `SELECT DISTINCT application_name FROM pg_stat_activity
          WHERE application_name = ANY($1::text[]) AND wait_event_type = 'Lock'`,
        [nodes.map((n) => n.name)],
      );
      waiting = result.rows.map((r) => r.application_name);
      if (waiting.length === nodes.length) break;
      await delay(15);
    }
  } finally {
    try {
      await blocker.query('ROLLBACK');
    } finally {
      blocker.release();
    }
  }
  const results = await batch;
  assert.equal(waiting.length, nodes.length, 'Both API processes must reach the database barrier');
  const replies = results.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
  return { replies, waitingProcesses: waiting.length };
}
