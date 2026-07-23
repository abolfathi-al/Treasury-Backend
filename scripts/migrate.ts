import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { Pool } from 'pg';

async function migrate(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const names = (await readdir(join(process.cwd(), 'migrations')))
      .filter((name) => name.endsWith('.sql'))
      .sort();

    for (const name of names) {
      await client.query('BEGIN');
      try {
        const existing = await client.query<{ exists: boolean }>(
          'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE name = $1) AS exists',
          [name],
        );
        if (!existing.rows[0]?.exists) {
          await client.query(await readFile(join(process.cwd(), 'migrations', name), 'utf8'));
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
          process.stdout.write(`applied ${name}\n`);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

void migrate().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
