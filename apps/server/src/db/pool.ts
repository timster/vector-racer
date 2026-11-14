import pg from 'pg';

// bigint ids and counts come back as JS numbers; they stay far below 2^53 here.
pg.types.setTypeParser(pg.types.builtins.INT8, Number);

export type Db = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(databaseUrl: string, onError: (err: Error) => void = () => {}): Db {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  // An idle client can error when the database restarts; the pool replaces it. Without a
  // listener, that error would be unhandled and crash the process.
  pool.on('error', onError);
  return pool;
}

export async function withTransaction<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    // If a statement failed and fn caught the error, Postgres has already aborted the
    // transaction and turns COMMIT into a rollback. Don't report that as success.
    const commit = await client.query('COMMIT');
    if (commit.command === 'ROLLBACK') throw new Error('Transaction was aborted by an earlier error and rolled back');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
