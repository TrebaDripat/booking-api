import { writeFile } from 'node:fs/promises';
import { createApp, document } from './app.js';

async function main(): Promise<void> {
  const app = await createApp();
  try {
    const json = JSON.stringify(document(app), null, 2) + '\n';
    if (process.argv[2]) await writeFile(process.argv[2], json);
    else process.stdout.write(json);
  } finally {
    await app.close();
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
