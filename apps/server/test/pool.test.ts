import { describe, expect, it } from 'vitest';
import { withTransaction } from '../src/db/pool';
import { testApp } from './helpers';

const { db } = await testApp();

describe('withTransaction', () => {
  it('commits what the callback wrote', async () => {
    await withTransaction(db, (tx) => tx.query("INSERT INTO players (display_name, token_hash) VALUES ('kept', 'k')"));
    expect((await db.query("SELECT count(*) FROM players WHERE display_name = 'kept'")).rows[0].count).toBe(1);
  });

  it('throws, rather than reporting success, when a caught error left the transaction aborted', async () => {
    const run = withTransaction(db, async (tx) => {
      await tx.query("INSERT INTO players (display_name, token_hash) VALUES ('lost', 'l')");
      await tx.query('SELECT * FROM no_such_table').catch(() => {});
      return 'done';
    });
    await expect(run).rejects.toThrow(/rolled back/);
    expect((await db.query("SELECT count(*) FROM players WHERE display_name = 'lost'")).rows[0].count).toBe(0);
  });
});
