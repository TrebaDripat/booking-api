import { Injectable } from '@nestjs/common';
import { Database, inTransaction } from './database.js';
import { Booking, BookingError, BookingWindow } from './domain.js';

interface BookingRow {
  id: string;
  resource_id: string;
  starts_at: Date;
  ends_at: Date;
  created_at: Date;
  cancelled_at: Date | null;
}

const columns = 'id, resource_id, starts_at, ends_at, created_at, cancelled_at';
const missingResource = () => new BookingError(404, 'resource_not_found', 'Resource not found');
const missingBooking = () => new BookingError(404, 'booking_not_found', 'Booking not found');

function present(row: BookingRow): Booking {
  return {
    id: row.id,
    resourceId: row.resource_id,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
  };
}

@Injectable()
export class Bookings {
  constructor(private readonly database: Database) {}

  async resources(): Promise<{ id: string; name: string }[]> {
    return (await this.database.pool.query('SELECT id, name FROM resources ORDER BY id')).rows;
  }

  async availability(resourceId: string, window: BookingWindow): Promise<boolean> {
    const result = await this.database.pool.query<{ available: boolean }>(
      `SELECT NOT EXISTS (
         SELECT 1 FROM bookings b WHERE b.resource_id = r.id AND b.cancelled_at IS NULL
         AND tstzrange(b.starts_at, b.ends_at, '[)') && tstzrange($2, $3, '[)')
       ) AS available FROM resources r WHERE r.id = $1`,
      [resourceId, window.startsAt, window.endsAt],
    );
    if (!result.rows.length) throw missingResource();
    return result.rows[0].available;
  }

  async reserve(
    resourceId: string,
    window: BookingWindow,
    key: string,
  ): Promise<{ booking: Booking; replay: boolean }> {
    return inTransaction(this.database.pool, async (client) => {
      // The same key may arrive on different processes or with a different resource.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text, 0))', [key]);
      const prior = await client.query<BookingRow>(`SELECT ${columns} FROM bookings WHERE request_key = $1`, [
        key,
      ]);
      if (prior.rows.length) {
        const booking = present(prior.rows[0]);
        if (
          booking.resourceId !== resourceId.toLowerCase() ||
          booking.startsAt !== window.startsAt ||
          booking.endsAt !== window.endsAt
        ) {
          throw new BookingError(
            409,
            'idempotency_key_reused',
            'This key already identifies a different request',
          );
        }
        return { booking, replay: true };
      }
      // Serialize short create transactions per room. The exclusion constraint also covers other writers.
      const resource = await client.query('SELECT id FROM resources WHERE id = $1 FOR NO KEY UPDATE', [
        resourceId,
      ]);
      if (!resource.rows.length) throw missingResource();
      try {
        const saved = await client.query<BookingRow>(
          `INSERT INTO bookings(resource_id, request_key, starts_at, ends_at)
           VALUES ($1, $2, $3, $4) RETURNING ${columns}`,
          [resourceId, key, window.startsAt, window.endsAt],
        );
        return { booking: present(saved.rows[0]), replay: false };
      } catch (error) {
        const dbError = error as { code?: string; constraint?: string };
        if (dbError.code === '23P01' && dbError.constraint === 'bookings_no_active_overlap') {
          throw new BookingError(409, 'slot_unavailable', 'This resource already has an overlapping booking');
        }
        throw error;
      }
    });
  }

  async find(id: string): Promise<Booking> {
    const result = await this.database.pool.query<BookingRow>(
      `SELECT ${columns} FROM bookings WHERE id = $1`,
      [id],
    );
    if (!result.rows.length) throw missingBooking();
    return present(result.rows[0]);
  }

  async cancel(id: string): Promise<Booking> {
    const result = await this.database.pool.query<BookingRow>(
      `UPDATE bookings SET cancelled_at = COALESCE(cancelled_at, clock_timestamp())
       WHERE id = $1 RETURNING ${columns}`,
      [id],
    );
    if (!result.rows.length) throw missingBooking();
    return present(result.rows[0]);
  }
}
