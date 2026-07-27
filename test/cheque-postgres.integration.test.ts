import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  ChequeBookCreateDto,
  ChequeLeafCommand,
} from '../src/cheques/cheque.dto';
import { ChequeRepository } from '../src/cheques/cheque.repository';
import { ChequeService } from '../src/cheques/cheque.service';
import { TreasuryProblem } from '../src/common/problem';
import { DatabaseService } from '../src/database/database.service';

const connectionString = process.env.TEST_DATABASE_URL;

test('INC-1G PostgreSQL books and leaf controls are scoped, atomic, and serialized', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = connectionString;
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 43).toString('base64');
  const database = new DatabaseService();
  const service = new ChequeService(new ChequeRepository(database));
  try {
    const fixture = await seed(database);
    const book = await service.createChequeBook(
      fixture.organizationId,
      fixture.scopedUserId,
      createCommand(fixture.accountAId, 100, 102, fixture.custodianId),
      'cheque-book-main',
      'request-book-main',
    );
    assert.equal(book.state, 'ACTIVE');
    assert.equal(book.leafCount, 3);
    assert.deepEqual(book.leaves.map(({ leafNumber }) => leafNumber), [100, 101, 102]);
    assert.ok(book.leaves.every(({ state, version }) => state === 'AVAILABLE' && version === 0));
    assert.equal(book.bankAccount.id, fixture.accountAId);
    assert.match(book.bankAccount.label, /First Bank.*A-1/u);
    assert.notEqual(book.bankAccount.label, book.bankAccount.id);
    assert.deepEqual(book.custodian, {
      id: fixture.custodianId,
      label: 'Cheque Custodian',
    });
    assert.ok(book.leaves.every(({ label, id }) => label !== id && label.startsWith('SERIES-A-')));
    assert.equal((await database.pool.query<{ scope: string }>(`
      SELECT scope FROM idempotency_records
      WHERE organization_id = $1 AND idempotency_key = 'cheque-book-main'
    `, [fixture.organizationId])).rows[0]!.scope, `createChequeBook:${fixture.scopedUserId}`);

    assert.equal((await service.createChequeBook(
      fixture.organizationId,
      fixture.scopedUserId,
      createCommand(fixture.accountAId, 100, 102, fixture.custodianId),
      'cheque-book-main',
      'request-book-replay',
    )).id, book.id);
    await assert.rejects(
      service.createChequeBook(
        fixture.organizationId,
        fixture.scopedUserId,
        { ...createCommand(fixture.accountAId, 100, 102), notes: 'changed' },
        'cheque-book-main',
        'request-book-conflict',
      ),
      (error) => problem(error, 'TRS-GEN-007', 409),
    );
    await assert.rejects(
      service.createChequeBook(
        fixture.organizationId,
        fixture.scopedUserId,
        createCommand(fixture.accountBId, 300, 301),
        'cheque-book-denied',
        'request-book-denied',
      ),
      (error) => problem(error, 'TRS-GEN-003', 403),
    );
    await assert.rejects(
      service.createChequeBook(
        fixture.organizationId,
        fixture.adminUserId,
        createCommand('00000000-0000-4000-8000-999999999999', 300, 301),
        'cheque-book-hidden',
        'request-book-hidden',
      ),
      (error) => problem(error, 'TRS-GEN-004', 404),
    );
    await assert.rejects(
      service.createChequeBook(
        fixture.organizationId,
        fixture.adminUserId,
        createCommand(fixture.unavailableAccountId, 300, 301),
        'cheque-book-unavailable',
        'request-book-unavailable',
      ),
      (error) => problem(error, 'TRS-BNK-001', 409),
    );
    await assert.rejects(
      service.createChequeBook(
        fixture.organizationId,
        fixture.adminUserId,
        createCommand(fixture.accountAId, 300, 301, fixture.inactiveCustodianId),
        'cheque-book-inactive-custodian',
        'request-book-inactive-custodian',
      ),
      (error) => problem(error, 'TRS-MST-001', 409),
    );

    const overlaps = await Promise.allSettled([
      service.createChequeBook(
        fixture.organizationId,
        fixture.adminUserId,
        createCommand(fixture.accountAId, 200, 210),
        'cheque-overlap-one',
        'request-overlap-one',
      ),
      service.createChequeBook(
        fixture.organizationId,
        fixture.adminUserId,
        createCommand(fixture.accountAId, 205, 215),
        'cheque-overlap-two',
        'request-overlap-two',
      ),
    ]);
    assert.equal(overlaps.filter(({ status }) => status === 'fulfilled').length, 1);
    const overlapFailure = overlaps.find(({ status }) => status === 'rejected');
    assert.ok(
      overlapFailure?.status === 'rejected'
      && problem(overlapFailure.reason, 'TRS-CHQ-002', 409),
    );
    assert.equal((await database.pool.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM cheque_leaves
      WHERE organization_id = $1
        AND series = 'SERIES-A'
        AND leaf_number BETWEEN 200 AND 215
    `, [fixture.organizationId])).rows[0]!.count, '11');

    await database.pool.query(
      'DELETE FROM access_grant_bank_account_scopes WHERE access_grant_id = $1',
      [fixture.scopedGrantId],
    );
    await database.pool.query(`
      INSERT INTO access_grant_bank_account_scopes (access_grant_id, bank_account_id)
      VALUES ($1,$2)
    `, [fixture.scopedGrantId, fixture.accountBId]);
    await assert.rejects(
      service.createChequeBook(
        fixture.organizationId,
        fixture.scopedUserId,
        createCommand(fixture.accountAId, 100, 102, fixture.custodianId),
        'cheque-book-main',
        'request-book-replay-rescoped',
      ),
      (error) => problem(error, 'TRS-GEN-003', 403),
    );
    await database.pool.query(
      'DELETE FROM access_grant_bank_account_scopes WHERE access_grant_id = $1',
      [fixture.scopedGrantId],
    );
    await database.pool.query(`
      INSERT INTO access_grant_bank_account_scopes (access_grant_id, bank_account_id)
      VALUES ($1,$2)
    `, [fixture.scopedGrantId, fixture.accountAId]);

    await assert.rejects(
      service.transitionCheque(
        fixture.organizationId,
        fixture.deniedUserId,
        book.id,
        '100',
        { command: ChequeLeafCommand.VOID, reason: 'Denied' },
        'leaf-denied-key',
        '"0"',
        'request-leaf-denied',
      ),
      (error) => problem(error, 'TRS-GEN-003', 403),
    );
    const transitions = await Promise.allSettled([
      service.transitionCheque(
        fixture.organizationId,
        fixture.scopedUserId,
        book.id,
        '100',
        { command: ChequeLeafCommand.VOID, reason: 'Damaged leaf' },
        'leaf-void-key',
        '"0"',
        'request-leaf-void',
      ),
      service.transitionCheque(
        fixture.organizationId,
        fixture.scopedUserId,
        book.id,
        '100',
        { command: ChequeLeafCommand.REPORT_LOST, reason: 'Missing leaf' },
        'leaf-lost-race',
        '"0"',
        'request-leaf-lost-race',
      ),
    ]);
    assert.equal(transitions.filter(({ status }) => status === 'fulfilled').length, 1);
    const transitionFailure = transitions.find(({ status }) => status === 'rejected');
    assert.ok(
      transitionFailure?.status === 'rejected'
      && problem(transitionFailure.reason, 'TRS-GEN-006', 409),
    );
    const applied = transitions.find(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<
        ChequeService['transitionCheque']
      >>> => result.status === 'fulfilled',
    )!.value;
    assert.equal(applied.version, 1);
    assert.ok(['VOID', 'LOST'].includes(applied.state));
    assert.equal(applied.label, 'SERIES-A-100');

    const event = await database.pool.query<{
      id: string;
      count: string;
      from_state: string;
      to_state: string;
      actor_user_id: string;
      reason: string;
      idempotency_key: string;
    }>(`
      SELECT id, count(*) OVER ()::text AS count, from_state, to_state,
             actor_user_id, reason, idempotency_key
      FROM cheque_events
      WHERE cheque_type = 'LEAF' AND cheque_id = $1
    `, [applied.id]);
    assert.equal(event.rows[0]!.count, '1');
    assert.equal(event.rows[0]!.from_state, 'AVAILABLE');
    assert.equal(event.rows[0]!.to_state, applied.state);
    assert.equal(event.rows[0]!.actor_user_id, fixture.scopedUserId);
    assert.equal((await database.pool.query<{ scope: string }>(`
      SELECT scope FROM idempotency_records
      WHERE organization_id = $1
        AND idempotency_key IN ('leaf-void-key', 'leaf-lost-race')
        AND response_body IS NOT NULL
    `, [fixture.organizationId])).rows[0]!.scope, `transitionCheque:${fixture.scopedUserId}`);

    const winningKey = applied.state === 'VOID' ? 'leaf-void-key' : 'leaf-lost-race';
    const winningCommand = applied.state === 'VOID'
      ? ChequeLeafCommand.VOID
      : ChequeLeafCommand.REPORT_LOST;
    const winningReason = applied.state === 'VOID' ? 'Damaged leaf' : 'Missing leaf';
    assert.equal(event.rows[0]!.reason, winningReason);
    assert.equal(event.rows[0]!.idempotency_key, winningKey);
    assert.equal((await service.transitionCheque(
      fixture.organizationId,
      fixture.scopedUserId,
      book.id,
      '100',
      { command: winningCommand, reason: winningReason },
      winningKey,
      '"0"',
      'request-leaf-replay',
    )).state, applied.state);
    await assert.rejects(
      service.transitionCheque(
        fixture.organizationId,
        fixture.scopedUserId,
        book.id,
        '100',
        { command: winningCommand, reason: 'Changed reason' },
        winningKey,
        '"0"',
        'request-leaf-conflict',
      ),
      (error) => problem(error, 'TRS-GEN-007', 409),
    );
    await assert.rejects(
      service.transitionCheque(
        fixture.organizationId,
        fixture.scopedUserId,
        book.id,
        '100',
        { command: ChequeLeafCommand.VOID, reason: 'Already terminal' },
        'leaf-terminal-key',
        '"1"',
        'request-leaf-terminal',
      ),
      (error) => problem(error, 'TRS-CHQ-003', 409),
    );
    await assert.rejects(
      service.transitionCheque(
        fixture.organizationId,
        fixture.scopedUserId,
        book.id,
        '999',
        { command: ChequeLeafCommand.VOID, reason: 'Outside range' },
        'leaf-outside-key',
        '"0"',
        'request-leaf-outside',
      ),
      (error) => problem(error, 'TRS-CHQ-001', 409),
    );
    await assert.rejects(
      service.transitionCheque(
        fixture.organizationId,
        fixture.adminUserId,
        '00000000-0000-4000-8000-999999999999',
        '100',
        { command: ChequeLeafCommand.VOID, reason: 'Hidden book' },
        'leaf-hidden-key',
        '"0"',
        'request-leaf-hidden',
      ),
      (error) => problem(error, 'TRS-GEN-004', 404),
    );
    for (const statement of [
      'UPDATE cheque_events SET reason = reason WHERE id = $1',
      'DELETE FROM cheque_events WHERE id = $1',
    ]) {
      await assert.rejects(
        database.pool.query(statement, [event.rows[0]!.id]),
        (error: unknown) => (error as { code?: string }).code === '23514',
      );
    }
  } finally {
    await cleanup(database);
    await database.onModuleDestroy();
  }
});

test('0007 upgrades a valid 0006 reference-only book with its complete leaf range', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = connectionString;
  const database = new DatabaseService();
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE SCHEMA cheque_upgrade_test');
    await client.query('SET LOCAL search_path TO cheque_upgrade_test, public');
    for (const name of [
      '0001_foundation.sql',
      '0002_access_control.sql',
      '0003_party_directory.sql',
      '0004_cashbox_base_data.sql',
      '0005_banking_base_data.sql',
      '0006_print_templates.sql',
    ]) {
      await client.query(await readFile(join('migrations', name), 'utf8'));
    }
    const fixture = await client.query<{
      organization_id: string;
      account_id: string;
    }>(`
      WITH organization AS (
        INSERT INTO organizations (code, legal_name, timezone, base_currency)
        VALUES ('UPGRADE', 'Upgrade Test', 'UTC', 'USD')
        RETURNING id
      ), currency AS (
        INSERT INTO currencies (
          organization_id, code, name, decimal_places, base_currency
        )
        SELECT id, 'USD', 'US Dollar', 2, true FROM organization
      ), bank_type AS (
        INSERT INTO bank_types (organization_id, code, display_name)
        SELECT id, 'COMMERCIAL', 'Commercial' FROM organization
        RETURNING id, organization_id
      ), bank AS (
        INSERT INTO banks (
          organization_id, bank_type_id, code, display_name, country_code
        )
        SELECT organization_id, id, 'UPGRADE', 'Upgrade Bank', 'US'
        FROM bank_type
        RETURNING id, organization_id
      ), account AS (
        INSERT INTO bank_accounts (
          organization_id, bank_id, account_type, account_number, currency,
          legal_owner_name, opening_date, cheque_enabled,
          can_receive, can_pay, can_transfer, state
        )
        SELECT organization_id, id, 'CURRENT', 'UP-1', 'USD',
               'Upgrade Test', '2026-07-27', true, true, true, true, 'ACTIVE'
        FROM bank
        RETURNING id, organization_id
      )
      SELECT organization_id, id AS account_id FROM account
    `);
    const legacy = await client.query<{ id: string }>(`
      INSERT INTO cheque_books (
        bank_account_id, series, first_leaf, last_leaf, received_date, state
      ) VALUES ($1, 'LEGACY', 10, 12, '2026-07-27', 'ACTIVE')
      RETURNING id
    `, [fixture.rows[0]!.account_id]);

    await client.query(
      await readFile(join('migrations', '0007_cheque_foundation.sql'), 'utf8'),
    );
    const leaves = await client.query<{
      organization_id: string;
      leaf_number: string;
      state: string;
    }>(`
      SELECT organization_id, leaf_number::text, state
      FROM cheque_leaves
      WHERE cheque_book_id = $1
      ORDER BY leaf_number
    `, [legacy.rows[0]!.id]);
    assert.deepEqual(
      leaves.rows.map(({ leaf_number }) => leaf_number),
      ['10', '11', '12'],
    );
    assert.ok(leaves.rows.every(({ organization_id, state }) =>
      organization_id === fixture.rows[0]!.organization_id
      && state === 'AVAILABLE'
    ));
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await database.onModuleDestroy();
  }
});

function createCommand(
  bankAccountId: string,
  firstLeaf: number,
  lastLeaf: number,
  custodianUserId?: string,
): ChequeBookCreateDto {
  return {
    bankAccountId,
    series: 'SERIES-A',
    firstLeaf,
    lastLeaf,
    receivedDate: '2026-07-27',
    ...(custodianUserId ? { custodianUserId } : {}),
  };
}

async function seed(database: DatabaseService) {
  await cleanup(database);
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    const organization = await client.query<{ id: string }>(`
      INSERT INTO organizations (code, legal_name, timezone, base_currency)
      VALUES ('CHEQUE', 'Cheque Test', 'UTC', 'USD')
      RETURNING id
    `);
    const organizationId = organization.rows[0]!.id;
    await client.query(`
      INSERT INTO currencies (
        organization_id, code, name, decimal_places, base_currency
      ) VALUES ($1,'USD','US Dollar',2,true)
    `, [organizationId]);
    const bankType = await client.query<{ id: string }>(`
      INSERT INTO bank_types (organization_id, code, display_name)
      VALUES ($1,'COMMERCIAL','Commercial') RETURNING id
    `, [organizationId]);
    const bank = await client.query<{ id: string }>(`
      INSERT INTO banks (
        organization_id, bank_type_id, code, display_name, country_code
      ) VALUES ($1,$2,'FIRST','First Bank','US') RETURNING id
    `, [organizationId, bankType.rows[0]!.id]);
    const accounts = await client.query<{
      id: string;
      account_number: string;
    }>(`
      INSERT INTO bank_accounts (
        organization_id, bank_id, account_type, account_number, currency,
        legal_owner_name, opening_date, cheque_enabled,
        can_receive, can_pay, can_transfer, state, version
      ) VALUES
        ($1,$2,'CURRENT','A-1','USD','Cheque Test','2026-07-27',true,true,true,true,'ACTIVE',1),
        ($1,$2,'CURRENT','B-1','USD','Cheque Test','2026-07-27',true,true,true,true,'ACTIVE',1),
        ($1,$2,'CURRENT','C-1','USD','Cheque Test','2026-07-27',true,true,true,true,'SUSPENDED',1)
      RETURNING id, account_number
    `, [organizationId, bank.rows[0]!.id]);
    const accountIds = new Map(accounts.rows.map((row) => [row.account_number, row.id]));
    const users = await client.query<{ id: string; subject_key: string }>(`
      INSERT INTO user_refs (
        organization_id, subject_key, display_name, state
      ) VALUES
        ($1,'cheque-admin','Cheque Admin','ACTIVE'),
        ($1,'cheque-scoped','Cheque Scoped','ACTIVE'),
        ($1,'cheque-denied','Cheque Denied','ACTIVE'),
        ($1,'cheque-custodian','Cheque Custodian','ACTIVE'),
        ($1,'cheque-inactive-custodian','Inactive Custodian','INACTIVE')
      RETURNING id, subject_key
    `, [organizationId]);
    const userIds = new Map(users.rows.map((row) => [row.subject_key, row.id]));
    const role = await client.query<{ id: string }>(`
      INSERT INTO roles (organization_id, code, name)
      VALUES ($1,'CHEQUE_ADMIN','Cheque Admin') RETURNING id
    `, [organizationId]);
    await client.query(`
      INSERT INTO role_permissions (role_id, permission)
      VALUES ($1,'cheque-book.manage'), ($1,'cheque.transition')
    `, [role.rows[0]!.id]);
    const grants = await client.query<{ id: string; user_ref_id: string }>(`
      INSERT INTO access_grants (
        organization_id, user_ref_id, role_id, scope_id
      ) VALUES
        ($1,$2,$5,$1),
        ($1,$3,$5,$1),
        ($1,$4,$5,$1)
      RETURNING id, user_ref_id
    `, [
      organizationId,
      userIds.get('cheque-admin'),
      userIds.get('cheque-scoped'),
      userIds.get('cheque-denied'),
      role.rows[0]!.id,
    ]);
    const grantIds = new Map(grants.rows.map((row) => [row.user_ref_id, row.id]));
    await client.query(`
      INSERT INTO access_grant_bank_account_scopes (
        access_grant_id, bank_account_id
      ) VALUES ($1,$2), ($3,$4)
    `, [
      grantIds.get(userIds.get('cheque-scoped')!),
      accountIds.get('A-1'),
      grantIds.get(userIds.get('cheque-denied')!),
      accountIds.get('B-1'),
    ]);
    await client.query('COMMIT');
    return {
      organizationId,
      accountAId: accountIds.get('A-1')!,
      accountBId: accountIds.get('B-1')!,
      unavailableAccountId: accountIds.get('C-1')!,
      adminUserId: userIds.get('cheque-admin')!,
      scopedUserId: userIds.get('cheque-scoped')!,
      deniedUserId: userIds.get('cheque-denied')!,
      custodianId: userIds.get('cheque-custodian')!,
      inactiveCustodianId: userIds.get('cheque-inactive-custodian')!,
      scopedGrantId: grantIds.get(userIds.get('cheque-scoped')!)!,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function cleanup(database: DatabaseService): Promise<void> {
  await database.pool.query('TRUNCATE TABLE organizations CASCADE');
}

function problem(error: unknown, code: string, status: number): boolean {
  return error instanceof TreasuryProblem
    && error.getStatus() === status
    && (error.getResponse() as { code?: string }).code === code;
}
