import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { AccountingRepository } from '../src/accounting-integration/accounting.repository';
import { AccountingService } from '../src/accounting-integration/accounting.service';
import { AccessAuthorizationRepository } from '../src/access-control/access-authorization.repository';
import { AccessAuthorizationService } from '../src/access-control/access-authorization.service';
import { TreasuryProblem } from '../src/common/problem';
import { DatabaseService } from '../src/database/database.service';
import { FoundationEffectsRepository, FoundationEffectsService } from '../src/foundation-effects/foundation-effects.service';

const connectionString = process.env.TEST_DATABASE_URL;

test('INC-3D PostgreSQL export/ack flow is scoped, deterministic, replay-safe, atomic, and locked', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = connectionString;
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 47).toString('base64');
  const database = new DatabaseService();
  const repository = new AccountingRepository();
  const authorization = new AccessAuthorizationService(new AccessAuthorizationRepository());
  const foundation = new FoundationEffectsService(new FoundationEffectsRepository());
  const service = new AccountingService(database, repository, authorization, foundation);
  let cleanupSeed: Awaited<ReturnType<typeof seedData>> | undefined;
  try {
    const seed = await seedData(database);
    cleanupSeed = seed;
    const body = (sourceId: string, exportKind: string, accountingSystemId = seed.accountingSystemId) => ({
      accountingSystemId,
      sourceType: 'PAYMENT' as const,
      sourceId,
      sourceVersion: 7,
      exportKind,
    });

    const systems = await service.listSystems(seed.organizationId, seed.exporterId, { limit: '500' });
    assert.deepEqual(
      systems.items.find(({ id }) => id === seed.accountingSystemId)?.supportedSourceTypes,
      ['PAYMENT'],
    );

    await assert.rejects(
      service.createExport(
        seed.organizationId, seed.exporterId, body(seed.paymentIds[0], 'GENERAL_LEDGER'),
        'mapping-missing', randomUUID(),
      ),
      isProblem('TRS-ACT-001'),
    );
    assert.equal(await exportCount(database, seed.paymentIds), 0);

    await database.pool.query(`
      INSERT INTO accounting_mappings (
        organization_id, accounting_system_id, local_type, local_id, mapping_type,
        external_key, source_version, state
      ) VALUES ($1,$2,'METHOD_DEFINITION',$3,'SUB_ACCOUNT','1101-1','1','ACTIVE')
    `, [seed.organizationId, seed.accountingSystemId, seed.methodId]);
    await assert.rejects(
      service.createExport(
        seed.organizationId, seed.exporterId, body(seed.paymentIds[0], 'AMBIGUOUS'),
        'ambiguous-mapping', randomUUID(),
      ),
      isProblem('TRS-ACT-001'),
    );
    await database.pool.query(`
      UPDATE accounting_mappings SET state = 'INACTIVE'
      WHERE organization_id = $1 AND accounting_system_id = $2
        AND local_type = 'METHOD_DEFINITION' AND local_id = $3 AND mapping_type = 'SUB_ACCOUNT'
    `, [seed.organizationId, seed.accountingSystemId, seed.methodId]);

    await insertMappings(database, seed);
    await assert.rejects(
      service.createExport(
        seed.organizationId, seed.exporterId, body(seed.paymentIds[0], 'GENERAL_LEDGER'),
        'period-missing', randomUUID(),
      ),
      isProblem('TRS-ACT-006'),
    );
    assert.equal(await exportCount(database, seed.paymentIds), 0);

    await insertPeriod(database, seed);
    await assert.rejects(
      service.createExport(
        seed.organizationId, seed.deniedId, body(seed.paymentIds[0], 'GENERAL_LEDGER'),
        'denied-export', randomUUID(),
      ),
      isProblem('TRS-GEN-003'),
    );
    assert.equal(await exportCount(database, seed.paymentIds), 0);
    await assert.rejects(
      service.createExport(
        seed.organizationId, seed.executorId, body(seed.paymentIds[0], 'GENERAL_LEDGER'),
        'executor-export', randomUUID(),
      ),
      isProblem('TRS-GEN-003'),
    );
    assert.equal(await exportCount(database, seed.paymentIds), 0);

    const first = await service.createExport(
      seed.organizationId, seed.exporterId, body(seed.paymentIds[0], 'GENERAL_LEDGER'),
      'export-replay-key', randomUUID(),
    );
    const queue = await service.listExports(
      seed.organizationId,
      seed.acknowledgerIds[0],
      { limit: '10' },
    );
    assert.equal(queue.items[0]!.id, first.id);
    assert.equal(queue.items[0]!.source.label.startsWith('PAY-'), true);
    assert.equal(queue.items[0]!.version, 1);
    assert.equal(
      (await service.listExports(seed.organizationId, seed.exporterId, { limit: '10' }))
        .items.some(({ id }) => id === first.id),
      false,
    );
    await assert.rejects(
      service.listExports(seed.organizationId, seed.deniedId, { limit: '10' }),
      isProblem('TRS-GEN-003'),
    );
    await database.pool.query(`
      UPDATE access_grants
      SET amount_ceiling = 50, amount_ceiling_currency = 'IRR'
      WHERE organization_id = $1 AND user_ref_id = $2
    `, [seed.organizationId, seed.acknowledgerIds[0]]);
    assert.deepEqual(
      (await service.listExports(seed.organizationId, seed.acknowledgerIds[0], { limit: '10' })).items,
      [],
    );
    await database.pool.query(`
      UPDATE access_grants
      SET amount_ceiling = NULL, amount_ceiling_currency = NULL
      WHERE organization_id = $1 AND user_ref_id = $2
    `, [seed.organizationId, seed.acknowledgerIds[0]]);
    const secondQueueExport = await service.createExport(
      seed.organizationId,
      seed.exporterId,
      body(seed.paymentIds[1], 'QUEUE_PAGINATION'),
      'queue-pagination-export',
      randomUUID(),
    );
    const firstQueuePage = await service.listExports(
      seed.organizationId,
      seed.acknowledgerIds[0],
      { limit: '1' },
    );
    assert.equal(firstQueuePage.page.hasMore, true);
    assert.ok(firstQueuePage.page.nextCursor);
    const secondQueuePage = await service.listExports(
      seed.organizationId,
      seed.acknowledgerIds[0],
      { limit: '1', cursor: firstQueuePage.page.nextCursor },
    );
    assert.notEqual(secondQueuePage.items[0]!.id, firstQueuePage.items[0]!.id);
    assert.ok([first.id, secondQueueExport.id].includes(firstQueuePage.items[0]!.id));
    const tamperedCursor = JSON.parse(Buffer.from(
      firstQueuePage.page.nextCursor,
      'base64url',
    ).toString('utf8')) as { payload: { after: { id: string } } };
    tamperedCursor.payload.after.id = randomUUID();
    await assert.rejects(
      service.listExports(seed.organizationId, seed.acknowledgerIds[0], {
        limit: '1',
        cursor: Buffer.from(JSON.stringify(tamperedCursor)).toString('base64url'),
      }),
      isProblem('TRS-GEN-001'),
    );
    await database.pool.query(`
      UPDATE access_grants
      SET amount_ceiling = 150, amount_ceiling_currency = 'IRR'
      WHERE organization_id = $1 AND user_ref_id = $2
    `, [seed.organizationId, seed.acknowledgerIds[0]]);
    await assert.rejects(
      service.listExports(seed.organizationId, seed.acknowledgerIds[0], {
        limit: '1', cursor: firstQueuePage.page.nextCursor,
      }),
      isProblem('TRS-GEN-001'),
    );
    await database.pool.query(`
      UPDATE access_grants
      SET amount_ceiling = NULL, amount_ceiling_currency = NULL
      WHERE organization_id = $1 AND user_ref_id = $2
    `, [seed.organizationId, seed.acknowledgerIds[0]]);
    await assert.rejects(
      service.listExports(seed.organizationId, seed.acknowledgerIds[1], {
        limit: '1', cursor: firstQueuePage.page.nextCursor,
      }),
      isProblem('TRS-GEN-001'),
    );
    const replay = await service.createExport(
      seed.organizationId, seed.exporterId, body(seed.paymentIds[0], 'GENERAL_LEDGER'),
      'export-replay-key', randomUUID(),
    );
    assert.deepEqual(replay, first);
    assert.equal(first.artifacts.length, 2);
    assert.deepEqual(first.artifacts.map(({ rowCount }) => rowCount), [1, 1]);
    await assert.rejects(
      service.createExport(
        seed.organizationId, seed.exporterId, body(seed.paymentIds[0], 'CHANGED_KIND'),
        'export-replay-key', randomUUID(),
      ),
      isProblem('TRS-GEN-007'),
    );
    const frozenScopeExport = await service.createExport(
      seed.organizationId,
      seed.exporterId,
      body(seed.paymentIds[5], 'FROZEN_SCOPE'),
      'frozen-scope-export',
      randomUUID(),
    );
    const driftBranchId = randomUUID();
    const driftTreasuryUnitId = randomUUID();
    await database.pool.query(`
      INSERT INTO branches (id, organization_id, code, name)
      VALUES ($1, $2, $3, 'INC-3D drift branch')
    `, [driftBranchId, seed.organizationId, `DRIFT-${driftBranchId.slice(0, 8)}`]);
    await database.pool.query(`
      INSERT INTO treasury_units (
        id, organization_id, branch_id, code, name, default_currency
      ) VALUES ($1, $2, $3, $4, 'INC-3D drift unit', 'IRR')
    `, [driftTreasuryUnitId, seed.organizationId, driftBranchId,
      `DRIFT-${driftTreasuryUnitId.slice(0, 8)}`]);
    await database.pool.query(`
      UPDATE payment_documents SET branch_id = $1, treasury_unit_id = $2
      WHERE organization_id = $3 AND id = $4
    `, [driftBranchId, driftTreasuryUnitId, seed.organizationId, seed.paymentIds[5]]);
    const frozenDownloaded = await service.download(
      seed.organizationId,
      seed.exporterId,
      frozenScopeExport.id,
      { representation: 'XLSX' },
    );
    assert.equal(frozenDownloaded.bytes.readUInt32LE(0), 0x04034b50);
    const frozenAcknowledged = await service.acknowledge(
      seed.organizationId,
      seed.acknowledgerIds[0],
      frozenScopeExport.id,
      acknowledgement('ACCEPTED', 'external-frozen-scope'),
      'frozen-scope-ack',
      '"1"',
      randomUUID(),
    );
    assert.equal(frozenAcknowledged.export.state, 'ACCEPTED');
    const downloaded = await service.download(
      seed.organizationId,
      seed.exporterId,
      first.id,
      { representation: 'XLSX' },
    );
    assert.equal(downloaded.bytes.readUInt32LE(0), 0x04034b50);
    assert.equal(downloaded.etag, `"${first.artifacts.find(({ representation }) =>
      representation === 'XLSX')!.payloadDigest}"`);

    const accepted = await service.acknowledge(
      seed.organizationId,
      seed.acknowledgerIds[0],
      first.id,
      acknowledgement('ACCEPTED', 'external-a'),
      'ack-replay-key',
      '"1"',
      randomUUID(),
    );
    assert.equal(accepted.export.state, 'ACCEPTED');
    assert.ok(accepted.postingLock);
    const acceptedEvents = await database.pool.query<{
      event_type: string;
      payload: Record<string, unknown>;
    }>('SELECT event_type, payload FROM outbox_events WHERE aggregate_id = $1', [first.id]);
    assert.equal(acceptedEvents.rows.length, 1);
    assert.equal(acceptedEvents.rows[0]!.event_type, 'treasury.accounting.export-accepted.v1');
    assert.equal(acceptedEvents.rows[0]!.payload.responseDigest, 'b'.repeat(64));
    assert.equal(acceptedEvents.rows[0]!.payload.exportVersion, 2);
    const acceptedReplay = await service.acknowledge(
      seed.organizationId,
      seed.acknowledgerIds[0],
      first.id,
      acknowledgement('ACCEPTED', 'external-a'),
      'ack-replay-key',
      '"1"',
      randomUUID(),
    );
    assert.deepEqual(acceptedReplay, accepted);
    await assert.rejects(
      service.createExport(
        seed.organizationId,
        seed.exporterId,
        body(seed.paymentIds[0], 'SECOND_AFTER_ACCEPTANCE'),
        'accepted-source-duplicate',
        randomUUID(),
      ),
      isProblem('TRS-ACT-002'),
    );
    await assert.rejects(
      service.acknowledge(
        seed.organizationId,
        seed.acknowledgerIds[0],
        first.id,
        acknowledgement('ACCEPTED', 'external-a'),
        'stale-ack-key',
        '"1"',
        randomUUID(),
      ),
      isProblem('TRS-GEN-006'),
    );
    const returned = await service.acknowledge(
      seed.organizationId,
      seed.acknowledgerIds[0],
      first.id,
      {
        outcome: 'RETURNED',
        externalDocumentId: 'external-a',
        externalReturnId: 'return-a',
        responseDigest: 'd'.repeat(64),
        errorCode: 'LEDGER_RETURNED',
        acknowledgedAt: '2026-08-02T13:00:00.000Z',
      },
      'return-ack-key',
      '"2"',
      randomUUID(),
    );
    assert.equal(returned.export.state, 'RETURNED');
    assert.equal(returned.export.externalDocumentNumber, 'EXT-NUMBER');
    await assert.rejects(
      database.pool.query('UPDATE payment_documents SET purpose = $1 WHERE id = $2', [
        'mutated after posting', seed.paymentIds[0],
      ]),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
    await assert.rejects(
      database.pool.query('DELETE FROM payment_lines WHERE payment_document_id = $1', [
        seed.paymentIds[0],
      ]),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
    await assert.rejects(
      database.pool.query(`
        INSERT INTO payment_line_attachment_links (
          organization_id, payment_line_id, attachment_id, content_digest
        )
        SELECT organization_id, id, gen_random_uuid(), $1
        FROM payment_lines WHERE payment_document_id = $2 LIMIT 1
      `, ['d'.repeat(64), seed.paymentIds[0]]),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
    await assert.rejects(
      database.pool.query('UPDATE posting_locks SET locked_digest = $1 WHERE accounting_export_id = $2', [
        'e'.repeat(64), first.id,
      ]),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
    await assert.rejects(
      database.pool.query('DELETE FROM posting_locks WHERE accounting_export_id = $1', [first.id]),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );

    const concurrent = await service.createExport(
      seed.organizationId, seed.exporterId, body(seed.paymentIds[1], 'CONCURRENT'),
      'concurrent-export', randomUUID(),
    );
    const concurrentResults = await Promise.allSettled(seed.acknowledgerIds.map((actorUserId, index) =>
      service.acknowledge(
        seed.organizationId,
        actorUserId,
        concurrent.id,
        acknowledgement('ACCEPTED', `external-race-${index}`),
        `concurrent-ack-${index}`,
        '"1"',
        randomUUID(),
      )));
    assert.equal(concurrentResults.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.equal(concurrentResults.filter(({ status }) => status === 'rejected').length, 1);
    assert.ok(concurrentResults.some((result) => result.status === 'rejected'
      && isProblem('TRS-GEN-006')(result.reason)));

    const crossSystemExports = await Promise.all([
      service.createExport(
        seed.organizationId, seed.exporterId, body(seed.paymentIds[4], 'CROSS_SYSTEM'),
        'cross-system-a', randomUUID(),
      ),
      service.createExport(
        seed.organizationId, seed.exporterId,
        body(seed.paymentIds[4], 'CROSS_SYSTEM', seed.secondAccountingSystemId),
        'cross-system-b', randomUUID(),
      ),
    ]);
    const crossSystemResults = await Promise.allSettled(crossSystemExports.map((item, index) =>
      service.acknowledge(
        seed.organizationId,
        seed.acknowledgerIds[index]!,
        item.id,
        acknowledgement('ACCEPTED', `external-cross-${index}`),
        `cross-system-ack-${index}`,
        '"1"',
        randomUUID(),
      )));
    assert.equal(crossSystemResults.filter(({ status }) => status === 'fulfilled').length, 1);
    const crossSystemFailures = crossSystemResults.flatMap((result) => {
      if (result.status !== 'rejected') return [];
      const reason = result.reason as {
        name?: string; message?: string; code?: string; constraint?: string;
        getResponse?: () => unknown;
      };
      return [{
        name: reason.name,
        message: reason.message,
        code: reason.code,
        constraint: reason.constraint,
        response: reason.getResponse?.(),
      }];
    });
    assert.deepEqual(
      crossSystemFailures.map(({ response }) => (response as { code?: string } | undefined)?.code),
      ['TRS-ACT-002'],
      JSON.stringify(crossSystemFailures),
    );

    const rejectedExport = await service.createExport(
      seed.organizationId, seed.exporterId, body(seed.paymentIds[2], 'REJECTED'),
      'rejected-export', randomUUID(),
    );
    const rejected = await service.acknowledge(
      seed.organizationId,
      seed.acknowledgerIds[0],
      rejectedExport.id,
      {
        outcome: 'REJECTED',
        responseDigest: 'c'.repeat(64),
        errorCode: 'LEDGER_REJECTED',
        errorDetail: 'Rejected by the accounting system',
        acknowledgedAt: '2026-08-02T12:00:00.000Z',
      },
      'rejected-ack',
      '"1"',
      randomUUID(),
    );
    assert.equal(rejected.export.state, 'FAILED');
    const failedEvents = await database.pool.query<{
      event_type: string;
      payload: Record<string, unknown>;
    }>('SELECT event_type, payload FROM outbox_events WHERE aggregate_id = $1', [rejectedExport.id]);
    assert.equal(failedEvents.rows.length, 1);
    assert.equal(failedEvents.rows[0]!.event_type, 'treasury.accounting.export-failed.v1');
    assert.equal(failedEvents.rows[0]!.payload.state, 'FAILED');
    assert.equal(failedEvents.rows[0]!.payload.errorCode, 'LEDGER_REJECTED');

    const rollback = await service.createExport(
      seed.organizationId, seed.exporterId, body(seed.paymentIds[3], 'ROLLBACK'),
      'rollback-export', randomUUID(),
    );
    const failing = new AccountingService(
      database,
      repository,
      authorization,
      {
        appendAudit: (...args: Parameters<FoundationEffectsService['appendAudit']>) =>
          foundation.appendAudit(...args),
        appendOutbox: async () => { throw new Error('forced outbox failure'); },
      } as unknown as FoundationEffectsService,
    );
    await assert.rejects(
      failing.acknowledge(
        seed.organizationId,
        seed.acknowledgerIds[0],
        rollback.id,
        acknowledgement('ACCEPTED', 'external-rollback'),
        'rollback-ack',
        '"1"',
        randomUUID(),
      ),
      /forced outbox failure/u,
    );
    const rolledBack = await database.pool.query<{
      state: string;
      version: string;
      acknowledgements: string;
      locks: string;
    }>(`
      SELECT e.state, e.version::text,
        (SELECT count(*)::text FROM accounting_acknowledgements a
          WHERE a.accounting_export_id = e.id) AS acknowledgements,
        (SELECT count(*)::text FROM posting_locks l
          WHERE l.accounting_export_id = e.id) AS locks
      FROM accounting_exports e WHERE e.id = $1
    `, [rollback.id]);
    assert.deepEqual(rolledBack.rows[0], {
      state: 'QUEUED', version: '1', acknowledgements: '0', locks: '0',
    });
  } finally {
    if (cleanupSeed) await cleanup(database, cleanupSeed);
    await database.onModuleDestroy();
  }
});

function acknowledgement(outcome: 'ACCEPTED', externalDocumentId: string) {
  return {
    outcome,
    externalDocumentId,
    externalDocumentNumber: 'EXT-NUMBER',
    responseDigest: 'b'.repeat(64),
    acknowledgedAt: '2026-08-02T12:00:00.000Z',
  };
}

async function seedData(database: DatabaseService) {
  let organizationId: string;
  let branchId: string;
  let treasuryUnitId: string;
  const existing = await database.pool.query<{
    organization_id: string;
    branch_id: string;
    treasury_unit_id: string;
  }>(`
    SELECT o.id AS organization_id, b.id AS branch_id, t.id AS treasury_unit_id
    FROM organizations o
    JOIN branches b ON b.organization_id = o.id
    JOIN treasury_units t ON t.organization_id = o.id AND t.branch_id = b.id
    ORDER BY o.created_at LIMIT 1
  `);
  const ownsFoundation = !existing.rows[0];
  if (existing.rows[0]) {
    organizationId = existing.rows[0].organization_id;
    branchId = existing.rows[0].branch_id;
    treasuryUnitId = existing.rows[0].treasury_unit_id;
  } else {
    organizationId = randomUUID();
    branchId = randomUUID();
    treasuryUnitId = randomUUID();
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      await client.query(`
        INSERT INTO organizations (id, code, legal_name, timezone, base_currency)
        VALUES ($1,'INC3D','INC-3D organization','Asia/Tehran','IRR')
      `, [organizationId]);
      await client.query(`
        INSERT INTO currencies (organization_id, code, name, decimal_places, base_currency)
        VALUES ($1,'IRR','Iranian Rial',0,true)
      `, [organizationId]);
      await client.query(`
        INSERT INTO branches (id, organization_id, code, name)
        VALUES ($1,$2,'HQ','Head office')
      `, [branchId, organizationId]);
      await client.query(`
        INSERT INTO treasury_units (id, organization_id, branch_id, code, name, default_currency)
        VALUES ($1,$2,$3,'TU','Treasury unit','IRR')
      `, [treasuryUnitId, organizationId, branchId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  const exporterId = randomUUID();
  const acknowledgerIds = [randomUUID(), randomUUID()];
  const deniedId = randomUUID();
  const executorId = randomUUID();
  const partyId = randomUUID();
  const methodId = randomUUID();
  const exportRoleId = randomUUID();
  const acknowledgeRoleId = randomUUID();
  const accountingSystemId = randomUUID();
  const accountingImportId = randomUUID();
  const secondAccountingSystemId = randomUUID();
  const secondAccountingImportId = randomUUID();
  const paymentIds = [
    randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(),
  ] as [
    string, string, string, string, string, string,
  ];
  const suffix = exporterId.slice(0, 8).toUpperCase();
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query(`
      INSERT INTO user_refs (id, organization_id, subject_key, display_name) VALUES
        ($1,$6,$7,'INC-3D exporter'),($2,$6,$8,'INC-3D acknowledger one'),
        ($3,$6,$9,'INC-3D acknowledger two'),($4,$6,$10,'INC-3D denied actor'),
        ($5,$6,$11,'INC-3D source executor')
    `, [
      exporterId, acknowledgerIds[0], acknowledgerIds[1], deniedId, executorId,
      organizationId, `exporter-${suffix}`, `ack-one-${suffix}`, `ack-two-${suffix}`,
      `denied-${suffix}`, `executor-${suffix}`,
    ]);
    await client.query(`
      INSERT INTO parties (id, organization_id, code, display_name)
      VALUES ($1,$2,$3,'INC-3D supplier')
    `, [partyId, organizationId, `PTY-${suffix}`]);
    await client.query(`
      INSERT INTO method_definitions (
        id, organization_id, code, name, direction, behavior_category,
        creates_funds_in_transit, requires_approval
      ) VALUES ($1,$2,$3,'Controlled payment','PAYMENT','OTHER_CONTROLLED',false,false)
    `, [methodId, organizationId, `MTH-${suffix}`]);
    await client.query(`
      INSERT INTO roles (id, organization_id, code, name) VALUES
        ($1,$3,$4,'Accounting exporter'),($2,$3,$5,'Accounting acknowledger')
    `, [exportRoleId, acknowledgeRoleId, organizationId, `EXP-${suffix}`, `ACK-${suffix}`]);
    await client.query(`
      INSERT INTO role_permissions (role_id, permission) VALUES
        ($1,'accounting.export'),($1,'accounting.acknowledge'),($2,'accounting.acknowledge')
    `, [exportRoleId, acknowledgeRoleId]);
    const grants = [
      [randomUUID(), exporterId, exportRoleId],
      [randomUUID(), executorId, exportRoleId],
      [randomUUID(), acknowledgerIds[0], acknowledgeRoleId],
      [randomUUID(), acknowledgerIds[1], acknowledgeRoleId],
    ];
    for (const [grantId, userId, roleId] of grants) {
      await client.query(`
        INSERT INTO access_grants (
          id, organization_id, user_ref_id, role_id, scope_type, scope_id, organization_wide
        ) VALUES ($1,$2,$3,$4,'ORGANIZATION',$2,false)
      `, [grantId, organizationId, userId, roleId]);
      await client.query(`INSERT INTO access_grant_branch_scopes VALUES ($1,$2)`, [grantId, branchId]);
      await client.query(`INSERT INTO access_grant_treasury_unit_scopes VALUES ($1,$2)`, [grantId, treasuryUnitId]);
      await client.query(`INSERT INTO access_grant_document_type_scopes VALUES ($1,'PAYMENT')`, [grantId]);
    }
    for (const [index, paymentId] of paymentIds.entries()) {
      await client.query(`
        INSERT INTO payment_documents (
          id, organization_id, business_number, business_date, beneficiary_party_id,
          branch_id, treasury_unit_id, base_currency, total_base_amount, purpose,
          creator_user_id, executed_at, executed_by_user_id, state, workflow_state,
          execution_state, accounting_state, version
        ) VALUES (
          $1,$2,$3,'2026-08-02',$4,$5,$6,'IRR',100,'INC-3D payment',$7,
          '2026-08-02T10:00:00Z',$7,'EXECUTED','APPROVED','EXECUTED','NOT_READY',7
        )
      `, [paymentId, organizationId, `PAY-${suffix}-${index}`, partyId, branchId, treasuryUnitId, executorId]);
      await client.query(`
        INSERT INTO payment_lines (
          organization_id, payment_document_id, line_number, method_id, method_name,
          method_category, method_required_references, requires_approval, amount,
          currency, base_currency, exchange_rate, rate_type, rate_source, rate_at,
          base_amount, beneficiary_party_id, description, executed_at,
          executed_by_user_id, state, version
        ) VALUES (
          $1,$2,1,$3,'Controlled payment','OTHER_CONTROLLED','[]',false,100,
          'IRR','IRR',1,'SPOT','IDENTITY','2026-08-02T10:00:00Z',100,$4,
          'INC-3D line','2026-08-02T10:00:00Z',$5,'EXECUTED',7
        )
      `, [organizationId, paymentId, methodId, partyId, executorId]);
    }
    await client.query(`
      INSERT INTO accounting_systems (
        id, organization_id, code, name, transport_profile, contract_version, state
      ) VALUES
        ($1,$3,$4,'INC-3D ERP','CSV_ZIP_MANIFEST','1','ACTIVE'),
        ($2,$3,$5,'INC-3D second ERP','XLSX','1','ACTIVE')
    `, [accountingSystemId, secondAccountingSystemId, organizationId, `ERP-${suffix}`, `ERP2-${suffix}`]);
    await client.query(`
      INSERT INTO accounting_imports (
        id, organization_id, accounting_system_id, source_digest, contract_version,
        representation, snapshot_kind, source_version, received_at, state
      ) VALUES
        ($1,$3,$4,$6,'1','CSV_ZIP_MANIFEST','FULL','1',now(),'APPLIED'),
        ($2,$3,$5,$7,'1','XLSX','FULL','1',now(),'APPLIED')
    `, [accountingImportId, secondAccountingImportId, organizationId,
      accountingSystemId, secondAccountingSystemId, 'a'.repeat(64), 'f'.repeat(64)]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return {
    organizationId,
    branchId,
    treasuryUnitId,
    exporterId,
    acknowledgerIds,
    deniedId,
    partyId,
    methodId,
    accountingSystemId,
    accountingImportId,
    secondAccountingSystemId,
    secondAccountingImportId,
    paymentIds,
    executorId,
    exportRoleId,
    acknowledgeRoleId,
    ownsFoundation,
  };
}

async function cleanup(
  database: DatabaseService,
  seed: Awaited<ReturnType<typeof seedData>>,
): Promise<void> {
  const actors = [seed.exporterId, ...seed.acknowledgerIds, seed.deniedId, seed.executorId];
  const roles = [seed.exportRoleId, seed.acknowledgeRoleId];
  const systems = [seed.accountingSystemId, seed.secondAccountingSystemId];
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    const exports = await client.query<{ id: string }>(`
      SELECT id FROM accounting_exports
      WHERE organization_id = $1 AND source_id = ANY($2::uuid[])
    `, [seed.organizationId, seed.paymentIds]);
    const exportIds = exports.rows.map(({ id }) => id);
    await client.query(`
      DELETE FROM audit_events WHERE organization_id = $1
        AND entity_type = 'AccountingExport' AND entity_id = ANY($2::uuid[])
    `, [seed.organizationId, exportIds]);
    await client.query(`
      DELETE FROM outbox_events WHERE organization_id = $1
        AND aggregate_type = 'AccountingExport' AND aggregate_id = ANY($2::uuid[])
    `, [seed.organizationId, exportIds]);
    await client.query(`
      DELETE FROM idempotency_records WHERE organization_id = $1 AND scope = ANY($2::text[])
    `, [seed.organizationId, [
      ...systems.map((id) => `createAccountingExport:${id}`),
      ...exportIds.map((id) => `recordAccountingAcknowledgement:${id}`),
    ]]);
    await client.query(`
      DELETE FROM accounting_export_row_results WHERE organization_id = $1
        AND accounting_export_artifact_id IN (
          SELECT id FROM accounting_export_artifacts
          WHERE accounting_export_id = ANY($2::uuid[])
        )
    `, [seed.organizationId, exportIds]);
    for (const table of [
      'accounting_acknowledgements', 'posting_locks', 'accounting_export_attempts',
      'accounting_export_artifacts',
    ]) {
      await client.query(`DELETE FROM ${table} WHERE organization_id = $1
        AND accounting_export_id = ANY($2::uuid[])`, [seed.organizationId, exportIds]);
    }
    await client.query(`DELETE FROM accounting_exports WHERE organization_id = $1
      AND id = ANY($2::uuid[])`, [seed.organizationId, exportIds]);
    for (const table of ['fiscal_periods', 'accounting_mappings', 'accounting_imports']) {
      await client.query(`DELETE FROM ${table} WHERE organization_id = $1
        AND accounting_system_id = ANY($2::uuid[])`, [seed.organizationId, systems]);
    }
    await client.query(`DELETE FROM accounting_systems WHERE organization_id = $1
      AND id = ANY($2::uuid[])`, [seed.organizationId, systems]);
    await client.query(`DELETE FROM payment_lines WHERE organization_id = $1
      AND payment_document_id = ANY($2::uuid[])`, [seed.organizationId, seed.paymentIds]);
    await client.query(`DELETE FROM payment_documents WHERE organization_id = $1
      AND id = ANY($2::uuid[])`, [seed.organizationId, seed.paymentIds]);
    for (const table of [
      'access_grant_branch_scopes', 'access_grant_treasury_unit_scopes',
      'access_grant_document_type_scopes',
    ]) {
      await client.query(`DELETE FROM ${table} WHERE access_grant_id IN (
        SELECT id FROM access_grants WHERE organization_id = $1 AND user_ref_id = ANY($2::uuid[])
      )`, [seed.organizationId, actors]);
    }
    await client.query(`DELETE FROM access_grants WHERE organization_id = $1
      AND user_ref_id = ANY($2::uuid[])`, [seed.organizationId, actors]);
    await client.query('DELETE FROM role_permissions WHERE role_id = ANY($1::uuid[])', [roles]);
    await client.query(`DELETE FROM roles WHERE organization_id = $1
      AND id = ANY($2::uuid[])`, [seed.organizationId, roles]);
    await client.query(`DELETE FROM user_refs WHERE organization_id = $1
      AND id = ANY($2::uuid[])`, [seed.organizationId, actors]);
    await client.query('DELETE FROM method_definitions WHERE organization_id = $1 AND id = $2',
      [seed.organizationId, seed.methodId]);
    await client.query('DELETE FROM parties WHERE organization_id = $1 AND id = $2',
      [seed.organizationId, seed.partyId]);
    await client.query(`DELETE FROM treasury_units
      WHERE organization_id = $1 AND name = 'INC-3D drift unit'`, [seed.organizationId]);
    await client.query(`DELETE FROM branches
      WHERE organization_id = $1 AND name = 'INC-3D drift branch'`, [seed.organizationId]);
    if (seed.ownsFoundation) {
      await client.query('DELETE FROM treasury_units WHERE organization_id = $1 AND id = $2',
        [seed.organizationId, seed.treasuryUnitId]);
      await client.query('DELETE FROM branches WHERE organization_id = $1 AND id = $2',
        [seed.organizationId, seed.branchId]);
      await client.query("DELETE FROM currencies WHERE organization_id = $1 AND code = 'IRR'",
        [seed.organizationId]);
      await client.query('DELETE FROM organizations WHERE id = $1', [seed.organizationId]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function insertMappings(
  database: DatabaseService,
  seed: Awaited<ReturnType<typeof seedData>>,
): Promise<void> {
  await database.pool.query(`
    INSERT INTO accounting_mappings (
      organization_id, accounting_system_id, local_type, local_id, mapping_type,
      external_key, source_version, state
    ) VALUES
      ($1,$2,'METHOD_DEFINITION',$3,'GENERAL_ACCOUNT','1101','1','ACTIVE'),
      ($1,$2,'PARTY',$4,'DETAIL_ACCOUNT','SUPPLIER-1','1','ACTIVE'),
      ($1,$5,'METHOD_DEFINITION',$3,'GENERAL_ACCOUNT','1101','1','ACTIVE'),
      ($1,$5,'PARTY',$4,'DETAIL_ACCOUNT','SUPPLIER-1','1','ACTIVE')
  `, [seed.organizationId, seed.accountingSystemId, seed.methodId, seed.partyId,
    seed.secondAccountingSystemId]);
}

async function insertPeriod(
  database: DatabaseService,
  seed: Awaited<ReturnType<typeof seedData>>,
): Promise<void> {
  await database.pool.query(`
    INSERT INTO fiscal_periods (
      organization_id, accounting_system_id, accounting_import_id, external_key,
      period_start, period_end, source_version, source_digest, effective_at, state
    ) VALUES
      ($1,$2,$3,'2026-08','2026-08-01','2026-08-31','1',$6,now(),'OPEN'),
      ($1,$4,$5,'2026-08','2026-08-01','2026-08-31','1',$7,now(),'OPEN')
  `, [seed.organizationId, seed.accountingSystemId, seed.accountingImportId,
    seed.secondAccountingSystemId, seed.secondAccountingImportId, 'c'.repeat(64), 'd'.repeat(64)]);
}

async function exportCount(database: DatabaseService, paymentIds: string[]): Promise<number> {
  const result = await database.pool.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM accounting_exports WHERE source_id = ANY($1::uuid[])
  `, [paymentIds]);
  return Number(result.rows[0]!.count);
}

function isProblem(code: string) {
  return (error: unknown): boolean => error instanceof TreasuryProblem
    && (error.getResponse() as { code?: string }).code === code;
}
