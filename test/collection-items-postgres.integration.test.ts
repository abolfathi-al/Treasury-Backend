import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { Pool, PoolClient } from 'pg';

const connectionString = process.env.TEST_DATABASE_URL;

test('INC-2D migration applies to fresh and pre-0016 PostgreSQL schemas', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  const pool = new Pool({ connectionString, max: 1 });
  const names = (await readdir('migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  assert.equal(names.at(-1), '0016_collection_items_queue.sql');
  try {
    await withSchema(pool, async (client) => {
      await apply(client, names);
      await assertCollectionShape(client);
    });
    await withSchema(pool, async (client) => {
      await apply(client, names.filter((name) => name < '0016_collection_items_queue.sql'));
      const before = await client.query<{ present: boolean }>(`
        SELECT EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'collection_items'
             AND column_name = 'treasury_unit_id'
        ) AS present
      `);
      assert.equal(before.rows[0]!.present, false);
      await apply(client, ['0016_collection_items_queue.sql']);
      await assertCollectionShape(client);
    });
  } finally {
    await pool.end();
  }
});

async function withSchema(
  pool: Pool,
  work: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const schema = `inc2d_${randomUUID().replaceAll('-', '')}`;
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}", public`);
    await work(client);
  } finally {
    await client.query('RESET search_path');
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
  }
}

async function apply(client: PoolClient, names: string[]): Promise<void> {
  for (const name of names) {
    await client.query('BEGIN');
    try {
      await client.query(await readFile(`migrations/${name}`, 'utf8'));
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
}

async function assertCollectionShape(client: PoolClient): Promise<void> {
  const columns = await client.query<{
    column_name: string;
    is_nullable: 'YES' | 'NO';
  }>(`
    SELECT column_name, is_nullable
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'collection_items'
       AND column_name IN (
         'branch_id',
         'treasury_unit_id',
         'collected_party_id',
         'expected_settlement_date',
         'created_at',
         'updated_at'
       )
     ORDER BY column_name
  `);
  assert.deepEqual(
    columns.rows.map(({ column_name }) => column_name),
    [
      'branch_id',
      'collected_party_id',
      'created_at',
      'expected_settlement_date',
      'treasury_unit_id',
      'updated_at',
    ],
  );
  for (const required of [
    'treasury_unit_id',
    'expected_settlement_date',
    'created_at',
    'updated_at',
  ]) {
    assert.equal(
      columns.rows.find(({ column_name }) => column_name === required)!.is_nullable,
      'NO',
    );
  }

  const invariants = await client.query<{ name: string }>(`
    SELECT conname AS name
      FROM pg_constraint
     WHERE conrelid = 'collection_items'::regclass
       AND conname IN (
         'collection_items_money_balance',
         'collection_items_state_money_shape',
         'collection_item_destination_scope_chain_consistency',
         'collection_item_source_fact_consistency'
       )
     ORDER BY conname
  `);
  assert.deepEqual(invariants.rows.map(({ name }) => name), [
    'collection_item_destination_scope_chain_consistency',
    'collection_item_source_fact_consistency',
    'collection_items_money_balance',
    'collection_items_state_money_shape',
  ]);
}
