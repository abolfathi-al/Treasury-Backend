import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CashboxCreateDto,
  CashboxType,
} from '../src/cashbox-and-custody/cashbox.dto';
import { CashboxRepository } from '../src/cashbox-and-custody/cashbox.repository';
import { CashboxService } from '../src/cashbox-and-custody/cashbox.service';
import { TreasuryProblem } from '../src/common/problem';
import { DatabaseService } from '../src/database/database.service';

const connectionString = process.env.TEST_DATABASE_URL;

test('INC-1D PostgreSQL create/list/handover are scoped, replay-safe, atomic, and serialized', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = connectionString;
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 23).toString('base64');
  const database = new DatabaseService();
  const service = new CashboxService(new CashboxRepository(database));
  try {
    const fixture = await seed(database);
    const first = await service.create(
      fixture.organizationId,
      fixture.primaryUserId,
      createDto(fixture, 'MAIN'),
      'cashbox-main',
      'request-create-main',
    );
    assert.equal(first.state, 'ACTIVE');
    assert.equal(first.primaryCustodianId, fixture.primaryUserId);
    assert.deepEqual(first.heldInstrumentOptions, []);
    assert.deepEqual(
      (await service.list(fixture.organizationId, fixture.scopedUserId)).items,
      [],
    );
    await assert.rejects(
      service.create(
        fixture.organizationId,
        fixture.scopedUserId,
        createDto(fixture, 'DENIED'),
        'cashbox-denied',
        'request-create-denied',
      ),
      (error) => problem(error, 'TRS-GEN-003', 403),
    );
    await assert.rejects(
      service.createHandover(
        fixture.organizationId,
        fixture.scopedUserId,
        first.id,
        {
          incomingUserId: fixture.incomingUserId,
          moneyCounts: [{ currency: 'USD', countedAmount: '0' }],
          observedInstrumentIds: [],
        },
        'handover-denied',
        '"0"',
        'request-denied',
      ),
      (error) => problem(error, 'TRS-GEN-003', 403),
    );
    await assert.rejects(
      database.pool.query(
        'UPDATE treasury_units SET branch_id = NULL WHERE id = $1',
        [fixture.treasuryUnitId],
      ),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
    assert.equal((await service.create(
      fixture.organizationId,
      fixture.primaryUserId,
      createDto(fixture, 'MAIN'),
      'cashbox-main',
      'request-create-main-retry',
    )).id, first.id);
    await assert.rejects(
      service.create(
        fixture.organizationId,
        fixture.otherUserId,
        createDto(fixture, 'MAIN'),
        'cashbox-main',
        'request-create-main-other-actor',
      ),
      (error) => problem(error, 'TRS-GEN-007', 409),
    );
    await database.pool.query(`
      INSERT INTO access_grant_branch_scopes (access_grant_id, branch_id)
      VALUES ($1,$2)
    `, [fixture.primaryGrantId, fixture.otherBranchId]);
    await assert.rejects(
      service.create(
        fixture.organizationId,
        fixture.primaryUserId,
        createDto(fixture, 'MAIN'),
        'cashbox-main',
        'request-create-main-rescoped',
      ),
      (error) => problem(error, 'TRS-GEN-003', 403),
    );
    await database.pool.query(
      'DELETE FROM access_grant_branch_scopes WHERE access_grant_id = $1',
      [fixture.primaryGrantId],
    );
    await assert.rejects(
      service.create(
        fixture.organizationId,
        fixture.primaryUserId,
        { ...createDto(fixture, 'MAIN'), name: 'Changed digest' },
        'cashbox-main',
        'request-create-main-changed',
      ),
      (error) => problem(error, 'TRS-GEN-007', 409),
    );

    const page = await service.list(
      fixture.organizationId,
      fixture.primaryUserId,
      '1',
    );
    assert.deepEqual(page.items.map(({ id }) => id), [first.id]);

    const counted = await service.createHandover(
      fixture.organizationId,
      fixture.primaryUserId,
      first.id,
      {
        incomingUserId: fixture.incomingUserId,
        moneyCounts: [{ currency: 'USD', countedAmount: '0' }],
        observedInstrumentIds: [],
      },
      'handover-main',
      '"0"',
      'request-main',
    );
    assert.equal(counted.state, 'COUNTED');
    assert.equal(counted.outgoingUserId, fixture.primaryUserId);
    assert.equal(counted.currentAssignmentId.length > 0, true);
    assert.deepEqual(counted.heldInstrumentSnapshot, []);
    assert.equal(counted.moneyCounts[0]!.bookAmount, '0.00000000');
    assert.equal((await service.createHandover(
      fixture.organizationId,
      fixture.primaryUserId,
      first.id,
      {
        incomingUserId: fixture.incomingUserId,
        moneyCounts: [{ currency: 'USD', countedAmount: '0' }],
        observedInstrumentIds: [],
      },
      'handover-main',
      '"0"',
      'request-main',
    )).id, counted.id);
    await database.pool.query(`
      UPDATE cashbox_assignments SET user_id = $1
      WHERE id = $2
    `, [fixture.otherUserId, counted.currentAssignmentId]);
    await assert.rejects(
      service.createHandover(
        fixture.organizationId,
        fixture.primaryUserId,
        first.id,
        {
          incomingUserId: fixture.incomingUserId,
          moneyCounts: [{ currency: 'USD', countedAmount: '0' }],
          observedInstrumentIds: [],
        },
        'handover-main',
        '"0"',
        'request-main',
      ),
      (error) => problem(error, 'TRS-CSH-002', 409),
    );
    await database.pool.query(`
      UPDATE cashbox_assignments SET user_id = $1
      WHERE id = $2
    `, [fixture.primaryUserId, counted.currentAssignmentId]);

    const assignment = await database.pool.query<{ user_id: string; count: number }>(`
      SELECT min(user_id::text) AS user_id, count(*)::int
      FROM cashbox_assignments
      WHERE cashbox_id = $1 AND assignment_type = 'PRIMARY' AND state = 'ACTIVE'
    `, [first.id]);
    assert.equal(assignment.rows[0]!.count, 1);
    assert.equal(assignment.rows[0]!.user_id, fixture.primaryUserId);

    await assert.rejects(
      service.createHandover(
        fixture.organizationId,
        fixture.otherUserId,
        first.id,
        {
          incomingUserId: fixture.incomingUserId,
          moneyCounts: [{ currency: 'USD', countedAmount: '0' }],
          observedInstrumentIds: [],
        },
        'wrong-custodian',
        '"0"',
        'request-wrong-custodian',
      ),
      (error) => problem(error, 'TRS-CSH-002', 409),
    );

    const second = await service.create(
      fixture.organizationId,
      fixture.primaryUserId,
      createDto(fixture, 'SECOND'),
      'cashbox-second',
      'request-create-second',
    );
    await assert.rejects(
      service.createHandover(
        fixture.organizationId,
        fixture.primaryUserId,
        second.id,
        {
          incomingUserId: fixture.incomingUserId,
          moneyCounts: [{ currency: 'USD', countedAmount: '0' }],
          observedInstrumentIds: [],
        },
        'stale-handover',
        '"9"',
        'request-stale',
      ),
      (error) => problem(error, 'TRS-GEN-006', 409),
    );

    const concurrent = await Promise.allSettled([
      service.createHandover(
        fixture.organizationId,
        fixture.primaryUserId,
        second.id,
        {
          incomingUserId: fixture.incomingUserId,
          moneyCounts: [{ currency: 'USD', countedAmount: '0' }],
          observedInstrumentIds: [],
        },
        'concurrent-one',
        '"0"',
        'request-concurrent-one',
      ),
      service.createHandover(
        fixture.organizationId,
        fixture.primaryUserId,
        second.id,
        {
          incomingUserId: fixture.incomingUserId,
          moneyCounts: [{ currency: 'USD', countedAmount: '0' }],
          observedInstrumentIds: [],
        },
        'concurrent-two',
        '"0"',
        'request-concurrent-two',
      ),
    ]);
    assert.equal(concurrent.filter(({ status }) => status === 'fulfilled').length, 1);
    const rejected = concurrent.find(({ status }) => status === 'rejected');
    assert.ok(rejected?.status === 'rejected');
    assert.ok(problem(rejected.reason, 'TRS-GEN-005', 409));
    const open = await database.pool.query<{ count: number }>(`
      SELECT count(*)::int
      FROM cashbox_handovers
      WHERE cashbox_id = $1
        AND state NOT IN ('COMPLETED', 'REJECTED', 'CANCELLED')
    `, [second.id]);
    assert.equal(open.rows[0]!.count, 1);
  } finally {
    await cleanup(database);
    await database.onModuleDestroy();
  }
});

function createDto(
  fixture: {
    branchId: string;
    treasuryUnitId: string;
    primaryUserId: string;
  },
  code: string,
): CashboxCreateDto {
  return {
    code,
    name: `${code} Cashbox`,
    type: CashboxType.CASH,
    branchId: fixture.branchId,
    treasuryUnitId: fixture.treasuryUnitId,
    mainCurrency: 'USD',
    currencyControls: [{
      currency: 'USD',
      transactionCeiling: '1000',
      minimumPosition: '0',
      maximumHolding: '5000',
      allowNegative: false,
    }],
    primaryCustodianId: fixture.primaryUserId,
    capabilities: { receive: true, pay: true, transfer: true },
    requiresApproval: false,
  };
}

async function seed(database: DatabaseService) {
  await cleanup(database);
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    const organization = await client.query<{ id: string }>(`
      INSERT INTO organizations (code, legal_name, timezone, base_currency)
      VALUES ('CASHBOX', 'Cashbox Test', 'UTC', 'USD')
      RETURNING id
    `);
    const organizationId = organization.rows[0]!.id;
    await client.query(`
      INSERT INTO currencies (
        organization_id, code, name, decimal_places, base_currency
      ) VALUES ($1, 'USD', 'US Dollar', 2, true)
    `, [organizationId]);
    const branch = await client.query<{ id: string }>(`
      INSERT INTO branches (organization_id, code, name)
      VALUES ($1, 'HQ', 'Headquarters') RETURNING id
    `, [organizationId]);
    const unit = await client.query<{ id: string }>(`
      INSERT INTO treasury_units (
        organization_id, branch_id, code, name, default_currency
      ) VALUES ($1,$2,'TREASURY','Treasury','USD') RETURNING id
    `, [organizationId, branch.rows[0]!.id]);
    const users = await client.query<{ id: string; subject_key: string }>(`
      INSERT INTO user_refs (organization_id, subject_key, display_name)
      VALUES
        ($1, 'primary', 'Primary'),
        ($1, 'incoming', 'Incoming'),
        ($1, 'other', 'Other'),
        ($1, 'scoped', 'Scoped')
      RETURNING id, subject_key
    `, [organizationId]);
    const userId = new Map(users.rows.map((user) => [user.subject_key, user.id]));
    const role = await client.query<{ id: string }>(`
      INSERT INTO roles (organization_id, code, name)
      VALUES ($1, 'CASHBOX_TEST', 'Cashbox Test') RETURNING id
    `, [organizationId]);
    await client.query(`
      INSERT INTO role_permissions (role_id, permission)
      VALUES ($1, 'cashbox.view'), ($1, 'cashbox.manage'), ($1, 'cashbox.handover')
    `, [role.rows[0]!.id]);
    let primaryGrantId = '';
    for (const subject of ['primary', 'other']) {
      const grant = await client.query<{ id: string }>(`
        INSERT INTO access_grants (
          organization_id, user_ref_id, role_id, scope_id
        ) VALUES ($1,$2,$3,$1)
        RETURNING id
      `, [organizationId, userId.get(subject), role.rows[0]!.id]);
      if (subject === 'primary') primaryGrantId = grant.rows[0]!.id;
    }
    const otherBranch = await client.query<{ id: string }>(`
      INSERT INTO branches (organization_id, code, name)
      VALUES ($1, 'OTHER', 'Other Branch') RETURNING id
    `, [organizationId]);
    const scopedGrant = await client.query<{ id: string }>(`
      INSERT INTO access_grants (
        organization_id, user_ref_id, role_id, scope_id
      ) VALUES ($1,$2,$3,$1)
      RETURNING id
    `, [organizationId, userId.get('scoped'), role.rows[0]!.id]);
    await client.query(`
      INSERT INTO access_grant_branch_scopes (access_grant_id, branch_id)
      VALUES ($1,$2)
    `, [scopedGrant.rows[0]!.id, otherBranch.rows[0]!.id]);
    await client.query('COMMIT');
    return {
      organizationId,
      branchId: branch.rows[0]!.id,
      treasuryUnitId: unit.rows[0]!.id,
      primaryUserId: userId.get('primary')!,
      incomingUserId: userId.get('incoming')!,
      otherUserId: userId.get('other')!,
      scopedUserId: userId.get('scoped')!,
      primaryGrantId,
      otherBranchId: otherBranch.rows[0]!.id,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function cleanup(database: DatabaseService): Promise<void> {
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    for (const table of [
      'cashbox_handover_instruments',
      'cashbox_handover_money',
      'cashbox_handovers',
      'cashbox_assignments',
      'auth_step_up_proofs',
      'auth_challenges',
      'auth_sessions',
      'security_audit_events',
      'auth_password_attempt_reservations',
      'auth_throttle_buckets',
      'auth_recovery_attempts',
      'access_grant_cashbox_scopes',
      'cashbox_currency_controls',
      'cashboxes',
      'access_grant_currency_scopes',
      'access_grant_method_category_scopes',
      'access_grant_document_type_scopes',
      'access_grant_bank_account_scopes',
      'access_grant_treasury_unit_scopes',
      'access_grant_branch_scopes',
      'access_grants',
      'role_permissions',
      'identity_accounts',
      'roles',
      'idempotency_records',
      'party_kinds',
      'parties',
      'method_amount_limits',
      'method_allowed_currencies',
      'method_required_references',
      'method_mappings',
      'method_definitions',
      'user_refs',
      'treasury_units',
      'branches',
      'currencies',
      'organizations',
    ]) await client.query(`DELETE FROM ${table}`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function problem(error: unknown, code: string, status: number): boolean {
  return error instanceof TreasuryProblem
    && error.getStatus() === status
    && (error.getResponse() as { code?: string }).code === code;
}
