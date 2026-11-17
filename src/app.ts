import 'reflect-metadata';
import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { Bookings } from './bookings.js';
import { Database } from './database.js';
import { ApiErrors, BookingController, OperationsController } from './http.js';
import { BookingMetrics } from './metrics.js';

@Module({
  controllers: [BookingController, OperationsController],
  providers: [Database, Bookings, BookingMetrics],
})
class BookingModule {}

export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(BookingModule, { logger: ['error', 'warn'] });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new ApiErrors());
  return app;
}

export function document(app: INestApplication): OpenAPIObject {
  const description = new DocumentBuilder()
    .setTitle('Booking API')
    .setDescription(
      'Local room reservation demo. Intervals include the start and exclude the end. All instants require a time zone.',
    )
    .setVersion('1.0.0')
    .build();
  return SwaggerModule.createDocument(app, description);
}
