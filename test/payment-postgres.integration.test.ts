import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { AccessAuthorizationRepository } from '../src/access-control/access-authorization.repository';
import { AccessAuthorizationService } from '../src/access-control/access-authorization.service';
import { BankInstructionOutcomeRepository } from '../src/banking/bank-instruction-outcome.repository';
import { BankInstructionOutcomeService } from '../src/banking/bank-instruction-outcome.service';
import { BankInstructionOutcome } from '../src/banking/banking.dto';
import {
  PaymentBankingEffectsRepository,
  PaymentBankingEffectsService,
} from '../src/banking/payment-banking-effects.service';
import { ReceiptBankingEffectsRepository, ReceiptBankingEffectsService } from '../src/banking/receipt-banking-effects.service';
import {
  PaymentCashboxEffectsRepository,
  PaymentCashboxEffectsService,
} from '../src/cashbox-and-custody/payment-cashbox-effects.service';
import { ReceiptCashboxEffectsRepository, ReceiptCashboxEffectsService } from '../src/cashbox-and-custody/receipt-cashbox-effects.service';
import { commandDigest, digest } from '../src/common/http';
import { TreasuryProblem } from '../src/common/problem';
import { DatabaseService } from '../src/database/database.service';
import { FoundationEffectsRepository, FoundationEffectsService } from '../src/foundation-effects/foundation-effects.service';
import { MethodBehaviorCategory, MethodReference } from '../src/master-data/master-data.dto';
import { PaymentApprovalRepository } from '../src/payments/payment-approval.repository';
import { PaymentApprovalService } from '../src/payments/payment-approval.service';
import { PaymentApprovalAction } from '../src/payments/payment.dto';
import { PaymentExecutionRepository } from '../src/payments/payment-execution.repository';
import { PaymentExecutionService } from '../src/payments/payment-execution.service';
import { PaymentRepository } from '../src/payments/payment.repository';
import { PaymentService } from '../src/payments/payment.service';

const connectionString = process.env.TEST_DATABASE_URL;

test('INC-3A/3B payments preserve draft, approval, aggregation, and concurrency invariants', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = connectionString;
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 31).toString('base64');
  const database = new DatabaseService();
  let seeded: Awaited<ReturnType<typeof seed>> | undefined;
  const repository = new PaymentRepository();
  const approvalRepository = new PaymentApprovalRepository();
  const authorization = new AccessAuthorizationService(new AccessAuthorizationRepository());
  const service = new PaymentService(repository, database, authorization, approvalRepository);
  const approvalService = new PaymentApprovalService(
    database,
    approvalRepository,
    repository,
    service,
    authorization,
  );
  const foundation = new FoundationEffectsService(new FoundationEffectsRepository());
  const execution = new PaymentExecutionService(
    database,
    new PaymentExecutionRepository(),
    repository,
    authorization,
    new PaymentCashboxEffectsService(new PaymentCashboxEffectsRepository()),
    new PaymentBankingEffectsService(new PaymentBankingEffectsRepository()),
    new ReceiptCashboxEffectsService(new ReceiptCashboxEffectsRepository()),
    new ReceiptBankingEffectsService(new ReceiptBankingEffectsRepository()),
    foundation,
  );
  const outcomes = new BankInstructionOutcomeService(
    database,
    new BankInstructionOutcomeRepository(),
    authorization,
    foundation,
  );
  try {
    seeded = await seed(database);
  const { baseCurrency, foreignCurrency } = seeded;
  const requestDraft = {
    beneficiaryPartyId: seeded.partyId,
    requestedMoney: { amount: '125000', currency: baseCurrency },
    treasuryUnitId: seeded.treasuryUnitId,
    purpose: 'Approved supplier request',
  };
  const paymentDraft = {
    businessDate: '2026-08-01',
    beneficiaryPartyId: seeded.partyId,
    treasuryUnitId: seeded.treasuryUnitId,
    baseCurrency,
    purpose: 'Approved supplier payment',
    lines: [{
      lineNumber: 1,
      methodId: seeded.methodId,
      money: { amount: '125000', currency: baseCurrency },
      cashboxId: seeded.cashboxId,
      beneficiaryPartyId: seeded.partyId,
    }],
  };

    const request = await service.createRequest(
      seeded.organizationId,
      seeded.actorId,
      requestDraft,
      'request-idempotency-key',
      'request-command',
    );
    assert.match(request.businessNumber, /^PR-[0-9]{8}$/u);
    assert.equal(request.beneficiary.label, 'INC-3A supplier');
    let requestReplay;
    try {
      requestReplay = await service.createRequest(
        seeded.organizationId,
        seeded.actorId,
        requestDraft,
        'request-idempotency-key',
        'request-replay',
      );
    } catch (error) {
      assert.fail(`Request replay failed with ${problemCode(error)}`);
    }
    assert.deepEqual(requestReplay, request);

    const rollbackKey = 'request-invalid-evidence';
    await assert.rejects(service.createRequest(
      seeded.organizationId,
      seeded.actorId,
      {
        ...requestDraft,
        attachments: [{ id: randomUUID(), contentDigest: '0'.repeat(64) }],
      },
      rollbackKey,
      'request-invalid',
    ), isProblem('TRS-PAY-002'));
    const rolledBack = await database.pool.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM idempotency_records
      WHERE organization_id = $1 AND scope = $2 AND idempotency_key = $3
    `, [seeded.organizationId, `createPaymentRequest:${seeded.actorId}`, rollbackKey]);
    assert.equal(rolledBack.rows[0]!.count, '0');

    const createAuthorization = await database.db.transaction(async (transaction) => ({
      grants: await new AccessAuthorizationRepository().paymentGrants(
        transaction,
        seeded!.organizationId,
        seeded!.actorId,
        'payment.create',
      ),
      allowed: await authorization.canCreatePayment(
        transaction,
        seeded!.organizationId,
        seeded!.actorId,
        {
          branchId: seeded!.branchId,
          treasuryUnitId: seeded!.treasuryUnitId,
          cashboxIds: [seeded!.cashboxId],
          bankAccountIds: [],
          currencies: [baseCurrency],
          methodCategories: ['CASH'],
          documentType: 'PAYMENT',
          amount: '125000',
          amountCurrency: baseCurrency,
        },
      ),
    }));
    assert.equal(
      createAuthorization.allowed,
      true,
      `Payment grant coverage: ${JSON.stringify(createAuthorization.grants)}`,
    );

    let concurrent;
    try {
      concurrent = await settledPair(
        service.create(
          seeded.organizationId,
          seeded.actorId,
          paymentDraft,
          'payment-shared-key',
          'payment-a',
        ),
        service.create(
          seeded.organizationId,
          seeded.actorId,
          paymentDraft,
          'payment-shared-key',
          'payment-b',
        ),
      );
    } catch (error) {
      if (error instanceof TreasuryProblem) {
        assert.fail(`Concurrent payment replay failed with ${problemCode(error)}`);
      }
      throw (error as { cause?: unknown }).cause ?? error;
    }
    assert.deepEqual(concurrent[1], concurrent[0]);
    assert.equal(concurrent[0]!.totalBaseAmount.amount, '125000.00000000');
    assert.equal(concurrent[0]!.lines[0]!.rateSnapshot.rateSource, 'IDENTITY');
    const persisted = await database.pool.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM payment_documents
      WHERE organization_id = $1 AND creator_user_id = $2
    `, [seeded.organizationId, seeded.actorId]);
    assert.equal(persisted.rows[0]!.count, '1');
    await database.pool.query(`UPDATE payment_requests SET requester_user_id = $1 WHERE id = $2`, [
      seeded.requesterId,
      request.id,
    ]);
    await database.pool.query(`UPDATE payment_documents SET payment_request_id = $1 WHERE id = $2`, [
      request.id,
      concurrent[0]!.id,
    ]);
    assert.ok((await service.list(
      seeded.organizationId,
      seeded.actorId,
      '10',
    )).items.some(({ id }) => id === concurrent[0]!.id));
    await database.pool.query(`UPDATE method_definitions SET name = 'Renamed after draft' WHERE id = $1`, [
      seeded.methodId,
    ]);
    assert.equal((await service.list(
      seeded.organizationId,
      seeded.actorId,
      '10',
    )).items.find(({ id }) => id === concurrent[0]!.id)!.lines[0]!.method.label, 'Cash payment');
    await database.pool.query(`UPDATE method_definitions SET name = 'Cash payment' WHERE id = $1`, [
      seeded.methodId,
    ]);

    await database.pool.query(`UPDATE method_definitions SET direction = 'RECEIPT' WHERE id = $1`, [
      seeded.methodId,
    ]);
    await assert.rejects(service.create(
      seeded.organizationId,
      seeded.actorId,
      paymentDraft,
      'payment-invalid-method',
      'payment-invalid-method-request',
    ), isProblem('TRS-MST-004'));
    await database.pool.query(`UPDATE method_definitions SET direction = 'PAYMENT' WHERE id = $1`, [
      seeded.methodId,
    ]);

    await database.pool.query(`INSERT INTO method_required_references (method_id, reference)
      VALUES ($1,'EVIDENCE')`, [seeded.methodId]);
    await assert.rejects(service.create(
      seeded.organizationId,
      seeded.actorId,
      paymentDraft,
      'payment-missing-method-evidence',
      'payment-missing-method-evidence-request',
    ), isProblem('TRS-PAY-002'));
    await database.pool.query(`DELETE FROM method_required_references
      WHERE method_id = $1 AND reference = 'EVIDENCE'`, [seeded.methodId]);

    const actorId = seeded.actorId;
    const isolatedFacts = await database.db.transaction((transaction) => repository.requestFacts(
      transaction,
      randomUUID(),
      actorId,
      requestDraft,
    ));
    assert.equal(isolatedFacts.organization, undefined);
    assert.equal(isolatedFacts.requester, undefined);
    assert.equal(isolatedFacts.beneficiary, undefined);
    await assert.rejects(service.createRequest(
      seeded.organizationId,
      randomUUID(),
      requestDraft,
      'request-foreign-actor',
      'request-foreign-actor-request',
    ), isProblem('TRS-GEN-003'));

    const foreignPayment = await service.create(
      seeded.organizationId,
      seeded.actorId,
      {
        ...paymentDraft,
        purpose: 'Foreign supplier payment',
        lines: [{ ...paymentDraft.lines[0], money: { amount: '10', currency: foreignCurrency } }],
      },
      'payment-foreign-rate',
      'payment-foreign-rate-request',
    );
    assert.equal(foreignPayment.lines[0]!.rateSnapshot.rateSource, 'TABLE');
    assert.equal(foreignPayment.lines[0]!.rateSnapshot.rateRecordId, seeded.foreignRateId);
    assert.equal(foreignPayment.lines[0]!.baseAmount.amount, '25.00000000');

    await database.pool.query(`INSERT INTO exchange_rates (
      source_currency, target_currency, rate_type, rate, valid_at, source_name,
      recorded_by, approved_by, state
    ) VALUES ($1,$2,'SELL','2.6','2026-08-01T12:00:00Z','INC-3A QA secondary',$3,$3,'APPROVED')`, [
      foreignCurrency,
      baseCurrency,
      seeded.actorId,
    ]);
    await assert.rejects(service.create(
      seeded.organizationId,
      seeded.actorId,
      {
        ...paymentDraft,
        purpose: 'Ambiguous foreign supplier payment',
        lines: [{ ...paymentDraft.lines[0], money: { amount: '10', currency: foreignCurrency } }],
      },
      'payment-ambiguous-rate',
      'payment-ambiguous-rate-request',
    ), isProblem('TRS-MST-003'));

    await database.pool.query(`
      UPDATE access_grants SET state = 'REVOKED' WHERE id = $1
    `, [seeded.paymentGrantId]);
    assert.deepEqual((await service.list(
      seeded.organizationId,
      seeded.actorId,
      '10',
    )).items, []);
    await assert.rejects(service.create(
      seeded.organizationId,
      seeded.actorId,
      paymentDraft,
      'payment-shared-key',
      'payment-replay-after-revoke',
    ), isProblem('TRS-GEN-003'));
    await database.pool.query(`
      UPDATE access_grants SET state = 'ACTIVE' WHERE id = $1
    `, [seeded.paymentGrantId]);

    const submitted = await settledPair(
      approvalService.submit(
        seeded.organizationId,
        seeded.actorId,
        concurrent[0]!.id,
        'payment-submit-shared',
        '"0"',
        'payment-submit-a',
      ),
      approvalService.submit(
        seeded.organizationId,
        seeded.actorId,
        concurrent[0]!.id,
        'payment-submit-shared',
        '"0"',
        'payment-submit-b',
      ),
    );
    assert.deepEqual(submitted[1], submitted[0]);
    assert.equal(submitted[0]!.state, 'APPROVAL_PENDING');
    assert.equal(submitted[0]!.version, 1);
    assert.equal(submitted[0]!.approvalSnapshot?.documentVersion, 1);
    assert.equal(submitted[0]!.approvalSnapshot?.paymentAggregation?.participants.length, 1);
    await assert.rejects(approvalService.act(
      seeded.organizationId,
      seeded.actorId,
      concurrent[0]!.id,
      { action: PaymentApprovalAction.APPROVE },
      'payment-creator-denied',
      '"1"',
      'payment-creator-denied',
    ), isProblem('TRS-GEN-003'));

    await assert.rejects(approvalService.act(
      seeded.organizationId,
      seeded.requesterId,
      concurrent[0]!.id,
      { action: PaymentApprovalAction.APPROVE },
      'payment-requester-denied',
      '"1"',
      'payment-requester-denied',
    ), isProblem('TRS-GEN-003'));

    const approved = await settledPair(
      approvalService.act(
        seeded.organizationId,
        seeded.delegateId,
        concurrent[0]!.id,
        { action: PaymentApprovalAction.APPROVE },
        'payment-approve-shared',
        '"1"',
        'payment-approve-a',
      ),
      approvalService.act(
        seeded.organizationId,
        seeded.delegateId,
        concurrent[0]!.id,
        { action: PaymentApprovalAction.APPROVE },
        'payment-approve-shared',
        '"1"',
        'payment-approve-b',
      ),
    );
    assert.deepEqual(approved[1], approved[0]);
    assert.equal(approved[0]!.state, 'APPROVED');
    assert.equal(approved[0]!.version, 2);
    assert.equal(approved[0]!.approvalSnapshot?.steps[0]?.approvalsRecorded, 1);
    assert.equal(
      approved[0]!.approvalSnapshot?.actions.at(-1)?.delegatedFromUserId,
      seeded.approverId,
    );
    assert.deepEqual(await approvalService.act(
      seeded.organizationId,
      seeded.delegateId,
      concurrent[0]!.id,
      { action: PaymentApprovalAction.APPROVE },
      'payment-approve-shared',
      '"1"',
      'payment-approve-replay',
    ), approved[0]);
    await database.pool.query(`UPDATE delegations SET revoked_at = now(), revoked_by_user_id = $1
      WHERE id = $2`, [seeded.approverId, seeded.approvalDelegationId]);
    await assert.rejects(
      database.pool.query(`UPDATE delegations SET reason = 'Broadened after creation' WHERE id = $1`, [
        seeded.approvalDelegationId,
      ]),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
    await assert.rejects(approvalService.act(
      seeded.organizationId,
      seeded.delegateId,
      concurrent[0]!.id,
      { action: PaymentApprovalAction.APPROVE },
      'payment-approve-shared',
      '"1"',
      'payment-approve-replay-after-revoke',
    ), isProblem('TRS-GEN-003'));
    const approvalActions = await database.pool.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM payment_approval_actions
      WHERE organization_id = $1 AND actor_user_id = $2
    `, [seeded.organizationId, seeded.delegateId]);
    assert.equal(approvalActions.rows[0]!.count, '1');

    const unresolved = await service.create(
      seeded.organizationId,
      seeded.actorId,
      { ...paymentDraft, purpose: 'Unresolved policy payment' },
      'payment-unresolved-draft',
      'payment-unresolved-draft',
    );
    await database.pool.query(`UPDATE payment_approval_policies SET state = 'RETIRED'
      WHERE id = $1`, [seeded.approvalPolicyId]);
    await assert.rejects(approvalService.submit(
      seeded.organizationId,
      seeded.actorId,
      unresolved.id,
      'payment-unresolved-submit',
      '"0"',
      'payment-unresolved-submit',
    ), isProblem('TRS-PAY-008'));
    const unresolvedIdempotency = await database.pool.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM idempotency_records
      WHERE organization_id = $1 AND scope = $2 AND idempotency_key = $3
    `, [
      seeded.organizationId,
      `submitPayment:${seeded.actorId}:${unresolved.id}`,
      'payment-unresolved-submit',
    ]);
    assert.equal(unresolvedIdempotency.rows[0]!.count, '0');
    await database.pool.query(`UPDATE payment_approval_policies SET state = 'ACTIVE'
      WHERE id = $1`, [seeded.approvalPolicyId]);

    const aggregateDraft = await service.create(
      seeded.organizationId,
      seeded.actorId,
      { ...paymentDraft, purpose: 'Aggregate participant payment' },
      'payment-aggregate-draft',
      'payment-aggregate-draft',
    );
    await database.pool.query(`UPDATE payment_documents SET payment_request_id = $1 WHERE id = $2`, [
      request.id,
      aggregateDraft.id,
    ]);
    await assert.rejects(approvalService.submit(
      seeded.organizationId,
      seeded.actorId,
      aggregateDraft.id,
      'payment-stale-submit',
      '"9"',
      'payment-stale-submit',
    ), isProblem('TRS-GEN-006'));
    const aggregateSubmitted = await approvalService.submit(
      seeded.organizationId,
      seeded.actorId,
      aggregateDraft.id,
      'payment-aggregate-submit',
      '"0"',
      'payment-aggregate-submit',
    );
    assert.equal(aggregateSubmitted.approvalSnapshot?.paymentAggregation?.participants.length, 2);
    assert.deepEqual(
      aggregateSubmitted.approvalSnapshot?.paymentAggregation?.participants.map((participant) =>
        participant.versionBasis).sort(),
      ['LIVE_AGGREGATE', 'SUBMITTED_CONTENT'],
    );
    assert.equal(
      aggregateSubmitted.approvalSnapshot?.amountBasis.amount,
      '250000.00000000',
    );
    await database.pool.query(`UPDATE payment_documents SET version = version + 1
      WHERE organization_id = $1 AND id = $2`, [seeded.organizationId, concurrent[0]!.id]);
    await assert.rejects(approvalService.act(
      seeded.organizationId,
      seeded.approverId,
      aggregateDraft.id,
      { action: PaymentApprovalAction.APPROVE },
      'payment-stale-aggregate',
      '"1"',
      'payment-stale-aggregate',
    ), isProblem('TRS-PAY-007'));

    const guard = await database.pool.connect();
    try {
      await guard.query('BEGIN');
      await guard.query(`
        UPDATE payment_documents SET total_base_amount = total_base_amount + 1
        WHERE organization_id = $1 AND id = $2
      `, [seeded.organizationId, concurrent[0]!.id]);
      await assert.rejects(
        guard.query('COMMIT'),
        (error: unknown) => (error as { code?: string }).code === '23514',
      );
    } finally {
      await guard.query('ROLLBACK').catch(() => undefined);
      guard.release();
    }
    const unchanged = await database.pool.query<{ total: string }>(`
      SELECT total_base_amount::text AS total FROM payment_documents
      WHERE organization_id = $1 AND id = $2
    `, [seeded.organizationId, concurrent[0]!.id]);
    assert.equal(unchanged.rows[0]!.total, '125000.00000000');

    const executeContext = {
      organizationId: seeded.organizationId,
      actorUserId: seeded.executorId,
      physicalSessionId: 'not-required',
      paymentId: concurrent[0]!.id,
      key: 'payment-execute-shared',
      ifMatch: '"3"',
      requestId: 'payment-execute-request',
    };
    await assert.rejects(execution.execute({
      ...executeContext,
      actorUserId: seeded.actorId,
      key: 'payment-execute-creator',
    }), isProblem('TRS-GEN-003'));

    const competingReservationId = randomUUID();
    await database.pool.query(`
      INSERT INTO payment_reservations (
        id, organization_id, payment_document_id, source_type, source_id,
        amount, currency, review_due_at, state
      ) VALUES ($1,$2,$3,'CASHBOX',$4,400000,$5,now() - interval '1 minute','REVIEW_REQUIRED')
    `, [
      competingReservationId,
      seeded.organizationId,
      aggregateDraft.id,
      seeded.cashboxId,
      baseCurrency,
    ]);
    await assert.rejects(execution.execute({
      ...executeContext,
      key: 'payment-execute-reserved',
    }), isProblem('TRS-PAY-004'));
    await database.pool.query('DELETE FROM payment_reservations WHERE id = $1', [
      competingReservationId,
    ]);

    const allocationIds = [randomUUID(), randomUUID()];
    await database.pool.query(`
      INSERT INTO payment_allocations (
        id, organization_id, payment_document_id, source_namespace,
        external_object_type, external_object_id, allocated_amount, currency,
        known_obligation_total, state
      ) VALUES
        ($1,$3,$4,'accounting.qa','INVOICE','invoice-overpay',70000,$6,100000,'ACTIVE'),
        ($2,$3,$5,'accounting.qa','INVOICE','invoice-overpay',70000,$6,100000,'ACTIVE')
    `, [
      allocationIds[0], allocationIds[1], seeded.organizationId,
      concurrent[0]!.id, aggregateDraft.id, baseCurrency,
    ]);
    await assert.rejects(execution.execute({
      ...executeContext,
      key: 'payment-execute-overallocated',
    }), isProblem('TRS-PAY-006'));
    await database.pool.query('DELETE FROM payment_allocations WHERE id = ANY($1::uuid[])', [
      allocationIds,
    ]);

    await database.pool.query(`
      UPDATE cashbox_currency_controls SET minimum_position = 500000
      WHERE cashbox_id = $1 AND currency = $2
    `, [seeded.cashboxId, baseCurrency]);
    await assert.rejects(execution.execute({
      ...executeContext,
      key: 'payment-execute-rollback',
    }), isProblem('TRS-PAY-004'));
    const executeRollback = await database.pool.query<{ count: string; state: string }>(`
      SELECT
        (SELECT count(*)::text FROM idempotency_records
          WHERE organization_id = $1 AND scope = $2 AND idempotency_key = $3) AS count,
        (SELECT state FROM payment_documents WHERE organization_id = $1 AND id = $4) AS state
    `, [
      seeded.organizationId,
      `executePayment:${seeded.executorId}:${concurrent[0]!.id}`,
      'payment-execute-rollback',
      concurrent[0]!.id,
    ]);
    assert.deepEqual(executeRollback.rows[0], { count: '0', state: 'APPROVED' });
    await database.pool.query(`
      UPDATE cashbox_currency_controls SET minimum_position = NULL
      WHERE cashbox_id = $1 AND currency = $2
    `, [seeded.cashboxId, baseCurrency]);

    await assert.rejects(execution.execute({
      ...executeContext,
      key: 'payment-execute-stale',
      ifMatch: '"2"',
    }), isProblem('TRS-GEN-006'));
    const executed = await settledPair(
      execution.execute(executeContext),
      execution.execute({ ...executeContext, requestId: 'payment-execute-replay' }),
    );
    assert.deepEqual(executed[1], executed[0]);
    assert.equal(executed[0]!.state, 'EXECUTED');
    assert.equal(executed[0]!.version, 4);
    assert.equal(executed[0]!.lines[0]!.executionEffects?.length, 1);
    const executionFacts = await database.pool.query<{
      effects: string;
      movements: string;
      audits: string;
      outbox: string;
    }>(`
      SELECT
        (SELECT count(*)::text FROM payment_execution_effects effect
          JOIN payment_lines line ON line.id = effect.payment_line_id
          WHERE line.payment_document_id = $1) AS effects,
        (SELECT count(*)::text FROM movement_facts
          WHERE organization_id = $2 AND owner = 'domain.payments' AND source_id = $1) AS movements,
        (SELECT count(*)::text FROM audit_events
          WHERE organization_id = $2 AND entity_type = 'Payment' AND entity_id = $1
            AND action = 'PAYMENT_EXECUTED') AS audits,
        (SELECT count(*)::text FROM outbox_events
          WHERE organization_id = $2 AND aggregate_type = 'Payment' AND aggregate_id = $1
            AND event_type = 'treasury.payment.executed.v1') AS outbox
    `, [concurrent[0]!.id, seeded.organizationId]);
    assert.deepEqual(executionFacts.rows[0], {
      effects: '1', movements: '1', audits: '1', outbox: '1',
    });

    const reverseBody = { reason: 'Execution correction', businessDate: '2026-08-02' };
    const reverseKey = 'payment-reverse-shared';
    await assert.rejects(execution.reverse({
      organizationId: seeded.organizationId,
      actorUserId: seeded.reverserId,
      physicalSessionId: seeded.reverserSessionId,
      paymentId: concurrent[0]!.id,
      key: 'payment-reverse-no-step',
      ifMatch: '"4"',
      requestId: 'payment-reverse-no-step',
    }, reverseBody), isProblem('TRS-AUT-005'));
    const reverseStep = await paymentStep(
      database,
      seeded.reverserAccountId,
      seeded.reverserSessionId,
      'reversePayment',
      `/v1/payments/${concurrent[0]!.id}/reverse`,
      reverseBody,
      reverseKey,
    );
    await assert.rejects(execution.reverse({
      organizationId: seeded.organizationId,
      actorUserId: seeded.reverserId,
      physicalSessionId: seeded.reverserSessionId,
      paymentId: concurrent[0]!.id,
      key: reverseKey,
      ifMatch: '"3"',
      requestId: 'payment-reverse-stale',
      stepUp: reverseStep,
    }, reverseBody), isProblem('TRS-GEN-006'));
    const reversed = await settledPair(
      execution.reverse({
        organizationId: seeded.organizationId,
        actorUserId: seeded.reverserId,
        physicalSessionId: seeded.reverserSessionId,
        paymentId: concurrent[0]!.id,
        key: reverseKey,
        ifMatch: '"4"',
        requestId: 'payment-reverse-a',
        stepUp: reverseStep,
      }, reverseBody),
      execution.reverse({
        organizationId: seeded.organizationId,
        actorUserId: seeded.reverserId,
        physicalSessionId: seeded.reverserSessionId,
        paymentId: concurrent[0]!.id,
        key: reverseKey,
        ifMatch: '"4"',
        requestId: 'payment-reverse-b',
        stepUp: reverseStep,
      }, reverseBody),
    );
    assert.deepEqual(reversed[1], reversed[0]);
    assert.equal(reversed[0]!.original.state, 'REVERSED');
    assert.equal(reversed[0]!.reversal.state, 'EXECUTED');
    assert.equal(reversed[0]!.reversal.lines[0]!.executionEffects?.[0]?.direction, 'REVERSAL');
    const inverse = await database.pool.query<{ amount: string; currency: string; links: string }>(`
      SELECT inverse.amount::text, inverse.currency,
             count(*) FILTER (WHERE inverse.reversal_of_fact_id = original.id)::text AS links
      FROM movement_facts inverse
      JOIN movement_facts original ON original.organization_id = inverse.organization_id
        AND original.id = inverse.reversal_of_fact_id
      WHERE inverse.organization_id = $1 AND inverse.source_id = $2
      GROUP BY inverse.amount, inverse.currency
    `, [seeded.organizationId, reversed[0]!.reversal.id]);
    assert.deepEqual(inverse.rows[0], {
      amount: '125000.00000000', currency: baseCurrency, links: '1',
    });

    const bankDraft = await service.create(
      seeded.organizationId,
      seeded.actorId,
      {
        ...paymentDraft,
        purpose: 'Bank instruction outcome payment',
        lines: [{
          lineNumber: 1,
          methodId: seeded.bankMethodId,
          money: { amount: '100000', currency: baseCurrency },
          bankAccountId: seeded.bankAccountId,
          beneficiaryPartyId: seeded.partyId,
          beneficiaryAccountReference: 'IR-INC-3C-BENEFICIARY',
        }],
      },
      'bank-payment-create',
      'bank-payment-create',
    );
    await approvalService.submit(
      seeded.organizationId,
      seeded.actorId,
      bankDraft.id,
      'bank-payment-submit',
      '"0"',
      'bank-payment-submit',
    );
    await approvalService.act(
      seeded.organizationId,
      seeded.approverId,
      bankDraft.id,
      { action: PaymentApprovalAction.APPROVE },
      'bank-payment-approve',
      '"1"',
      'bank-payment-approve',
    );
    const executedBank = await execution.execute({
      organizationId: seeded.organizationId,
      actorUserId: seeded.executorId,
      physicalSessionId: 'not-required',
      paymentId: bankDraft.id,
      key: 'bank-payment-execute',
      ifMatch: '"2"',
      requestId: 'bank-payment-execute',
    });
    const instructionId = executedBank.lines[0]!.executionEffects!
      .find(({ effectType }) => effectType === 'BANK_INSTRUCTION')!.effect.id;
    const bankReverseBody = { reason: 'Bank correction', businessDate: '2026-08-02' };
    const bankReverseKey = 'bank-payment-reverse';
    const bankReverseStep = await paymentStep(
      database,
      seeded.reverserAccountId,
      seeded.reverserSessionId,
      'reversePayment',
      `/v1/payments/${bankDraft.id}/reverse`,
      bankReverseBody,
      bankReverseKey,
    );
    const bankReversal = await execution.reverse({
      organizationId: seeded.organizationId,
      actorUserId: seeded.reverserId,
      physicalSessionId: seeded.reverserSessionId,
      paymentId: bankDraft.id,
      key: bankReverseKey,
      ifMatch: '"3"',
      requestId: 'bank-payment-reverse',
      stepUp: bankReverseStep,
    }, bankReverseBody);

    const confirmedBody = {
      outcome: BankInstructionOutcome.CONFIRMED,
      effectiveAt: '2026-08-02T09:00:00.000Z',
      attachments: [{ id: seeded.attachmentId, contentDigest: 'a'.repeat(64) }],
    };
    await assert.rejects(outcomes.record(
      seeded.organizationId,
      seeded.executorId,
      instructionId,
      'outcome-invalid-evidence',
      '"0"',
      'outcome-invalid-evidence',
      { ...confirmedBody, attachments: [{ id: randomUUID(), contentDigest: 'a'.repeat(64) }] },
    ), isProblem('TRS-BNK-005'));
    await assert.rejects(outcomes.record(
      seeded.organizationId,
      seeded.executorId,
      instructionId,
      'outcome-stale-version',
      '"1"',
      'outcome-stale-version',
      confirmedBody,
    ), isProblem('TRS-GEN-006'));
    const confirmed = await settledPair(
      outcomes.record(
        seeded.organizationId,
        seeded.executorId,
        instructionId,
        'outcome-confirm-shared',
        '"0"',
        'outcome-confirm-a',
        confirmedBody,
      ),
      outcomes.record(
        seeded.organizationId,
        seeded.executorId,
        instructionId,
        'outcome-confirm-shared',
        '"0"',
        'outcome-confirm-b',
        confirmedBody,
      ),
    );
    assert.deepEqual(confirmed[1], confirmed[0]);
    assert.equal(confirmed[0]!.state, 'CONFIRMED');
    const returnedBody = {
      outcome: BankInstructionOutcome.RETURNED,
      effectiveAt: '2026-08-02T10:00:00.000Z',
      reason: 'Bank returned the confirmed transfer',
      correctionPaymentId: bankReversal.reversal.id,
      attachments: [{ id: seeded.attachmentId, contentDigest: 'a'.repeat(64) }],
    };
    await assert.rejects(outcomes.record(
      seeded.organizationId,
      seeded.executorId,
      instructionId,
      'outcome-returned-executor',
      '"1"',
      'outcome-returned-executor',
      returnedBody,
    ), isProblem('TRS-BNK-005'));
    const returned = await outcomes.record(
      seeded.organizationId,
      seeded.reverserId,
      instructionId,
      'outcome-returned',
      '"1"',
      'outcome-returned',
      returnedBody,
    );
    assert.equal(returned.state, 'RETURNED');
    assert.deepEqual(returned.outcomes.map(({ sequenceNo, outcome }) => ({ sequenceNo, outcome })), [
      { sequenceNo: 1, outcome: BankInstructionOutcome.CONFIRMED },
      { sequenceNo: 2, outcome: BankInstructionOutcome.RETURNED },
    ]);
    const bankOutbox = await database.pool.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM outbox_events
      WHERE organization_id = $1 AND aggregate_type = 'BankInstruction' AND aggregate_id = $2
    `, [seeded.organizationId, instructionId]);
    assert.equal(bankOutbox.rows[0]!.count, '0');
  } finally {
    if (seeded) {
      await cleanup(database, seeded);
    }
    await database.onModuleDestroy();
  }
});

async function seed(database: DatabaseService) {
  let organizationId: string = randomUUID();
  let branchId: string = randomUUID();
  let treasuryUnitId: string = randomUUID();
  let ownsFoundation = true;
  let ownsForeignCurrency = false;
  let ownsBranch = false;
  let ownsTreasuryUnit = false;
  let baseCurrency = 'IRR';
  let foreignCurrency = 'USD';
  const actorId = randomUUID();
  const approverId = randomUUID();
  const requesterId = randomUUID();
  const delegateId = randomUUID();
  const executorId = randomUUID();
  const reverserId = randomUUID();
  const executorGrantId = randomUUID();
  const reverserGrantId = randomUUID();
  const actorBankGrantId = randomUUID();
  const approverBankGrantId = randomUUID();
  const executorBankGrantId = randomUUID();
  const reverserBankGrantId = randomUUID();
  const reverserAccountId = randomUUID();
  const reverserSessionId = randomUUID();
  const partyId = randomUUID();
  const methodId = randomUUID();
  const bankMethodId = randomUUID();
  const cashboxId = randomUUID();
  const bankTypeId = randomUUID();
  const bankId = randomUUID();
  const bankAccountId = randomUUID();
  const attachmentId = randomUUID();
  const requestRoleId = randomUUID();
  const paymentRoleId = randomUUID();
  const approvalRoleId = randomUUID();
  const alternateRoleId = randomUUID();
  const requestGrantId = randomUUID();
  const paymentGrantId = randomUUID();
  const approvalGrantId = randomUUID();
  const alternateGrantId = randomUUID();
  const requesterDelegationId = randomUUID();
  const approvalDelegationId = randomUUID();
  const approvalPolicyId = randomUUID();
  const bankApprovalPolicyId = randomUUID();
  const foreignRateId = randomUUID();
  const suffix = actorId.slice(0, 8).toUpperCase();
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    const existing = await client.query<{ id: string; base_currency: string }>(`
      SELECT id, base_currency FROM organizations ORDER BY created_at LIMIT 1
    `);
    if (existing.rows[0]) {
      organizationId = existing.rows[0].id;
      baseCurrency = existing.rows[0].base_currency;
      foreignCurrency = baseCurrency === 'USD' ? 'IRR' : 'USD';
      ownsFoundation = false;
      const insertedForeign = await client.query(`
        INSERT INTO currencies (organization_id, code, name, decimal_places, base_currency)
        VALUES ($1,$2,$3,2,false)
        ON CONFLICT (organization_id, code) DO NOTHING
        RETURNING code
      `, [organizationId, foreignCurrency, `Test ${foreignCurrency}`]);
      ownsForeignCurrency = insertedForeign.rowCount === 1;
      const existingBranch = await client.query<{ id: string }>(`
        SELECT id FROM branches
        WHERE organization_id = $1 AND state = 'ACTIVE'
        ORDER BY created_at LIMIT 1
      `, [organizationId]);
      if (existingBranch.rows[0]) {
        branchId = existingBranch.rows[0].id;
      } else {
        await client.query(`
          INSERT INTO branches (id, organization_id, code, name)
          VALUES ($1,$2,$3,'INC-3A branch')
        `, [branchId, organizationId, `BR-${suffix}`]);
        ownsBranch = true;
      }
      const existingUnit = await client.query<{ id: string }>(`
        SELECT id FROM treasury_units
        WHERE organization_id = $1 AND branch_id = $2 AND state = 'ACTIVE'
        ORDER BY created_at LIMIT 1
      `, [organizationId, branchId]);
      if (existingUnit.rows[0]) {
        treasuryUnitId = existingUnit.rows[0].id;
      } else {
        await client.query(`
          INSERT INTO treasury_units (id, organization_id, code, name, branch_id, default_currency)
          VALUES ($1,$2,$3,'INC-3A treasury unit',$4,$5)
        `, [treasuryUnitId, organizationId, `TU-${suffix}`, branchId, baseCurrency]);
        ownsTreasuryUnit = true;
      }
    } else {
      await client.query(`
        INSERT INTO organizations (id, code, legal_name, timezone, base_currency)
        VALUES ($1,$2,'INC-3A organization','Asia/Tehran','IRR')
      `, [organizationId, `PAY-${suffix}`]);
      await client.query(`
        INSERT INTO currencies (organization_id, code, name, decimal_places, base_currency)
        VALUES ($1,$2,$3,2,true),($1,$4,$5,2,false)
      `, [organizationId, baseCurrency, `Test ${baseCurrency}`, foreignCurrency, `Test ${foreignCurrency}`]);
      await client.query(`
        INSERT INTO branches (id, organization_id, code, name)
        VALUES ($1,$2,$3,'INC-3A branch')
      `, [branchId, organizationId, `BR-${suffix}`]);
      await client.query(`
        INSERT INTO treasury_units (id, organization_id, code, name, branch_id, default_currency)
        VALUES ($1,$2,$3,'INC-3A treasury unit',$4,$5)
      `, [treasuryUnitId, organizationId, `TU-${suffix}`, branchId, baseCurrency]);
    }
    await client.query(`
      INSERT INTO user_refs (id, organization_id, subject_key, display_name)
      VALUES ($1,$5,$6,'INC-3A creator'),($2,$5,$7,'INC-3B approver'),
             ($3,$5,$8,'INC-3B requester'),($4,$5,$9,'INC-3B delegate')
    `, [
      actorId, approverId, requesterId, delegateId, organizationId,
      `actor-${suffix}`, `approver-${suffix}`, `requester-${suffix}`, `delegate-${suffix}`,
    ]);
    await client.query(`
      INSERT INTO user_refs (id, organization_id, subject_key, display_name)
      VALUES ($1,$3,$4,'INC-3C executor'),($2,$3,$5,'INC-3C reverser')
    `, [executorId, reverserId, organizationId, `executor-${suffix}`, `reverser-${suffix}`]);
    await client.query(`
      INSERT INTO identity_accounts (
        id, user_ref_id, normalized_login, password_hash, privileged
      ) VALUES ($1,$2,$3,'test-password-hash',false)
    `, [reverserAccountId, reverserId, `reverser.${suffix.toLowerCase()}`]);
    await client.query(`
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
    await client.query(`
      INSERT INTO exchange_rates (
        id, source_currency, target_currency, rate_type, rate, valid_at, source_name,
        recorded_by, approved_by, state
      ) VALUES ($1,$2,$3,'SELL','2.5','2026-08-01T12:00:00Z',
        'INC-3A QA primary',$4,$4,'APPROVED')
    `, [foreignRateId, foreignCurrency, baseCurrency, actorId]);
    await client.query(`
      INSERT INTO parties (id, organization_id, code, display_name)
      VALUES ($1,$2,$3,'INC-3A supplier')
    `, [partyId, organizationId, `SUP-${suffix}`]);
    await client.query(`
      INSERT INTO method_definitions (
        id, organization_id, code, name, direction, behavior_category,
        creates_funds_in_transit, requires_approval
      ) VALUES ($1,$2,$3,'Cash payment','PAYMENT',$4,false,false)
    `, [methodId, organizationId, `MTH-${suffix}`, MethodBehaviorCategory.CASH]);
    await client.query(`
      INSERT INTO method_required_references (method_id, reference) VALUES ($1,$2)
    `, [methodId, MethodReference.CASHBOX]);
    await client.query(`
      INSERT INTO method_allowed_currencies (method_id, organization_id, currency_code)
      VALUES ($1,$2,$3),($1,$2,$4)
    `, [methodId, organizationId, baseCurrency, foreignCurrency]);
    await client.query(`
      INSERT INTO method_definitions (
        id, organization_id, code, name, direction, behavior_category,
        creates_funds_in_transit, requires_approval
      ) VALUES ($1,$2,$3,'Bank transfer','PAYMENT','BANK_TRANSFER',true,false)
    `, [bankMethodId, organizationId, `BNK-${suffix}`]);
    await client.query(`
      INSERT INTO method_required_references (method_id, reference)
      VALUES ($1,'BANK_ACCOUNT')
    `, [bankMethodId]);
    await client.query(`
      INSERT INTO method_allowed_currencies (method_id, organization_id, currency_code)
      VALUES ($1,$2,$3)
    `, [bankMethodId, organizationId, baseCurrency]);
    await client.query(`
      INSERT INTO cashboxes (
        id, organization_id, branch_id, treasury_unit_id, code, name, cashbox_type,
        main_currency, can_receive, can_pay, can_transfer, requires_approval, active_from
      ) VALUES ($1,$2,$3,$4,$5,'INC-3A cashbox','CASH',$6,true,true,false,false,'2026-01-01')
    `, [cashboxId, organizationId, branchId, treasuryUnitId, `CB-${suffix}`, baseCurrency]);
    await client.query(`
      INSERT INTO cashbox_currency_controls (cashbox_id, organization_id, currency, allow_negative)
      VALUES ($1,$2,$3,false),($1,$2,$4,false)
    `, [cashboxId, organizationId, baseCurrency, foreignCurrency]);
    await client.query(`
      INSERT INTO bank_types (id, organization_id, code, display_name)
      VALUES ($1,$2,$3,'INC-3C commercial bank')
    `, [bankTypeId, organizationId, `BT-${suffix}`]);
    await client.query(`
      INSERT INTO banks (id, organization_id, bank_type_id, code, display_name, country_code)
      VALUES ($1,$2,$3,$4,'INC-3C bank','IR')
    `, [bankId, organizationId, bankTypeId, `BANK-${suffix}`]);
    await client.query(`
      INSERT INTO bank_accounts (
        id, organization_id, bank_id, treasury_unit_id, account_type,
        account_number, currency, legal_owner_name, opening_date,
        cheque_enabled, can_receive, can_pay, can_transfer, state, version
      ) VALUES (
        $1,$2,$3,$4,'CURRENT',$5,$6,'INC-3C organization','2026-01-01',
        false,true,true,true,'ACTIVE',1
      )
    `, [bankAccountId, organizationId, bankId, treasuryUnitId, `ACC-${suffix}`, baseCurrency]);
    await client.query(`
      INSERT INTO attachments (
        id, organization_id, content_digest, attachment_version, file_name,
        media_type, byte_length, storage_ref, state, created_by
      ) VALUES ($1,$2,$3,1,'bank-outcome.txt','text/plain',1,$4,'ACTIVE',$5)
    `, [attachmentId, organizationId, 'a'.repeat(64), `qa/${suffix}/bank-outcome`, executorId]);
    await client.query(`
      INSERT INTO movement_facts (
        organization_id, owner, source_type, source_id, source_line_id,
        effect_key, endpoint_type, endpoint_id, direction, amount, currency,
        business_date, state
      ) VALUES
        ($1,'qa.seed','QA',$2,$3,$4,'CASHBOX',$5,'CREDIT',500000,$8,'2026-08-01','POSTED'),
        ($1,'qa.seed','QA',$2,$3,$6,'BANK_ACCOUNT',$7,'CREDIT',500000,$8,'2026-08-01','POSTED')
    `, [
      organizationId, actorId, randomUUID(), `cash-seed-${suffix}`, cashboxId,
      `bank-seed-${suffix}`, bankAccountId, baseCurrency,
    ]);
    await client.query(`
      INSERT INTO roles (id, organization_id, code, name) VALUES
        ($1,$3,$4,'Payment Request creator'),
        ($2,$3,$5,'Payment creator and viewer'),
        ($6,$3,$7,'Payment approver'),
        ($8,$3,$9,'Alternate payment approver')
    `, [
      requestRoleId,
      paymentRoleId,
      organizationId,
      `REQ-${suffix}`,
      `PAY-${suffix}`,
      approvalRoleId,
      `APR-${suffix}`,
      alternateRoleId,
      `ALT-${suffix}`,
    ]);
    await client.query(`
      INSERT INTO role_permissions (role_id, permission) VALUES
        ($1,'payment-request.create'),
        ($2,'payment.create'),
        ($2,'payment.view'),
        ($2,'payment.submit'),
        ($2,'payment.execute'),
        ($2,'payment.reverse'),
        ($2,'bank-instruction.record-outcome'),
        ($3,'payment.approve'),
        ($3,'payment.reject'),
        ($4,'payment.approve')
    `, [requestRoleId, paymentRoleId, approvalRoleId, alternateRoleId]);
    await client.query(`
      INSERT INTO access_grants (
        id, organization_id, user_ref_id, role_id, scope_type, scope_id, organization_wide
      ) VALUES
        ($1,$3,$4,$5,'ORGANIZATION',$3,false),
        ($2,$3,$4,$6,'ORGANIZATION',$3,false),
        ($7,$3,$8,$9,'ORGANIZATION',$3,false),
        ($10,$3,$11,$12,'ORGANIZATION',$3,false)
    `, [
      requestGrantId,
      paymentGrantId,
      organizationId,
      actorId,
      requestRoleId,
      paymentRoleId,
      approvalGrantId,
      approverId,
      approvalRoleId,
      alternateGrantId,
      delegateId,
      alternateRoleId,
    ]);
    await client.query(`
      INSERT INTO access_grants (
        id, organization_id, user_ref_id, role_id, scope_type, scope_id, organization_wide
      ) VALUES
        ($1,$3,$4,$5,'ORGANIZATION',$3,false),
        ($2,$3,$6,$5,'ORGANIZATION',$3,false)
    `, [executorGrantId, reverserGrantId, organizationId, executorId, paymentRoleId, reverserId]);
    await client.query(`
      INSERT INTO access_grants (
        id, organization_id, user_ref_id, role_id, scope_type, scope_id, organization_wide
      ) VALUES
        ($1,$5,$6,$7,'ORGANIZATION',$5,false),
        ($2,$5,$8,$9,'ORGANIZATION',$5,false),
        ($3,$5,$10,$7,'ORGANIZATION',$5,false),
        ($4,$5,$11,$7,'ORGANIZATION',$5,false)
    `, [
      actorBankGrantId,
      approverBankGrantId,
      executorBankGrantId,
      reverserBankGrantId,
      organizationId,
      actorId,
      paymentRoleId,
      approverId,
      approvalRoleId,
      executorId,
      reverserId,
    ]);
    await client.query(`
      INSERT INTO access_grant_treasury_unit_scopes (access_grant_id, treasury_unit_id)
      VALUES ($1,$3),($2,$3),($4,$3),($5,$3)
    `, [requestGrantId, paymentGrantId, treasuryUnitId, approvalGrantId, alternateGrantId]);
    await client.query(`
      INSERT INTO access_grant_branch_scopes (access_grant_id, branch_id)
      VALUES ($1,$3),($2,$3),($4,$3),($5,$3)
    `, [requestGrantId, paymentGrantId, branchId, approvalGrantId, alternateGrantId]);
    await client.query(`
      INSERT INTO access_grant_document_type_scopes (access_grant_id, document_type)
      VALUES ($1,'PAYMENT_REQUEST'),($2,'PAYMENT'),($3,'PAYMENT'),($4,'PAYMENT')
    `, [requestGrantId, paymentGrantId, approvalGrantId, alternateGrantId]);
    await client.query(`
      INSERT INTO access_grant_currency_scopes (access_grant_id, organization_id, currency)
      VALUES ($1,$3,$6),($1,$3,$7),($2,$3,$6),($2,$3,$7),
             ($4,$3,$6),($4,$3,$7),($5,$3,$6),($5,$3,$7)
    `, [
      requestGrantId,
      paymentGrantId,
      organizationId,
      approvalGrantId,
      alternateGrantId,
      baseCurrency,
      foreignCurrency,
    ]);
    await client.query(`
      INSERT INTO access_grant_cashbox_scopes (access_grant_id, cashbox_id)
      VALUES ($1,$2),($3,$2),($4,$2)
    `, [paymentGrantId, cashboxId, approvalGrantId, alternateGrantId]);
    await client.query(`
      INSERT INTO access_grant_method_category_scopes (access_grant_id, method_category)
      VALUES ($1,'CASH'),($2,'CASH'),($3,'CASH')
    `, [paymentGrantId, approvalGrantId, alternateGrantId]);
    for (const grantId of [executorGrantId, reverserGrantId]) {
      await client.query(`
        INSERT INTO access_grant_treasury_unit_scopes (access_grant_id, treasury_unit_id)
        VALUES ($1,$2)
      `, [grantId, treasuryUnitId]);
      await client.query(`
        INSERT INTO access_grant_branch_scopes (access_grant_id, branch_id)
        VALUES ($1,$2)
      `, [grantId, branchId]);
      await client.query(`
        INSERT INTO access_grant_document_type_scopes (access_grant_id, document_type)
        VALUES ($1,'PAYMENT')
      `, [grantId]);
      await client.query(`
        INSERT INTO access_grant_currency_scopes (access_grant_id, organization_id, currency)
        VALUES ($1,$2,$3)
      `, [grantId, organizationId, baseCurrency]);
      await client.query(`
        INSERT INTO access_grant_cashbox_scopes (access_grant_id, cashbox_id)
        VALUES ($1,$2)
      `, [grantId, cashboxId]);
      await client.query(`
        INSERT INTO access_grant_method_category_scopes (access_grant_id, method_category)
        VALUES ($1,'CASH')
      `, [grantId]);
    }
    for (const grantId of [
      actorBankGrantId,
      approverBankGrantId,
      executorBankGrantId,
      reverserBankGrantId,
    ]) {
      await client.query(`
        INSERT INTO access_grant_treasury_unit_scopes (access_grant_id, treasury_unit_id)
        VALUES ($1,$2)
      `, [grantId, treasuryUnitId]);
      await client.query(`
        INSERT INTO access_grant_branch_scopes (access_grant_id, branch_id)
        VALUES ($1,$2)
      `, [grantId, branchId]);
      await client.query(`
        INSERT INTO access_grant_document_type_scopes (access_grant_id, document_type)
        VALUES ($1,'PAYMENT')
      `, [grantId]);
      await client.query(`
        INSERT INTO access_grant_currency_scopes (access_grant_id, organization_id, currency)
        VALUES ($1,$2,$3)
      `, [grantId, organizationId, baseCurrency]);
      await client.query(`
        INSERT INTO access_grant_bank_account_scopes (access_grant_id, bank_account_id)
        VALUES ($1,$2)
      `, [grantId, bankAccountId]);
      await client.query(`
        INSERT INTO access_grant_method_category_scopes (access_grant_id, method_category)
        VALUES ($1,'BANK_TRANSFER')
      `, [grantId]);
    }
    await client.query(`
      INSERT INTO delegations (
        id, organization_id, access_grant_id, grantor_user_id, delegate_user_id,
        reason, valid_from, valid_to
      ) VALUES
        ($1,$3,$4,$5,$6,'Requester separation proof',now() - interval '1 minute',now() + interval '1 day'),
        ($2,$3,$4,$5,$7,'Temporary approval cover',now() - interval '1 minute',now() + interval '1 day')
    `, [
      requesterDelegationId, approvalDelegationId, organizationId, approvalGrantId,
      approverId, requesterId, delegateId,
    ]);
    await client.query(`
      INSERT INTO payment_approval_policies (
        id, organization_id, code, name, document_type, treasury_unit_id, method_category,
        aggregation_window_kind, aggregation_keys, version, state
      ) VALUES ($1,$2,$3,'INC-3B beneficiary approval','PAYMENT',$4,NULL,'BUSINESS_DATE',
        ARRAY['BENEFICIARY']::varchar[],1,'ACTIVE'),
        ($5,$2,$6,'INC-3C bank beneficiary approval','PAYMENT',$4,'BANK_TRANSFER','BUSINESS_DATE',
        ARRAY['BENEFICIARY']::varchar[],1,'ACTIVE')
    `, [
      approvalPolicyId, organizationId, `PAP-${suffix}`, treasuryUnitId,
      bankApprovalPolicyId, `PAB-${suffix}`,
    ]);
    await client.query(`
      INSERT INTO payment_approval_policy_steps (
        organization_id, policy_id, step_order, role_id, approvals_required, separation_rules
      ) VALUES
        ($1,$2,1,$4,1,ARRAY['CREATOR_NOT_APPROVER','REQUESTER_NOT_APPROVER']::varchar[]),
        ($1,$3,1,$4,1,ARRAY['CREATOR_NOT_APPROVER']::varchar[])
    `, [organizationId, approvalPolicyId, bankApprovalPolicyId, approvalRoleId]);
    await client.query('COMMIT');
    return {
      organizationId,
      ownsFoundation,
      ownsForeignCurrency,
      ownsBranch,
      ownsTreasuryUnit,
      baseCurrency,
      foreignCurrency,
      actorId,
      approverId,
      requesterId,
      delegateId,
      executorId,
      reverserId,
      executorGrantId,
      reverserGrantId,
      actorBankGrantId,
      approverBankGrantId,
      executorBankGrantId,
      reverserBankGrantId,
      reverserAccountId,
      reverserSessionId,
      partyId,
      branchId,
      treasuryUnitId,
      methodId,
      bankMethodId,
      cashboxId,
      bankTypeId,
      bankId,
      bankAccountId,
      attachmentId,
      requestRoleId,
      paymentRoleId,
      approvalRoleId,
      alternateRoleId,
      requestGrantId,
      paymentGrantId,
      approvalGrantId,
      alternateGrantId,
      requesterDelegationId,
      approvalDelegationId,
      approvalPolicyId,
      bankApprovalPolicyId,
      foreignRateId,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function cleanup(
  database: DatabaseService,
  seeded: Awaited<ReturnType<typeof seed>>,
): Promise<void> {
  const {
    organizationId,
    actorId,
    approverId,
    requesterId,
    delegateId,
    executorId,
    reverserId,
    executorGrantId,
    reverserGrantId,
    actorBankGrantId,
    approverBankGrantId,
    executorBankGrantId,
    reverserBankGrantId,
    reverserAccountId,
    reverserSessionId,
    partyId,
    methodId,
    bankMethodId,
    cashboxId,
    bankTypeId,
    bankId,
    bankAccountId,
    attachmentId,
    requestRoleId,
    paymentRoleId,
    approvalRoleId,
    alternateRoleId,
    requestGrantId,
    paymentGrantId,
    approvalGrantId,
    alternateGrantId,
    requesterDelegationId,
    approvalDelegationId,
    approvalPolicyId,
    bankApprovalPolicyId,
    ownsFoundation,
    ownsForeignCurrency,
    ownsBranch,
    ownsTreasuryUnit,
  } = seeded;
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(`
      DELETE FROM audit_events WHERE organization_id = $1 AND entity_type = 'BankInstruction'
        AND entity_id IN (
          SELECT instruction.id FROM bank_instructions instruction
          JOIN payment_lines line ON line.id = instruction.payment_line_id
          JOIN payment_documents payment ON payment.id = line.payment_document_id
          WHERE payment.organization_id = $1 AND payment.creator_user_id IN ($2, $3)
        )
    `, [organizationId, actorId, reverserId]);
    await client.query(`
      DELETE FROM outbox_events WHERE organization_id = $1 AND aggregate_type = 'BankInstruction'
        AND aggregate_id IN (
          SELECT instruction.id FROM bank_instructions instruction
          JOIN payment_lines line ON line.id = instruction.payment_line_id
          JOIN payment_documents payment ON payment.id = line.payment_document_id
          WHERE payment.organization_id = $1 AND payment.creator_user_id IN ($2, $3)
        )
    `, [organizationId, actorId, reverserId]);
    await client.query(`
      DELETE FROM bank_instruction_outcome_events WHERE bank_instruction_id IN (
        SELECT instruction.id FROM bank_instructions instruction
        JOIN payment_lines line ON line.id = instruction.payment_line_id
        JOIN payment_documents payment ON payment.id = line.payment_document_id
        WHERE payment.organization_id = $1 AND payment.creator_user_id IN ($2, $3)
      )
    `, [organizationId, actorId, reverserId]);
    await client.query(`
      DELETE FROM bank_instructions WHERE payment_line_id IN (
        SELECT line.id FROM payment_lines line
        JOIN payment_documents payment ON payment.id = line.payment_document_id
        WHERE payment.organization_id = $1 AND payment.creator_user_id IN ($2, $3)
      )
    `, [organizationId, actorId, reverserId]);
    await client.query(`
      DELETE FROM payment_execution_effects WHERE payment_line_id IN (
        SELECT line.id FROM payment_lines line
        JOIN payment_documents payment ON payment.id = line.payment_document_id
        WHERE payment.organization_id = $1 AND payment.creator_user_id IN ($2, $3)
      )
    `, [organizationId, actorId, reverserId]);
    await client.query(`
      DELETE FROM payment_reservations WHERE payment_document_id IN (
        SELECT id FROM payment_documents
        WHERE organization_id = $1 AND creator_user_id IN ($2, $3)
      )
    `, [organizationId, actorId, reverserId]);
    await client.query(`
      DELETE FROM payment_allocations WHERE payment_document_id IN (
        SELECT id FROM payment_documents
        WHERE organization_id = $1 AND creator_user_id IN ($2, $3)
      )
    `, [organizationId, actorId, reverserId]);
    await client.query(`
      DELETE FROM movement_facts
      WHERE organization_id = $1 AND (
        (owner = 'qa.seed' AND source_id = $2)
        OR source_id IN (
          SELECT id FROM payment_documents
          WHERE organization_id = $1 AND creator_user_id IN ($2, $3)
        )
      )
    `, [organizationId, actorId, reverserId]);
    await client.query(`
      DELETE FROM audit_events WHERE organization_id = $1 AND entity_id IN (
        SELECT id FROM payment_documents
        WHERE organization_id = $1 AND creator_user_id IN ($2, $3)
      )
    `, [organizationId, actorId, reverserId]);
    await client.query(`
      DELETE FROM outbox_events WHERE organization_id = $1 AND aggregate_id IN (
        SELECT id FROM payment_documents
        WHERE organization_id = $1 AND creator_user_id IN ($2, $3)
      )
    `, [organizationId, actorId, reverserId]);
    await client.query(`
      UPDATE payment_documents
      SET state = 'DRAFT', workflow_state = 'DRAFT', current_approval_snapshot_id = NULL
      WHERE organization_id = $1 AND creator_user_id = $2
    `, [organizationId, actorId]);
    for (const table of [
      'payment_approval_actions',
      'payment_approval_aggregation_participants',
      'payment_approval_aggregations',
      'payment_approval_snapshot_steps',
      'payment_approval_snapshot_contexts',
    ]) {
      await client.query(`
        DELETE FROM ${table}
        WHERE organization_id = $1 AND approval_snapshot_id IN (
          SELECT id FROM payment_approval_snapshots
          WHERE organization_id = $1 AND payment_document_id IN (
            SELECT id FROM payment_documents
            WHERE organization_id = $1 AND creator_user_id = $2
          )
        )
      `, [organizationId, actorId]);
    }
    await client.query(`
      DELETE FROM payment_approval_snapshots
      WHERE organization_id = $1 AND payment_document_id IN (
        SELECT id FROM payment_documents
        WHERE organization_id = $1 AND creator_user_id = $2
      )
    `, [organizationId, actorId]);
    await client.query(`
      DELETE FROM payment_line_attachment_links WHERE payment_line_id IN (
        SELECT l.id FROM payment_lines l
        JOIN payment_documents d ON d.id = l.payment_document_id
        WHERE d.creator_user_id IN ($1, $2)
      )
    `, [actorId, reverserId]);
    await client.query(`
      DELETE FROM payment_lines WHERE payment_document_id IN (
        SELECT id FROM payment_documents WHERE creator_user_id IN ($1, $2)
      )
    `, [actorId, reverserId]);
    await client.query('DELETE FROM payment_documents WHERE creator_user_id IN ($1, $2)', [
      actorId,
      reverserId,
    ]);
    await client.query(`
      DELETE FROM payment_request_attachment_links WHERE payment_request_id IN (
        SELECT id FROM payment_requests WHERE requester_user_id IN ($1, $2)
      )
    `, [actorId, requesterId]);
    await client.query('DELETE FROM payment_requests WHERE requester_user_id IN ($1, $2)', [
      actorId,
      requesterId,
    ]);
    await client.query(`
      DELETE FROM idempotency_records
      WHERE organization_id = $1
        AND (scope LIKE $2 OR scope LIKE $3 OR scope LIKE $4 OR scope LIKE $5
          OR scope LIKE $6 OR scope LIKE $7)
    `, [
      organizationId,
      `%:${actorId}%`,
      `%:${approverId}%`,
      `%:${requesterId}%`,
      `%:${delegateId}%`,
      `%:${executorId}%`,
      `%:${reverserId}%`,
    ]);
    await client.query('DELETE FROM delegations WHERE id IN ($1, $2)', [
      requesterDelegationId,
      approvalDelegationId,
    ]);
    for (const table of [
      'access_grant_method_category_scopes',
      'access_grant_currency_scopes',
      'access_grant_document_type_scopes',
      'access_grant_cashbox_scopes',
      'access_grant_bank_account_scopes',
      'access_grant_branch_scopes',
      'access_grant_treasury_unit_scopes',
    ]) {
      await client.query(
        `DELETE FROM ${table}
          WHERE access_grant_id IN ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          requestGrantId,
          paymentGrantId,
          approvalGrantId,
          alternateGrantId,
          executorGrantId,
          reverserGrantId,
          actorBankGrantId,
          approverBankGrantId,
          executorBankGrantId,
          reverserBankGrantId,
        ],
      );
    }
    await client.query(`
      DELETE FROM access_grants WHERE id IN ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [
      requestGrantId,
      paymentGrantId,
      approvalGrantId,
      alternateGrantId,
      executorGrantId,
      reverserGrantId,
      actorBankGrantId,
      approverBankGrantId,
      executorBankGrantId,
      reverserBankGrantId,
    ]);
    await client.query('DELETE FROM payment_approval_policy_steps WHERE policy_id IN ($1, $2)', [
      approvalPolicyId, bankApprovalPolicyId,
    ]);
    await client.query('DELETE FROM payment_approval_policies WHERE id IN ($1, $2)', [
      approvalPolicyId, bankApprovalPolicyId,
    ]);
    await client.query('DELETE FROM role_permissions WHERE role_id IN ($1, $2, $3, $4)', [
      requestRoleId,
      paymentRoleId,
      approvalRoleId,
      alternateRoleId,
    ]);
    await client.query('DELETE FROM roles WHERE id IN ($1, $2, $3, $4)', [
      requestRoleId,
      paymentRoleId,
      approvalRoleId,
      alternateRoleId,
    ]);
    await client.query('DELETE FROM exchange_rates WHERE recorded_by = $1', [actorId]);
    await client.query('DELETE FROM attachments WHERE id = $1', [attachmentId]);
    await client.query('DELETE FROM cashbox_currency_controls WHERE cashbox_id = $1', [cashboxId]);
    await client.query('DELETE FROM cashboxes WHERE id = $1', [cashboxId]);
    await client.query('DELETE FROM bank_accounts WHERE id = $1', [bankAccountId]);
    await client.query('DELETE FROM banks WHERE id = $1', [bankId]);
    await client.query('DELETE FROM bank_types WHERE id = $1', [bankTypeId]);
    await client.query('DELETE FROM method_allowed_currencies WHERE method_id IN ($1, $2)', [
      methodId,
      bankMethodId,
    ]);
    await client.query('DELETE FROM method_required_references WHERE method_id IN ($1, $2)', [
      methodId,
      bankMethodId,
    ]);
    await client.query('DELETE FROM method_definitions WHERE id IN ($1, $2)', [methodId, bankMethodId]);
    await client.query('DELETE FROM parties WHERE id = $1', [partyId]);
    await client.query(`
      DELETE FROM auth_step_up_proofs WHERE challenge_id IN (
        SELECT id FROM auth_challenges WHERE identity_account_id = $1
      )
    `, [reverserAccountId]);
    await client.query('DELETE FROM auth_challenges WHERE identity_account_id = $1', [
      reverserAccountId,
    ]);
    await client.query('DELETE FROM auth_sessions WHERE id = $1', [reverserSessionId]);
    await client.query('DELETE FROM identity_accounts WHERE id = $1', [reverserAccountId]);
    await client.query('DELETE FROM user_refs WHERE id IN ($1, $2, $3, $4, $5, $6)', [
      actorId,
      approverId,
      requesterId,
      delegateId,
      executorId,
      reverserId,
    ]);
    if (ownsFoundation) {
      await client.query('DELETE FROM payment_number_counters WHERE organization_id = $1', [organizationId]);
      await client.query('DELETE FROM payment_request_number_counters WHERE organization_id = $1', [organizationId]);
      await client.query('DELETE FROM treasury_units WHERE id = $1', [seeded.treasuryUnitId]);
      await client.query('DELETE FROM branches WHERE id = $1', [seeded.branchId]);
      await client.query('DELETE FROM currencies WHERE organization_id = $1', [organizationId]);
      await client.query('DELETE FROM organizations WHERE id = $1', [organizationId]);
    } else {
      if (ownsTreasuryUnit) {
        await client.query('DELETE FROM treasury_units WHERE id = $1', [seeded.treasuryUnitId]);
      }
      if (ownsBranch) await client.query('DELETE FROM branches WHERE id = $1', [seeded.branchId]);
      if (ownsForeignCurrency) {
        await client.query(
          'DELETE FROM currencies WHERE organization_id = $1 AND code = $2',
          [organizationId, seeded.foreignCurrency],
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function isProblem(code: string) {
  return (error: unknown) => error instanceof TreasuryProblem
    && (error.getResponse() as { code?: string }).code === code;
}

function problemCode(error: unknown): string {
  return error instanceof TreasuryProblem
    ? String((error.getResponse() as { code?: string }).code)
    : String(error);
}

async function paymentStep(
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
    command: { operationId, method: 'POST', path, bodyDigest, idempotencyKey },
  };
}

async function settledPair<T>(first: Promise<T>, second: Promise<T>): Promise<[T, T]> {
  const results = await Promise.allSettled([first, second]);
  const rejected = results.find((result): result is PromiseRejectedResult =>
    result.status === 'rejected');
  if (rejected) throw new Error(`Concurrent operation failed with ${problemCode(rejected.reason)}`, {
    cause: rejected.reason,
  });
  return results.map((result) => (result as PromiseFulfilledResult<T>).value) as [T, T];
}
