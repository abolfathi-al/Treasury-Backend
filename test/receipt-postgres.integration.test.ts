import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { commandDigest, digest } from '../src/common/http';
import { DatabaseService } from '../src/database/database.service';
import { MethodBehaviorCategory, MethodReference } from '../src/master-data/master-data.dto';
import {
  ReceiptApprovalAction,
  ReceiptAllocationObjectType,
  ReceiptRemainderTreatment,
} from '../src/receipts/receipt.dto';
import { ReceiptApprovalRepository } from '../src/receipts/receipt-approval.repository';
import { ReceiptApprovalService } from '../src/receipts/receipt-approval.service';
import { ReceiptRepository } from '../src/receipts/receipt.repository';
import { ReceiptService } from '../src/receipts/receipt.service';
import { TreasuryProblem } from '../src/common/problem';
import { AccessAuthorizationRepository } from '../src/access-control/access-authorization.repository';
import { AccessAuthorizationService } from '../src/access-control/access-authorization.service';
import {
  ReceiptBankingEffectsRepository,
  ReceiptBankingEffectsService,
} from '../src/banking/receipt-banking-effects.service';
import {
  ReceiptCashboxEffectsRepository,
  ReceiptCashboxEffectsService,
} from '../src/cashbox-and-custody/receipt-cashbox-effects.service';
import {
  ReceiptChequeEffectsRepository,
  ReceiptChequeEffectsService,
} from '../src/cheques/receipt-cheque-effects.service';
import {
  CollectionEffectsRepository,
  CollectionEffectsService,
} from '../src/collection-and-settlement/collection-effects.service';
import {
  FoundationEffectsRepository,
  FoundationEffectsService,
} from '../src/foundation-effects/foundation-effects.service';
import { ReceiptExecutionRepository } from '../src/receipts/receipt-execution.repository';
import { ReceiptExecutionService } from '../src/receipts/receipt-execution.service';

const connectionString = process.env.TEST_DATABASE_URL;
const receiptBusinessDate = '2026-07-28';

test('Receipt draft create/read/replace is semantic, idempotent, versioned, and DB-guarded', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = connectionString;
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 22).toString('base64');
  const database = new DatabaseService();
  const seeded = await seedReceiptFoundation(database);
    const service = new ReceiptService(new ReceiptRepository(database));
    const approvalService = new ReceiptApprovalService(
      database,
      new ReceiptApprovalRepository(),
      new ReceiptRepository(database),
    );
  try {
    const draft = {
      businessDate: receiptBusinessDate,
      partyId: seeded.partyId,
      treasuryUnitId: seeded.treasuryUnitId,
      baseCurrency: seeded.baseCurrency,
      purpose: 'دریافت وجه از مشتری',
      lines: [{
        lineNumber: 1,
        methodId: seeded.methodId,
        money: { amount: '125000', currency: seeded.baseCurrency },
        cashboxId: seeded.cashboxId,
        allocations: [{
          externalObjectType: ReceiptAllocationObjectType.INVOICE,
          externalObjectId: 'INV-1405-001',
          baseMoney: { amount: '25000', currency: seeded.baseCurrency },
        }],
        remainderTreatment: ReceiptRemainderTreatment.UNALLOCATED,
      }],
    };
    await database.pool.query(`
      INSERT INTO idempotency_records (
        organization_id, scope, idempotency_key, request_digest
      ) VALUES ($1,$2,'receipt-incomplete-key',$3)
    `, [
      seeded.organizationId,
      `createReceipt:${seeded.actorId}`,
      '0'.repeat(64),
    ]);
    await assert.rejects(
      service.create(
        seeded.organizationId,
        seeded.actorId,
        draft,
        'receipt-incomplete-key',
        'receipt-incomplete-request',
      ),
      (error: unknown) => error instanceof TreasuryProblem
        && (error.getResponse() as { code?: string }).code === 'TRS-GEN-007',
    );
    const created = await service.create(
      seeded.organizationId,
      seeded.actorId,
      draft,
      'receipt-create-key',
      'receipt-create-request',
    );
    assert.match(created.businessNumber, /^RCP-20260728-[0-9]{6}$/u);
    assert.equal(created.origin, 'MANUAL');
    assert.equal(created.totalBaseAmount.amount, '125000.00000000');
    assert.equal(created.lines[0]!.rateSnapshot.rateSource, 'IDENTITY');
    assert.equal(created.lines[0]!.rateSnapshot.rate, '1.000000000000000000');
    assert.equal(created.party.label, 'مشتری آزمون دریافت');
    assert.equal(created.lines[0]!.cashbox?.label, 'صندوق اصلی');
    await assert.rejects(
      service.create(
        seeded.organizationId,
        seeded.actorId,
        {
          ...draft,
          lines: [{ ...draft.lines[0]!, methodId: randomUUID() }],
        },
        'receipt-create-key',
        'receipt-create-request-changed',
      ),
      (error: unknown) => error instanceof TreasuryProblem
        && (error.getResponse() as { code?: string }).code === 'TRS-GEN-007',
    );
    assert.deepEqual(
      await service.create(
        seeded.organizationId,
        seeded.actorId,
        draft,
        'receipt-create-key',
        'receipt-create-request',
      ),
      created,
    );
    const anchorlessDraft = {
      ...draft,
      purpose: 'دریافت بدون ابزار صندوق یا حساب بانکی',
      lines: [{
        lineNumber: 1,
        methodId: seeded.anchorlessMethodId,
        money: { amount: '1000', currency: seeded.baseCurrency },
        remainderTreatment: ReceiptRemainderTreatment.UNALLOCATED,
      }],
    };
    const anchorlessCreated = await service.create(
      seeded.organizationId,
      seeded.actorId,
      anchorlessDraft,
      'receipt-anchorless-key',
      'receipt-anchorless-request',
    );
    await database.pool.query(`
      INSERT INTO access_grant_branch_scopes (access_grant_id, branch_id)
      VALUES ($1,$2)
    `, [seeded.grantId, seeded.branchId]);
    await assert.rejects(
      service.create(
        seeded.organizationId,
        seeded.actorId,
        draft,
        'receipt-branchless-denied',
        'receipt-branchless-denied-request',
      ),
      (error: unknown) => error instanceof TreasuryProblem
        && (error.getResponse() as { code?: string }).code === 'TRS-GEN-003',
    );
    await assert.rejects(
      service.get(seeded.organizationId, seeded.actorId, created.id),
      (error: unknown) => error instanceof TreasuryProblem
        && (error.getResponse() as { code?: string }).code === 'TRS-GEN-004',
    );
    await assert.rejects(
      service.create(
        seeded.organizationId,
        seeded.actorId,
        draft,
        'receipt-create-key',
        'receipt-create-request',
      ),
      (error: unknown) => error instanceof TreasuryProblem
        && (error.getResponse() as { code?: string }).code === 'TRS-GEN-003',
    );
    assert.deepEqual((await service.list(
      seeded.organizationId,
      seeded.actorId,
      '10',
    )).items, []);
    await database.pool.query(
      `DELETE FROM access_grant_branch_scopes WHERE access_grant_id = $1`,
      [seeded.grantId],
    );
    await database.pool.query(`
      INSERT INTO access_grant_cashbox_scopes (access_grant_id, cashbox_id)
      VALUES ($1,$2)
    `, [seeded.grantId, seeded.cashboxId]);
    await assert.rejects(
      service.create(
        seeded.organizationId,
        seeded.actorId,
        anchorlessDraft,
        'receipt-cashbox-scope-empty',
        'receipt-cashbox-scope-empty-request',
      ),
      (error: unknown) => error instanceof TreasuryProblem
        && (error.getResponse() as { code?: string }).code === 'TRS-GEN-003',
    );
    await assert.rejects(
      service.create(
        seeded.organizationId,
        seeded.actorId,
        anchorlessDraft,
        'receipt-anchorless-key',
        'receipt-anchorless-request',
      ),
      (error: unknown) => error instanceof TreasuryProblem
        && (error.getResponse() as { code?: string }).code === 'TRS-GEN-003',
    );
    await assert.rejects(
      service.get(seeded.organizationId, seeded.actorId, anchorlessCreated.id),
      (error: unknown) => error instanceof TreasuryProblem
        && (error.getResponse() as { code?: string }).code === 'TRS-GEN-004',
    );
    assert.deepEqual(
      (await service.list(seeded.organizationId, seeded.actorId, '10')).items
        .map(({ id }) => id),
      [created.id],
    );
    await database.pool.query(
      `DELETE FROM access_grant_cashbox_scopes WHERE access_grant_id = $1`,
      [seeded.grantId],
    );
    await database.pool.query(`
      INSERT INTO access_grant_bank_account_scopes (access_grant_id, bank_account_id)
      VALUES ($1,$2)
    `, [seeded.grantId, seeded.bankAccountId]);
    await assert.rejects(
      service.create(
        seeded.organizationId,
        seeded.actorId,
        anchorlessDraft,
        'receipt-account-scope-empty',
        'receipt-account-scope-empty-request',
      ),
      (error: unknown) => error instanceof TreasuryProblem
        && (error.getResponse() as { code?: string }).code === 'TRS-GEN-003',
    );
    await assert.rejects(
      service.create(
        seeded.organizationId,
        seeded.actorId,
        anchorlessDraft,
        'receipt-anchorless-key',
        'receipt-anchorless-request',
      ),
      (error: unknown) => error instanceof TreasuryProblem
        && (error.getResponse() as { code?: string }).code === 'TRS-GEN-003',
    );
    await assert.rejects(
      service.get(seeded.organizationId, seeded.actorId, anchorlessCreated.id),
      (error: unknown) => error instanceof TreasuryProblem
        && (error.getResponse() as { code?: string }).code === 'TRS-GEN-004',
    );
    assert.deepEqual(
      (await service.list(seeded.organizationId, seeded.actorId, '10')).items,
      [],
    );
    await database.pool.query(
      `DELETE FROM access_grant_bank_account_scopes WHERE access_grant_id = $1`,
      [seeded.grantId],
    );
    await database.pool.query(
      `UPDATE method_definitions SET state = 'INACTIVE' WHERE id = $1`,
      [seeded.methodId],
    );
    assert.deepEqual(
      await service.create(
        seeded.organizationId,
        seeded.actorId,
        draft,
        'receipt-create-key',
        'receipt-create-request',
      ),
      created,
    );
    await database.pool.query(
      `UPDATE method_definitions SET state = 'ACTIVE' WHERE id = $1`,
      [seeded.methodId],
    );

    const fetched = await service.get(seeded.organizationId, seeded.actorId, created.id);
    assert.deepEqual(fetched, created);
    assert.deepEqual(
      new Set((await service.list(
        seeded.organizationId,
        seeded.actorId,
        '10',
      )).items.map(({ id }) => id)),
      new Set([created.id, anchorlessCreated.id]),
    );
    assert.deepEqual((await service.list(
      randomUUID(),
      seeded.actorId,
      '10',
    )).items, []);
    await assert.rejects(
      service.get(randomUUID(), seeded.actorId, created.id),
      (error: unknown) => error instanceof TreasuryProblem
        && (error.getResponse() as { code?: string }).code === 'TRS-GEN-004',
    );

    const foreignDraft = {
      ...draft,
      lines: [{
        ...draft.lines[0]!,
        money: { amount: '2', currency: seeded.foreignCurrency },
        allocations: [],
      }],
    };
    await assert.rejects(
      service.create(
        seeded.organizationId,
        seeded.actorId,
        {
          ...draft,
          lines: [{
            lineNumber: 1,
            methodId: seeded.invalidMethodId,
            money: { amount: '1', currency: seeded.baseCurrency },
            remainderTreatment: ReceiptRemainderTreatment.UNALLOCATED,
          }],
        },
        'receipt-other-controlled-invalid',
        'receipt-other-controlled-invalid-request',
      ),
      (error: unknown) => error instanceof TreasuryProblem
        && (error.getResponse() as { code?: string }).code === 'TRS-MST-004',
    );
    await assert.rejects(
      service.create(
        seeded.organizationId,
        seeded.actorId,
        foreignDraft,
        'receipt-rate-missing',
        'receipt-rate-missing-request',
      ),
      (error: unknown) => error instanceof TreasuryProblem
        && (error.getResponse() as { code?: string }).code === 'TRS-MST-003',
    );
    const rateIds = [randomUUID(), randomUUID()];
    await database.pool.query(`
      INSERT INTO exchange_rates (
        id, source_currency, target_currency, rate_type, rate, valid_at,
        source_name, recorded_by, approved_by, state
      ) VALUES
        ($1,$3,$5,'MARKET',42000,'2026-07-01T00:00:00Z','SOURCE-A',$4,$4,'APPROVED'),
        ($2,$3,$5,'MARKET',42000,'2026-07-01T00:00:00Z','SOURCE-B',$4,$4,'APPROVED')
    `, [
      rateIds[0],
      rateIds[1],
      seeded.foreignCurrency,
      seeded.actorId,
      seeded.baseCurrency,
    ]);
    await assert.rejects(
      service.create(
        seeded.organizationId,
        seeded.actorId,
        foreignDraft,
        'receipt-rate-ambiguous',
        'receipt-rate-ambiguous-request',
      ),
      (error: unknown) => error instanceof TreasuryProblem
        && (error.getResponse() as { code?: string }).code === 'TRS-MST-003',
    );
    await database.pool.query(
      `UPDATE exchange_rates SET state = 'RETIRED' WHERE id = $1`,
      [rateIds[1]],
    );
    const foreignCreated = await service.create(
      seeded.organizationId,
      seeded.actorId,
      foreignDraft,
      'receipt-rate-approved',
      'receipt-rate-approved-request',
    );
    assert.equal(foreignCreated.lines[0]!.rateSnapshot.rateSource, 'TABLE');
    assert.equal(foreignCreated.lines[0]!.rateSnapshot.rateRecordId, rateIds[0]);
    assert.equal(foreignCreated.lines[0]!.baseAmount.amount, '84000.00000000');
    await database.pool.query(
      `UPDATE exchange_rates SET rate = 42000.000000000000000001 WHERE id = $1`,
      [rateIds[0]],
    );
    assert.deepEqual(
      await service.create(
        seeded.organizationId,
        seeded.actorId,
        foreignDraft,
        'receipt-rate-approved',
        'receipt-rate-approved-request',
      ),
      foreignCreated,
    );
    await assert.rejects(
      approvalService.submit(
        seeded.organizationId,
        seeded.actorId,
        foreignCreated.id,
        'receipt-rate-submit',
        '"0"',
        'receipt-rate-submit-request',
      ),
      isProblemCode('TRS-MST-003'),
    );
    assert.equal(
      (await service.get(seeded.organizationId, seeded.actorId, foreignCreated.id)).version,
      0,
    );

    const changed = {
      ...draft,
      purpose: 'اصلاح پیش‌نویس دریافت',
      lines: [{
        ...draft.lines[0]!,
        money: { amount: '150000', currency: seeded.baseCurrency },
      }],
    };
    const attempts = await Promise.allSettled([
      service.replace(
        seeded.organizationId,
        seeded.actorId,
        created.id,
        changed,
        'receipt-replace-key-a',
        '"0"',
        'receipt-replace-a',
      ),
      service.replace(
        seeded.organizationId,
        seeded.actorId,
        created.id,
        changed,
        'receipt-replace-key-b',
        '"0"',
        'receipt-replace-b',
      ),
    ]);
    assert.equal(attempts.filter(({ status }) => status === 'fulfilled').length, 1);
    const rejected = attempts.find(({ status }) => status === 'rejected');
    assert.ok(rejected?.status === 'rejected');
    assert.ok(rejected.reason instanceof TreasuryProblem);
    assert.equal(
      (rejected.reason.getResponse() as { code: string }).code,
      'TRS-GEN-006',
    );
    const replaced = await service.get(seeded.organizationId, seeded.actorId, created.id);
    assert.equal(replaced.version, 1);
    assert.equal(replaced.totalBaseAmount.amount, '150000.00000000');
    const winningReplaceKey = attempts[0]!.status === 'fulfilled'
      ? 'receipt-replace-key-a'
      : 'receipt-replace-key-b';
    await database.pool.query(
      `UPDATE method_definitions SET state = 'INACTIVE' WHERE id = $1`,
      [seeded.methodId],
    );
    assert.deepEqual(
      await service.replace(
        seeded.organizationId,
        seeded.actorId,
        created.id,
        changed,
        winningReplaceKey,
        '"0"',
        'receipt-replace-replay',
      ),
      replaced,
    );
    await database.pool.query(
      `UPDATE method_definitions SET state = 'ACTIVE' WHERE id = $1`,
      [seeded.methodId],
    );

    const lineId = replaced.lines[0]!.id;
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        INSERT INTO receipt_allocations (
          organization_id, receipt_line_id, external_object_type,
          external_object_id, base_amount, base_currency
        ) VALUES ($1,$2,'DEBT','too-large',999999999,$3)
      `, [seeded.organizationId, lineId, seeded.baseCurrency]);
      await assert.rejects(
        client.query('COMMIT'),
        (error: unknown) => (error as { code?: string }).code === '23514',
      );
      await assert.rejects(
        client.query(`
          UPDATE receipt_lines
          SET cheque_input = jsonb_build_object('bankId', $1::text)
          WHERE id = $2
        `, [randomUUID(), lineId]),
        (error: unknown) => (error as { code?: string }).code === '23514',
      );
      await assert.rejects(
        client.query(`
          UPDATE receipt_lines
          SET cheque_bank_id = $1::uuid,
              cheque_input = jsonb_build_object('bankId', NULL)
          WHERE id = $2
        `, [seeded.bankId, lineId]),
        (error: unknown) => (error as { code?: string }).code === '23514',
      );
      await assert.rejects(
        client.query(`
          UPDATE receipt_lines
          SET cheque_bank_id = $1::uuid,
              cheque_bank_branch_id = $2::uuid,
              cheque_input = jsonb_build_object(
                'bankId', $1::text,
                'bankBranchId', NULL
              )
          WHERE id = $3
        `, [seeded.bankId, seeded.bankBranchId, lineId]),
        (error: unknown) => (error as { code?: string }).code === '23514',
      );
      await assert.rejects(
        client.query(`
          UPDATE receipt_lines
          SET cheque_bank_id = $1::uuid,
              cheque_payer_party_id = $2::uuid,
              cheque_input = jsonb_build_object(
                'bankId', $1::text,
                'payerPartyId', NULL
              )
          WHERE id = $3
        `, [seeded.bankId, seeded.partyId, lineId]),
        (error: unknown) => (error as { code?: string }).code === '23514',
      );
      await client.query('ROLLBACK');

      await assert.rejects(
        client.query(`
          UPDATE receipt_lines SET receipt_document_id = $1 WHERE id = $2
        `, [randomUUID(), lineId]),
        (error: unknown) => (error as { code?: string }).code === '23514',
      );
    } finally {
      client.release();
    }

    await database.pool.query(
      `DELETE FROM role_permissions WHERE role_id = $1 AND permission = 'receipt.submit'`,
      [seeded.roleId],
    );
    await assert.rejects(
      approvalService.submit(
        seeded.organizationId,
        seeded.actorId,
        replaced.id,
        'receipt-submit-denied',
        '"1"',
        'receipt-submit-denied-request',
      ),
      isProblemCode('TRS-GEN-003'),
    );
    await database.pool.query(
      `INSERT INTO role_permissions (role_id, permission) VALUES ($1,'receipt.submit')`,
      [seeded.roleId],
    );
    await assert.rejects(
      approvalService.submit(
        seeded.organizationId,
        seeded.actorId,
        replaced.id,
        'receipt-submit-stale',
        '"0"',
        'receipt-submit-stale-request',
      ),
      isProblemCode('TRS-GEN-006'),
    );
    await database.pool.query(
      `UPDATE cashboxes SET state = 'SUSPENDED' WHERE id = $1`,
      [seeded.cashboxId],
    );
    await assert.rejects(
      approvalService.submit(
        seeded.organizationId,
        seeded.actorId,
        replaced.id,
        'receipt-submit-inactive-destination',
        '"1"',
        'receipt-submit-inactive-destination-request',
      ),
      isProblemCode('TRS-MST-001'),
    );
    await database.pool.query(
      `UPDATE cashboxes SET state = 'ACTIVE' WHERE id = $1`,
      [seeded.cashboxId],
    );
    await database.pool.query(`
      UPDATE access_grants
      SET amount_ceiling = 1, amount_ceiling_currency = $2
      WHERE id = $1
    `, [seeded.grantId, seeded.baseCurrency]);
    await assert.rejects(
      approvalService.submit(
        seeded.organizationId,
        seeded.actorId,
        replaced.id,
        'receipt-submit-over-ceiling',
        '"1"',
        'receipt-submit-over-ceiling-request',
      ),
      isProblemCode('TRS-GEN-003'),
    );
    await database.pool.query(`
      UPDATE access_grants
      SET amount_ceiling = NULL, amount_ceiling_currency = NULL
      WHERE id = $1
    `, [seeded.grantId]);
    assert.equal(
      (await service.get(seeded.organizationId, seeded.actorId, replaced.id)).version,
      1,
    );
    const ambiguousPolicyId = randomUUID();
    await database.pool.query(`
      INSERT INTO receipt_approval_policies (
        id, organization_id, code, name, document_type,
        currency, method_category, version, state
      ) VALUES ($1,$2,$3,'Ambiguous cash approval','RECEIPT',$4,'CASH',1,'ACTIVE')
    `, [
      ambiguousPolicyId,
      seeded.organizationId,
      `RCP-AMB-${ambiguousPolicyId.slice(0, 8).toUpperCase()}`,
      seeded.baseCurrency,
    ]);
    await assert.rejects(
      approvalService.submit(
        seeded.organizationId,
        seeded.actorId,
        replaced.id,
        'receipt-submit-ambiguous',
        '"1"',
        'receipt-submit-ambiguous-request',
      ),
      isProblemCode('TRS-RCP-005'),
    );
    assert.equal(
      (await service.get(seeded.organizationId, seeded.actorId, replaced.id)).version,
      1,
    );
    await database.pool.query(
      'DELETE FROM receipt_approval_policies WHERE id = $1',
      [ambiguousPolicyId],
    );

    const submitted = await approvalService.submit(
      seeded.organizationId,
      seeded.actorId,
      replaced.id,
      'receipt-submit-key',
      '"1"',
      'receipt-submit-request',
    );
    assert.equal(submitted.state, 'APPROVAL_PENDING');
    assert.equal(submitted.version, 2);
    assert.equal(submitted.approvalSnapshot?.documentVersion, 2);
    assert.equal(submitted.approvalSnapshot?.steps[0]?.state, 'CURRENT');
    assert.equal(submitted.approvalSnapshot?.steps[1]?.state, 'WAITING');
    assert.equal(submitted.approvalSnapshot?.policyContexts[0]?.policy.label, 'Cash approval');
    assert.deepEqual(
      await approvalService.submit(
        seeded.organizationId,
        seeded.actorId,
        replaced.id,
        'receipt-submit-key',
        '"1"',
        'receipt-submit-replay',
      ),
      submitted,
    );
    await assert.rejects(
      approvalService.submit(
        seeded.organizationId,
        seeded.actorId,
        replaced.id,
        'receipt-submit-key',
        '"2"',
        'receipt-submit-conflict',
      ),
      isProblemCode('TRS-GEN-007'),
    );
    const approvalAttempts = await Promise.allSettled([
      approvalService.act(
        seeded.organizationId,
        seeded.actorId,
        replaced.id,
        { action: ReceiptApprovalAction.APPROVE },
        'receipt-approve-a',
        '"2"',
        'receipt-approve-a-request',
      ),
      approvalService.act(
        seeded.organizationId,
        seeded.actorId,
        replaced.id,
        { action: ReceiptApprovalAction.APPROVE },
        'receipt-approve-b',
        '"2"',
        'receipt-approve-b-request',
      ),
    ]);
    assert.equal(
      approvalAttempts.filter(({ status }) => status === 'fulfilled').length,
      1,
      approvalAttempts.map((attempt) => attempt.status === 'rejected'
        ? String(attempt.reason)
        : 'fulfilled').join(' | '),
    );
    const staleAttempt = approvalAttempts.find(({ status }) => status === 'rejected');
    assert.ok(staleAttempt?.status === 'rejected');
    assert.ok(isProblemCode('TRS-GEN-006')(staleAttempt.reason));
    const afterFirstApproval = await service.get(
      seeded.organizationId, seeded.actorId, replaced.id,
    );
    assert.equal(afterFirstApproval.state, 'APPROVAL_PENDING');
    assert.equal(afterFirstApproval.version, 3);
    assert.equal(afterFirstApproval.approvalSnapshot?.steps[0]?.state, 'APPROVED');
    assert.equal(afterFirstApproval.approvalSnapshot?.steps[1]?.state, 'CURRENT');
    const approved = await approvalService.act(
      seeded.organizationId,
      seeded.actorId,
      replaced.id,
      { action: ReceiptApprovalAction.APPROVE },
      'receipt-approve-second',
      '"3"',
      'receipt-approve-second-request',
    );
    assert.equal(approved.state, 'APPROVED');
    assert.equal(approved.version, 4);
    assert.equal(approved.approvalSnapshot?.documentVersion, 2);
    assert.equal(approved.approvalSnapshot?.steps[1]?.state, 'APPROVED');
    assert.equal(approved.approvalSnapshot?.actions[0]?.action, 'APPROVED');
    await assert.rejects(
      database.pool.query(
        `DELETE FROM receipt_approval_actions WHERE id = $1`,
        [approved.approvalSnapshot!.actions[0]!.id],
      ),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );

    const zeroStepDraft = await service.create(
      seeded.organizationId,
      seeded.actorId,
      {
        businessDate: receiptBusinessDate,
        partyId: seeded.partyId,
        treasuryUnitId: seeded.treasuryUnitId,
        baseCurrency: seeded.baseCurrency,
        lines: [{
          lineNumber: 1,
          methodId: seeded.anchorlessMethodId,
          money: { amount: '1000', currency: seeded.baseCurrency },
          remainderTreatment: ReceiptRemainderTreatment.UNALLOCATED,
        }],
      },
      'receipt-zero-create',
      'receipt-zero-create-request',
    );
    const zeroStepApproved = await approvalService.submit(
      seeded.organizationId,
      seeded.actorId,
      zeroStepDraft.id,
      'receipt-zero-submit',
      '"0"',
      'receipt-zero-submit-request',
    );
    assert.equal(zeroStepApproved.state, 'APPROVED');
    assert.deepEqual(zeroStepApproved.approvalSnapshot?.steps, []);
    const returned = await approvalService.act(
      seeded.organizationId,
      seeded.actorId,
      zeroStepDraft.id,
      { action: ReceiptApprovalAction.RETURN, reason: 'Correct the draft.' },
      'receipt-zero-return',
      '"1"',
      'receipt-zero-return-request',
    );
    assert.equal(returned.state, 'DRAFT');
    assert.equal(returned.version, 2);
    assert.equal(returned.approvalSnapshot, undefined);

    const rejectedDraft = await service.create(
      seeded.organizationId,
      seeded.actorId,
      {
        businessDate: receiptBusinessDate,
        partyId: seeded.partyId,
        treasuryUnitId: seeded.treasuryUnitId,
        baseCurrency: seeded.baseCurrency,
        lines: [{
          lineNumber: 1,
          methodId: seeded.methodId,
          money: { amount: '2000', currency: seeded.baseCurrency },
          cashboxId: seeded.cashboxId,
          remainderTreatment: ReceiptRemainderTreatment.UNALLOCATED,
        }],
      },
      'receipt-reject-create',
      'receipt-reject-create-request',
    );
    const rejectionPending = await approvalService.submit(
      seeded.organizationId,
      seeded.actorId,
      rejectedDraft.id,
      'receipt-reject-submit',
      '"0"',
      'receipt-reject-submit-request',
    );
    const rejectedReceipt = await approvalService.act(
      seeded.organizationId,
      seeded.actorId,
      rejectedDraft.id,
      { action: ReceiptApprovalAction.REJECT, reason: 'Evidence is insufficient.' },
      'receipt-reject-action',
      `"${rejectionPending.version}"`,
      'receipt-reject-action-request',
    );
    assert.equal(rejectedReceipt.state, 'REJECTED');
    assert.equal(rejectedReceipt.approvalSnapshot?.steps[0]?.state, 'REJECTED');
    assert.equal(rejectedReceipt.approvalSnapshot?.actions[0]?.reason, 'Evidence is insufficient.');

    const returnedStepDraft = await service.create(
      seeded.organizationId,
      seeded.actorId,
      {
        businessDate: receiptBusinessDate,
        partyId: seeded.partyId,
        treasuryUnitId: seeded.treasuryUnitId,
        baseCurrency: seeded.baseCurrency,
        lines: [{
          lineNumber: 1,
          methodId: seeded.methodId,
          money: { amount: '3000', currency: seeded.baseCurrency },
          cashboxId: seeded.cashboxId,
          remainderTreatment: ReceiptRemainderTreatment.UNALLOCATED,
        }],
      },
      'receipt-return-create',
      'receipt-return-create-request',
    );
    const returnPending = await approvalService.submit(
      seeded.organizationId,
      seeded.actorId,
      returnedStepDraft.id,
      'receipt-return-submit',
      '"0"',
      'receipt-return-submit-request',
    );
    const returnedStep = await approvalService.act(
      seeded.organizationId,
      seeded.actorId,
      returnedStepDraft.id,
      { action: ReceiptApprovalAction.RETURN, reason: 'Correct the evidence.' },
      'receipt-return-action',
      `"${returnPending.version}"`,
      'receipt-return-action-request',
    );
    assert.equal(returnedStep.state, 'DRAFT');
    assert.equal(returnedStep.approvalSnapshot, undefined);

    const mixedDraft = await service.create(
      seeded.organizationId,
      seeded.actorId,
      {
        businessDate: receiptBusinessDate,
        partyId: seeded.partyId,
        treasuryUnitId: seeded.treasuryUnitId,
        baseCurrency: seeded.baseCurrency,
        lines: [{
          lineNumber: 1,
          methodId: seeded.methodId,
          money: { amount: '4000', currency: seeded.baseCurrency },
          cashboxId: seeded.cashboxId,
          remainderTreatment: ReceiptRemainderTreatment.UNALLOCATED,
        }, {
          lineNumber: 2,
          methodId: seeded.anchorlessMethodId,
          money: { amount: '5000', currency: seeded.baseCurrency },
          remainderTreatment: ReceiptRemainderTreatment.UNALLOCATED,
        }],
      },
      'receipt-mixed-create',
      'receipt-mixed-create-request',
    );
    const mixed = await approvalService.submit(
      seeded.organizationId,
      seeded.actorId,
      mixedDraft.id,
      'receipt-mixed-submit',
      '"0"',
      'receipt-mixed-submit-request',
    );
    assert.equal(mixed.approvalSnapshot?.policyContexts.length, 2);
    assert.equal(mixed.approvalSnapshot?.steps.length, 2);
  } finally {
    await cleanupReceiptFoundation(database, seeded);
    await database.onModuleDestroy();
  }
});

test('Receipt execution is atomic, actor-idempotent, versioned and race-safe', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = connectionString;
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 22).toString('base64');
  const database = new DatabaseService();
  const seeded = await seedReceiptFoundation(database);
  const receipts = new ReceiptService(new ReceiptRepository(database));
  const authorization = new AccessAuthorizationService(
    new AccessAuthorizationRepository(),
  );
  const execution = new ReceiptExecutionService(
    database,
    new ReceiptExecutionRepository(),
    receipts,
    authorization,
    new ReceiptCashboxEffectsService(new ReceiptCashboxEffectsRepository()),
    new ReceiptBankingEffectsService(new ReceiptBankingEffectsRepository()),
    new ReceiptChequeEffectsService(new ReceiptChequeEffectsRepository()),
    new CollectionEffectsService(new CollectionEffectsRepository()),
    new FoundationEffectsService(new FoundationEffectsRepository()),
  );
  const executorId = randomUUID();
  const executorRoleId = randomUUID();
  const executorGrantId = randomUUID();
  const reverserId = randomUUID();
  const reverserRoleId = randomUUID();
  const reverserGrantId = randomUUID();
  const reverserAccountId = randomUUID();
  const reverserSessionId = randomUUID();
  const unscopedBankAccountId = randomUUID();
  const derivedPosTerminalId = randomUUID();
  const derivedGatewayId = randomUUID();
  let reversalReceiptId: string | undefined;
  const suffix = executorId.slice(0, 8).toUpperCase();
  try {
    await database.pool.query('UPDATE cashboxes SET active_from = $2 WHERE id = $1', [
      seeded.cashboxId,
      '2026-01-01',
    ]);
    await database.pool.query(`
      INSERT INTO user_refs (id, organization_id, subject_key, display_name)
      VALUES ($1,$2,$3,'Receipt executor')
    `, [executorId, seeded.organizationId, `executor-${suffix}`]);
    await database.pool.query(`
      INSERT INTO roles (id, organization_id, code, name)
      VALUES ($1,$2,$3,'Receipt execution role')
    `, [executorRoleId, seeded.organizationId, `EXEC-${suffix}`]);
    await database.pool.query(`
      INSERT INTO role_permissions (role_id, permission)
      VALUES ($1,'receipt.execute'),($1,'receipt.view')
    `, [executorRoleId]);
    await database.pool.query(`
      INSERT INTO user_refs (id, organization_id, subject_key, display_name)
      VALUES ($1,$2,$3,'Receipt reverser')
    `, [reverserId, seeded.organizationId, `reverser-${suffix}`]);
    await database.pool.query(`
      INSERT INTO roles (id, organization_id, code, name)
      VALUES ($1,$2,$3,'Receipt reversal role')
    `, [reverserRoleId, seeded.organizationId, `REVERSE-${suffix}`]);
    await database.pool.query(`
      INSERT INTO role_permissions (role_id, permission)
      VALUES ($1,'receipt.reverse'),($1,'receipt.view')
    `, [reverserRoleId]);
    await database.pool.query(`
      INSERT INTO identity_accounts (
        id, user_ref_id, normalized_login, password_hash, privileged
      ) VALUES ($1,$2,$3,'test-password-hash',false)
    `, [reverserAccountId, reverserId, `reverser.${suffix.toLowerCase()}`]);
    await database.pool.query(`
      INSERT INTO auth_sessions (
        id, identity_account_id, token_digest, xsrf_digest, authenticated_at,
        last_rotated_at, idle_expires_at, absolute_expires_at, assurance
      ) VALUES (
        $1,$2,$3,$4,now(),now(),now() + interval '15 minutes',
        now() + interval '8 hours','PASSWORD_TOTP'
      )
    `, [
      reverserSessionId,
      reverserAccountId,
      digest(`session-${suffix}`),
      digest(`xsrf-${suffix}`),
    ]);
    await database.pool.query(`
      INSERT INTO access_grants (
        id, organization_id, user_ref_id, role_id, scope_type, scope_id, organization_wide
      ) VALUES ($1,$2,$3,$4,'ORGANIZATION',$2,true)
    `, [reverserGrantId, seeded.organizationId, reverserId, reverserRoleId]);
    const grantClient = await database.pool.connect();
    try {
      await grantClient.query('BEGIN');
      await grantClient.query(`
        INSERT INTO access_grants (
          id, organization_id, user_ref_id, role_id, scope_type, scope_id, organization_wide
        ) VALUES ($1,$2,$3,$4,'ORGANIZATION',$2,false)
      `, [executorGrantId, seeded.organizationId, executorId, executorRoleId]);
      await grantClient.query(`
        INSERT INTO access_grant_treasury_unit_scopes (
          access_grant_id, treasury_unit_id
        ) VALUES ($1,$2)
      `, [executorGrantId, seeded.treasuryUnitId]);
      await grantClient.query('COMMIT');
    } catch (error) {
      await grantClient.query('ROLLBACK');
      throw error;
    } finally {
      grantClient.release();
    }

    await database.pool.query(`
      INSERT INTO bank_accounts (
        id, organization_id, bank_id, treasury_unit_id, account_type,
        account_number, currency, legal_owner_name, opening_date,
        cheque_enabled, can_receive, can_pay, can_transfer, state
      ) VALUES (
        $1,$2,$3,$4,'CURRENT',$5,$6,'Receipt scope test owner',
        '2026-01-01',false,true,true,true,'ACTIVE'
      )
    `, [
      unscopedBankAccountId,
      seeded.organizationId,
      seeded.bankId,
      seeded.treasuryUnitId,
      `UNSCOPED-${suffix}`,
      seeded.baseCurrency,
    ]);
    await database.pool.query(`
      INSERT INTO pos_terminals (
        id, organization_id, bank_account_id, treasury_unit_id,
        terminal_number, merchant_number, provider_label, currency,
        settlement_cycle, state
      ) VALUES ($1,$2,$3,$4,$5,$6,'Scope test POS',$7,'DAILY','ACTIVE')
    `, [
      derivedPosTerminalId,
      seeded.organizationId,
      seeded.bankAccountId,
      seeded.treasuryUnitId,
      `POS-${suffix}`,
      `MERCHANT-${suffix}`,
      seeded.baseCurrency,
    ]);
    await database.pool.query(`
      INSERT INTO payment_gateways (
        id, organization_id, bank_account_id, treasury_unit_id,
        provider_code, merchant_id, terminal_id, currency,
        settlement_cycle, state
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'DAILY','ACTIVE')
    `, [
      derivedGatewayId,
      seeded.organizationId,
      seeded.bankAccountId,
      seeded.treasuryUnitId,
      `SCOPE_${suffix}`,
      `MERCHANT-${suffix}`,
      `GATEWAY-${suffix}`,
      seeded.baseCurrency,
    ]);
    await database.pool.query(`
      INSERT INTO access_grant_bank_account_scopes (
        access_grant_id, bank_account_id
      ) VALUES ($1,$2)
    `, [executorGrantId, unscopedBankAccountId]);
    const cancelled = await receipts.create(
      seeded.organizationId,
      seeded.actorId,
      {
        businessDate: receiptBusinessDate,
        partyId: seeded.partyId,
        treasuryUnitId: seeded.treasuryUnitId,
        baseCurrency: seeded.baseCurrency,
        lines: [{
          lineNumber: 1,
          methodId: seeded.methodId,
          money: { amount: '1000', currency: seeded.baseCurrency },
          cashboxId: seeded.cashboxId,
          remainderTreatment: ReceiptRemainderTreatment.UNALLOCATED,
        }],
      },
      `cancelled-create-${suffix}`,
      `cancelled-create-request-${suffix}`,
    );
    await database.pool.query(`
      UPDATE receipt_documents
      SET state = 'CANCELLED', workflow_state = 'CANCELLED', version = 1
      WHERE organization_id = $1 AND id = $2
    `, [seeded.organizationId, cancelled.id]);
    const cancelledWithoutSnapshot = await receipts.get(
      seeded.organizationId,
      reverserId,
      cancelled.id,
    );
    assert.equal(cancelledWithoutSnapshot.state, 'CANCELLED');
    assert.equal(cancelledWithoutSnapshot.workflowState, 'CANCELLED');
    assert.equal(cancelledWithoutSnapshot.executionState, 'NOT_EXECUTED');
    assert.equal(cancelledWithoutSnapshot.approvalSnapshot, undefined);
    const cancelledSnapshotId = randomUUID();
    await database.pool.query(`
      INSERT INTO receipt_approval_snapshots (
        id, organization_id, receipt_document_id, document_version,
        amount_basis, base_currency, evaluated_at
      ) VALUES ($1,$2,$3,1,1000,$4,now())
    `, [
      cancelledSnapshotId,
      seeded.organizationId,
      cancelled.id,
      seeded.baseCurrency,
    ]);
    await database.pool.query(`
      UPDATE receipt_documents
      SET current_approval_snapshot_id = $1
      WHERE organization_id = $2 AND id = $3
    `, [cancelledSnapshotId, seeded.organizationId, cancelled.id]);
    const cancelledWithSnapshot = await receipts.get(
      seeded.organizationId,
      reverserId,
      cancelled.id,
    );
    assert.equal(cancelledWithSnapshot.approvalSnapshot?.id, cancelledSnapshotId);
    const cancelledReverseKey = `cancelled-reverse-${suffix}`;
    await assert.rejects(
      execution.reverse({
        organizationId: seeded.organizationId,
        actorUserId: reverserId,
        physicalSessionId: reverserSessionId,
        receiptId: cancelled.id,
        key: cancelledReverseKey,
        ifMatch: '"1"',
        requestId: `cancelled-reverse-request-${suffix}`,
      }, {
        reason: 'Cancelled receipts cannot be reversed',
        businessDate: receiptBusinessDate,
      }),
      isProblemCode('TRS-RCP-006'),
    );
    assert.deepEqual(
      await receipts.get(seeded.organizationId, reverserId, cancelled.id),
      cancelledWithSnapshot,
    );
    const cancelledReverseRecords = await database.pool.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM idempotency_records
      WHERE organization_id = $1
        AND scope = $2
        AND idempotency_key = $3
    `, [
      seeded.organizationId,
      `reverseReceipt:${reverserId}:${cancelled.id}`,
      cancelledReverseKey,
    ]);
    assert.equal(cancelledReverseRecords.rows[0]!.count, '0');
    const draft = await receipts.create(
      seeded.organizationId,
      seeded.actorId,
      {
        businessDate: receiptBusinessDate,
        partyId: seeded.partyId,
        treasuryUnitId: seeded.treasuryUnitId,
        baseCurrency: seeded.baseCurrency,
        lines: [{
          lineNumber: 1,
          methodId: seeded.methodId,
          money: { amount: '1000', currency: seeded.baseCurrency },
          cashboxId: seeded.cashboxId,
          remainderTreatment: ReceiptRemainderTreatment.UNALLOCATED,
        }],
      },
      `execution-create-${suffix}`,
      `execution-create-request-${suffix}`,
    );
    const executionLine = await database.pool.query<{ id: string }>(`
      SELECT id
      FROM receipt_lines
      WHERE organization_id = $1 AND receipt_document_id = $2
    `, [seeded.organizationId, draft.id]);
    for (const derivedReference of [
      { category: 'POS', column: 'pos_terminal_id', id: derivedPosTerminalId },
      { category: 'GATEWAY', column: 'payment_gateway_id', id: derivedGatewayId },
    ]) {
      await database.pool.query(`
        UPDATE receipt_lines
        SET cashbox_id = NULL,
            ${derivedReference.column} = $1,
            method_category = $2,
            creates_funds_in_transit = true
        WHERE organization_id = $3 AND id = $4
      `, [
        derivedReference.id,
        derivedReference.category,
        seeded.organizationId,
        executionLine.rows[0]!.id,
      ]);
      assert.equal(
        await database.db.transaction((transaction) =>
          authorization.canOperateReceipt(
            transaction,
            seeded.organizationId,
            executorId,
            draft.id,
            'receipt.execute',
          )),
        false,
      );
      await database.pool.query(`
        UPDATE receipt_lines
        SET ${derivedReference.column} = NULL
        WHERE organization_id = $1 AND id = $2
      `, [seeded.organizationId, executionLine.rows[0]!.id]);
    }
    await database.pool.query(`
      UPDATE receipt_lines
      SET cashbox_id = $1, method_category = 'CASH',
          creates_funds_in_transit = false
      WHERE organization_id = $2 AND id = $3
    `, [seeded.cashboxId, seeded.organizationId, executionLine.rows[0]!.id]);
    await database.pool.query(
      'DELETE FROM access_grant_bank_account_scopes WHERE access_grant_id = $1',
      [executorGrantId],
    );
    const snapshotId = randomUUID();
    await database.pool.query(`
      INSERT INTO receipt_approval_snapshots (
        id, organization_id, receipt_document_id, document_version,
        amount_basis, base_currency, evaluated_at
      ) VALUES ($1,$2,$3,1,1000,$4,now())
    `, [snapshotId, seeded.organizationId, draft.id, seeded.baseCurrency]);
    await database.pool.query(`
      UPDATE receipt_documents
      SET current_approval_snapshot_id = $1, state = 'APPROVED',
          workflow_state = 'APPROVED', version = 1
      WHERE organization_id = $2 AND id = $3
    `, [snapshotId, seeded.organizationId, draft.id]);

    const command = {
      organizationId: seeded.organizationId,
      actorUserId: executorId,
      physicalSessionId: randomUUID(),
      receiptId: draft.id,
      ifMatch: '"1"',
      requestId: `execute-request-${suffix}`,
    };
    const partialKey = `execute-partial-${suffix}`;
    await database.pool.query(`
      INSERT INTO idempotency_records (
        organization_id, scope, idempotency_key, request_digest,
        response_status, response_body
      ) VALUES ($1,$2,$3,$4,200,$5)
    `, [
      seeded.organizationId,
      `executeReceipt:${executorId}:${draft.id}`,
      partialKey,
      commandDigest('executeReceipt', {
        actorUserId: executorId,
        receiptId: draft.id,
        ifMatch: command.ifMatch,
        body: null,
      }),
      { receiptId: draft.id, version: 2 },
    ]);
    await assert.rejects(
      execution.execute({ ...command, key: partialKey }),
      isProblemCode('TRS-GEN-007'),
    );
    await database.pool.query(`
      DELETE FROM idempotency_records
      WHERE organization_id = $1 AND scope = $2 AND idempotency_key = $3
    `, [
      seeded.organizationId,
      `executeReceipt:${executorId}:${draft.id}`,
      partialKey,
    ]);
    await database.pool.query(`
      UPDATE access_grants
      SET amount_ceiling = 999, amount_ceiling_currency = $2
      WHERE id = $1
    `, [executorGrantId, seeded.baseCurrency]);
    await assert.rejects(
      execution.execute({ ...command, key: `execute-ceiling-${suffix}` }),
      isProblemCode('TRS-GEN-003'),
    );
    await database.pool.query(`
      UPDATE access_grants
      SET amount_ceiling = NULL, amount_ceiling_currency = NULL
      WHERE id = $1
    `, [executorGrantId]);
    await assert.rejects(
      execution.execute({
        ...command,
        actorUserId: seeded.actorId,
        key: `execute-denied-${suffix}`,
      }),
      isProblemCode('TRS-GEN-003'),
    );
    await database.pool.query(`
      INSERT INTO cashbox_days (
        organization_id, cashbox_id, business_date, close_cycle, state
      ) VALUES ($1,$2,$3,1,'CLOSED')
    `, [seeded.organizationId, seeded.cashboxId, receiptBusinessDate]);
    const rollbackKey = `execute-rollback-${suffix}`;
    await assert.rejects(
      execution.execute({ ...command, key: rollbackKey }),
      isProblemCode('TRS-GEN-009'),
    );
    const rolledBack = await database.pool.query<{ count: string }>(`
      SELECT (
        (SELECT count(*) FROM receipt_execution_effects e
          JOIN receipt_lines l ON l.id = e.receipt_line_id
          WHERE l.receipt_document_id = $1)
        + (SELECT count(*) FROM movement_facts WHERE source_id = $1)
        + (SELECT count(*) FROM idempotency_records
          WHERE organization_id = $2
            AND scope = $3
            AND idempotency_key = $4)
      )::text AS count
    `, [
      draft.id,
      seeded.organizationId,
      `executeReceipt:${executorId}:${draft.id}`,
      rollbackKey,
    ]);
    assert.equal(rolledBack.rows[0]!.count, '0');
    await database.pool.query(`
      UPDATE cashbox_days
      SET state = 'OPEN', version = version + 1
      WHERE organization_id = $1 AND cashbox_id = $2 AND business_date = $3
    `, [seeded.organizationId, seeded.cashboxId, receiptBusinessDate]);

    const competing = [
      { ...command, key: `execute-a-${suffix}` },
      { ...command, key: `execute-b-${suffix}` },
    ];
    const race = await Promise.allSettled(
      competing.map((candidate) => execution.execute(candidate)),
    );
    const winners = race.flatMap((result, index) =>
      result.status === 'fulfilled'
        ? [{ index, receipt: result.value }]
        : []);
    const failures = race.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    assert.equal(winners.length, 1);
    assert.equal(failures.length, 1);
    assert.ok(isProblemCode('TRS-GEN-006')(failures[0]!.reason));
    const winner = winners[0]!;
    const executed = winner.receipt;
    assert.equal(executed.state, 'EXECUTED');
    assert.equal(executed.version, 2);
    assert.equal(executed.lines[0]!.executionEffects?.length, 1);
    assert.equal(
      executed.lines[0]!.executionEffects?.[0]?.effect?.label,
      'Cashbox movement',
    );
    assert.deepEqual(
      await receipts.get(seeded.organizationId, executorId, draft.id),
      executed,
    );
    assert.deepEqual(await execution.execute(competing[winner.index]!), executed);

    const incomingEffect = await database.pool.query<{
      id: string;
      lineId: string;
      movementFactId: string;
      amount: string;
      currency: string;
    }>(`
      SELECT id, receipt_line_id AS "lineId",
             movement_fact_id AS "movementFactId", amount::text, currency
      FROM receipt_execution_effects
      WHERE organization_id = $1 AND receipt_line_id = $2
        AND direction = 'INCOMING'
    `, [seeded.organizationId, executionLine.rows[0]!.id]);
    const evidenceClient = await database.pool.connect();
    try {
      await evidenceClient.query('BEGIN');
      const mismatchedFact = await evidenceClient.query<{ id: string }>(`
        INSERT INTO movement_facts (
          organization_id, owner, source_type, source_id, source_line_id,
          effect_key, endpoint_type, endpoint_id, direction, amount, currency,
          business_date, state
        ) VALUES (
          $1,'Cashbox','Receipt',$2,$3,$4,'CASHBOX',$5,'CREDIT',
          999,$6,$7,'POSTED'
        )
        RETURNING id
      `, [
        seeded.organizationId,
        randomUUID(),
        executionLine.rows[0]!.id,
        `incoming-mismatch-${suffix}`,
        seeded.cashboxId,
        incomingEffect.rows[0]!.currency,
        receiptBusinessDate,
      ]);
      await assert.rejects(
        evidenceClient.query(`
          INSERT INTO receipt_execution_effects (
            organization_id, receipt_line_id, effect_key, effect_type,
            direction, amount, currency, business_date, source_version,
            movement_fact_id
          ) VALUES (
            $1,$2,$3,'CASHBOX_MOVEMENT','INCOMING',$4,$5,$6,2,$7
          )
        `, [
          seeded.organizationId,
          incomingEffect.rows[0]!.lineId,
          `incoming-mismatch-${suffix}`,
          incomingEffect.rows[0]!.amount,
          incomingEffect.rows[0]!.currency,
          receiptBusinessDate,
          mismatchedFact.rows[0]!.id,
        ]),
        (error: unknown) => (error as { code?: string; constraint?: string }).code === '23514'
          && (error as { constraint?: string }).constraint
            === 'receipt_execution_effect_movement_consistency',
      );
      await evidenceClient.query('ROLLBACK');

      await evidenceClient.query('BEGIN');
      const inverseFact = await evidenceClient.query<{ id: string }>(`
        INSERT INTO movement_facts (
          organization_id, owner, source_type, source_id, source_line_id,
          effect_key, endpoint_type, endpoint_id, direction, amount, currency,
          business_date, reversal_of_fact_id, state
        ) VALUES (
          $1,'BankAccount','Receipt',$2,$3,$4,'BANK_ACCOUNT',$5,'DEBIT',
          $6,$7,$8,$9,'POSTED'
        )
        RETURNING id
      `, [
        seeded.organizationId,
        randomUUID(),
        executionLine.rows[0]!.id,
        `mixed-evidence-${suffix}`,
        seeded.bankAccountId,
        incomingEffect.rows[0]!.amount,
        incomingEffect.rows[0]!.currency,
        receiptBusinessDate,
        incomingEffect.rows[0]!.movementFactId,
      ]);
      await assert.rejects(
        evidenceClient.query(`
          INSERT INTO receipt_execution_effects (
            organization_id, receipt_line_id, effect_key, effect_type,
            direction, amount, currency, business_date, source_version,
            movement_fact_id, reversal_of_effect_id
          ) VALUES (
            $1,$2,$3,'BANK_MOVEMENT','REVERSAL',$4,$5,$6,3,$7,$8
          )
        `, [
          seeded.organizationId,
          incomingEffect.rows[0]!.lineId,
          `mixed-evidence-${suffix}`,
          incomingEffect.rows[0]!.amount,
          incomingEffect.rows[0]!.currency,
          receiptBusinessDate,
          inverseFact.rows[0]!.id,
          incomingEffect.rows[0]!.id,
        ]),
        (error: unknown) => (error as { code?: string; constraint?: string }).code === '23514'
          && (error as { constraint?: string }).constraint
            === 'receipt_execution_effect_reversal_target_consistency',
      );
      await evidenceClient.query('ROLLBACK');

      await evidenceClient.query('BEGIN');
      const receivedChequeId = randomUUID();
      const incomingChequeEffectId = randomUUID();
      const invalidChequeEventId = randomUUID();
      await evidenceClient.query(`
        INSERT INTO received_cheques (
          id, organization_id, receipt_line_id, issuer_bank_id,
          cheque_number, amount, currency, receipt_date, due_date,
          custodian_type, custodian_id, state
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$8,'CASHBOX',$9,'RECEIVED'
        )
      `, [
        receivedChequeId,
        seeded.organizationId,
        incomingEffect.rows[0]!.lineId,
        seeded.bankId,
        `STATE-${suffix}`,
        incomingEffect.rows[0]!.amount,
        incomingEffect.rows[0]!.currency,
        receiptBusinessDate,
        seeded.cashboxId,
      ]);
      await evidenceClient.query(`
        INSERT INTO receipt_execution_effects (
          id, organization_id, receipt_line_id, effect_key, effect_type,
          direction, amount, currency, business_date, source_version,
          received_cheque_id
        ) VALUES (
          $1,$2,$3,$4,'RECEIVED_CHEQUE','INCOMING',$5,$6,$7,2,$8
        )
      `, [
        incomingChequeEffectId,
        seeded.organizationId,
        incomingEffect.rows[0]!.lineId,
        `cheque-incoming-${suffix}`,
        incomingEffect.rows[0]!.amount,
        incomingEffect.rows[0]!.currency,
        receiptBusinessDate,
        receivedChequeId,
      ]);
      await evidenceClient.query(`
        INSERT INTO cheque_events (
          id, cheque_type, cheque_id, sequence_no, from_state, to_state,
          actor_user_id, occurred_at, idempotency_key
        ) VALUES (
          $1,'RECEIVED',$2,1,'RECEIVED','IN_CUSTODY',$3,now(),$4
        )
      `, [
        invalidChequeEventId,
        receivedChequeId,
        seeded.actorId,
        `invalid-state-${suffix}`,
      ]);
      await assert.rejects(
        evidenceClient.query(`
          INSERT INTO receipt_execution_effects (
            organization_id, receipt_line_id, effect_key, effect_type,
            direction, amount, currency, business_date, source_version,
            cheque_event_id, reversal_of_effect_id
          ) VALUES (
            $1,$2,$3,'RECEIVED_CHEQUE','REVERSAL',$4,$5,$6,3,$7,$8
          )
        `, [
          seeded.organizationId,
          incomingEffect.rows[0]!.lineId,
          `cheque-reversal-${suffix}`,
          incomingEffect.rows[0]!.amount,
          incomingEffect.rows[0]!.currency,
          receiptBusinessDate,
          invalidChequeEventId,
          incomingChequeEffectId,
        ]),
        (error: unknown) => (error as { code?: string; constraint?: string }).code === '23514'
          && (error as { constraint?: string }).constraint
            === 'receipt_execution_effect_cheque_event_consistency',
      );
    } finally {
      await evidenceClient.query('ROLLBACK');
      evidenceClient.release();
    }

    const counts = await database.pool.query<{
      effects: string;
      facts: string;
      audits: string;
      events: string;
    }>(`
      SELECT
        (SELECT count(*) FROM receipt_execution_effects e
          JOIN receipt_lines l ON l.id = e.receipt_line_id
          WHERE l.receipt_document_id = $1)::text AS effects,
        (SELECT count(*) FROM movement_facts WHERE source_id = $1)::text AS facts,
        (SELECT count(*) FROM audit_events WHERE entity_id = $1)::text AS audits,
        (SELECT count(*) FROM outbox_events WHERE aggregate_id = $1)::text AS events
    `, [draft.id]);
    assert.deepEqual(counts.rows[0], {
      effects: '1',
      facts: '1',
      audits: '1',
      events: '1',
    });

    const reverseBody = {
      reason: 'Correction required',
      businessDate: receiptBusinessDate,
    };
    const reverseKey = `reverse-key-${suffix}`;
    const reversePath = `/v1/receipts/${draft.id}/reverse`;
    const reverseStep = await receiptStep(
      database,
      reverserAccountId,
      reverserSessionId,
      'reverseReceipt',
      reversePath,
      reverseBody,
      reverseKey,
    );
    const reverseCommand = {
      organizationId: seeded.organizationId,
      actorUserId: reverserId,
      physicalSessionId: reverserSessionId,
      receiptId: draft.id,
      key: reverseKey,
      ifMatch: '"2"',
      requestId: `reverse-request-${suffix}`,
      stepUp: reverseStep,
    };
    await database.pool.query(`
      UPDATE receipt_documents
      SET state = 'ACCOUNTING_POSTED', accounting_state = 'ACCEPTED'
      WHERE organization_id = $1 AND id = $2
    `, [seeded.organizationId, draft.id]);
    const reversalSnapshot = async () => (await database.pool.query<{
      state: string;
      accountingState: string;
      version: string;
      reversalReceiptId: string | null;
      reversalDocuments: string;
      reverseIdempotencyRecords: string;
      reverseAudits: string;
      reverseEvents: string;
      proofConsumedAt: string | null;
    }>(`
      SELECT
        document.state,
        document.accounting_state AS "accountingState",
        document.version::text AS version,
        document.reversal_receipt_id::text AS "reversalReceiptId",
        (
          SELECT count(*)::text
          FROM receipt_documents reversal
          WHERE reversal.organization_id = document.organization_id
            AND reversal.reverses_receipt_id = document.id
        ) AS "reversalDocuments",
        (
          SELECT count(*)::text
          FROM idempotency_records record
          WHERE record.organization_id = document.organization_id
            AND record.scope = $3
            AND record.idempotency_key = $4
        ) AS "reverseIdempotencyRecords",
        (
          SELECT count(*)::text
          FROM audit_events audit
          WHERE audit.organization_id = document.organization_id
            AND audit.entity_id = document.id
            AND audit.action = 'RECEIPT_REVERSED'
        ) AS "reverseAudits",
        (
          SELECT count(*)::text
          FROM outbox_events event
          WHERE event.organization_id = document.organization_id
            AND event.aggregate_id = document.id
            AND event.event_type = 'treasury.receipt.reversed.v1'
        ) AS "reverseEvents",
        (
          SELECT proof.consumed_at::text
          FROM auth_step_up_proofs proof
          WHERE proof.token_digest = $5
        ) AS "proofConsumedAt"
      FROM receipt_documents document
      WHERE document.organization_id = $1 AND document.id = $2
    `, [
      seeded.organizationId,
      draft.id,
      `reverseReceipt:${reverserId}:${draft.id}`,
      reverseKey,
      digest(reverseStep.proofId),
    ])).rows[0]!;
    const beforeBlockedReversal = await reversalSnapshot();
    await assert.rejects(
      execution.reverse(reverseCommand, reverseBody),
      isProblemCode('TRS-RCP-006'),
    );
    assert.deepEqual(await reversalSnapshot(), beforeBlockedReversal);
    assert.deepEqual(beforeBlockedReversal, {
      state: 'ACCOUNTING_POSTED',
      accountingState: 'ACCEPTED',
      version: '2',
      reversalReceiptId: null,
      reversalDocuments: '0',
      reverseIdempotencyRecords: '0',
      reverseAudits: '0',
      reverseEvents: '0',
      proofConsumedAt: null,
    });
    await database.pool.query(`
      UPDATE receipt_documents
      SET state = 'ACCOUNTING_READY', accounting_state = 'READY'
      WHERE organization_id = $1 AND id = $2
    `, [seeded.organizationId, draft.id]);
    await database.pool.query(`
      UPDATE cashbox_days
      SET state = 'CLOSED', version = version + 1
      WHERE organization_id = $1 AND cashbox_id = $2 AND business_date = $3
    `, [seeded.organizationId, seeded.cashboxId, receiptBusinessDate]);
    await assert.rejects(
      execution.reverse(reverseCommand, reverseBody),
      isProblemCode('TRS-GEN-009'),
    );
    await database.pool.query(`
      UPDATE cashbox_days
      SET state = 'OPEN', version = version + 1
      WHERE organization_id = $1 AND cashbox_id = $2 AND business_date = $3
    `, [seeded.organizationId, seeded.cashboxId, receiptBusinessDate]);
    const reversed = await execution.reverse(reverseCommand, reverseBody);
    reversalReceiptId = reversed.reversalReceipt.id;
    assert.equal(reversed.originalReceipt.state, 'REVERSED');
    assert.equal(reversed.originalReceipt.version, 3);
    assert.equal(reversed.reversalReceipt.state, 'EXECUTED');
    assert.equal(reversed.reversalReceipt.version, 1);
    assert.equal(reversed.reversalReceipt.lines[0]!.executionEffects?.length, 1);
    assert.deepEqual(
      await execution.reverse(reverseCommand, reverseBody),
      reversed,
    );
    assert.deepEqual(
      await execution.execute(competing[winner.index]!),
      executed,
    );
    const storedExecuteResponse = await database.pool.query<{
      etag: string | null;
    }>(`
      SELECT response_body ->> 'etag' AS etag
      FROM idempotency_records
      WHERE organization_id = $1
        AND scope = $2
        AND idempotency_key = $3
    `, [
      seeded.organizationId,
      `executeReceipt:${executorId}:${draft.id}`,
      competing[winner.index]!.key,
    ]);
    assert.equal(storedExecuteResponse.rows[0]!.etag, '"2"');
    const consumedProof = await database.pool.query<{ consumedAt: Date | null }>(`
      SELECT consumed_at AS "consumedAt"
      FROM auth_step_up_proofs
      WHERE token_digest = $1
    `, [digest(reverseStep.proofId)]);
    assert.ok(consumedProof.rows[0]!.consumedAt);
  } finally {
    const grantCleanupClient = await database.pool.connect();
    try {
      await grantCleanupClient.query('BEGIN');
      await grantCleanupClient.query(
        'DELETE FROM access_grant_treasury_unit_scopes WHERE access_grant_id = $1',
        [executorGrantId],
      );
      await grantCleanupClient.query(
        'DELETE FROM access_grant_bank_account_scopes WHERE access_grant_id = $1',
        [executorGrantId],
      );
      await grantCleanupClient.query(
        'DELETE FROM access_grants WHERE id = $1',
        [executorGrantId],
      );
      await grantCleanupClient.query('COMMIT');
    } catch (error) {
      await grantCleanupClient.query('ROLLBACK');
      throw error;
    } finally {
      grantCleanupClient.release();
    }
    await database.pool.query('DELETE FROM role_permissions WHERE role_id = $1', [executorRoleId]);
    await database.pool.query('DELETE FROM roles WHERE id = $1', [executorRoleId]);
    await database.pool.query('DELETE FROM access_grants WHERE id = $1', [reverserGrantId]);
    await database.pool.query('DELETE FROM role_permissions WHERE role_id = $1', [reverserRoleId]);
    await database.pool.query('DELETE FROM roles WHERE id = $1', [reverserRoleId]);
    if (reversalReceiptId) {
      await cleanupReceiptReversal(database, seeded.organizationId, reversalReceiptId);
    }
    await cleanupReceiptFoundation(database, seeded);
    await database.pool.query('DELETE FROM pos_terminals WHERE id = $1', [derivedPosTerminalId]);
    await database.pool.query('DELETE FROM payment_gateways WHERE id = $1', [derivedGatewayId]);
    await database.pool.query('DELETE FROM bank_accounts WHERE id = $1', [unscopedBankAccountId]);
    await database.pool.query('DELETE FROM user_refs WHERE id = $1', [executorId]);
    await database.pool.query(`
      DELETE FROM auth_step_up_proofs
      WHERE challenge_id IN (
        SELECT id FROM auth_challenges WHERE identity_account_id = $1
      )
    `, [reverserAccountId]);
    await database.pool.query(
      'DELETE FROM auth_challenges WHERE identity_account_id = $1',
      [reverserAccountId],
    );
    await database.pool.query('DELETE FROM auth_sessions WHERE id = $1', [reverserSessionId]);
    await database.pool.query('DELETE FROM identity_accounts WHERE id = $1', [reverserAccountId]);
    await database.pool.query('DELETE FROM user_refs WHERE id = $1', [reverserId]);
    await database.onModuleDestroy();
  }
});

async function receiptStep(
  database: DatabaseService,
  accountId: string,
  sessionId: string,
  operationId: string,
  path: string,
  body: unknown,
  idempotencyKey: string,
) {
  const proofId = randomUUID();
  const bodyDigest = commandDigest(operationId, body);
  const challenge = await database.pool.query<{ id: string }>(`
    INSERT INTO auth_challenges (
      identity_account_id, session_id, token_digest, kind, http_method,
      http_path, request_body_digest, idempotency_key, expires_at
    ) VALUES ($1,$2,$3,'STEP_UP','POST',$4,$5,$6,now() + interval '5 minutes')
    RETURNING id
  `, [
    accountId,
    sessionId,
    digest(`challenge:${proofId}`),
    path,
    bodyDigest,
    idempotencyKey,
  ]);
  await database.pool.query(`
    INSERT INTO auth_step_up_proofs (challenge_id, token_digest, expires_at)
    VALUES ($1,$2,now() + interval '5 minutes')
  `, [challenge.rows[0]!.id, digest(proofId)]);
  return {
    proofId,
    command: {
      operationId,
      method: 'POST',
      path,
      bodyDigest,
      idempotencyKey,
    },
  };
}

async function cleanupReceiptReversal(
  database: DatabaseService,
  organizationId: string,
  reversalReceiptId: string,
): Promise<void> {
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL session_replication_role = replica`);
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query(`
      UPDATE receipt_documents
      SET state = 'EXECUTED',
          execution_state = 'EXECUTED',
          reversal_receipt_id = NULL
      WHERE organization_id = $1 AND reversal_receipt_id = $2
    `, [organizationId, reversalReceiptId]);
    await client.query(`
      DELETE FROM receipt_execution_effects effects
      USING receipt_lines lines
      WHERE effects.organization_id = $1
        AND effects.receipt_line_id = lines.id
        AND lines.organization_id = $1
        AND lines.receipt_document_id = $2
    `, [organizationId, reversalReceiptId]);
    await client.query(`
      DELETE FROM movement_facts
      WHERE organization_id = $1 AND source_id = $2
    `, [organizationId, reversalReceiptId]);
    await client.query(`
      DELETE FROM receipt_lines
      WHERE organization_id = $1 AND receipt_document_id = $2
    `, [organizationId, reversalReceiptId]);
    await client.query(`
      DELETE FROM receipt_documents
      WHERE organization_id = $1 AND id = $2
    `, [organizationId, reversalReceiptId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function seedReceiptFoundation(database: DatabaseService) {
  const existingOrganization = await database.pool.query<{
    id: string;
    baseCurrency: string;
  }>(
    `SELECT id, base_currency AS "baseCurrency"
     FROM organizations ORDER BY created_at LIMIT 1`,
  );
  const createdOrganization = !existingOrganization.rowCount;
  const organizationId = existingOrganization.rows[0]?.id ?? randomUUID();
  const baseCurrency = existingOrganization.rows[0]?.baseCurrency ?? 'IRR';
  const initialCounter = await database.pool.query<{ nextValue: string }>(`
    SELECT next_value::text AS "nextValue"
    FROM receipt_number_counters
    WHERE organization_id = $1 AND business_date = $2
  `, [organizationId, receiptBusinessDate]);
  const initialReceiptCounter = initialCounter.rows[0]?.nextValue ?? null;
  const actorId = randomUUID();
  const treasuryUnitId = randomUUID();
  const branchId = randomUUID();
  const partyId = randomUUID();
  const methodId = randomUUID();
  const anchorlessMethodId = randomUUID();
  const invalidMethodId = randomUUID();
  const cashboxId = randomUUID();
  const bankTypeId = randomUUID();
  const bankId = randomUUID();
  const bankBranchId = randomUUID();
  const bankAccountId = randomUUID();
  const roleId = randomUUID();
  const grantId = randomUUID();
  const cashApprovalPolicyId = randomUUID();
  const zeroStepPolicyId = randomUUID();
  const foreignCurrency = `X${treasuryUnitId.replaceAll('-', '').slice(0, 7).toUpperCase()}`;
  const suffix = treasuryUnitId.slice(0, 8).toUpperCase();
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    if (!existingOrganization.rowCount) {
      await client.query(`
        INSERT INTO organizations (id, code, legal_name, timezone, base_currency)
        VALUES ($1,$2,'سازمان آزمون خزانه','Asia/Tehran','IRR')
      `, [organizationId, `RCP-${suffix}`]);
      await client.query(`
        INSERT INTO currencies (
          organization_id, code, name, decimal_places, base_currency
        ) VALUES ($1,'IRR','ریال ایران',0,true)
      `, [organizationId]);
    }
    await client.query(`
      INSERT INTO currencies (
        organization_id, code, name, decimal_places, base_currency
      ) VALUES ($1,$2,'ارز آزمون نرخ',2,false)
      ON CONFLICT (organization_id, code) DO NOTHING
    `, [organizationId, foreignCurrency]);
    await client.query(`
      INSERT INTO branches (id, organization_id, code, name)
      VALUES ($1,$2,$3,'شعبه محدودکننده آزمون دریافت')
    `, [branchId, organizationId, `BR-${suffix}`]);
    await client.query(`
      INSERT INTO treasury_units (
        id, organization_id, code, name, default_currency
      ) VALUES ($1,$2,$3,'واحد خزانه مرکزی',$4)
    `, [treasuryUnitId, organizationId, `TU-${suffix}`, baseCurrency]);
    await client.query(`
      INSERT INTO user_refs (id, organization_id, subject_key, display_name)
      VALUES ($1,$2,$3,'کاربر ثبت دریافت')
    `, [actorId, organizationId, `actor-${suffix}`]);
    await client.query(`
      INSERT INTO bank_types (id, organization_id, code, display_name)
      VALUES ($1,$2,$3,'نوع بانک آزمون دریافت')
    `, [bankTypeId, organizationId, `BT-${suffix}`]);
    await client.query(`
      INSERT INTO banks (
        id, organization_id, bank_type_id, code, display_name, country_code
      ) VALUES ($1,$2,$3,$4,'بانک آزمون دریافت','IR')
    `, [bankId, organizationId, bankTypeId, `BANK-${suffix}`]);
    await client.query(`
      INSERT INTO bank_branches (id, organization_id, bank_id, code, name)
      VALUES ($1,$2,$3,$4,'شعبه بانک آزمون دریافت')
    `, [bankBranchId, organizationId, bankId, `BANK-BR-${suffix}`]);
    await client.query(`
      INSERT INTO bank_accounts (
        id, organization_id, bank_id, treasury_unit_id, account_type,
        account_number, currency, legal_owner_name, opening_date,
        cheque_enabled, can_receive, can_pay, can_transfer, state
      ) VALUES (
        $1,$2,$3,$4,'CURRENT',$5,$6,'سازمان آزمون خزانه',
        '2026-01-01',false,true,true,true,'ACTIVE'
      )
    `, [
      bankAccountId,
      organizationId,
      bankId,
      treasuryUnitId,
      `ACC-${suffix}`,
      baseCurrency,
    ]);
    await client.query(`
      INSERT INTO parties (id, organization_id, code, display_name)
      VALUES ($1,$2,$3,'مشتری آزمون دریافت')
    `, [partyId, organizationId, `PARTY-${suffix}`]);
    await client.query(`
      INSERT INTO method_definitions (
        id, organization_id, code, name, direction, behavior_category,
        creates_funds_in_transit, requires_approval
      ) VALUES ($1,$2,$3,'دریافت نقدی','RECEIPT',$4,false,false)
    `, [methodId, organizationId, `CASH-${suffix}`, MethodBehaviorCategory.CASH]);
    await client.query(`
      INSERT INTO method_required_references (method_id, reference)
      VALUES ($1,$2)
    `, [methodId, MethodReference.CASHBOX]);
    await client.query(`
      INSERT INTO method_allowed_currencies (method_id, organization_id, currency_code)
      VALUES ($1,$2,$3),($1,$2,$4)
    `, [methodId, organizationId, baseCurrency, foreignCurrency]);
    await client.query(`
      INSERT INTO method_definitions (
        id, organization_id, code, name, direction, behavior_category,
        creates_funds_in_transit, requires_approval
      ) VALUES ($1,$2,$3,'تهاتر کنترل‌شده','RECEIPT','OFFSET',false,false)
    `, [anchorlessMethodId, organizationId, `OFFSET-${suffix}`]);
    await client.query(`
      INSERT INTO method_allowed_currencies (method_id, organization_id, currency_code)
      VALUES ($1,$2,$3)
    `, [anchorlessMethodId, organizationId, baseCurrency]);
    await client.query(`
      INSERT INTO method_definitions (
        id, organization_id, code, name, direction, behavior_category,
        creates_funds_in_transit, requires_approval
      ) VALUES ($1,$2,$3,'روش کنترل‌شده نامعتبر','RECEIPT','OTHER_CONTROLLED',false,false)
    `, [invalidMethodId, organizationId, `OTHER-${suffix}`]);
    await client.query(`
      INSERT INTO method_allowed_currencies (method_id, organization_id, currency_code)
      VALUES ($1,$2,$3)
    `, [invalidMethodId, organizationId, baseCurrency]);
    await client.query(`
      INSERT INTO cashboxes (
        id, organization_id, treasury_unit_id, code, name, cashbox_type,
        main_currency, can_receive, can_pay, can_transfer, requires_approval,
        active_from
      ) VALUES ($1,$2,$3,$4,'صندوق اصلی','CASH',$5,true,true,false,false,now())
    `, [cashboxId, organizationId, treasuryUnitId, `CB-${suffix}`, baseCurrency]);
    await client.query(`
      INSERT INTO cashbox_currency_controls (
        cashbox_id, organization_id, currency, allow_negative
      ) VALUES ($1,$2,$3,false),($1,$2,$4,false)
    `, [cashboxId, organizationId, baseCurrency, foreignCurrency]);
    await client.query(`
      INSERT INTO cashbox_assignments (
        organization_id, cashbox_id, user_id, assignment_type,
        effective_from, state
      ) VALUES ($1,$2,$3,'PRIMARY',now(),'ACTIVE')
    `, [organizationId, cashboxId, actorId]);
    await client.query(`
      INSERT INTO roles (id, organization_id, code, name)
      VALUES ($1,$2,$3,'ثبت‌کننده دریافت')
    `, [roleId, organizationId, `RCP-ROLE-${suffix}`]);
    await client.query(`
      INSERT INTO receipt_approval_policies (
        id, organization_id, code, name, document_type,
        currency, method_category, version, state
      ) VALUES
        ($1,$2,$3,'Cash approval','RECEIPT',$5,'CASH',1,'ACTIVE'),
        ($4,$2,$6,'Offset no approval','RECEIPT',$5,'OFFSET',1,'ACTIVE')
    `, [
      cashApprovalPolicyId,
      organizationId,
      `RCP-CASH-${suffix}`,
      zeroStepPolicyId,
      baseCurrency,
      `RCP-OFFSET-${suffix}`,
    ]);
    await client.query(`
      INSERT INTO receipt_approval_policy_steps (
        organization_id, policy_id, step_order, role_id,
        approver_user_id, approvals_required, separation_rules
      ) VALUES
        ($1,$2,1,$3,NULL,1,'{}'),
        ($1,$2,2,NULL,$4,1,'{}')
    `, [organizationId, cashApprovalPolicyId, roleId, actorId]);
    await client.query(`
      INSERT INTO role_permissions (role_id, permission)
      VALUES
        ($1,'receipt.create'),($1,'receipt.view'),($1,'receipt.edit-draft'),
        ($1,'receipt.submit'),($1,'receipt.approve'),($1,'receipt.reject')
    `, [roleId]);
    await client.query(`
      INSERT INTO access_grants (
        id, organization_id, user_ref_id, role_id, scope_type, scope_id,
        organization_wide
      ) VALUES ($1,$2,$3,$4,'ORGANIZATION',$2,false)
    `, [grantId, organizationId, actorId, roleId]);
    await client.query(`
      INSERT INTO access_grant_treasury_unit_scopes (access_grant_id, treasury_unit_id)
      VALUES ($1,$2)
    `, [grantId, treasuryUnitId]);
    await client.query('COMMIT');
    return {
      organizationId,
      actorId,
      treasuryUnitId,
      branchId,
      partyId,
      methodId,
      anchorlessMethodId,
      invalidMethodId,
      cashboxId,
      bankTypeId,
      bankId,
      bankBranchId,
      bankAccountId,
      foreignCurrency,
      baseCurrency,
      roleId,
      grantId,
      cashApprovalPolicyId,
      zeroStepPolicyId,
      createdOrganization,
      receiptBusinessDate,
      initialReceiptCounter,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function cleanupReceiptFoundation(
  database: DatabaseService,
  seeded: {
    organizationId: string;
    actorId: string;
    treasuryUnitId: string;
    branchId: string;
    partyId: string;
    methodId: string;
    anchorlessMethodId: string;
    invalidMethodId: string;
    cashboxId: string;
    bankTypeId: string;
    bankId: string;
    bankBranchId: string;
    bankAccountId: string;
    foreignCurrency: string;
    roleId: string;
    grantId: string;
    cashApprovalPolicyId: string;
    zeroStepPolicyId: string;
    createdOrganization: boolean;
    receiptBusinessDate: string;
    initialReceiptCounter: string | null;
  },
): Promise<void> {
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL session_replication_role = replica`);
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query(`
      UPDATE receipt_documents
      SET state = 'DRAFT',
          workflow_state = 'DRAFT',
          execution_state = 'NOT_EXECUTED',
          accounting_state = 'NOT_READY',
          current_approval_snapshot_id = NULL,
          executed_at = NULL,
          executed_by_user_id = NULL,
          reversal_receipt_id = NULL,
          reverses_receipt_id = NULL
      WHERE organization_id = $1 AND creator_user_id = $2
    `, [seeded.organizationId, seeded.actorId]);
    await client.query(`
      DELETE FROM receipt_approval_actions
      WHERE organization_id = $1 AND approval_snapshot_id IN (
        SELECT id FROM receipt_approval_snapshots
        WHERE organization_id = $1 AND receipt_document_id IN (
          SELECT id FROM receipt_documents
          WHERE organization_id = $1 AND creator_user_id = $2
        )
      )
    `, [seeded.organizationId, seeded.actorId]);
    for (const table of [
      'receipt_approval_snapshot_steps',
      'receipt_approval_snapshot_contexts',
    ]) {
      await client.query(`
        DELETE FROM ${table}
        WHERE organization_id = $1 AND approval_snapshot_id IN (
          SELECT id FROM receipt_approval_snapshots
          WHERE organization_id = $1 AND receipt_document_id IN (
            SELECT id FROM receipt_documents
            WHERE organization_id = $1 AND creator_user_id = $2
          )
        )
      `, [seeded.organizationId, seeded.actorId]);
    }
    await client.query(`
      DELETE FROM receipt_approval_snapshots
      WHERE organization_id = $1 AND receipt_document_id IN (
        SELECT id FROM receipt_documents
        WHERE organization_id = $1 AND creator_user_id = $2
      )
    `, [seeded.organizationId, seeded.actorId]);
    await client.query(`
      DELETE FROM receipt_line_attachment_links links
      USING receipt_lines lines, receipt_documents documents
      WHERE links.organization_id = $1
        AND links.receipt_line_id = lines.id
        AND lines.organization_id = $1
        AND lines.receipt_document_id = documents.id
        AND documents.organization_id = $1
        AND documents.creator_user_id = $2
    `, [seeded.organizationId, seeded.actorId]);
    await client.query(`
      DELETE FROM receipt_execution_effects effects
      USING receipt_lines lines, receipt_documents documents
      WHERE effects.organization_id = $1
        AND effects.receipt_line_id = lines.id
        AND lines.organization_id = $1
        AND lines.receipt_document_id = documents.id
        AND documents.organization_id = $1
        AND documents.creator_user_id = $2
    `, [seeded.organizationId, seeded.actorId]);
    await client.query(`
      DELETE FROM movement_facts facts
      USING receipt_documents documents
      WHERE facts.organization_id = $1
        AND facts.source_type = 'Receipt'
        AND facts.source_id = documents.id
        AND documents.organization_id = $1
        AND documents.creator_user_id = $2
    `, [seeded.organizationId, seeded.actorId]);
    await client.query(`
      DELETE FROM received_cheques cheques
      USING receipt_lines lines, receipt_documents documents
      WHERE cheques.organization_id = $1
        AND cheques.receipt_line_id = lines.id
        AND lines.organization_id = $1
        AND lines.receipt_document_id = documents.id
        AND documents.organization_id = $1
        AND documents.creator_user_id = $2
    `, [seeded.organizationId, seeded.actorId]);
    await client.query(`
      DELETE FROM collection_items items
      USING receipt_lines lines, receipt_documents documents
      WHERE items.organization_id = $1
        AND items.source_fact_type = 'ReceiptLine'
        AND items.source_fact_id = lines.id
        AND lines.organization_id = $1
        AND lines.receipt_document_id = documents.id
        AND documents.organization_id = $1
        AND documents.creator_user_id = $2
    `, [seeded.organizationId, seeded.actorId]);
    await client.query(`
      DELETE FROM audit_events events
      USING receipt_documents documents
      WHERE events.organization_id = $1
        AND events.entity_type = 'Receipt'
        AND events.entity_id = documents.id
        AND documents.organization_id = $1
        AND documents.creator_user_id = $2
    `, [seeded.organizationId, seeded.actorId]);
    await client.query(`
      DELETE FROM outbox_events events
      USING receipt_documents documents
      WHERE events.organization_id = $1
        AND events.aggregate_type = 'Receipt'
        AND events.aggregate_id = documents.id
        AND documents.organization_id = $1
        AND documents.creator_user_id = $2
    `, [seeded.organizationId, seeded.actorId]);
    await client.query(`
      DELETE FROM receipt_allocations allocations
      USING receipt_lines lines, receipt_documents documents
      WHERE allocations.organization_id = $1
        AND allocations.receipt_line_id = lines.id
        AND lines.organization_id = $1
        AND lines.receipt_document_id = documents.id
        AND documents.organization_id = $1
        AND documents.creator_user_id = $2
    `, [seeded.organizationId, seeded.actorId]);
    await client.query(`
      DELETE FROM receipt_lines lines
      USING receipt_documents documents
      WHERE lines.organization_id = $1
        AND lines.receipt_document_id = documents.id
        AND documents.organization_id = $1
        AND documents.creator_user_id = $2
    `, [seeded.organizationId, seeded.actorId]);
    await client.query(`
      DELETE FROM idempotency_records
      WHERE organization_id = $1
        AND (
          scope = $2
          OR scope LIKE $3
          OR scope LIKE $4
          OR scope LIKE $5
          OR (
            (
              scope LIKE 'executeReceipt:%'
              OR scope LIKE 'reverseReceipt:%'
            )
            AND split_part(scope, ':', 3) IN (
              SELECT id::text FROM receipt_documents
              WHERE organization_id = $1 AND creator_user_id = $6
            )
          )
        )
    `, [
      seeded.organizationId,
      `createReceipt:${seeded.actorId}`,
      `replaceReceiptDraft:${seeded.actorId}:%`,
      `submitReceipt:${seeded.actorId}:%`,
      `actOnReceiptApproval:${seeded.actorId}:%`,
      seeded.actorId,
    ]);
    await client.query(`
      DELETE FROM receipt_documents
      WHERE organization_id = $1 AND creator_user_id = $2
    `, [seeded.organizationId, seeded.actorId]);
    await client.query(`
      DELETE FROM exchange_rates WHERE recorded_by = $1 OR approved_by = $1
    `, [seeded.actorId]);
    for (const table of [
      'access_grant_branch_scopes',
      'access_grant_treasury_unit_scopes',
      'access_grant_cashbox_scopes',
      'access_grant_bank_account_scopes',
      'access_grant_document_type_scopes',
      'access_grant_method_category_scopes',
      'access_grant_currency_scopes',
    ]) {
      await client.query(`DELETE FROM ${table} WHERE access_grant_id = $1`, [seeded.grantId]);
    }
    await client.query('DELETE FROM access_grants WHERE id = $1', [seeded.grantId]);
    await client.query(
      'DELETE FROM receipt_approval_policy_steps WHERE policy_id = ANY($1::uuid[])',
      [[seeded.cashApprovalPolicyId, seeded.zeroStepPolicyId]],
    );
    await client.query(
      'DELETE FROM receipt_approval_policies WHERE id = ANY($1::uuid[])',
      [[seeded.cashApprovalPolicyId, seeded.zeroStepPolicyId]],
    );
    await client.query('DELETE FROM role_permissions WHERE role_id = $1', [seeded.roleId]);
    await client.query('DELETE FROM roles WHERE id = $1', [seeded.roleId]);
    await client.query(
      'DELETE FROM cashbox_assignments WHERE organization_id = $1 AND cashbox_id = $2',
      [seeded.organizationId, seeded.cashboxId],
    );
    await client.query(
      'DELETE FROM cashbox_currency_controls WHERE organization_id = $1 AND cashbox_id = $2',
      [seeded.organizationId, seeded.cashboxId],
    );
    await client.query(
      'DELETE FROM cashbox_days WHERE organization_id = $1 AND cashbox_id = $2',
      [seeded.organizationId, seeded.cashboxId],
    );
    await client.query(
      'DELETE FROM cashboxes WHERE organization_id = $1 AND id = $2',
      [seeded.organizationId, seeded.cashboxId],
    );
    await client.query(
      'DELETE FROM bank_accounts WHERE organization_id = $1 AND id = $2',
      [seeded.organizationId, seeded.bankAccountId],
    );
    await client.query(
      'DELETE FROM bank_branches WHERE organization_id = $1 AND id = $2',
      [seeded.organizationId, seeded.bankBranchId],
    );
    await client.query(
      'DELETE FROM banks WHERE organization_id = $1 AND id = $2',
      [seeded.organizationId, seeded.bankId],
    );
    await client.query(
      'DELETE FROM bank_types WHERE organization_id = $1 AND id = $2',
      [seeded.organizationId, seeded.bankTypeId],
    );
    const methodIds = [
      seeded.methodId,
      seeded.anchorlessMethodId,
      seeded.invalidMethodId,
    ];
    await client.query(
      'DELETE FROM method_amount_limits WHERE method_id = ANY($1::uuid[])',
      [methodIds],
    );
    await client.query(
      'DELETE FROM method_mappings WHERE method_id = ANY($1::uuid[])',
      [methodIds],
    );
    await client.query(
      'DELETE FROM method_required_references WHERE method_id = ANY($1::uuid[])',
      [methodIds],
    );
    await client.query(
      'DELETE FROM method_allowed_currencies WHERE method_id = ANY($1::uuid[])',
      [methodIds],
    );
    await client.query(
      'DELETE FROM method_definitions WHERE organization_id = $1 AND id = ANY($2::uuid[])',
      [seeded.organizationId, methodIds],
    );
    await client.query('DELETE FROM party_kinds WHERE party_id = $1', [seeded.partyId]);
    await client.query(
      'DELETE FROM parties WHERE organization_id = $1 AND id = $2',
      [seeded.organizationId, seeded.partyId],
    );
    await client.query(
      'DELETE FROM treasury_units WHERE organization_id = $1 AND id = $2',
      [seeded.organizationId, seeded.treasuryUnitId],
    );
    await client.query(
      'DELETE FROM branches WHERE organization_id = $1 AND id = $2',
      [seeded.organizationId, seeded.branchId],
    );
    await client.query(
      'DELETE FROM user_refs WHERE organization_id = $1 AND id = $2',
      [seeded.organizationId, seeded.actorId],
    );
    await client.query(
      'DELETE FROM currencies WHERE organization_id = $1 AND code = $2',
      [seeded.organizationId, seeded.foreignCurrency],
    );
    if (seeded.initialReceiptCounter === null) {
      await client.query(`
        DELETE FROM receipt_number_counters
        WHERE organization_id = $1 AND business_date = $2
      `, [seeded.organizationId, seeded.receiptBusinessDate]);
    } else {
      await client.query(`
        UPDATE receipt_number_counters
        SET next_value = $3
        WHERE organization_id = $1 AND business_date = $2
      `, [
        seeded.organizationId,
        seeded.receiptBusinessDate,
        seeded.initialReceiptCounter,
      ]);
    }
    if (seeded.createdOrganization) {
      await client.query(
        `DELETE FROM currencies WHERE organization_id = $1`,
        [seeded.organizationId],
      );
      await client.query(
        `DELETE FROM organizations WHERE id = $1`,
        [seeded.organizationId],
      );
    }
    await client.query('COMMIT');

    const leftovers = await database.pool.query<{ count: number }>(`
      SELECT (
        (SELECT count(*) FROM user_refs WHERE id = $1)
        + (SELECT count(*) FROM treasury_units WHERE id = $2)
        + (SELECT count(*) FROM cashboxes WHERE id = $3)
        + (SELECT count(*) FROM method_definitions WHERE id = $4)
        + (SELECT count(*) FROM method_definitions WHERE id = $8)
        + (SELECT count(*) FROM method_definitions WHERE id = $10)
        + (SELECT count(*) FROM bank_accounts WHERE id = $11)
        + (SELECT count(*) FROM banks WHERE id = $12)
        + (SELECT count(*) FROM bank_types WHERE id = $13)
        + (SELECT count(*) FROM bank_branches WHERE id = $14)
        + (SELECT count(*) FROM parties WHERE id = $5)
        + (SELECT count(*) FROM roles WHERE id = $6)
        + (SELECT count(*) FROM access_grants WHERE id = $7)
        + (SELECT count(*) FROM branches WHERE id = $9)
        + (SELECT count(*) FROM receipt_documents WHERE creator_user_id = $1)
        + (SELECT count(*) FROM exchange_rates WHERE recorded_by = $1 OR approved_by = $1)
      )::int AS count
    `, [
      seeded.actorId,
      seeded.treasuryUnitId,
      seeded.cashboxId,
      seeded.methodId,
      seeded.partyId,
      seeded.roleId,
      seeded.grantId,
      seeded.invalidMethodId,
      seeded.branchId,
      seeded.anchorlessMethodId,
      seeded.bankAccountId,
      seeded.bankId,
      seeded.bankTypeId,
      seeded.bankBranchId,
    ]);
    assert.equal(leftovers.rows[0]!.count, 0);
    const restoredCounter = await database.pool.query<{ nextValue: string }>(`
      SELECT next_value::text AS "nextValue"
      FROM receipt_number_counters
      WHERE organization_id = $1 AND business_date = $2
    `, [seeded.organizationId, seeded.receiptBusinessDate]);
    assert.equal(
      restoredCounter.rows[0]?.nextValue ?? null,
      seeded.initialReceiptCounter,
    );
    if (seeded.createdOrganization) {
      assert.equal(
        (await database.pool.query(
          'SELECT 1 FROM organizations WHERE id = $1',
          [seeded.organizationId],
        )).rowCount,
        0,
      );
    }
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function isProblemCode(code: string) {
  return (error: unknown) => error instanceof TreasuryProblem
    && (error.getResponse() as { code?: string }).code === code;
}
