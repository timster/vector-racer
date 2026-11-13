import { existsSync } from 'node:fs';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { migrate } from '../src/db/migrations';
import { createPool } from '../src/db/pool';
import { syncBuiltinTracks } from '../src/tracks';

declare module 'vitest' {
  export interface ProvidedContext {
    testDb: { adminUrl: string; template: string };
  }
}

export function databaseUrl(adminUrl: string, name: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/** Builds one migrated, track-synced template database; each test file clones it. */
export default async function setup(project: TestProject) {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const adminUrl = process.env.TEST_DATABASE_URL ?? 'postgres://vr:vr@127.0.0.1:5433/postgres';
  const admin = new pg.Client({ connectionString: adminUrl });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `Test Postgres is not reachable at ${adminUrl}. Start it with: docker compose up -d db-test\n(${String(err)})`,
    );
  }

  const prefix = `vr_${process.pid}_${Date.now()}`;
  const template = `${prefix}_template`;
  await admin.query(`CREATE DATABASE ${template}`);
  const pool = createPool(databaseUrl(adminUrl, template));
  await migrate(pool);
  await syncBuiltinTracks(pool);
  await pool.end();

  project.provide('testDb', { adminUrl, template });

  return async () => {
    const { rows } = await admin.query<{ datname: string }>('SELECT datname FROM pg_database WHERE datname LIKE $1', [
      `${prefix}%`,
    ]);
    for (const { datname } of rows) await admin.query(`DROP DATABASE IF EXISTS ${datname} WITH (FORCE)`);
    await admin.end();
  };
}
