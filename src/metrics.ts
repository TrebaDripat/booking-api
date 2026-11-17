import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Counter, Histogram, Registry } from '@prometheus-io/client';
import type { Response } from 'express';
import type { Observable } from 'rxjs';

@Injectable()
export class BookingMetrics implements NestInterceptor {
  readonly registry = new Registry();
  private readonly requests = new Counter({
    name: 'booking_http_requests_total',
    help: 'Completed requests to booking and resource endpoints.',
    labelNames: ['operation', 'status'] as const,
    registers: [this.registry],
  });
  private readonly duration = new Histogram({
    name: 'booking_http_request_duration_seconds',
    help: 'Booking and resource endpoint duration including database lock waits.',
    labelNames: ['operation'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const operation = context.getHandler().name;
    const response = context.switchToHttp().getResponse<Response>();
    const stop = this.duration.startTimer({ operation });
    response.once('finish', () => {
      this.requests.inc({ operation, status: String(response.statusCode) });
      stop();
    });
    return next.handle();
  }
}
