import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import { createPool, inTransaction } from './database.js';

export async function migrate(pool: Pool): Promise<'applied' | 'current'> {
  const sql = await readFile(join(import.meta.dirname, '../db/001_reservations.sql'), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  return inTransaction(pool, async (client) => {
    // A separate two-int advisory namespace keeps migrations independent of booking keys.
    await client.query('SELECT pg_advisory_xact_lock(18011, 1)');
    await client.query(`CREATE TABLE IF NOT EXISTS booking_migrations (
      version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const existing = await client.query<{ checksum: string }>(
      'SELECT checksum FROM booking_migrations WHERE version = 1',
    );
    if (existing.rows.length) {
      if (existing.rows[0].checksum !== checksum) throw new Error('Applied migration 1 has changed');
      return 'current';
    }
    await client.query(sql);
    await client.query('INSERT INTO booking_migrations(version, checksum) VALUES (1, $1)', [checksum]);
    return 'applied';
  });
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL before running migrations');
  const pool = createPool();
  try {
    console.log(JSON.stringify({ migration: 1, result: await migrate(pool) }));
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  main().catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
