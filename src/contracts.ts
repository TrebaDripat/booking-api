import { ApiProperty } from '@nestjs/swagger';
import { IsISO8601, IsUUID, Matches } from 'class-validator';

// Store and return milliseconds. Require an explicit offset so a host timezone cannot change a booking.
const instantPattern =
  /^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const instant = { type: String, format: 'date-time', pattern: instantPattern.source };

export class WindowDto {
  @ApiProperty({ ...instant, example: '2030-06-03T09:00:00Z' })
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(instantPattern)
  startsAt!: string;

  @ApiProperty({ ...instant, example: '2030-06-03T10:00:00Z' })
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(instantPattern)
  endsAt!: string;
}

export class CreateBookingDto extends WindowDto {
  @ApiProperty({ format: 'uuid', example: '10000000-0000-4000-8000-000000000001' })
  @IsUUID()
  resourceId!: string;
}

export class BookingDto extends CreateBookingDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) cancelledAt!: string | null;
}

export class ResourceDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
}

export class AvailabilityDto extends CreateBookingDto {
  @ApiProperty() available!: boolean;
}

export class ProblemDto {
  @ApiProperty({ example: 409 }) statusCode!: number;
  @ApiProperty({ example: 'slot_unavailable' }) code!: string;
  @ApiProperty({ example: 'This resource already has an overlapping booking' }) message!: string;
}

export class HealthDto {
  @ApiProperty({ enum: ['ok'] }) status!: 'ok';
}
