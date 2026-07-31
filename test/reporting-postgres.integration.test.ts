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
    const {
      organizationId,
      actorUserId,
      restrictedActorUserId,
      visibleBankAccountId,
      hiddenBankAccountId,
      hiddenBankAccountNumber,
      partyId,
      projectRef,
      receiptBusinessNumber,
      chequeCollectionItemId,
      chequeEventId,
      receivedChequeNumber,
    } = await seedReportFixture(database);
    const before = await counts(database);
    const itemCounts = new Map<string, number>();
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
        { limit: '5', partyId },
      );
      assert.equal(page.reportKey, reportKey);
      assert.equal(page.freshness, 'READ_AFTER_WRITE');
      assert.ok(page.organization.label);
      assert.ok(page.appliedAuthorizationScope.length > 0);
      itemCounts.set(reportKey, page.items.length);
      if (reportKey === 'receipts') {
        const item = page.items[0];
        assert.equal(item?.kind, 'RECEIPT');
        if (item?.kind === 'RECEIPT') {
          assert.equal(item.source.label, `Receipt ${receiptBusinessNumber} · line 1`);
          assert.equal(Number(item.original.amount), 100);
          assert.ok(item.party.label);
          assert.ok(item.currency.label);
          assert.equal(item.project?.id, projectRef);
          assert.equal(item.project?.label, 'Project');
          assert.notEqual(item.project?.label, item.project?.id);
        }
      }
      if (reportKey === 'funds-in-transit') {
        const item = page.items.find(({ source }) => source.id === chequeCollectionItemId);
        assert.equal(item?.kind, 'FUNDS_IN_TRANSIT');
        if (item?.kind === 'FUNDS_IN_TRANSIT') {
          assert.equal(item.source.label, `Received cheque ${receivedChequeNumber}`);
          assert.doesNotMatch(item.source.label, /[0-9a-f]{8}-[0-9a-f-]{27,}/iu);
          assert.ok(!item.source.label.includes(chequeEventId));
        }
      }
    }
    assert.ok((itemCounts.get('receipts') ?? 0) > 0);
    assert.ok((itemCounts.get('received-cheques') ?? 0) > 0);
    assert.ok((itemCounts.get('funds-in-transit') ?? 0) > 0);
    assert.equal(itemCounts.get('issued-cheques'), 0);
    await assert.rejects(
      service.run(organizationId, randomUUID(), 'receipts', {}),
      (error) => error instanceof TreasuryProblem
        && error.getStatus() === 403
        && (error.getResponse() as { code?: string }).code === 'TRS-GEN-003',
    );
    const scopedPage = await service.run(
      organizationId,
      restrictedActorUserId,
      'receipts',
      { bankAccountId: visibleBankAccountId },
    );
    assert.ok(scopedPage.items.length > 0);
    await assert.rejects(
      service.run(
        organizationId,
        restrictedActorUserId,
        'receipts',
        { bankAccountId: hiddenBankAccountId },
      ),
      (error) => {
        if (!(error instanceof TreasuryProblem)) return false;
        const response = JSON.stringify(error.getResponse());
        return error.getStatus() === 403
          && (error.getResponse() as { code?: string }).code === 'TRS-GEN-003'
          && !response.includes(hiddenBankAccountId)
          && !response.includes(hiddenBankAccountNumber);
      },
    );
    assert.deepEqual(await counts(database), before);

    const repository = new ReportingRepository(database);
    const watermarkBefore = await repository.sourceWatermark('receipts', organizationId);
    await database.pool.query(
      'UPDATE parties SET display_name = $1 WHERE organization_id = $2 AND id = $3',
      ['QA customer updated', organizationId, partyId],
    );
    const watermarkAfter = await repository.sourceWatermark('receipts', organizationId);
    assert.notEqual(watermarkAfter, watermarkBefore);
  } finally {
    await database.onModuleDestroy();
  }
});

async function seedReportFixture(database: DatabaseService): Promise<{
  organizationId: string;
  actorUserId: string;
  restrictedActorUserId: string;
  visibleBankAccountId: string;
  hiddenBankAccountId: string;
  hiddenBankAccountNumber: string;
  partyId: string;
  projectRef: string;
  receiptBusinessNumber: string;
  chequeCollectionItemId: string;
  chequeEventId: string;
  receivedChequeNumber: string;
}> {
  const fixtureKey = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
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
  const restrictedUserId = randomUUID();
  const restrictedGrantId = randomUUID();
  const receiptId = randomUUID();
  const lineId = randomUUID();
  const receivedChequeId = randomUUID();
  const collectionItemId = randomUUID();
  const chequeCollectionItemId = randomUUID();
  const chequeEventId = randomUUID();
  const hiddenBankAccountId = randomUUID();
  const projectRef = randomUUID();
  const visibleBankAccountNumber = `RPT-${fixtureKey}`;
  const hiddenBankAccountNumber = `HID-${fixtureKey}`;
  const receiptBusinessNumber = `RPT-${fixtureKey}`;
  const receivedChequeNumber = `RCH-${fixtureKey}`;
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    const organization = await client.query<{
      id: string;
      base_currency: string;
    }>(`
      SELECT id, base_currency
      FROM organizations
      ORDER BY created_at, id
      LIMIT 1
    `);
    const owner = organization.rows[0];
    if (!owner) throw new Error('Singleton organization fixture is required.');
    const organizationId = owner.id;
    const baseCurrency = owner.base_currency;
    await client.query(`
      INSERT INTO branches (id, organization_id, code, name)
      VALUES ($1, $2, $3, 'INC-2E report branch')
    `, [branchId, organizationId, `RB-${fixtureKey}`]);
    await client.query(`
      INSERT INTO treasury_units (
        id, organization_id, branch_id, code, name, default_currency
      ) VALUES ($1, $2, $3, $4, 'INC-2E report treasury', $5)
    `, [treasuryUnitId, organizationId, branchId, `RT-${fixtureKey}`, baseCurrency]);
    await client.query(`
      INSERT INTO user_refs (id, organization_id, subject_key, display_name)
      VALUES ($1, $2, $3, 'INC-2E reporter')
    `, [userId, organizationId, `inc-2e-reporter-${fixtureKey}`]);
    await client.query(`
      INSERT INTO user_refs (id, organization_id, subject_key, display_name)
      VALUES ($1, $2, $3, 'INC-2E scoped reporter')
    `, [restrictedUserId, organizationId, `inc-2e-scoped-${fixtureKey}`]);
    await client.query(`
      INSERT INTO parties (id, organization_id, code, display_name)
      VALUES ($1, $2, $3, 'QA customer')
    `, [partyId, organizationId, `RC-${fixtureKey}`]);
    await client.query(`
      INSERT INTO method_definitions (
        id, organization_id, code, name, direction, behavior_category,
        creates_funds_in_transit, requires_approval
      ) VALUES ($1, $2, $3, 'Bank transfer', 'RECEIPT', 'BANK_TRANSFER', false, false)
    `, [methodId, organizationId, `RM-${fixtureKey}`]);
    await client.query(`
      INSERT INTO bank_types (id, organization_id, code, display_name)
      VALUES ($1, $2, $3, 'Commercial bank')
    `, [bankTypeId, organizationId, `RBT-${fixtureKey}`]);
    await client.query(`
      INSERT INTO banks (
        id, organization_id, bank_type_id, code, display_name, country_code
      ) VALUES ($1, $2, $3, $4, 'QA Bank', 'IR')
    `, [bankId, organizationId, bankTypeId, `RBK-${fixtureKey}`]);
    await client.query(`
      INSERT INTO bank_accounts (
        id, organization_id, bank_id, treasury_unit_id, account_type,
        account_number, currency, legal_owner_name, opening_date,
        cheque_enabled, can_receive, can_pay, can_transfer, state
      ) VALUES (
        $1, $2, $3, $4, 'CURRENT', $5, $6,
        'INC-2E QA Treasury', '2026-01-01', false, true, true, true, 'ACTIVE'
      )
    `, [
      bankAccountId,
      organizationId,
      bankId,
      treasuryUnitId,
      visibleBankAccountNumber,
      baseCurrency,
    ]);
    await client.query(`
      INSERT INTO bank_accounts (
        id, organization_id, bank_id, treasury_unit_id, account_type,
        account_number, currency, legal_owner_name, opening_date,
        cheque_enabled, can_receive, can_pay, can_transfer, state
      ) VALUES (
        $1, $2, $3, $4, 'CURRENT', $5, $6,
        'Hidden treasury account', '2026-01-01', false, true, true, true, 'ACTIVE'
      )
    `, [
      hiddenBankAccountId,
      organizationId,
      bankId,
      treasuryUnitId,
      hiddenBankAccountNumber,
      baseCurrency,
    ]);
    await client.query(`
      INSERT INTO roles (id, organization_id, code, name)
      VALUES ($1, $2, $3, 'Reporter')
    `, [roleId, organizationId, `RR-${fixtureKey}`]);
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
      INSERT INTO access_grants (
        id, organization_id, user_ref_id, role_id, scope_type, scope_id,
        organization_wide
      ) VALUES ($1, $2, $3, $4, 'ORGANIZATION', $5, false)
    `, [
      restrictedGrantId,
      organizationId,
      restrictedUserId,
      roleId,
      organizationId,
    ]);
    await client.query(`
      INSERT INTO access_grant_bank_account_scopes (
        access_grant_id, bank_account_id
      ) VALUES ($1, $2)
    `, [restrictedGrantId, bankAccountId]);
    await client.query(`
      INSERT INTO receipt_documents (
        id, organization_id, business_number, business_date, entered_at,
        party_id, branch_id, treasury_unit_id, base_currency, total_base_amount,
        project_ref, cost_center_ref, creator_user_id
      ) VALUES (
        $1, $2, $3, '2026-07-30', now(),
        $4, $5, $6, $8, 100, $9, $10, $7
      )
    `, [
      receiptId,
      organizationId,
      receiptBusinessNumber,
      partyId,
      branchId,
      treasuryUnitId,
      userId,
      baseCurrency,
      projectRef,
      `COST-${fixtureKey}`,
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
    await client.query(`
      INSERT INTO received_cheques (
        id, organization_id, receipt_line_id, issuer_bank_id, cheque_number,
        payer_party_id, amount, currency, receipt_date, due_date,
        custodian_type, custodian_id, state
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, 100, $7, '2026-07-30', '2026-08-15',
        'TREASURY_UNIT', $8, 'DEPOSITED'
      )
    `, [
      receivedChequeId,
      organizationId,
      lineId,
      bankId,
      receivedChequeNumber,
      partyId,
      baseCurrency,
      treasuryUnitId,
    ]);
    await client.query(`
      INSERT INTO receipt_execution_effects (
        id, organization_id, receipt_line_id, effect_key, effect_type,
        direction, amount, currency, business_date, source_version,
        received_cheque_id
      ) VALUES (
        $1, $2, $3, 'received-cheque', 'RECEIVED_CHEQUE',
        'INCOMING', 100, $4, '2026-07-30', 1, $5
      )
    `, [randomUUID(), organizationId, lineId, baseCurrency, receivedChequeId]);
    await client.query(`
      INSERT INTO cheque_events (
        id, cheque_type, cheque_id, sequence_no, from_state, to_state,
        actor_user_id, occurred_at, idempotency_key
      ) VALUES (
        $1, 'RECEIVED', $2, 1, 'IN_CUSTODY', 'DEPOSITED',
        $3, now(), $4
      )
    `, [chequeEventId, receivedChequeId, userId, `deposit-${fixtureKey}`]);
    await client.query(`
      INSERT INTO collection_items (
        id, organization_id, source_fact_type, source_fact_id, branch_id,
        treasury_unit_id, channel_type, collected_party_id, gross_amount,
        currency, allocated_amount, remaining_amount,
        destination_bank_account_id, collected_at, expected_settlement_date,
        state
      ) VALUES (
        $1, $2, 'RECEIPT_LINE', $3, $4,
        $5, 'BANK_TRANSFER', $6, 100,
        $7, 0, 100,
        $8, now(), '2026-08-01',
        'OPEN'
      )
    `, [
      collectionItemId,
      organizationId,
      lineId,
      branchId,
      treasuryUnitId,
      partyId,
      baseCurrency,
      bankAccountId,
    ]);
    await client.query(`
      INSERT INTO receipt_execution_effects (
        id, organization_id, receipt_line_id, effect_key, effect_type,
        direction, amount, currency, business_date, source_version,
        collection_item_id
      ) VALUES (
        $1, $2, $3, 'collection-item', 'COLLECTION_ITEM',
        'INCOMING', 100, $4, '2026-07-30', 1, $5
      )
    `, [randomUUID(), organizationId, lineId, baseCurrency, collectionItemId]);
    await client.query(`
      INSERT INTO collection_items (
        id, organization_id, source_fact_type, source_fact_id, branch_id,
        treasury_unit_id, channel_type, collected_party_id, gross_amount,
        currency, allocated_amount, remaining_amount,
        destination_bank_account_id, collected_at, expected_settlement_date,
        state
      ) VALUES (
        $1, $2, 'CHEQUE_EVENT', $3, $4,
        $5, 'DEPOSITED_CHEQUE', $6, 100,
        $7, 0, 100,
        $8, now(), '2026-08-02',
        'OPEN'
      )
    `, [
      chequeCollectionItemId,
      organizationId,
      chequeEventId,
      branchId,
      treasuryUnitId,
      partyId,
      baseCurrency,
      bankAccountId,
    ]);
    await client.query('COMMIT');
    return {
      organizationId,
      actorUserId: userId,
      restrictedActorUserId: restrictedUserId,
      visibleBankAccountId: bankAccountId,
      hiddenBankAccountId,
      hiddenBankAccountNumber,
      partyId,
      projectRef,
      receiptBusinessNumber,
      chequeCollectionItemId,
      chequeEventId,
      receivedChequeNumber,
    };
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
