import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizedWindow } from '../dist/domain.js';

test('offset-equivalent time windows have the same stored representation', () => {
  const expected = { startsAt: '2030-01-01T09:00:00.000Z', endsAt: '2030-01-01T10:00:00.250Z' };
  assert.deepEqual(normalizedWindow(expected), expected);
  assert.deepEqual(
    normalizedWindow({ startsAt: '2030-01-01T11:00:00+02:00', endsAt: '2030-01-01T12:00:00.25+02:00' }),
    expected,
  );
});

test('empty, reversed and unrepresentable intervals fail before the database', () => {
  const instant = '2030-01-01T10:00:00Z';
  for (const [start, end] of [
    [instant, instant],
    [instant, '2030-01-01T09:00:00Z'],
    ['invalid', instant],
    ['0001-01-01T00:00:00+01:00', instant],
    [instant, '9999-12-31T23:59:59-02:00'],
  ]) {
    assert.throws(
      () => normalizedWindow({ startsAt: start, endsAt: end }),
      (e) => e.getResponse().code === 'invalid_interval',
    );
  }
});
