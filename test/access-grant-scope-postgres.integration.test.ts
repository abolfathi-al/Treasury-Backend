import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { PoolClient } from 'pg';

import { DatabaseService } from '../src/database/database.service';

const connectionString = process.env.TEST_DATABASE_URL;

test('0011 backfills explicit Grant scope mode and rejects contradictory persistence', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = connectionString;
  const database = new DatabaseService();
  const client = await database.pool.connect();
  const schema = `grant_scope_${randomUUID().replaceAll('-', '')}`;
  const wideId = randomUUID();
  const restrictedId = randomUUID();
  const amountRestrictedId = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}, public`);
    await client.query(`
      CREATE TABLE access_grants (
        id uuid PRIMARY KEY,
        amount_ceiling numeric(38,8)
      );
      CREATE TABLE access_grant_branch_scopes (
        access_grant_id uuid NOT NULL REFERENCES access_grants(id)
      );
      CREATE TABLE access_grant_treasury_unit_scopes (
        access_grant_id uuid NOT NULL REFERENCES access_grants(id)
      );
      CREATE TABLE access_grant_cashbox_scopes (
        access_grant_id uuid NOT NULL REFERENCES access_grants(id)
      );
      CREATE TABLE access_grant_bank_account_scopes (
        access_grant_id uuid NOT NULL REFERENCES access_grants(id)
      );
      CREATE TABLE access_grant_document_type_scopes (
        access_grant_id uuid NOT NULL REFERENCES access_grants(id)
      );
      CREATE TABLE access_grant_method_category_scopes (
        access_grant_id uuid NOT NULL REFERENCES access_grants(id)
      );
      CREATE TABLE access_grant_currency_scopes (
        access_grant_id uuid NOT NULL REFERENCES access_grants(id)
      );
    `);
    await client.query(`
      INSERT INTO access_grants (id, amount_ceiling)
      VALUES ($1,NULL), ($2,NULL), ($3,100)
    `, [wideId, restrictedId, amountRestrictedId]);
    await client.query(
      'INSERT INTO access_grant_branch_scopes (access_grant_id) VALUES ($1)',
      [restrictedId],
    );
    await client.query(await readFile(
      'migrations/0011_explicit_access_grant_scope.sql',
      'utf8',
    ));
    await client.query('COMMIT');

    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO ${schema}, public`);
    const backfill = await client.query<{
      id: string;
      organization_wide: boolean;
    }>(`
      SELECT id, organization_wide
      FROM access_grants
      ORDER BY id
    `);
    assert.deepEqual(
      new Map(backfill.rows.map((row) => [row.id, row.organization_wide])),
      new Map([
        [wideId, true],
        [restrictedId, false],
        [amountRestrictedId, false],
      ]),
    );
    await client.query('COMMIT');

    await rejectsConstraint(client, schema, async () => {
      const id = randomUUID();
      await client.query(
        'INSERT INTO access_grants (id, amount_ceiling, organization_wide) VALUES ($1,NULL,true)',
        [id],
      );
      await client.query(
        'INSERT INTO access_grant_branch_scopes (access_grant_id) VALUES ($1)',
        [id],
      );
    });
    await rejectsConstraint(client, schema, () => client.query(
      'INSERT INTO access_grants (id, amount_ceiling, organization_wide) VALUES ($1,NULL,false)',
      [randomUUID()],
    ));
    await rejectsConstraint(client, schema, () => client.query(
      'INSERT INTO access_grants (id, amount_ceiling, organization_wide) VALUES ($1,1,true)',
      [randomUUID()],
    ));
    await rejectsConstraint(client, schema, () => client.query(
      'DELETE FROM access_grant_branch_scopes WHERE access_grant_id = $1',
      [restrictedId],
    ));
    await rejectsConstraint(client, schema, () => client.query(
      `UPDATE access_grant_branch_scopes
       SET access_grant_id = $2
       WHERE access_grant_id = $1`,
      [restrictedId, amountRestrictedId],
    ));

    const validRestrictedId = randomUUID();
    const validWideId = randomUUID();
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO ${schema}, public`);
    await client.query(
      'INSERT INTO access_grants (id, amount_ceiling, organization_wide) VALUES ($1,NULL,false)',
      [validRestrictedId],
    );
    await client.query(
      'INSERT INTO access_grant_currency_scopes (access_grant_id) VALUES ($1)',
      [validRestrictedId],
    );
    await client.query(
      'INSERT INTO access_grants (id, amount_ceiling, organization_wide) VALUES ($1,NULL,true)',
      [validWideId],
    );
    await client.query('COMMIT');

    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO ${schema}, public`);
    assert.equal(
      (await client.query(
        'SELECT count(*)::int AS count FROM access_grants WHERE id = ANY($1::uuid[])',
        [[validRestrictedId, validWideId]],
      )).rows[0]!.count,
      2,
    );
    await client.query('COMMIT');

    const concurrentRestrictedId = randomUUID();
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO ${schema}, public`);
    await client.query(
      'INSERT INTO access_grants (id, amount_ceiling, organization_wide) VALUES ($1,NULL,false)',
      [concurrentRestrictedId],
    );
    await client.query(
      'INSERT INTO access_grant_branch_scopes (access_grant_id) VALUES ($1)',
      [concurrentRestrictedId],
    );
    await client.query(
      'INSERT INTO access_grant_currency_scopes (access_grant_id) VALUES ($1)',
      [concurrentRestrictedId],
    );
    await client.query('COMMIT');

    const firstDelete = await database.pool.connect();
    const secondDelete = await database.pool.connect();
    try {
      await firstDelete.query('BEGIN');
      await firstDelete.query(`SET LOCAL search_path TO ${schema}, public`);
      await secondDelete.query('BEGIN');
      await secondDelete.query(`SET LOCAL search_path TO ${schema}, public`);
      await firstDelete.query(
        'DELETE FROM access_grant_branch_scopes WHERE access_grant_id = $1',
        [concurrentRestrictedId],
      );
      await secondDelete.query(
        'DELETE FROM access_grant_currency_scopes WHERE access_grant_id = $1',
        [concurrentRestrictedId],
      );

      const outcomes = await Promise.allSettled([
        commitDeferredConstraints(firstDelete),
        commitDeferredConstraints(secondDelete),
      ]);
      assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1);
      const rejected = outcomes.find(({ status }) => status === 'rejected');
      assert.ok(rejected?.status === 'rejected');
      assert.equal((rejected.reason as { code?: string }).code, '23514');
    } finally {
      firstDelete.release();
      secondDelete.release();
    }

    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO ${schema}, public`);
    const remaining = await client.query<{ count: number }>(`
      SELECT (
        (SELECT count(*) FROM access_grant_branch_scopes WHERE access_grant_id = $1)
        + (SELECT count(*) FROM access_grant_currency_scopes WHERE access_grant_id = $1)
      )::int AS count
    `, [concurrentRestrictedId]);
    assert.equal(remaining.rows[0]!.count, 1);
    await client.query('COMMIT');
  } finally {
    try {
      await client.query('ROLLBACK');
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      client.release();
      await database.onModuleDestroy();
    }
  }
});

async function rejectsConstraint(
  client: PoolClient,
  schema: string,
  change: () => Promise<unknown>,
): Promise<void> {
  await client.query('BEGIN');
  await client.query(`SET LOCAL search_path TO ${schema}, public`);
  await assert.rejects(
    async () => {
      await change();
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    },
    (error: unknown) => (error as { code?: string }).code === '23514',
  );
  await client.query('ROLLBACK');
}

async function commitDeferredConstraints(client: PoolClient): Promise<void> {
  try {
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
