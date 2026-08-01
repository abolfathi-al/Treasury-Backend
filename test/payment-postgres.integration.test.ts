import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { AccessAuthorizationRepository } from '../src/access-control/access-authorization.repository';
import { AccessAuthorizationService } from '../src/access-control/access-authorization.service';
import { TreasuryProblem } from '../src/common/problem';
import { DatabaseService } from '../src/database/database.service';
import { MethodBehaviorCategory, MethodReference } from '../src/master-data/master-data.dto';
import { PaymentApprovalRepository } from '../src/payments/payment-approval.repository';
import { PaymentApprovalService } from '../src/payments/payment-approval.service';
import { PaymentApprovalAction } from '../src/payments/payment.dto';
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
  try {
    seeded = await seed(database);
  const requestDraft = {
    beneficiaryPartyId: seeded.partyId,
    requestedMoney: { amount: '125000', currency: 'IRR' },
    treasuryUnitId: seeded.treasuryUnitId,
    purpose: 'Approved supplier request',
  };
  const paymentDraft = {
    businessDate: '2026-08-01',
    beneficiaryPartyId: seeded.partyId,
    treasuryUnitId: seeded.treasuryUnitId,
    baseCurrency: 'IRR',
    purpose: 'Approved supplier payment',
    lines: [{
      lineNumber: 1,
      methodId: seeded.methodId,
      money: { amount: '125000', currency: 'IRR' },
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
        lines: [{ ...paymentDraft.lines[0], money: { amount: '10', currency: 'USD' } }],
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
    ) VALUES ('USD','IRR','SELL','2.6','2026-08-01T12:00:00Z','INC-3A QA secondary',$1,$1,'APPROVED')`, [
      seeded.actorId,
    ]);
    await assert.rejects(service.create(
      seeded.organizationId,
      seeded.actorId,
      {
        ...paymentDraft,
        purpose: 'Ambiguous foreign supplier payment',
        lines: [{ ...paymentDraft.lines[0], money: { amount: '10', currency: 'USD' } }],
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
  let ownsUsd = false;
  const actorId = randomUUID();
  const approverId = randomUUID();
  const requesterId = randomUUID();
  const delegateId = randomUUID();
  const partyId = randomUUID();
  const methodId = randomUUID();
  const cashboxId = randomUUID();
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
  const foreignRateId = randomUUID();
  const suffix = actorId.slice(0, 8).toUpperCase();
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    const existing = await client.query<{
      organization_id: string;
      branch_id: string;
      treasury_unit_id: string;
    }>(`
      SELECT o.id AS organization_id, b.id AS branch_id, tu.id AS treasury_unit_id
      FROM organizations o
      JOIN branches b ON b.organization_id = o.id AND b.state = 'ACTIVE'
      JOIN treasury_units tu
        ON tu.organization_id = o.id AND tu.branch_id = b.id AND tu.state = 'ACTIVE'
      ORDER BY o.created_at, b.created_at, tu.created_at
      LIMIT 1
    `);
    if (existing.rows[0]) {
      organizationId = existing.rows[0].organization_id;
      branchId = existing.rows[0].branch_id;
      treasuryUnitId = existing.rows[0].treasury_unit_id;
      ownsFoundation = false;
      const insertedUsd = await client.query(`
        INSERT INTO currencies (organization_id, code, name, decimal_places, base_currency)
        VALUES ($1,'USD','US dollar',2,false)
        ON CONFLICT (organization_id, code) DO NOTHING
        RETURNING code
      `, [organizationId]);
      ownsUsd = insertedUsd.rowCount === 1;
    } else {
      await client.query(`
        INSERT INTO organizations (id, code, legal_name, timezone, base_currency)
        VALUES ($1,$2,'INC-3A organization','Asia/Tehran','IRR')
      `, [organizationId, `PAY-${suffix}`]);
      await client.query(`
        INSERT INTO currencies (organization_id, code, name, decimal_places, base_currency)
        VALUES ($1,'IRR','Iranian rial',0,true),($1,'USD','US dollar',2,false)
      `, [organizationId]);
      await client.query(`
        INSERT INTO branches (id, organization_id, code, name)
        VALUES ($1,$2,$3,'INC-3A branch')
      `, [branchId, organizationId, `BR-${suffix}`]);
      await client.query(`
        INSERT INTO treasury_units (id, organization_id, code, name, branch_id, default_currency)
        VALUES ($1,$2,$3,'INC-3A treasury unit',$4,'IRR')
      `, [treasuryUnitId, organizationId, `TU-${suffix}`, branchId]);
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
      INSERT INTO exchange_rates (
        id, source_currency, target_currency, rate_type, rate, valid_at, source_name,
        recorded_by, approved_by, state
      ) VALUES ($1,'USD','IRR','SELL','2.5','2026-08-01T12:00:00Z',
        'INC-3A QA primary',$2,$2,'APPROVED')
    `, [foreignRateId, actorId]);
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
      VALUES ($1,$2,'IRR'),($1,$2,'USD')
    `, [methodId, organizationId]);
    await client.query(`
      INSERT INTO cashboxes (
        id, organization_id, branch_id, treasury_unit_id, code, name, cashbox_type,
        main_currency, can_receive, can_pay, can_transfer, requires_approval, active_from
      ) VALUES ($1,$2,$3,$4,$5,'INC-3A cashbox','CASH','IRR',false,true,false,false,now())
    `, [cashboxId, organizationId, branchId, treasuryUnitId, `CB-${suffix}`]);
    await client.query(`
      INSERT INTO cashbox_currency_controls (cashbox_id, organization_id, currency, allow_negative)
      VALUES ($1,$2,'IRR',false),($1,$2,'USD',false)
    `, [cashboxId, organizationId]);
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
      VALUES ($1,$3,'IRR'),($1,$3,'USD'),($2,$3,'IRR'),($2,$3,'USD'),
             ($4,$3,'IRR'),($4,$3,'USD'),($5,$3,'IRR'),($5,$3,'USD')
    `, [requestGrantId, paymentGrantId, organizationId, approvalGrantId, alternateGrantId]);
    await client.query(`
      INSERT INTO access_grant_cashbox_scopes (access_grant_id, cashbox_id)
      VALUES ($1,$2),($3,$2),($4,$2)
    `, [paymentGrantId, cashboxId, approvalGrantId, alternateGrantId]);
    await client.query(`
      INSERT INTO access_grant_method_category_scopes (access_grant_id, method_category)
      VALUES ($1,'CASH'),($2,'CASH'),($3,'CASH')
    `, [paymentGrantId, approvalGrantId, alternateGrantId]);
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
        id, organization_id, code, name, document_type, aggregation_window_kind,
        aggregation_keys, version, state
      ) VALUES ($1,$2,$3,'INC-3B beneficiary approval','PAYMENT','BUSINESS_DATE',
        ARRAY['BENEFICIARY']::varchar[],1,'ACTIVE')
    `, [approvalPolicyId, organizationId, `PAP-${suffix}`]);
    await client.query(`
      INSERT INTO payment_approval_policy_steps (
        organization_id, policy_id, step_order, role_id, approvals_required, separation_rules
      ) VALUES ($1,$2,1,$3,1,
        ARRAY['CREATOR_NOT_APPROVER','REQUESTER_NOT_APPROVER']::varchar[])
    `, [organizationId, approvalPolicyId, approvalRoleId]);
    await client.query('COMMIT');
    return {
      organizationId,
      ownsFoundation,
      ownsUsd,
      actorId,
      approverId,
      requesterId,
      delegateId,
      partyId,
      branchId,
      treasuryUnitId,
      methodId,
      cashboxId,
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
    partyId,
    methodId,
    cashboxId,
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
    ownsFoundation,
    ownsUsd,
  } = seeded;
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
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
        WHERE d.creator_user_id = $1
      )
    `, [actorId]);
    await client.query(`
      DELETE FROM payment_lines WHERE payment_document_id IN (
        SELECT id FROM payment_documents WHERE creator_user_id = $1
      )
    `, [actorId]);
    await client.query('DELETE FROM payment_documents WHERE creator_user_id = $1', [actorId]);
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
        AND (scope LIKE $2 OR scope LIKE $3 OR scope LIKE $4 OR scope LIKE $5)
    `, [
      organizationId,
      `%:${actorId}%`,
      `%:${approverId}%`,
      `%:${requesterId}%`,
      `%:${delegateId}%`,
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
      'access_grant_branch_scopes',
      'access_grant_treasury_unit_scopes',
    ]) {
      await client.query(
        `DELETE FROM ${table} WHERE access_grant_id IN ($1, $2, $3, $4)`,
        [requestGrantId, paymentGrantId, approvalGrantId, alternateGrantId],
      );
    }
    await client.query('DELETE FROM access_grants WHERE id IN ($1, $2, $3, $4)', [
      requestGrantId,
      paymentGrantId,
      approvalGrantId,
      alternateGrantId,
    ]);
    await client.query('DELETE FROM payment_approval_policy_steps WHERE policy_id = $1', [
      approvalPolicyId,
    ]);
    await client.query('DELETE FROM payment_approval_policies WHERE id = $1', [approvalPolicyId]);
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
    await client.query('DELETE FROM cashbox_currency_controls WHERE cashbox_id = $1', [cashboxId]);
    await client.query('DELETE FROM cashboxes WHERE id = $1', [cashboxId]);
    await client.query('DELETE FROM method_allowed_currencies WHERE method_id = $1', [methodId]);
    await client.query('DELETE FROM method_required_references WHERE method_id = $1', [methodId]);
    await client.query('DELETE FROM method_definitions WHERE id = $1', [methodId]);
    await client.query('DELETE FROM parties WHERE id = $1', [partyId]);
    await client.query('DELETE FROM user_refs WHERE id IN ($1, $2, $3, $4)', [
      actorId,
      approverId,
      requesterId,
      delegateId,
    ]);
    if (ownsFoundation) {
      await client.query('DELETE FROM payment_number_counters WHERE organization_id = $1', [organizationId]);
      await client.query('DELETE FROM payment_request_number_counters WHERE organization_id = $1', [organizationId]);
      await client.query('DELETE FROM treasury_units WHERE id = $1', [seeded.treasuryUnitId]);
      await client.query('DELETE FROM branches WHERE id = $1', [seeded.branchId]);
      await client.query('DELETE FROM currencies WHERE organization_id = $1', [organizationId]);
      await client.query('DELETE FROM organizations WHERE id = $1', [organizationId]);
    } else if (ownsUsd) {
      await client.query(
        "DELETE FROM currencies WHERE organization_id = $1 AND code = 'USD'",
        [organizationId],
      );
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

async function settledPair<T>(first: Promise<T>, second: Promise<T>): Promise<[T, T]> {
  const results = await Promise.allSettled([first, second]);
  const rejected = results.find((result): result is PromiseRejectedResult =>
    result.status === 'rejected');
  if (rejected) throw new Error(`Concurrent operation failed with ${problemCode(rejected.reason)}`, {
    cause: rejected.reason,
  });
  return results.map((result) => (result as PromiseFulfilledResult<T>).value) as [T, T];
}
