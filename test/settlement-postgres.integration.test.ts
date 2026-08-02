import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { AccessAuthorizationRepository } from '../src/access-control/access-authorization.repository';
import { AccessAuthorizationService } from '../src/access-control/access-authorization.service';
import { TreasuryProblem } from '../src/common/problem';
import { DatabaseService } from '../src/database/database.service';
import {
  FoundationEffectsRepository,
  FoundationEffectsService,
} from '../src/foundation-effects/foundation-effects.service';
import {
  SettlementCreateDto,
  SettlementDiscrepancyDisposition,
  SettlementMatchKind,
} from '../src/collection-and-settlement/settlement.dto';
import { SettlementRepository } from '../src/collection-and-settlement/settlement.repository';
import { SettlementService } from '../src/collection-and-settlement/settlement.service';

const connectionString = process.env.TEST_DATABASE_URL;

test('INC-4C preserves rollback, replay, stale, concurrency, credit, and reversal invariants', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = connectionString;
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 43).toString('base64');
  const database = new DatabaseService();
  const authorization = new AccessAuthorizationService(
    new AccessAuthorizationRepository(),
  );
  authorization.consumeStepUpProof = async () => true;
  const service = new SettlementService(
    database,
    new SettlementRepository(),
    authorization,
    new FoundationEffectsService(new FoundationEffectsRepository()),
  );
  try {
    const seeded = await seed(database);
    const body = proposal(seeded);

    const missingEvidenceKey = `settlement-missing-evidence-${seeded.suffix}`;
    await assert.rejects(service.create(
      seeded.organizationId,
      seeded.creatorId,
      { ...body, attachments: [{
        id: randomUUID(),
        contentDigest: 'b'.repeat(64),
        purpose: 'BANK_CREDIT_EVIDENCE',
      }] },
      missingEvidenceKey,
      'settlement-missing-evidence',
    ), isProblem('TRS-COL-006'));
    assert.equal(await count(database, `
      SELECT count(*) FROM idempotency_records
      WHERE organization_id = $1 AND idempotency_key = $2
    `, [seeded.organizationId, missingEvidenceKey]), 0);

    const deniedKey = `settlement-denied-${seeded.suffix}`;
    await assert.rejects(service.create(
      seeded.organizationId,
      seeded.deniedId,
      body,
      deniedKey,
      'settlement-denied',
    ), isProblem('TRS-GEN-003'));
    assert.equal(await count(database, `
      SELECT count(*) FROM idempotency_records
      WHERE organization_id = $1 AND idempotency_key = $2
    `, [seeded.organizationId, deniedKey]), 0);

    const createKey = `settlement-create-${seeded.suffix}`;
    const [created, createReplay] = await Promise.all([
      service.create(
        seeded.organizationId, seeded.creatorId, body, createKey, 'create-a',
      ),
      service.create(
        seeded.organizationId, seeded.creatorId, body, createKey, 'create-b',
      ),
    ]);
    assert.deepEqual(createReplay, created);
    assert.equal(created.state, 'MATCHED');
    assert.equal(created.allocations.length, 2);
    assert.equal(await count(database, `
      SELECT count(*) FROM movement_facts
      WHERE organization_id = $1 AND source_id = $2
    `, [seeded.organizationId, created.id]), 0);

    const staleKey = `settlement-confirm-stale-${seeded.suffix}`;
    await assert.rejects(service.confirm(command(
      seeded,
      seeded.confirmerId,
      created.id,
      staleKey,
      '"9"',
    )), isProblem('TRS-GEN-006'));
    assert.equal(await count(database, `
      SELECT count(*) FROM idempotency_records
      WHERE organization_id = $1 AND idempotency_key = $2
    `, [seeded.organizationId, staleKey]), 0);

    const confirmationKeys = [
      `settlement-confirm-a-${seeded.suffix}`,
      `settlement-confirm-b-${seeded.suffix}`,
    ];
    const confirmations = await Promise.allSettled(confirmationKeys.map((key) =>
      service.confirm(command(
        seeded, seeded.confirmerId, created.id, key, '"0"',
      )),
    ));
    const winner = confirmations.findIndex(({ status }) => status === 'fulfilled');
    const loser = confirmations.find(({ status }) => status === 'rejected');
    assert.notEqual(winner, -1);
    assert.equal(confirmations.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.ok(loser?.status === 'rejected' && (
      isProblem('TRS-GEN-005')(loser.reason) || isProblem('TRS-GEN-006')(loser.reason)
    ));
    const confirmed = (confirmations[winner] as PromiseFulfilledResult<
      Awaited<ReturnType<SettlementService['confirm']>>
    >).value;
    assert.equal(confirmed.state, 'CONFIRMED');
    assert.equal(confirmed.version, 1);
    assert.deepEqual(await service.confirm(command(
      seeded,
      seeded.confirmerId,
      created.id,
      confirmationKeys[winner]!,
      '"0"',
    )), confirmed);
    assert.equal(await count(database, `
      SELECT count(*) FROM movement_facts
      WHERE organization_id = $1 AND source_id = $2 AND direction = 'CREDIT'
    `, [seeded.organizationId, created.id]), 1);
    assert.deepEqual(await balances(database, seeded.itemIds), [
      { allocated: '60.00000000', remaining: '0.00000000', state: 'SETTLED' },
      { allocated: '40.00000000', remaining: '0.00000000', state: 'SETTLED' },
    ]);

    const reverseKey = `settlement-reverse-${seeded.suffix}`;
    const reverseContext = {
      ...command(
        seeded, seeded.reverserId, created.id, reverseKey, '"1"',
      ),
      stepUp: {
        proofId: 'inc-4c-proof',
        command: {
          operationId: 'reverseSettlementBatch',
          method: 'POST',
          path: `/v1/settlement-batches/${created.id}/reverse`,
          bodyDigest: 'inc-4c-body',
          idempotencyKey: reverseKey,
        },
      },
    };
    const reverseBody = {
      reason: 'Duplicate bank credit correction',
      businessDate: '2026-08-03',
    };
    const reversed = await service.reverse(reverseContext, reverseBody);
    assert.equal(reversed.original.state, 'REVERSED');
    assert.equal(reversed.reversal.state, 'REVERSAL');
    assert.deepEqual(await service.reverse(reverseContext, reverseBody), reversed);
    assert.deepEqual(await balances(database, seeded.itemIds), [
      { allocated: '0.00000000', remaining: '60.00000000', state: 'REOPENED_AFTER_REVERSAL' },
      { allocated: '0.00000000', remaining: '40.00000000', state: 'REOPENED_AFTER_REVERSAL' },
    ]);
    assert.equal(await count(database, `
      SELECT count(*) FROM movement_facts
      WHERE organization_id = $1
        AND (source_id = $2 OR source_id = $3)
    `, [seeded.organizationId, created.id, reversed.reversal.id]), 2);
    assert.equal(await count(database, `
      SELECT count(*) FROM settlement_effects
      WHERE organization_id = $1
        AND settlement_batch_id IN ($2, $3)
    `, [seeded.organizationId, created.id, reversed.reversal.id]), 6);
  } finally {
    await database.onModuleDestroy();
  }
});

interface Seeded {
  suffix: string;
  organizationId: string;
  creatorId: string;
  confirmerId: string;
  reverserId: string;
  deniedId: string;
  bankAccountId: string;
  itemIds: [string, string];
  itemVersions: [number, number];
  attachmentId: string;
  attachmentDigest: string;
  currency: string;
}

async function seed(database: DatabaseService): Promise<Seeded> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
  let organizationId: string = randomUUID();
  const branchId = randomUUID();
  const treasuryUnitId = randomUUID();
  const creatorId = randomUUID();
  const confirmerId = randomUUID();
  const reverserId = randomUUID();
  const deniedId = randomUUID();
  const partyId = randomUUID();
  const methodId = randomUUID();
  const bankTypeId = randomUUID();
  const bankId = randomUUID();
  const bankAccountId = randomUUID();
  const receiptId = randomUUID();
  const lineIds: [string, string] = [randomUUID(), randomUUID()];
  const itemIds: [string, string] = [randomUUID(), randomUUID()];
  const attachmentId = randomUUID();
  const attachmentDigest = suffix.toLowerCase().padEnd(64, 'a');
  let currency = 'IRR';
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query(`
      INSERT INTO organizations (id, code, legal_name, timezone, base_currency)
      VALUES ($1,$2,'INC-4C Gate Treasury','Asia/Tehran',$3)
      ON CONFLICT (singleton_key) DO NOTHING
    `, [organizationId, `S${suffix}`, currency]);
    const organization = await client.query<{ id: string; base_currency: string }>(`
      SELECT id, base_currency FROM organizations WHERE singleton_key
    `);
    organizationId = organization.rows[0].id;
    currency = organization.rows[0].base_currency;
    await client.query(`
      INSERT INTO currencies (organization_id, code, name, decimal_places, base_currency)
      VALUES ($1,$2,'Iranian rial',0,true)
      ON CONFLICT (organization_id, code) DO NOTHING
    `, [organizationId, currency]);
    await client.query(`
      INSERT INTO branches (id, organization_id, code, name)
      VALUES ($1,$2,$3,'INC-4C Branch')
    `, [branchId, organizationId, `B${suffix}`]);
    await client.query(`
      INSERT INTO treasury_units (id, organization_id, branch_id, code, name, default_currency)
      VALUES ($1,$2,$3,$4,'INC-4C Unit',$5)
    `, [treasuryUnitId, organizationId, branchId, `T${suffix}`, currency]);
    for (const [id, label] of [
      [creatorId, 'Settlement creator'],
      [confirmerId, 'Settlement confirmer'],
      [reverserId, 'Settlement reverser'],
      [deniedId, 'Settlement denied user'],
    ]) {
      await client.query(`
        INSERT INTO user_refs (id, organization_id, subject_key, display_name)
        VALUES ($1,$2,$3,$4)
      `, [id, organizationId, `${label}-${suffix}`, label]);
    }
    await client.query(`
      INSERT INTO parties (id, organization_id, code, display_name)
      VALUES ($1,$2,$3,'INC-4C Customer')
    `, [partyId, organizationId, `P${suffix}`]);
    await client.query(`
      INSERT INTO method_definitions (
        id, organization_id, code, name, direction, behavior_category,
        creates_funds_in_transit, requires_approval
      ) VALUES ($1,$2,$3,'Bank transfer','RECEIPT','BANK_TRANSFER',false,false)
    `, [methodId, organizationId, `M${suffix}`]);
    await client.query(`
      INSERT INTO bank_types (id, organization_id, code, display_name)
      VALUES ($1,$2,$3,'Commercial bank')
    `, [bankTypeId, organizationId, `BT${suffix}`]);
    await client.query(`
      INSERT INTO banks (id, organization_id, bank_type_id, code, display_name, country_code)
      VALUES ($1,$2,$3,$4,'INC-4C Bank','IR')
    `, [bankId, organizationId, bankTypeId, `BK${suffix}`]);
    await client.query(`
      INSERT INTO bank_accounts (
        id, organization_id, bank_id, treasury_unit_id, account_type,
        account_number, currency, legal_owner_name, opening_date,
        cheque_enabled, can_receive, can_pay, can_transfer, state
      ) VALUES ($1,$2,$3,$4,'CURRENT',$5,$6,'INC-4C Treasury','2026-01-01',false,true,true,true,'ACTIVE')
    `, [bankAccountId, organizationId, bankId, treasuryUnitId, `A${suffix}`, currency]);
    for (const [actorId, permission] of [
      [creatorId, 'settlement.create'],
      [confirmerId, 'settlement.confirm'],
      [reverserId, 'settlement.reverse'],
    ]) {
      const roleId = randomUUID();
      const grantId = randomUUID();
      await client.query(`
        INSERT INTO roles (id, organization_id, code, name)
        VALUES ($1,$2,$3,$4)
      `, [roleId, organizationId, `R${permission}-${suffix}`, permission]);
      await client.query(
        'INSERT INTO role_permissions (role_id, permission) VALUES ($1,$2)',
        [roleId, permission],
      );
      await client.query(`
        INSERT INTO access_grants (
          id, organization_id, user_ref_id, role_id, scope_type, scope_id,
          organization_wide, amount_ceiling, amount_ceiling_currency
        ) VALUES ($1,$2,$3,$4,'ORGANIZATION',$2,false,100,$5)
      `, [grantId, organizationId, actorId, roleId, currency]);
      await client.query(
        'INSERT INTO access_grant_branch_scopes (access_grant_id, branch_id) VALUES ($1,$2)',
        [grantId, branchId],
      );
      await client.query(
        'INSERT INTO access_grant_treasury_unit_scopes (access_grant_id, treasury_unit_id) VALUES ($1,$2)',
        [grantId, treasuryUnitId],
      );
      await client.query(
        'INSERT INTO access_grant_bank_account_scopes (access_grant_id, bank_account_id) VALUES ($1,$2)',
        [grantId, bankAccountId],
      );
      await client.query(
        'INSERT INTO access_grant_currency_scopes (access_grant_id, organization_id, currency) VALUES ($1,$2,$3)',
        [grantId, organizationId, currency],
      );
    }
    await client.query(`
      INSERT INTO receipt_documents (
        id, organization_id, business_number, business_date, entered_at,
        party_id, branch_id, treasury_unit_id, base_currency,
        total_base_amount, creator_user_id
      ) VALUES ($1,$2,$3,'2026-08-03',now(),$4,$5,$6,$7,100,$8)
    `, [receiptId, organizationId, `REC-${suffix}`, partyId, branchId, treasuryUnitId, currency, creatorId]);
    for (const [index, amount] of ['60', '40'].entries()) {
      await client.query(`
        INSERT INTO receipt_lines (
          id, organization_id, receipt_document_id, line_number, method_id,
          method_name, method_category, method_required_references,
          creates_funds_in_transit, requires_approval, amount, currency,
          base_currency, exchange_rate, rate_type, rate_source, rate_at,
          base_amount, rounding_difference, bank_account_id, remainder_treatment
        ) VALUES ($1,$2,$3,$4,$5,'Bank transfer','BANK_TRANSFER','[]',
          false,false,$6,$7,$7,1,'IDENTITY','IDENTITY',now(),$6,0,$8,'UNALLOCATED')
      `, [lineIds[index], organizationId, receiptId, index + 1, methodId, amount, currency, bankAccountId]);
      await client.query(`
        INSERT INTO collection_items (
          id, organization_id, source_fact_type, source_fact_id, branch_id,
          treasury_unit_id, channel_type, collected_party_id, gross_amount,
          currency, allocated_amount, remaining_amount,
          destination_bank_account_id, collected_at, expected_settlement_date,
          state, version
        ) VALUES ($1,$2,'RECEIPT_LINE',$3,$4,$5,'BANK_TRANSFER',$6,$7,$8,0,$7,$9,now(),'2026-08-03','OPEN',0)
      `, [itemIds[index], organizationId, lineIds[index], branchId, treasuryUnitId, partyId, amount, currency, bankAccountId]);
    }
    await client.query(`
      INSERT INTO attachments (
        id, organization_id, content_digest, attachment_version, file_name,
        media_type, byte_length, storage_ref, state, created_by
      ) VALUES ($1,$2,$3,1,'bank-credit.pdf','application/pdf',100,'local://inc-4c','ACTIVE',$4)
    `, [attachmentId, organizationId, attachmentDigest, creatorId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return {
    suffix,
    organizationId,
    creatorId,
    confirmerId,
    reverserId,
    deniedId,
    bankAccountId,
    itemIds,
    itemVersions: [0, 0],
    attachmentId,
    attachmentDigest,
    currency,
  };
}

function proposal(seed: Seeded): SettlementCreateDto {
  return {
    destinationBankAccountId: seed.bankAccountId,
    settlementDate: '2026-08-03',
    match: { kind: SettlementMatchKind.MANUAL, reason: 'Exact bank credit' },
    gross: { amount: '100', currency: seed.currency },
    fee: { amount: '0', currency: seed.currency },
    deduction: { amount: '0', currency: seed.currency },
    expectedNet: { amount: '100', currency: seed.currency },
    actualNet: { amount: '100', currency: seed.currency },
    discrepancy: { amount: '0', currency: seed.currency },
    discrepancyDisposition: SettlementDiscrepancyDisposition.NONE,
    allocations: seed.itemIds.map((collectionItemId, index) => ({
      collectionItemId,
      collectionItemVersion: seed.itemVersions[index]!,
      amount: { amount: index === 0 ? '60' : '40', currency: seed.currency },
    })),
    attachments: [{
      id: seed.attachmentId,
      contentDigest: seed.attachmentDigest,
      purpose: 'BANK_CREDIT_EVIDENCE',
    }],
  };
}

function command(
  seed: Seeded,
  actorUserId: string,
  batchId: string,
  key: string,
  ifMatch: string,
) {
  return {
    organizationId: seed.organizationId,
    actorUserId,
    physicalSessionId: `session-${seed.suffix}`,
    batchId,
    key,
    ifMatch,
    requestId: `request-${key}`,
  };
}

async function count(
  database: DatabaseService,
  query: string,
  values: unknown[],
): Promise<number> {
  const result = await database.pool.query<{ count: string }>(query, values);
  return Number(result.rows[0]!.count);
}

async function balances(database: DatabaseService, itemIds: string[]) {
  const result = await database.pool.query<{
    allocated: string;
    remaining: string;
    state: string;
  }>(`
    SELECT allocated_amount::text AS allocated,
           remaining_amount::text AS remaining,
           state
    FROM collection_items
    WHERE id = ANY($1::uuid[])
    ORDER BY gross_amount DESC
  `, [itemIds]);
  return result.rows;
}

function isProblem(code: string) {
  return (error: unknown) => error instanceof TreasuryProblem
    && (error.getResponse() as { code?: string }).code === code;
}
