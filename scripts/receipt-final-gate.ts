import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline/promises';

import { Pool } from 'pg';

const AUTHORIZATION_FLAG = '--authorize-fresh-identity';
const DATABASE_PREFIX = 'treasury_receipt_qa_';
const GENERATED_DATABASE = /^treasury_receipt_qa_[0-9a-f]{32}$/u;
export const RECEIPT_QA_PERMISSIONS = [
  'cashbox.view',
  'master-data.view',
  'party.view',
  'receipt.approve',
  'receipt.create',
  'receipt.edit-draft',
  'receipt.reject',
  'receipt.submit',
  'receipt.view',
] as const;

type Stop = () => Promise<void>;

export function assertGateEntry(
  args: readonly string[],
  inputIsTTY: boolean | undefined,
  outputIsTTY: boolean | undefined,
): void {
  if (args.length !== 1 || args[0] !== AUTHORIZATION_FLAG) {
    throw new Error(`Explicit ${AUTHORIZATION_FLAG} authorization is required.`);
  }
  if (!inputIsTTY || !outputIsTTY) {
    throw new Error('Receipt Final Gate requires a protected interactive TTY.');
  }
}

export function localAdminDatabaseUrl(value: string | undefined): URL {
  if (!value) throw new Error('RECEIPT_QA_DATABASE_ADMIN_URL is required.');
  const url = new URL(value);
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !localHosts.has(url.hostname)) {
    throw new Error('Receipt Final Gate database administration must stay on localhost.');
  }
  if (decodeURIComponent(url.pathname) !== '/postgres') {
    throw new Error('Receipt Final Gate requires the local postgres maintenance database.');
  }
  return url;
}

export function generatedDatabaseUrl(adminUrl: URL, databaseName: string): string {
  if (!GENERATED_DATABASE.test(databaseName)) {
    throw new Error('Receipt Final Gate refused a non-generated database name.');
  }
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  return databaseUrl.toString();
}

export function redactGateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\bpostgres(?:ql)?:\/\/[^\s'"]+/giu, '[database-url-redacted]');
}

export class GateCleanup {
  private activeStop?: Stop;
  private backendStop?: Stop;
  private databaseCreated = false;
  private cleanupPromise?: Promise<void>;

  constructor(private readonly dropDatabase: Stop) {}

  setActive(stop?: Stop): void {
    this.activeStop = stop;
  }

  setBackend(stop?: Stop): void {
    this.backendStop = stop;
  }

  markDatabaseCreated(): void {
    this.databaseCreated = true;
  }

  cleanup(): Promise<void> {
    return this.cleanupPromise ??= this.performCleanup();
  }

  private async performCleanup(): Promise<void> {
    let failure: unknown;
    for (const stop of [this.activeStop, this.backendStop]) {
      try {
        await stop?.();
      } catch (error) {
        failure ??= error;
      }
    }
    if (this.databaseCreated) {
      try {
        await this.dropDatabase();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }
}

async function main(): Promise<void> {
  assertGateEntry(process.argv.slice(2), process.stdin.isTTY, process.stdout.isTTY);
  const adminUrl = localAdminDatabaseUrl(process.env.RECEIPT_QA_DATABASE_ADMIN_URL);
  const databaseName = `${DATABASE_PREFIX}${randomBytes(16).toString('hex')}`;
  const databaseUrl = generatedDatabaseUrl(adminUrl, databaseName);
  const cleanup = new GateCleanup(() => dropDatabase(adminUrl, databaseName));
  const removeSignalHandlers = registerSignalHandlers(cleanup);
  const runtimeEnv = {
    ...process.env,
    APP_ORIGIN: 'http://127.0.0.1:4200',
    COMMAND_DIGEST_HMAC_KEY_BASE64: randomBytes(32).toString('base64'),
    DATABASE_URL: databaseUrl,
    LOGIN_THROTTLE_HMAC_KEY_BASE64: randomBytes(32).toString('base64'),
    RECEIPT_QA_IN_MEMORY_TOTP_KEY: '1',
    TEST_DATABASE_URL: databaseUrl,
    TOTP_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'),
    TOTP_KEY_VERSION: '1',
  };

  try {
    cleanup.markDatabaseCreated();
    await createDatabase(adminUrl, databaseName);
    await run(
      'Migrating isolated receipt QA database',
      ['--import', 'tsx', 'scripts/migrate.ts'],
      runtimeEnv,
      cleanup,
    );
    await run(
      'Creating fresh receipt QA identity through protected TTY',
      ['--import', 'tsx', 'scripts/bootstrap.ts'],
      runtimeEnv,
      cleanup,
    );
    await restrictBootstrapPermissions(databaseUrl);
    await run(
      'Running receipt denial, idempotency, version, concurrency, and database checks',
      [
        '--import',
        'tsx',
        '--test',
        '--test-concurrency=1',
        'test/receipt-postgres.integration.test.ts',
      ],
      runtimeEnv,
      cleanup,
    );
    await seedBrowserReceiptFoundation(databaseUrl);
    const port = await availablePort();
    const backend = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/main.ts'],
      {
        cwd: process.cwd(),
        env: { ...runtimeEnv, PORT: String(port) },
        stdio: 'inherit',
      },
    );
    cleanup.setBackend(() => stopChild(backend));
    await waitForBackend(backend, port);
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const confirmation = await prompt.question(
        `Receipt QA backend is ready on loopback port ${port}. `
        + 'Run the focused browser journey, then type PASS to clean up: ',
      );
      if (confirmation.trim() !== 'PASS') {
        throw new Error('Focused browser journey completion was not confirmed.');
      }
    } finally {
      prompt.close();
    }
    process.stdout.write('Receipt Final Gate passed; cleaning isolated resources.\n');
  } finally {
    try {
      await cleanup.cleanup();
    } finally {
      removeSignalHandlers();
    }
  }
}

async function createDatabase(adminUrl: URL, databaseName: string): Promise<void> {
  if (!GENERATED_DATABASE.test(databaseName)) throw new Error('Unsafe database name.');
  const pool = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  try {
    await pool.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await pool.end();
  }
}

async function dropDatabase(adminUrl: URL, databaseName: string): Promise<void> {
  if (!GENERATED_DATABASE.test(databaseName)) throw new Error('Unsafe database name.');
  const pool = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  try {
    await pool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await pool.end();
  }
}

async function restrictBootstrapPermissions(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const role = await client.query<{ id: string }>(
      `SELECT id FROM roles WHERE code = 'SYSTEM_ADMIN' FOR UPDATE`,
    );
    if (role.rowCount !== 1) throw new Error('Fresh bootstrap role was not found exactly once.');
    await client.query('DELETE FROM role_permissions WHERE role_id = $1', [role.rows[0]!.id]);
    await client.query(
      `INSERT INTO role_permissions (role_id, permission)
       SELECT $1, permission FROM unnest($2::varchar[]) AS permission`,
      [role.rows[0]!.id, RECEIPT_QA_PERMISSIONS],
    );
    const actual = await client.query<{ permission: string }>(
      'SELECT permission FROM role_permissions WHERE role_id = $1 ORDER BY permission',
      [role.rows[0]!.id],
    );
    if (
      actual.rows.map(({ permission }) => permission).join(',')
      !== RECEIPT_QA_PERMISSIONS.join(',')
    ) {
      throw new Error('Fresh receipt QA identity did not receive the exact permissions.');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function seedBrowserReceiptFoundation(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    const foundation = await client.query<{
      organizationId: string;
      currency: string;
      treasuryUnitId: string;
      userId: string;
    }>(`
      SELECT
        organization.id AS "organizationId",
        organization.base_currency AS currency,
        treasury_unit.id AS "treasuryUnitId",
        user_ref.id AS "userId"
      FROM organizations organization
      JOIN treasury_units treasury_unit
        ON treasury_unit.organization_id = organization.id
      JOIN user_refs user_ref
        ON user_ref.organization_id = organization.id
      LIMIT 1
    `);
    if (foundation.rowCount !== 1) throw new Error('Fresh bootstrap foundation was not found.');
    const { organizationId, currency, treasuryUnitId, userId } = foundation.rows[0]!;
    const branch = await client.query<{ id: string }>(`
      INSERT INTO branches (organization_id, code, name)
      VALUES ($1, 'QA-BRANCH', 'QA Branch')
      RETURNING id
    `, [organizationId]);
    await client.query(
      'UPDATE treasury_units SET branch_id = $1 WHERE id = $2',
      [branch.rows[0]!.id, treasuryUnitId],
    );
    const party = await client.query<{ id: string }>(`
      INSERT INTO parties (organization_id, code, display_name)
      VALUES ($1, 'QA-PARTY', 'QA Receipt Party')
      RETURNING id
    `, [organizationId]);
    await client.query(
      `INSERT INTO party_kinds (party_id, party_kind) VALUES ($1, 'CUSTOMER')`,
      [party.rows[0]!.id],
    );
    const method = await client.query<{ id: string }>(`
      INSERT INTO method_definitions (
        organization_id, code, name, direction, behavior_category,
        creates_funds_in_transit, requires_approval
      ) VALUES ($1, 'QA-CASH', 'QA Cash Receipt', 'RECEIPT', 'CASH', false, true)
      RETURNING id
    `, [organizationId]);
    await client.query(
      `INSERT INTO method_required_references (method_id, reference)
       VALUES ($1, 'CASHBOX')`,
      [method.rows[0]!.id],
    );
    await client.query(
      `INSERT INTO method_allowed_currencies (method_id, organization_id, currency_code)
       VALUES ($1, $2, $3)`,
      [method.rows[0]!.id, organizationId, currency],
    );
    const cashbox = await client.query<{ id: string }>(`
      INSERT INTO cashboxes (
        organization_id, branch_id, treasury_unit_id, code, name, cashbox_type,
        main_currency, can_receive, can_pay, can_transfer, requires_approval,
        active_from
      ) VALUES ($1, $2, $3, 'QA-CASHBOX', 'QA Main Cashbox', 'CASH',
        $4, true, false, false, false, now())
      RETURNING id
    `, [organizationId, branch.rows[0]!.id, treasuryUnitId, currency]);
    await client.query(`
      INSERT INTO cashbox_currency_controls (
        cashbox_id, organization_id, currency, allow_negative
      ) VALUES ($1, $2, $3, false)
    `, [cashbox.rows[0]!.id, organizationId, currency]);
    await client.query(`
      INSERT INTO cashbox_assignments (
        organization_id, cashbox_id, user_id, assignment_type,
        effective_from, state
      ) VALUES ($1, $2, $3, 'PRIMARY', now(), 'ACTIVE')
    `, [organizationId, cashbox.rows[0]!.id, userId]);
    const policy = await client.query<{ id: string }>(`
      INSERT INTO receipt_approval_policies (
        organization_id, code, name, document_type,
        currency, method_category, version, state
      ) VALUES ($1, 'QA-CASH-RECEIPT', 'QA Cash Receipt Approval',
        'RECEIPT', $2, 'CASH', 1, 'ACTIVE')
      RETURNING id
    `, [organizationId, currency]);
    await client.query(`
      INSERT INTO receipt_approval_policy_steps (
        organization_id, policy_id, step_order, approver_user_id,
        approvals_required, separation_rules
      ) VALUES ($1, $2, 1, $3, 1, '{}')
    `, [organizationId, policy.rows[0]!.id, userId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function run(
  label: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cleanup: GateCleanup,
): Promise<void> {
  process.stdout.write(`${label}...\n`);
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
  });
  cleanup.setActive(() => stopChild(child));
  try {
    const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
    if (code !== 0) throw new Error(`${label} failed (${signal ?? code ?? 'unknown'}).`);
  } finally {
    cleanup.setActive();
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timeout = new Promise<'timeout'>((resolve) => {
    setTimeout(() => resolve('timeout'), 3_000).unref();
  });
  if (await Promise.race([exited, timeout]) === 'timeout') {
    child.kill('SIGKILL');
    await exited;
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a loopback port.');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForBackend(child: ChildProcess, port: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Receipt QA backend exited before becoming ready.');
    }
    try {
      await fetch(`http://127.0.0.1:${port}/v1/auth/sessions/current`, {
        signal: AbortSignal.timeout(500),
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('Receipt QA backend did not become ready.');
}

function registerSignalHandlers(cleanup: GateCleanup): () => void {
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    const handler = () => {
      void cleanup.cleanup()
        .catch((error: unknown) => {
          console.error(`Receipt Final Gate cleanup failed: ${redactGateError(error)}`);
        })
        .finally(() => process.exit(exitCode));
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(`Receipt Final Gate failed: ${redactGateError(error)}`);
    process.exitCode = 1;
  });
}
