import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { TreasuryProblem } from '../src/common/problem';
import { DatabaseService } from '../src/database/database.service';
import { ReportingRepository } from '../src/reporting/reporting.repository';
import { ReportingService } from '../src/reporting/reporting.service';

const connectionString = process.env.TEST_DATABASE_URL;

test('PostgreSQL operational reports execute typed owner queries without mutation', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async (t) => {
  process.env.DATABASE_URL = connectionString;
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 13).toString('base64');
  const database = new DatabaseService();
  const service = new ReportingService(new ReportingRepository(database));
  try {
    let actor = await reportActor(database);
    if (!actor) {
      await seedReportFixture(database);
      actor = await reportActor(database);
    }
    if (!actor) {
      t.skip('report fixture could not be established');
      return;
    }
    const { organization_id: organizationId, user_ref_id: actorUserId } = actor;
    const before = await counts(database);
    let receiptItemCount = 0;
    for (const reportKey of [
      'receipts',
      'received-cheques',
      'issued-cheques',
      'funds-in-transit',
    ]) {
      const page = await service.run(
        organizationId,
        actorUserId,
        reportKey,
        { limit: '5' },
      );
      assert.equal(page.reportKey, reportKey);
      assert.equal(page.freshness, 'READ_AFTER_WRITE');
      assert.ok(page.organization.label);
      assert.ok(page.appliedAuthorizationScope.length > 0);
      if (reportKey === 'receipts') {
        receiptItemCount = page.items.length;
        const item = page.items[0];
        assert.equal(item?.kind, 'RECEIPT');
        if (item?.kind === 'RECEIPT') {
          assert.equal(item.source.label, 'Receipt RPT-0001 · line 1');
          assert.equal(Number(item.original.amount), 100);
          assert.ok(item.party.label);
          assert.ok(item.currency.label);
        }
      }
    }
    assert.ok(receiptItemCount > 0);
    await assert.rejects(
      service.run(organizationId, randomUUID(), 'receipts', {}),
      (error) => error instanceof TreasuryProblem
        && error.getStatus() === 403
        && (error.getResponse() as { code?: string }).code === 'TRS-GEN-003',
    );
    assert.deepEqual(await counts(database), before);
  } finally {
    await database.onModuleDestroy();
  }
});

async function reportActor(database: DatabaseService) {
  const result = await database.pool.query<{
    organization_id: string;
    user_ref_id: string;
  }>(`
    SELECT access_grant.organization_id, access_grant.user_ref_id
    FROM access_grants AS access_grant
    JOIN roles AS role ON role.id = access_grant.role_id AND role.state = 'ACTIVE'
    JOIN role_permissions AS permission
      ON permission.role_id = role.id AND permission.permission = 'report.view'
    WHERE access_grant.state = 'ACTIVE'
      AND access_grant.valid_from <= now()
      AND (access_grant.valid_to IS NULL OR access_grant.valid_to > now())
      AND EXISTS (
        SELECT 1 FROM receipt_documents AS receipt
        WHERE receipt.organization_id = access_grant.organization_id
      )
    ORDER BY access_grant.organization_id, access_grant.user_ref_id
    LIMIT 1
  `);
  return result.rows[0];
}

async function seedReportFixture(database: DatabaseService): Promise<void> {
  const existing = await database.pool.query<{
    id: string;
    base_currency: string;
  }>('SELECT id, base_currency FROM organizations LIMIT 1');
  const organizationId = existing.rows[0]?.id ?? randomUUID();
  const baseCurrency = existing.rows[0]?.base_currency ?? 'IRR';
  const ids = Array.from({ length: 9 }, () => randomUUID());
  const [
    branchId,
    treasuryUnitId,
    userId,
    partyId,
    methodId,
    bankTypeId,
    bankId,
    bankAccountId,
    roleId,
  ] = ids as [string, string, string, string, string, string, string, string, string];
  const grantId = randomUUID();
  const receiptId = randomUUID();
  const lineId = randomUUID();
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    if (!existing.rows[0]) {
      await client.query(`
        INSERT INTO organizations (id, code, legal_name, timezone, base_currency)
        VALUES ($1, $2, 'INC-2E QA Treasury', 'Asia/Tehran', $3)
      `, [organizationId, `RPT-${organizationId.slice(0, 8)}`, baseCurrency]);
      await client.query(`
        INSERT INTO currencies (
          organization_id, code, name, decimal_places, base_currency
        ) VALUES ($1, $2, 'Iranian rial', 0, true)
      `, [organizationId, baseCurrency]);
    }
    await client.query(`
      INSERT INTO branches (id, organization_id, code, name)
      VALUES ($1, $2, 'HQ', 'Head office')
    `, [branchId, organizationId]);
    await client.query(`
      INSERT INTO treasury_units (
        id, organization_id, branch_id, code, name, default_currency
      ) VALUES ($1, $2, $3, 'MAIN', 'Main treasury', $4)
    `, [treasuryUnitId, organizationId, branchId, baseCurrency]);
    await client.query(`
      INSERT INTO user_refs (id, organization_id, subject_key, display_name)
      VALUES ($1, $2, 'inc-2e-reporter', 'INC-2E reporter')
    `, [userId, organizationId]);
    await client.query(`
      INSERT INTO parties (id, organization_id, code, display_name)
      VALUES ($1, $2, 'CUSTOMER', 'QA customer')
    `, [partyId, organizationId]);
    await client.query(`
      INSERT INTO method_definitions (
        id, organization_id, code, name, direction, behavior_category,
        creates_funds_in_transit, requires_approval
      ) VALUES ($1, $2, 'WIRE', 'Bank transfer', 'RECEIPT', 'BANK_TRANSFER', false, false)
    `, [methodId, organizationId]);
    await client.query(`
      INSERT INTO bank_types (id, organization_id, code, display_name)
      VALUES ($1, $2, 'COMMERCIAL', 'Commercial bank')
    `, [bankTypeId, organizationId]);
    await client.query(`
      INSERT INTO banks (
        id, organization_id, bank_type_id, code, display_name, country_code
      ) VALUES ($1, $2, $3, 'QA-BANK', 'QA Bank', 'IR')
    `, [bankId, organizationId, bankTypeId]);
    await client.query(`
      INSERT INTO bank_accounts (
        id, organization_id, bank_id, treasury_unit_id, account_type,
        account_number, currency, legal_owner_name, opening_date,
        cheque_enabled, can_receive, can_pay, can_transfer, state
      ) VALUES (
        $1, $2, $3, $4, 'CURRENT', 'QA-1001', $5,
        'INC-2E QA Treasury', '2026-01-01', false, true, true, true, 'ACTIVE'
      )
    `, [bankAccountId, organizationId, bankId, treasuryUnitId, baseCurrency]);
    await client.query(`
      INSERT INTO roles (id, organization_id, code, name)
      VALUES ($1, $2, 'REPORTER', 'Reporter')
    `, [roleId, organizationId]);
    await client.query(`
      INSERT INTO role_permissions (role_id, permission)
      VALUES ($1, 'report.view')
    `, [roleId]);
    await client.query(`
      INSERT INTO access_grants (
        id, organization_id, user_ref_id, role_id, scope_type, scope_id,
        organization_wide
      ) VALUES ($1, $2, $3, $4, 'ORGANIZATION', $2, true)
    `, [grantId, organizationId, userId, roleId]);
    await client.query(`
      INSERT INTO receipt_documents (
        id, organization_id, business_number, business_date, entered_at,
        party_id, branch_id, treasury_unit_id, base_currency, total_base_amount,
        project_ref, cost_center_ref, creator_user_id
      ) VALUES (
        $1, $2, 'RPT-0001', '2026-07-30', now(),
        $3, $4, $5, $7, 100, 'PROJECT-QA', 'COST-QA', $6
      )
    `, [
      receiptId,
      organizationId,
      partyId,
      branchId,
      treasuryUnitId,
      userId,
      baseCurrency,
    ]);
    await client.query(`
      INSERT INTO receipt_lines (
        id, organization_id, receipt_document_id, line_number, method_id,
        method_name, method_category, method_required_references,
        creates_funds_in_transit, requires_approval, amount, currency,
        base_currency, exchange_rate, rate_type, rate_source, rate_at,
        base_amount, rounding_difference, bank_account_id, remainder_treatment
      ) VALUES (
        $1, $2, $3, 1, $4, 'Bank transfer', 'BANK_TRANSFER', '[]',
        false, false, 100, $6, $6, 1, 'IDENTITY', 'IDENTITY', now(),
        100, 0, $5, 'UNALLOCATED'
      )
    `, [lineId, organizationId, receiptId, methodId, bankAccountId, baseCurrency]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function counts(database: DatabaseService) {
  const result = await database.pool.query<{
    receipts: number;
    audit: number;
    outbox: number;
  }>(`
    SELECT
      (SELECT count(*)::int FROM receipt_documents) AS receipts,
      (SELECT count(*)::int FROM audit_events) AS audit,
      (SELECT count(*)::int FROM outbox_events) AS outbox
  `);
  return result.rows[0];
}
