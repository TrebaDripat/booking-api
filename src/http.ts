import {
  ArgumentsHost,
  BadRequestException,
  Body,
  Catch,
  Controller,
  Delete,
  ExceptionFilter,
  Get,
  Header,
  Headers,
  HttpException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Registry } from '@prometheus-io/client';
import { isUUID } from 'class-validator';
import type { Response } from 'express';
import { Bookings } from './bookings.js';
import {
  AvailabilityDto,
  BookingDto,
  CreateBookingDto,
  HealthDto,
  ProblemDto,
  ResourceDto,
  WindowDto,
} from './contracts.js';
import { Database } from './database.js';
import { BookingError, normalizedWindow } from './domain.js';
import { BookingMetrics } from './metrics.js';

@Catch()
export class ApiErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof HttpException) {
      const status = error.getStatus();
      const body = error.getResponse();
      const detail =
        typeof body === 'string'
          ? { message: body }
          : (body as { code?: string; message?: string | string[] });
      const message = Array.isArray(detail.message) ? detail.message.join(', ') : detail.message;
      response.status(status).json({
        statusCode: status,
        code: detail.code ?? (status === 400 ? 'invalid_request' : 'http_error'),
        message: message ?? error.message,
      });
      return;
    }
    const code = (error as { code?: string } | null)?.code ?? '';
    const temporary =
      code.startsWith('08') ||
      ['ECONNREFUSED', 'ECONNRESET', '57P01', '57P03', '53300', '57014', '40P01'].includes(code);
    const status = temporary ? 503 : 500;
    console.error('Booking request failed', code || 'unexpected_error');
    response.status(status).json({
      statusCode: status,
      code: temporary ? 'database_unavailable' : 'internal_error',
      message: temporary ? 'The database is temporarily unavailable' : 'Internal server error',
    });
  }
}

@ApiTags('Bookings')
@ApiBadRequestResponse({ type: ProblemDto, description: 'Invalid input' })
@ApiServiceUnavailableResponse({ type: ProblemDto, description: 'Database unavailable' })
@UseInterceptors(BookingMetrics)
@Controller('v1')
export class BookingController {
  constructor(private readonly bookings: Bookings) {}

  @Get('resources')
  @ApiOkResponse({ type: [ResourceDto] })
  listResources(): Promise<ResourceDto[]> {
    return this.bookings.resources();
  }

  @Get('resources/:id/availability')
  @ApiOperation({ summary: 'Check availability for a half-open interval at the time of reading' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AvailabilityDto })
  @ApiNotFoundResponse({ type: ProblemDto })
  async availability(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: WindowDto,
  ): Promise<AvailabilityDto> {
    const window = normalizedWindow(query);
    return {
      resourceId: id.toLowerCase(),
      ...window,
      available: await this.bookings.availability(id, window),
    };
  }

  @Post('bookings')
  @ApiOperation({ summary: 'Reserve a resource, or return the booking for a previous successful request' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiCreatedResponse({
    type: BookingDto,
    description: 'Reservation committed',
    headers: { Location: { schema: { type: 'string' } } },
  })
  @ApiOkResponse({
    type: BookingDto,
    description: 'Replay of the same resource and instants',
    headers: { Location: { schema: { type: 'string' } } },
  })
  @ApiConflictResponse({
    type: ProblemDto,
    description: 'Overlapping booking or an idempotency key reused for different input',
  })
  @ApiNotFoundResponse({ type: ProblemDto })
  async reserve(
    @Body() body: CreateBookingDto,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<BookingDto> {
    if (!key || !isUUID(key)) throw new BadRequestException('Idempotency-Key must be a UUID');
    const result = await this.bookings.reserve(body.resourceId, normalizedWindow(body), key);
    response.status(result.replay ? 200 : 201);
    response.location(`/v1/bookings/${result.booking.id}`);
    return result.booking;
  }

  @Get('bookings/:id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: BookingDto })
  @ApiNotFoundResponse({ type: ProblemDto })
  getBooking(@Param('id', ParseUUIDPipe) id: string): Promise<BookingDto> {
    return this.bookings.find(id);
  }

  @Delete('bookings/:id')
  @ApiOperation({
    summary: 'Cancel a reservation and preserve its original cancellation timestamp on replay',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: BookingDto })
  @ApiNotFoundResponse({ type: ProblemDto })
  cancel(@Param('id', ParseUUIDPipe) id: string): Promise<BookingDto> {
    return this.bookings.cancel(id);
  }
}

@ApiTags('Operations')
@Controller()
export class OperationsController {
  constructor(
    private readonly database: Database,
    private readonly metrics: BookingMetrics,
  ) {}

  @Get('health/live')
  @ApiOkResponse({ type: HealthDto })
  live(): HealthDto {
    return { status: 'ok' };
  }

  @Get('health/ready')
  @ApiOkResponse({ type: HealthDto })
  @ApiServiceUnavailableResponse({ type: ProblemDto })
  async ready(): Promise<HealthDto> {
    try {
      const result = await this.database.pool.query('SELECT 1 FROM booking_migrations WHERE version = 1');
      if (result.rowCount === 1) return { status: 'ok' };
    } catch {
      // An unreachable database or a missing migration both make this instance unready.
    }
    throw new BookingError(503, 'database_unavailable', 'Database or booking schema is unavailable');
  }

  @Get('metrics')
  @Header('Content-Type', Registry.PROMETHEUS_CONTENT_TYPE)
  @ApiProduces('text/plain')
  @ApiOkResponse({ schema: { type: 'string' } })
  scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
