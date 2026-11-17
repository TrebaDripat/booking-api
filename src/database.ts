import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';

export function createPool(): Pool {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    application_name: process.env.PGAPPNAME ?? 'booking-api',
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    idle_in_transaction_session_timeout: 15000,
  });
  pool.on('error', (error: Error) => console.error('Idle database connection failed', error.name));
  return pool;
}

export async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
  }
}

@Injectable()
export class Database implements OnApplicationShutdown {
  readonly pool = createPool();

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
