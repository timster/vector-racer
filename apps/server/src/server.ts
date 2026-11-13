import { existsSync } from 'node:fs';
import { buildApp } from './app';
import { loadConfig } from './config';
import { migrate } from './db/migrations';
import { createPool } from './db/pool';
import { syncBuiltinTracks } from './tracks';

// Local development reads the repo-root .env; production sets real environment variables.
for (const path of ['.env', '../../.env']) {
  if (existsSync(path)) {
    process.loadEnvFile(path);
    break;
  }
}

const config = loadConfig();
const db = createPool(config.databaseUrl, (err) => app.log.error({ err }, 'idle database client error'));
const app = await buildApp(config, db);

const applied = await migrate(db);
if (applied.length) app.log.info({ applied }, 'migrations applied');
const trackChanges = await syncBuiltinTracks(db, undefined, { replaceChanged: !config.production });
if (trackChanges.length) app.log.info({ trackChanges }, 'tracks synced');

await app.listen({ host: config.host, port: config.port });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await db.end();
    process.exit(0);
  });
}
