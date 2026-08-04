import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { AccessAuthorizationRepository } from '../src/access-control/access-authorization.repository';
import { AccessAuthorizationService } from '../src/access-control/access-authorization.service';
import { TreasuryProblem } from '../src/common/problem';
import { DatabaseService } from '../src/database/database.service';
import { FoundationEffectsRepository, FoundationEffectsService } from '../src/foundation-effects/foundation-effects.service';
import { TransferApprovalAction, TransferAssetType, TransferEndpointType, TransferRoute } from '../src/transfers/transfer.dto';
import { TransferRepository } from '../src/transfers/transfer.repository';
import { TransferService } from '../src/transfers/transfer.service';

const connectionString = process.env.TEST_DATABASE_URL;

test('INC-4A/4B preserves scoped visibility, rollback, replay, stale-version, and concurrency invariants', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = connectionString;
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 41).toString('base64');
  const database = new DatabaseService();
  const service = new TransferService(
    database,
    new TransferRepository(),
    new AccessAuthorizationService(new AccessAuthorizationRepository()),
    new FoundationEffectsService(new FoundationEffectsRepository()),
  );
  let seeded: Awaited<ReturnType<typeof seed>> | undefined;
  try {
    seeded = await seed(database);
    const draft = {
      businessDate: '2026-08-02',
      route: TransferRoute.CASHBOX_TO_USER,
      source: { type: TransferEndpointType.CASHBOX, id: seeded.cashboxId },
      destination: { type: TransferEndpointType.USER, id: seeded.destinationId },
      sourceMoney: { amount: '100', currency: seeded.currency },
      destinationCurrency: seeded.currency,
      purpose: 'INC-4A custody transfer',
    };

    const [created, concurrentReplay] = await Promise.all([
      service.create(seeded.organizationId, seeded.actorId, draft, 'transfer-create-shared', 'create-a'),
      service.create(seeded.organizationId, seeded.actorId, draft, 'transfer-create-shared', 'create-b'),
    ]);
    assert.deepEqual(concurrentReplay, created);
    assert.equal(created.rateSnapshot.rateSource, 'IDENTITY');
    assert.equal(created.rateSnapshot.rate, '1.000000000000000000');
    assert.equal(created.state, 'DRAFT');

    await assert.rejects(
      service.create(seeded.organizationId, seeded.actorId, {
        ...draft,
        assets: [{ type: TransferAssetType.ISSUED_CHEQUE, id: randomUUID() }],
      }, 'transfer-create-unresolved-issued-cheque', 'create-unresolved-issued-cheque'),
      isProblem('TRS-TRF-001'),
    );

    const persisted = await database.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM transfer_documents WHERE organization_id = $1 AND creator_user_id = $2',
      [seeded.organizationId, seeded.actorId],
    );
    assert.equal(persisted.rows[0]!.count, '1');
    assert.ok((await service.list(seeded.organizationId, seeded.actorId, '10')).items.some(({ id }) => id === created.id));
    assert.equal((await service.list(seeded.organizationId, seeded.deniedId, '10')).items.length, 0);

    const crossCurrency = await service.create(seeded.organizationId, seeded.actorId, {
      ...draft,
      destinationCurrency: seeded.crossCurrency,
      purpose: 'INC-4A table-rate selection',
    }, 'transfer-create-cross-currency', 'create-cross-currency');
    assert.equal(crossCurrency.rateSnapshot.rateSource, 'TABLE');
    assert.equal(crossCurrency.rateSnapshot.rateRecordId, seeded.tableRateId);

    const zeroStepDraft = await service.create(seeded.organizationId, seeded.actorId, {
      ...draft, sourceMoney: { amount: '1500', currency: seeded.currency }, purpose: 'INC-4A zero-step approval',
    }, 'transfer-create-zero-step', 'create-zero-step');
    const zeroStepApproved = await service.submit(
      seeded.organizationId, seeded.actorId, zeroStepDraft.id, 'transfer-submit-zero-step', '"0"', 'submit-zero-step',
    );
    assert.equal(zeroStepApproved.state, 'APPROVED');
    assert.deepEqual(zeroStepApproved.approvalSnapshot?.steps, []);
    assert.equal(zeroStepApproved.sourceCustodian?.id, seeded.sourceCustodianId);

    await assert.rejects(
      service.submit(seeded.organizationId, seeded.actorId, created.id, 'transfer-submit-stale', '"99"', 'submit-stale'),
      isProblem('TRS-GEN-006'),
    );
    const beforeSubmit = await database.pool.query<{ snapshots: string; idempotency: string }>(`
      SELECT
        (SELECT count(*) FROM transfer_approval_snapshots WHERE organization_id = $1 AND transfer_document_id = $2)::text AS snapshots,
        (SELECT count(*) FROM idempotency_records WHERE organization_id = $1 AND idempotency_key = 'transfer-submit-stale')::text AS idempotency
    `, [seeded.organizationId, created.id]);
    assert.deepEqual(beforeSubmit.rows[0], { snapshots: '0', idempotency: '0' });

    const submitted = await service.submit(
      seeded.organizationId, seeded.actorId, created.id, 'transfer-submit-valid', '"0"', 'submit-valid',
    );
    assert.equal(submitted.state, 'REQUESTED');
    assert.equal(submitted.version, 1);
    assert.deepEqual(await service.submit(
      seeded.organizationId, seeded.actorId, created.id, 'transfer-submit-valid', '"0"', 'submit-replay',
    ), submitted);

    await assert.rejects(
      service.act(
        seeded.organizationId, seeded.approverId, created.id,
        { action: TransferApprovalAction.APPROVE }, 'transfer-action-stale', '"0"', 'action-stale',
      ),
      isProblem('TRS-GEN-006'),
    );
    await database.pool.query(
      "UPDATE cashbox_assignments SET effective_to = now() - interval '1 minute' WHERE id = $1",
      [seeded.assignmentId],
    );
    await assert.rejects(
      service.act(
        seeded.organizationId, seeded.approverId, created.id,
        { action: TransferApprovalAction.APPROVE }, 'transfer-action-expired-custodian', '"1"', 'action-expired-custodian',
      ),
      isProblem('TRS-TRF-005'),
    );
    const rolledBackAction = await database.pool.query<{ actions: string; idempotency: string }>(`
      SELECT
        (SELECT count(*) FROM transfer_approval_actions WHERE organization_id = $1 AND approval_snapshot_id = $2)::text AS actions,
        (SELECT count(*) FROM idempotency_records WHERE organization_id = $1 AND idempotency_key = 'transfer-action-expired-custodian')::text AS idempotency
    `, [seeded.organizationId, submitted.approvalSnapshot!.id]);
    assert.deepEqual(rolledBackAction.rows[0], { actions: '0', idempotency: '0' });
    await database.pool.query('UPDATE cashbox_assignments SET effective_to = NULL WHERE id = $1', [seeded.assignmentId]);
    const [firstStep, approvalReplay] = await Promise.all([
      service.act(
        seeded.organizationId, seeded.approverId, created.id,
        { action: TransferApprovalAction.APPROVE }, 'transfer-action-shared', '"1"', 'action-a',
      ),
      service.act(
        seeded.organizationId, seeded.approverId, created.id,
        { action: TransferApprovalAction.APPROVE }, 'transfer-action-shared', '"1"', 'action-b',
      ),
    ]);
    assert.deepEqual(approvalReplay, firstStep);
    assert.equal(firstStep.state, 'REQUESTED');
    assert.equal(firstStep.approvalSnapshot?.steps[0]?.state, 'APPROVED');
    assert.equal(firstStep.approvalSnapshot?.steps[1]?.state, 'CURRENT');
    const approved = await service.act(
      seeded.organizationId, seeded.secondApproverId, created.id,
      { action: TransferApprovalAction.APPROVE }, 'transfer-action-second-step', `"${firstStep.version}"`, 'action-second-step',
    );
    assert.equal(approved.state, 'APPROVED');
    assert.equal(approved.sourceCustodian?.id, seeded.sourceCustodianId);
    assert.equal(approved.destinationCustodian?.id, seeded.destinationId);
    assert.notEqual(approved.sourceCustodian?.id, approved.destinationCustodian?.id);
    assert.equal(approved.approvalSnapshot?.actions.length, 2);

    await database.pool.query('UPDATE cashbox_assignments SET user_id = $1 WHERE id = $2', [seeded.actorId, seeded.assignmentId]);
    await assert.rejects(
      service.release(
        seeded.organizationId, seeded.sourceCustodianId, approved.id,
        'transfer-release-stale-custodian', `"${approved.version}"`, 'release-stale-custodian',
      ),
      isProblem('TRS-TRF-005'),
    );
    await database.pool.query('UPDATE cashbox_assignments SET user_id = $1 WHERE id = $2', [seeded.sourceCustodianId, seeded.assignmentId]);
    await assert.rejects(
      service.release(
        seeded.organizationId, seeded.sourceCustodianId, approved.id,
        'transfer-release-no-value', `"${approved.version}"`, 'release-no-value',
      ),
      isProblem('TRS-TRF-002'),
    );
    const deniedRelease = await database.pool.query<{ movements: string; obligations: string; idempotency: string }>(`
      SELECT
        (SELECT count(*) FROM movement_facts WHERE organization_id = $1 AND source_type = 'Transfer' AND source_id = $2)::text AS movements,
        (SELECT count(*) FROM transfer_transit_obligations WHERE organization_id = $1 AND transfer_document_id = $2)::text AS obligations,
        (SELECT count(*) FROM idempotency_records WHERE organization_id = $1 AND idempotency_key IN ('transfer-release-stale-custodian','transfer-release-no-value'))::text AS idempotency
    `, [seeded.organizationId, approved.id]);
    assert.deepEqual(deniedRelease.rows[0], { movements: '0', obligations: '0', idempotency: '0' });

    await database.pool.query(`
      INSERT INTO movement_facts (
        id, organization_id, owner, source_type, source_id, effect_key,
        endpoint_type, endpoint_id, direction, amount, currency, business_date, state
      ) VALUES ($1,$2,'foundation','Seed',$3,'OPENING_BALANCE','CASHBOX',$4,'CREDIT',5000,$5,'2026-08-02','POSTED')
    `, [randomUUID(), seeded.organizationId, randomUUID(), seeded.cashboxId, seeded.currency]);
    const [released, releaseReplay] = await Promise.all([
      service.release(
        seeded.organizationId, seeded.sourceCustodianId, approved.id,
        'transfer-release-shared', `"${approved.version}"`, 'release-a',
      ),
      service.release(
        seeded.organizationId, seeded.sourceCustodianId, approved.id,
        'transfer-release-shared', `"${approved.version}"`, 'release-b',
      ),
    ]);
    assert.deepEqual(releaseReplay, released);
    assert.equal(released.state, 'IN_TRANSIT');
    assert.equal(released.release?.releasedByUserId, seeded.sourceCustodianId);
    assert.equal(released.transitObligation?.state, 'OPEN');
    await assert.rejects(
      service.acknowledge(
        seeded.organizationId, seeded.sourceCustodianId, approved.id,
        { receivedMoney: released.destinationMoney, receivedAt: new Date().toISOString(), receivedAssetIds: [] },
        'transfer-ack-source-denied', `"${released.version}"`, 'ack-source-denied',
      ),
      isProblem('TRS-TRF-005'),
    );
    await assert.rejects(
      service.acknowledge(
        seeded.organizationId, seeded.destinationId, approved.id,
        { receivedMoney: { amount: '0', currency: released.destinationMoney.currency }, receivedAt: new Date().toISOString(), receivedAssetIds: [] },
        'transfer-ack-missing-reason', `"${released.version}"`, 'ack-missing-reason',
      ),
      isProblem('TRS-TRF-003'),
    );
    await database.pool.query("UPDATE user_refs SET state = 'INACTIVE' WHERE id = $1", [seeded.actorId]);
    await database.pool.query("UPDATE cashboxes SET state = 'SUSPENDED' WHERE id = $1", [seeded.cashboxId]);
    const acknowledgement = {
      receivedMoney: released.destinationMoney,
      receivedAt: new Date().toISOString(),
      receivedAssetIds: [],
    };
    const [completed, acknowledgementReplay] = await Promise.all([
      service.acknowledge(
        seeded.organizationId, seeded.destinationId, approved.id, acknowledgement,
        'transfer-ack-shared', `"${released.version}"`, 'ack-a',
      ),
      service.acknowledge(
        seeded.organizationId, seeded.destinationId, approved.id, acknowledgement,
        'transfer-ack-shared', `"${released.version}"`, 'ack-b',
      ),
    ]);
    assert.deepEqual(acknowledgementReplay, completed);
    assert.equal(completed.state, 'COMPLETED');
    assert.equal(completed.receipt?.receivedByUserId, seeded.destinationId);
    assert.equal(completed.transitObligation?.state, 'CLOSED');
    assert.ok(completed.transitObligation?.destinationMovementFactId);
    await database.pool.query("UPDATE user_refs SET state = 'ACTIVE' WHERE id = $1", [seeded.actorId]);
    await database.pool.query("UPDATE cashboxes SET state = 'ACTIVE' WHERE id = $1", [seeded.cashboxId]);
    await assert.rejects(
      service.acknowledge(
        seeded.organizationId, seeded.destinationId, approved.id, acknowledgement,
        'transfer-ack-stale', `"${released.version}"`, 'ack-stale',
      ),
      isProblem('TRS-GEN-006'),
    );
    await assert.rejects(
      service.acknowledge(
        seeded.organizationId, seeded.destinationId, approved.id,
        { ...acknowledgement, receivedMoney: { ...acknowledgement.receivedMoney, amount: '99' } },
        'transfer-ack-shared', `"${released.version}"`, 'ack-changed-digest',
      ),
      isProblem('TRS-GEN-007'),
    );
    const exactEffects = await database.pool.query<{ movements: string; obligations: string; events: string }>(`
      SELECT
        (SELECT count(*) FROM movement_facts WHERE organization_id = $1 AND source_type = 'Transfer' AND source_id = $2)::text AS movements,
        (SELECT count(*) FROM transfer_transit_obligations WHERE organization_id = $1 AND transfer_document_id = $2)::text AS obligations,
        (SELECT count(*) FROM outbox_events WHERE organization_id = $1 AND aggregate_type = 'Transfer' AND aggregate_id = $2)::text AS events
    `, [seeded.organizationId, approved.id]);
    assert.deepEqual(exactEffects.rows[0], { movements: '2', obligations: '1', events: '1' });
    await assert.rejects(
      database.pool.query(
        'DELETE FROM transfer_transit_obligations WHERE organization_id = $1 AND transfer_document_id = $2',
        [seeded.organizationId, approved.id],
      ),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );

    const discrepancyReleased = await service.release(
      seeded.organizationId, seeded.sourceCustodianId, zeroStepApproved.id,
      'transfer-release-discrepancy', `"${zeroStepApproved.version}"`, 'release-discrepancy',
    );
    const discrepancy = await service.acknowledge(
      seeded.organizationId, seeded.destinationId, zeroStepApproved.id,
      {
        receivedMoney: { amount: '0', currency: discrepancyReleased.destinationMoney.currency },
        receivedAt: new Date().toISOString(), receivedAssetIds: [], discrepancyReason: 'Nothing arrived',
      },
      'transfer-ack-discrepancy', `"${discrepancyReleased.version}"`, 'ack-discrepancy',
    );
    assert.equal(discrepancy.state, 'DISCREPANCY');
    assert.equal(discrepancy.transitObligation?.state, 'DISCREPANCY');
    assert.equal(discrepancy.transitObligation?.destinationMovementFactId, undefined);
    assert.equal(discrepancy.receipt?.discrepancyReason, 'Nothing arrived');
    const discrepancyEffects = await database.pool.query<{ movements: string; events: string }>(`
      SELECT
        (SELECT count(*) FROM movement_facts WHERE organization_id = $1 AND source_type = 'Transfer' AND source_id = $2)::text AS movements,
        (SELECT count(*) FROM outbox_events WHERE organization_id = $1 AND aggregate_type = 'Transfer' AND aggregate_id = $2)::text AS events
    `, [seeded.organizationId, zeroStepApproved.id]);
    assert.deepEqual(discrepancyEffects.rows[0], { movements: '1', events: '0' });

    await assert.rejects(
      database.pool.query('UPDATE transfer_approval_snapshots SET policy_name = policy_name WHERE id = $1', [approved.approvalSnapshot!.id]),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );

    const rejectedDraft = await service.create(
      seeded.organizationId, seeded.actorId, { ...draft, purpose: 'INC-4A rejection path' },
      'transfer-create-reject', 'create-reject',
    );
    const rejectionRequested = await service.submit(
      seeded.organizationId, seeded.actorId, rejectedDraft.id, 'transfer-submit-reject', '"0"', 'submit-reject',
    );
    await assert.rejects(
      service.act(
        seeded.organizationId, seeded.approverId, rejectedDraft.id,
        { action: TransferApprovalAction.REJECT, reason: 'Permission must stay independent' },
        'transfer-action-reject-denied', `"${rejectionRequested.version}"`, 'action-reject-denied',
      ),
      isProblem('TRS-GEN-003'),
    );
    await database.pool.query(
      "INSERT INTO role_permissions (role_id, permission) VALUES ($1,'transfer.reject')",
      [seeded.approverRoleId],
    );
    const rejected = await service.act(
      seeded.organizationId, seeded.approverId, rejectedDraft.id,
      { action: TransferApprovalAction.REJECT, reason: 'Independent rejection proof' },
      'transfer-action-reject', `"${rejectionRequested.version}"`, 'action-reject',
    );
    assert.equal(rejected.state, 'REJECTED');
    assert.equal(rejected.approvalSnapshot?.actions[0]?.reason, 'Independent rejection proof');

    await database.pool.query("UPDATE access_grants SET state = 'REVOKED' WHERE id = $1", [seeded.secondApproverGrantId]);
    await assert.rejects(
      service.act(
        seeded.organizationId, seeded.secondApproverId, created.id,
        { action: TransferApprovalAction.APPROVE }, 'transfer-action-second-step', `"${firstStep.version}"`, 'action-replay-revoked',
      ),
      isProblem('TRS-GEN-003'),
    );

    await database.pool.query('DELETE FROM access_grant_branch_scopes WHERE access_grant_id = $1', [seeded.actorGrantId]);
    await database.pool.query('DELETE FROM access_grant_treasury_unit_scopes WHERE access_grant_id = $1', [seeded.actorGrantId]);
    const userOnlyId = randomUUID();
    await database.pool.query(`
      INSERT INTO transfer_documents (
        id, organization_id, business_number, business_date, route,
        source_type, source_id, destination_type, destination_id,
        source_amount, source_currency, destination_amount, destination_currency,
        exchange_rate, rate_type, rate_source, rated_at, rounding_difference,
        purpose, creator_user_id
      ) VALUES ($1,$2,$3,'2026-08-02','USER_TO_USER','USER',$4,'USER',$5,1,$6,1,$6,1,'IDENTITY','IDENTITY',now(),0,'Absent cashbox scope proof',$4)
    `, [userOnlyId, seeded.organizationId, `TRF-U-${userOnlyId.slice(0, 8)}`, seeded.actorId, seeded.destinationId, seeded.currency]);
    assert.ok(!(await service.list(seeded.organizationId, seeded.actorId, '100')).items.some(({ id }) => id === userOnlyId));
  } finally {
    try {
      if (seeded) await cleanup(database, seeded);
    } finally {
      await database.onModuleDestroy();
    }
  }
});

async function seed(database: DatabaseService) {
  const organizationId = randomUUID();
  const branchId = randomUUID();
  const deniedBranchId = randomUUID();
  const treasuryUnitId = randomUUID();
  const deniedTreasuryUnitId = randomUUID();
  const actorId = randomUUID();
  const approverId = randomUUID();
  const secondApproverId = randomUUID();
  const sourceCustodianId = randomUUID();
  const destinationId = randomUUID();
  const deniedId = randomUUID();
  const cashboxId = randomUUID();
  const assignmentId = randomUUID();
  const actorRoleId = randomUUID();
  const approverRoleId = randomUUID();
  const secondApproverRoleId = randomUUID();
  const deniedRoleId = randomUUID();
  const custodyRoleId = randomUUID();
  const actorGrantId = randomUUID();
  const approverGrantId = randomUUID();
  const secondApproverGrantId = randomUUID();
  const deniedGrantId = randomUUID();
  const sourceCustodianGrantId = randomUUID();
  const destinationCustodianGrantId = randomUUID();
  const policyId = randomUUID();
  const policyStepId = randomUUID();
  const policyStep2Id = randomUUID();
  const zeroStepPolicyId = randomUUID();
  const tableRateId = randomUUID();
  const manualRateId = randomUUID();
  const suffix = actorId.slice(0, 8).toUpperCase();
  const crossCurrency = `X${suffix.slice(0, 5)}`;
  let ownsFoundation = false;
  let currency: string;
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    const existing = await client.query<{ id: string; base_currency: string }>(
      'SELECT id, base_currency FROM organizations ORDER BY created_at LIMIT 1',
    );
    if (existing.rows[0]) {
      currency = existing.rows[0].base_currency;
    } else {
      currency = 'IRR';
      await client.query(`
        INSERT INTO organizations (id, code, legal_name, timezone, base_currency)
        VALUES ($1,$2,'INC-4A organization','Asia/Tehran',$3)
      `, [organizationId, `TRF-${suffix}`, currency]);
      await client.query(`
        INSERT INTO currencies (organization_id, code, name, decimal_places, base_currency)
        VALUES ($1,$2,'INC-4A currency',2,true)
      `, [organizationId, currency]);
      ownsFoundation = true;
    }
    const effectiveOrganizationId = existing.rows[0]?.id ?? organizationId;
    await client.query(`
      INSERT INTO branches (id, organization_id, code, name) VALUES
        ($1,$3,$4,'INC-4A branch'),($2,$3,$5,'INC-4A denied branch')
    `, [branchId, deniedBranchId, effectiveOrganizationId, `TRF-${suffix}`, `DEN-${suffix}`]);
    await client.query(`
      INSERT INTO treasury_units (id, organization_id, branch_id, code, name, default_currency) VALUES
        ($1,$3,$4,$5,'INC-4A unit',$6),($2,$3,$7,$8,'INC-4A denied unit',$6)
    `, [treasuryUnitId, deniedTreasuryUnitId, effectiveOrganizationId, branchId, `TRF-${suffix}`, currency, deniedBranchId, `DEN-${suffix}`]);
    await client.query(`
      INSERT INTO user_refs (id, organization_id, subject_key, display_name) VALUES
        ($1,$6,$7,'INC-4A creator'),($2,$6,$8,'INC-4A approver'),
        ($3,$6,$9,'INC-4A source custodian'),($4,$6,$10,'INC-4A destination custodian'),
        ($5,$6,$11,'INC-4A denied viewer'),($12,$6,$13,'INC-4A second approver')
    `, [
      actorId, approverId, sourceCustodianId, destinationId, deniedId, effectiveOrganizationId,
      `actor-${suffix}`, `approver-${suffix}`, `source-${suffix}`, `destination-${suffix}`, `denied-${suffix}`,
      secondApproverId, `approver-2-${suffix}`,
    ]);
    await client.query(`
      INSERT INTO currencies (organization_id, code, name, decimal_places, base_currency)
      VALUES ($1,$2,'INC-4A cross currency',2,false)
    `, [effectiveOrganizationId, crossCurrency]);
    await client.query(`
      INSERT INTO exchange_rates (
        id, source_currency, target_currency, rate_type, rate, valid_at,
        source_name, recorded_by, approved_by, state
      ) VALUES
        ($1,$3,$4,'TABLE',2,now() - interval '2 minutes','INC-4A table',$5,$5,'APPROVED'),
        ($2,$3,$4,'MANUAL',3,now() - interval '1 minute','INC-4A manual',$5,$5,'APPROVED')
    `, [tableRateId, manualRateId, currency, crossCurrency, actorId]);
    await client.query(`
      INSERT INTO cashboxes (
        id, organization_id, branch_id, treasury_unit_id, code, name, cashbox_type,
        main_currency, can_receive, can_pay, can_transfer, requires_approval, active_from
      ) VALUES ($1,$2,$3,$4,$5,'INC-4A cashbox','CASH',$6,true,true,true,true,'2026-01-01')
    `, [cashboxId, effectiveOrganizationId, branchId, treasuryUnitId, `CB-${suffix}`, currency]);
    await client.query(`
      INSERT INTO cashbox_currency_controls (cashbox_id, organization_id, currency, allow_negative)
      VALUES ($1,$2,$3,false)
    `, [cashboxId, effectiveOrganizationId, currency]);
    await client.query(`
      INSERT INTO cashbox_assignments (
        id, organization_id, cashbox_id, user_id, assignment_type, effective_from, state
      ) VALUES ($1,$2,$3,$4,'PRIMARY',now() - interval '1 day','ACTIVE')
    `, [assignmentId, effectiveOrganizationId, cashboxId, sourceCustodianId]);
    await client.query(`
      INSERT INTO roles (id, organization_id, code, name) VALUES
        ($1,$4,$5,'INC-4A creator'),($2,$4,$6,'INC-4A approver'),($3,$4,$7,'INC-4A denied viewer'),
        ($8,$4,$9,'INC-4A second approver'),($10,$4,$11,'INC-4B custody')
    `, [
      actorRoleId, approverRoleId, deniedRoleId, effectiveOrganizationId,
      `CRT-${suffix}`, `APR-${suffix}`, `DEN-${suffix}`, secondApproverRoleId, `APR2-${suffix}`,
      custodyRoleId, `CUS-${suffix}`,
    ]);
    await client.query(`
      INSERT INTO role_permissions (role_id, permission) VALUES
        ($1,'transfer.view'),($1,'transfer.create'),($1,'transfer.submit'),
        ($2,'transfer.view'),($2,'transfer.approve'),
        ($3,'transfer.view'),($4,'transfer.view'),($4,'transfer.approve'),($4,'transfer.reject'),
        ($5,'transfer.view'),($5,'transfer.release'),($5,'transfer.receive')
    `, [actorRoleId, approverRoleId, deniedRoleId, secondApproverRoleId, custodyRoleId]);
    await client.query(`
      INSERT INTO access_grants (
        id, organization_id, user_ref_id, role_id, scope_type, scope_id, organization_wide,
        amount_ceiling, amount_ceiling_currency
      ) VALUES
        ($1,$4,$5,$6,'ORGANIZATION',$4,false,2000,$10),
        ($2,$4,$7,$8,'ORGANIZATION',$4,false,2000,$10),
        ($3,$4,$9,$11,'ORGANIZATION',$4,false,2000,$10),
        ($12,$4,$13,$14,'ORGANIZATION',$4,false,2000,$10),
        ($15,$4,$16,$17,'ORGANIZATION',$4,false,2000,$10),
        ($18,$4,$19,$17,'ORGANIZATION',$4,false,2000,$10)
    `, [
      actorGrantId, approverGrantId, deniedGrantId, effectiveOrganizationId,
      actorId, actorRoleId, approverId, approverRoleId, deniedId, currency, deniedRoleId,
      secondApproverGrantId, secondApproverId, secondApproverRoleId,
      sourceCustodianGrantId, sourceCustodianId, custodyRoleId,
      destinationCustodianGrantId, destinationId,
    ]);
    for (const [grantId, scopedBranchId, scopedUnitId] of [
      [actorGrantId, branchId, treasuryUnitId],
      [approverGrantId, branchId, treasuryUnitId],
      [deniedGrantId, deniedBranchId, deniedTreasuryUnitId],
      [secondApproverGrantId, branchId, treasuryUnitId],
      [sourceCustodianGrantId, branchId, treasuryUnitId],
      [destinationCustodianGrantId, branchId, treasuryUnitId],
    ]) {
      await client.query('INSERT INTO access_grant_branch_scopes (access_grant_id, branch_id) VALUES ($1,$2)', [grantId, scopedBranchId]);
      await client.query('INSERT INTO access_grant_treasury_unit_scopes (access_grant_id, treasury_unit_id) VALUES ($1,$2)', [grantId, scopedUnitId]);
      await client.query('INSERT INTO access_grant_cashbox_scopes (access_grant_id, cashbox_id) VALUES ($1,$2)', [grantId, cashboxId]);
      await client.query("INSERT INTO access_grant_document_type_scopes (access_grant_id, document_type) VALUES ($1,'TRANSFER')", [grantId]);
      await client.query('INSERT INTO access_grant_currency_scopes (access_grant_id, organization_id, currency) VALUES ($1,$2,$3)', [grantId, effectiveOrganizationId, currency]);
    }
    await client.query(`
      INSERT INTO access_grant_currency_scopes (access_grant_id, organization_id, currency)
      VALUES ($1,$3,$4),($2,$3,$4),($5,$3,$4),($6,$3,$4),($7,$3,$4)
    `, [actorGrantId, approverGrantId, effectiveOrganizationId, crossCurrency, secondApproverGrantId,
      sourceCustodianGrantId, destinationCustodianGrantId]);
    await client.query(`
      INSERT INTO approval_policies (
        id, organization_id, code, name, document_type, organization_wide,
        branch_id, treasury_unit_id, currency, minimum_base_amount,
        maximum_base_amount, policy_version, state
      ) VALUES
        ($1,$2,$3,'INC-4A exact policy','TRANSFER',false,$4,$5,$6,0,1000,1,'ACTIVE'),
        ($7,$2,$8,'INC-4A zero-step policy','TRANSFER',false,$4,$5,$6,1000.00000001,2000,1,'ACTIVE')
    `, [policyId, effectiveOrganizationId, `TRF-${suffix}`, branchId, treasuryUnitId, currency, zeroStepPolicyId, `ZERO-${suffix}`]);
    await client.query(`
      INSERT INTO approval_steps (
        id, organization_id, approval_policy_id, step_order, named_approver_id,
        approvals_required, separation_rules
      ) VALUES
        ($1,$2,$3,1,$4,1,'["CREATOR_NOT_APPROVER","SOURCE_CUSTODIAN_NOT_APPROVER"]'::jsonb),
        ($5,$2,$3,2,$6,1,'["CREATOR_NOT_APPROVER","SOURCE_CUSTODIAN_NOT_APPROVER"]'::jsonb)
    `, [policyStepId, effectiveOrganizationId, policyId, approverId, policyStep2Id, secondApproverId]);
    await client.query('COMMIT');
    return {
      organizationId: effectiveOrganizationId, currency, ownsFoundation, branchId, deniedBranchId,
      treasuryUnitId, deniedTreasuryUnitId, actorId, approverId, sourceCustodianId,
      destinationId, deniedId, cashboxId, assignmentId, actorRoleId, approverRoleId,
      secondApproverId, secondApproverRoleId, deniedRoleId, actorGrantId, approverGrantId, secondApproverGrantId,
      deniedGrantId, custodyRoleId, sourceCustodianGrantId, destinationCustodianGrantId, policyId, zeroStepPolicyId,
      crossCurrency, tableRateId, manualRateId,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function cleanup(database: DatabaseService, seeded: Awaited<ReturnType<typeof seed>>): Promise<void> {
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    const ownedDocuments = `SELECT id FROM transfer_documents WHERE organization_id = $1 AND creator_user_id = $2`;
    const ownedSnapshots = `SELECT id FROM transfer_approval_snapshots WHERE organization_id = $1 AND transfer_document_id IN (${ownedDocuments})`;
    await client.query(`
      UPDATE transfer_documents
      SET state = 'DRAFT', current_approval_snapshot_id = NULL,
          source_custodian_user_id = NULL, destination_custodian_user_id = NULL,
          released_by_user_id = NULL, released_at = NULL,
          received_by_user_id = NULL, received_at = NULL, receipt_recorded_at = NULL,
          discrepancy_amount = 0, discrepancy_reason = NULL
      WHERE organization_id = $1 AND creator_user_id = $2
    `, [seeded.organizationId, seeded.actorId]);
    await client.query(`DELETE FROM transfer_transit_obligations WHERE organization_id = $1 AND transfer_document_id IN (${ownedDocuments})`, [seeded.organizationId, seeded.actorId]);
    await client.query(`DELETE FROM movement_facts WHERE organization_id = $1 AND source_type = 'Transfer' AND source_id IN (${ownedDocuments})`, [seeded.organizationId, seeded.actorId]);
    await client.query(`DELETE FROM audit_events WHERE organization_id = $1 AND entity_type = 'Transfer' AND entity_id IN (${ownedDocuments})`, [seeded.organizationId, seeded.actorId]);
    await client.query(`DELETE FROM outbox_events WHERE organization_id = $1 AND aggregate_type = 'Transfer' AND aggregate_id IN (${ownedDocuments})`, [seeded.organizationId, seeded.actorId]);
    await client.query(`DELETE FROM transfer_approval_actions WHERE organization_id = $1 AND approval_snapshot_id IN (${ownedSnapshots})`, [seeded.organizationId, seeded.actorId]);
    await client.query(`DELETE FROM transfer_approval_snapshot_steps WHERE organization_id = $1 AND approval_snapshot_id IN (${ownedSnapshots})`, [seeded.organizationId, seeded.actorId]);
    await client.query(`DELETE FROM transfer_approval_snapshots WHERE organization_id = $1 AND transfer_document_id IN (${ownedDocuments})`, [seeded.organizationId, seeded.actorId]);
    await client.query('DELETE FROM transfer_documents WHERE organization_id = $1 AND creator_user_id = $2', [seeded.organizationId, seeded.actorId]);
    await client.query('DELETE FROM approval_steps WHERE organization_id = $1 AND approval_policy_id = $2', [seeded.organizationId, seeded.policyId]);
    await client.query('DELETE FROM approval_policies WHERE organization_id = $1 AND id = ANY($2::uuid[])', [
      seeded.organizationId, [seeded.policyId, seeded.zeroStepPolicyId],
    ]);
    await client.query(`
      DELETE FROM idempotency_records
      WHERE organization_id = $1
        AND (scope LIKE '%' || $2 || '%' OR scope LIKE '%' || $3 || '%' OR scope LIKE '%' || $4 || '%')
    `, [seeded.organizationId, seeded.actorId, seeded.approverId, seeded.secondApproverId]);
    const grantIds = [seeded.actorGrantId, seeded.approverGrantId, seeded.secondApproverGrantId, seeded.deniedGrantId,
      seeded.sourceCustodianGrantId, seeded.destinationCustodianGrantId];
    await client.query('DELETE FROM access_grant_currency_scopes WHERE access_grant_id = ANY($1::uuid[])', [grantIds]);
    await client.query('DELETE FROM access_grant_document_type_scopes WHERE access_grant_id = ANY($1::uuid[])', [grantIds]);
    await client.query('DELETE FROM access_grant_cashbox_scopes WHERE access_grant_id = ANY($1::uuid[])', [grantIds]);
    await client.query('DELETE FROM access_grant_treasury_unit_scopes WHERE access_grant_id = ANY($1::uuid[])', [grantIds]);
    await client.query('DELETE FROM access_grant_branch_scopes WHERE access_grant_id = ANY($1::uuid[])', [grantIds]);
    await client.query('DELETE FROM access_grants WHERE id = ANY($1::uuid[])', [grantIds]);
    const roleIds = [seeded.actorRoleId, seeded.approverRoleId, seeded.secondApproverRoleId, seeded.deniedRoleId, seeded.custodyRoleId];
    await client.query('DELETE FROM role_permissions WHERE role_id = ANY($1::uuid[])', [roleIds]);
    await client.query('DELETE FROM roles WHERE id = ANY($1::uuid[])', [roleIds]);
    await client.query('DELETE FROM cashbox_assignments WHERE id = $1', [seeded.assignmentId]);
    await client.query("DELETE FROM movement_facts WHERE organization_id = $1 AND endpoint_id = $2 AND owner = 'foundation'", [seeded.organizationId, seeded.cashboxId]);
    await client.query('DELETE FROM cashbox_currency_controls WHERE cashbox_id = $1', [seeded.cashboxId]);
    await client.query('DELETE FROM cashboxes WHERE id = $1', [seeded.cashboxId]);
    await client.query('DELETE FROM exchange_rates WHERE id = ANY($1::uuid[])', [[seeded.tableRateId, seeded.manualRateId]]);
    await client.query('DELETE FROM user_refs WHERE id = ANY($1::uuid[])', [[
      seeded.actorId, seeded.approverId, seeded.secondApproverId,
      seeded.sourceCustodianId, seeded.destinationId, seeded.deniedId,
    ]]);
    await client.query('DELETE FROM treasury_units WHERE id = ANY($1::uuid[])', [[seeded.treasuryUnitId, seeded.deniedTreasuryUnitId]]);
    await client.query('DELETE FROM branches WHERE id = ANY($1::uuid[])', [[seeded.branchId, seeded.deniedBranchId]]);
    await client.query('DELETE FROM currencies WHERE organization_id = $1 AND code = $2', [seeded.organizationId, seeded.crossCurrency]);
    if (seeded.ownsFoundation) {
      await client.query('DELETE FROM currencies WHERE organization_id = $1', [seeded.organizationId]);
      await client.query('DELETE FROM organizations WHERE id = $1', [seeded.organizationId]);
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
