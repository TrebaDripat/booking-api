import { HttpException } from '@nestjs/common';

export class BookingError extends HttpException {
  constructor(status: number, code: string, message: string) {
    super({ statusCode: status, code, message }, status);
  }
}

export type BookingWindow = { startsAt: string; endsAt: string };

export function normalizedWindow(input: BookingWindow): BookingWindow {
  const start = new Date(input.startsAt);
  const end = new Date(input.endsAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
    throw new BookingError(400, 'invalid_interval', 'endsAt must be later than startsAt');
  }
  if (start.getUTCFullYear() < 1 || end.getUTCFullYear() > 9999) {
    throw new BookingError(400, 'invalid_interval', 'UTC instants must fall within years 0001 through 9999');
  }
  return { startsAt: start.toISOString(), endsAt: end.toISOString() };
}

export interface Booking extends BookingWindow {
  id: string;
  resourceId: string;
  createdAt: string;
  cancelledAt: string | null;
}
