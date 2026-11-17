import { AddressInfo } from 'node:net';
import { SwaggerModule } from '@nestjs/swagger';
import { createApp, document } from './app.js';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL before starting the API');
  const port = Number(process.env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('PORT must be between 0 and 65535');
  const app = await createApp();
  SwaggerModule.setup('docs', app, document(app), { jsonDocumentUrl: 'openapi.json' });
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  await app.listen(port, process.env.HOST ?? '127.0.0.1');
  const address = app.getHttpServer().address() as AddressInfo;
  console.log(JSON.stringify({ event: 'listening', port: address.port, pid: process.pid }));
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
