import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CashboxCreateDto,
  CashboxType,
} from '../src/cashbox-and-custody/cashbox.dto';
import { AccessAuthorizationRepository } from '../src/access-control/access-authorization.repository';
import { AccessAuthorizationService } from '../src/access-control/access-authorization.service';
import type { AuthService } from '../src/access-control/auth.service';
import type { CredentialService } from '../src/access-control/credential.service';
import { IdentityRepository } from '../src/access-control/identity.repository';
import { IdentityService } from '../src/access-control/identity.service';
import { CashboxRepository } from '../src/cashbox-and-custody/cashbox.repository';
import { CashboxService } from '../src/cashbox-and-custody/cashbox.service';
import {
  CashboxDayApprovalCommand,
  ReplenishmentSourceType,
} from '../src/cashbox-and-custody/cashbox-operations.dto';
import { CashboxOperationsRepository } from '../src/cashbox-and-custody/cashbox-operations.repository';
import { CashboxOperationsService } from '../src/cashbox-and-custody/cashbox-operations.service';
import { PaymentCashboxEffectsRepository } from '../src/cashbox-and-custody/payment-cashbox-effects.service';
import { ReceiptCashboxEffectsRepository } from '../src/cashbox-and-custody/receipt-cashbox-effects.service';
import { digest } from '../src/common/http';
import { TreasuryProblem } from '../src/common/problem';
import { DatabaseService } from '../src/database/database.service';
import {
  FoundationEffectsRepository,
  FoundationEffectsService,
} from '../src/foundation-effects/foundation-effects.service';
import { MasterDataRepository } from '../src/master-data/master-data.repository';
import { MasterDataService } from '../src/master-data/master-data.service';
import { TransferEndpointType, type TransferView } from '../src/transfers/transfer.dto';
import { TransferRepository } from '../src/transfers/transfer.repository';

const connectionString = process.env.TEST_DATABASE_URL;

test('INC-1D PostgreSQL create/list/handover are scoped, replay-safe, atomic, and serialized', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = connectionString;
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 23).toString('base64');
  const database = new DatabaseService();
  const service = new CashboxService(
    new CashboxRepository(database),
    database,
    new AccessAuthorizationService(new AccessAuthorizationRepository()),
    new IdentityService(
      new IdentityRepository(database),
      {} as CredentialService,
      {} as AuthService,
    ),
    new MasterDataService(new MasterDataRepository(database)),
  );
  const effects = new FoundationEffectsService(new FoundationEffectsRepository());
  const masterData = new MasterDataService(new MasterDataRepository(database));
  const operations = new CashboxOperationsService(
    database,
    new CashboxOperationsRepository(),
    new AccessAuthorizationService(new AccessAuthorizationRepository()),
    effects,
    masterData,
  );
  try {
    const fixture = await seed(database);
    const branchlessUnit = await database.pool.query<{ id: string }>(`
      INSERT INTO treasury_units (
        organization_id, branch_id, code, name, default_currency
      ) VALUES ($1, NULL, 'DIRECT', 'Direct Treasury', 'USD')
      RETURNING id
    `, [fixture.organizationId]);
    await database.pool.query(`
      INSERT INTO numbering_rules (
        organization_id, operation, branch_id, treasury_unit_id,
        fiscal_year, fiscal_year_starts_on, fiscal_year_ends_on,
        prefix, number_width, next_value
      ) VALUES ($1, 'CASHBOX_DAY_CLOSE', NULL, $2,
        '2026', '2026-01-01', '2026-12-31', 'DIRECT-', 4, 1)
    `, [fixture.organizationId, branchlessUnit.rows[0]!.id]);
    const branchlessNumber = await database.db.transaction((transaction) =>
      masterData.reserveCashboxDayNumber(
        transaction,
        fixture.organizationId,
        null,
        branchlessUnit.rows[0]!.id,
        '2026-08-08',
      ));
    assert.equal(branchlessNumber.businessNumber, 'DIRECT-2026-0001');
    const missingCashboxId = '00000000-0000-4000-8000-999999999999';
    await assert.rejects(
      service.createHandover(
        fixture.organizationId,
        fixture.primaryUserId,
        missingCashboxId,
        {
          incomingUserId: fixture.incomingUserId,
          moneyCounts: [{ currency: 'USD', countedAmount: '0' }],
          observedInstrumentIds: [],
        },
        'handover-missing-unrestricted',
        '"0"',
        'request-missing-unrestricted',
      ),
      (error) => problem(error, 'TRS-GEN-004', 404),
    );
    await assert.rejects(
      service.createHandover(
        fixture.organizationId,
        fixture.scopedUserId,
        missingCashboxId,
        {
          incomingUserId: fixture.incomingUserId,
          moneyCounts: [{ currency: 'USD', countedAmount: '0' }],
          observedInstrumentIds: [],
        },
        'handover-missing-scoped',
        '"0"',
        'request-missing-scoped',
      ),
      (error) => problem(error, 'TRS-GEN-003', 403),
    );
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
      WITH restricted AS (
        UPDATE access_grants
        SET organization_wide = false
        WHERE id = $1
        RETURNING id
      )
      INSERT INTO access_grant_branch_scopes (access_grant_id, branch_id)
      SELECT id, $2 FROM restricted
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
    await database.pool.query(`
      WITH removed AS (
        DELETE FROM access_grant_branch_scopes
        WHERE access_grant_id = $1
        RETURNING access_grant_id
      )
      UPDATE access_grants
      SET organization_wide = true
      WHERE id IN (SELECT access_grant_id FROM removed)
    `, [fixture.primaryGrantId]);
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
    const rolledBack = await database.pool.query<{ count: number }>(`
      SELECT count(*)::int
      FROM idempotency_records
      WHERE organization_id = $1
        AND scope = 'createCashboxHandover'
        AND idempotency_key = 'stale-handover'
    `, [fixture.organizationId]);
    assert.equal(rolledBack.rows[0]!.count, 0);

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

    const closeCashbox = await service.create(
      fixture.organizationId,
      fixture.primaryUserId,
      createDto(fixture, 'CLOSE'),
      'cashbox-close',
      'request-create-close',
    );
    const closeContext = {
      organizationId: fixture.organizationId,
      actorUserId: fixture.primaryUserId,
      key: 'close-rollback',
      requestId: 'request-close-rollback',
    };
    await database.db.transaction((transaction) => effects.appendMovement(transaction, {
      organizationId: fixture.organizationId,
      owner: 'domain.cashbox-and-custody',
      sourceType: 'CashboxDay',
      sourceId: closeCashbox.id,
      effectKey: 'cashbox-close-future-fact',
      endpointType: 'CASHBOX',
      endpointId: closeCashbox.id,
      amount: '100',
      currency: 'USD',
      businessDate: '2026-08-09',
    }));
    await assert.rejects(
      operations.closeDay({
        ...closeContext,
        actorUserId: fixture.otherUserId,
        key: 'close-wrong-custodian',
      }, closeCashbox.id, '2026-08-08', {
        counts: [{ currency: 'USD', countedAmount: '0' }],
        observedInstrumentIds: [],
      }),
      (error) => problem(error, 'TRS-CSH-002', 409),
    );
    await assert.rejects(
      operations.closeDay(closeContext, closeCashbox.id, '2026-08-08', {
        counts: [{ currency: 'USD', countedAmount: '0' }],
        observedInstrumentIds: ['00000000-0000-4000-8000-999999999999'],
      }),
      (error) => problem(error, 'TRS-GEN-001', 422),
    );
    await assert.rejects(
      operations.closeDay({ ...closeContext, key: 'close-overprecision' }, closeCashbox.id, '2026-08-08', {
        counts: [{ currency: 'USD', countedAmount: '0.001' }],
        observedInstrumentIds: [],
      }),
      (error) => problem(error, 'TRS-GEN-001', 422),
    );
    await assert.rejects(
      operations.closeDay({ ...closeContext, key: 'close-padded-overprecision' }, closeCashbox.id, '2026-08-08', {
        counts: [{ currency: 'USD', countedAmount: '1.000' }],
        observedInstrumentIds: [],
      }),
      (error) => problem(error, 'TRS-GEN-001', 422),
    );
    await database.pool.query(
      `UPDATE numbering_rules SET state = 'CLOSED' WHERE organization_id = $1`,
      [fixture.organizationId],
    );
    await assert.rejects(
      operations.closeDay({ ...closeContext, key: 'close-no-rule' }, closeCashbox.id, '2026-08-08', {
        counts: [{ currency: 'USD', countedAmount: '0' }],
        observedInstrumentIds: [],
      }),
      (error) => problem(error, 'TRS-MST-006', 422),
    );
    await database.pool.query(
      `UPDATE numbering_rules SET state = 'ACTIVE' WHERE organization_id = $1`,
      [fixture.organizationId],
    );
    await database.pool.query(
      `UPDATE numbering_rules SET number_width = 19, next_value = 9223372036854775807
       WHERE organization_id = $1`,
      [fixture.organizationId],
    );
    await assert.rejects(
      operations.closeDay({ ...closeContext, key: 'close-exhausted-rule' }, closeCashbox.id, '2026-08-08', {
        counts: [{ currency: 'USD', countedAmount: '0' }],
        observedInstrumentIds: [],
      }),
      (error) => problem(error, 'TRS-MST-006', 422),
    );
    await database.pool.query(
      `UPDATE numbering_rules SET number_width = 10, next_value = 1 WHERE organization_id = $1`,
      [fixture.organizationId],
    );
    await database.db.transaction((transaction) => effects.appendMovement(transaction, {
      organizationId: fixture.organizationId,
      owner: 'domain.cashbox-and-custody',
      sourceType: 'CashboxDay',
      sourceId: closeCashbox.id,
      effectKey: 'cashbox-close-book-amount',
      endpointType: 'CASHBOX',
      endpointId: closeCashbox.id,
      amount: '100',
      currency: 'USD',
      businessDate: '2026-08-08',
    }));
    const closed = await operations.closeDay(closeContext, closeCashbox.id, '2026-08-08', {
      counts: [{ currency: 'USD', countedAmount: '100' }],
      observedInstrumentIds: [],
    });
    assert.equal(closed.state, 'CLOSED');
    assert.equal(closed.businessNumber, 'CBD-2026-0000000001');
    assert.deepEqual(closed.counts, [{
      currency: 'USD',
      bookAmount: '100',
      countedAmount: '100',
      varianceAmount: '0',
    }]);
    assert.equal((await operations.closeDay(
      closeContext,
      closeCashbox.id,
      '2026-08-08',
      { counts: [{ currency: 'USD', countedAmount: '100' }], observedInstrumentIds: [] },
    )).id, closed.id);
    await assert.rejects(
      operations.closeDay(closeContext, closeCashbox.id, '2026-08-08', {
        counts: [{ currency: 'USD', countedAmount: '100.000' }],
        observedInstrumentIds: [],
      }),
      (error) => problem(error, 'TRS-GEN-001', 422),
    );
    const closedReservation = await database.pool.query<{
      state: string;
      cashbox_day_id: string;
      business_number: string;
      count: number;
    }>(`
      SELECT state, cashbox_day_id, business_number,
             count(*) OVER ()::int AS count
      FROM cashbox_day_number_reservations
      WHERE organization_id = $1 AND cashbox_day_id = $2
    `, [fixture.organizationId, closed.id]);
    assert.deepEqual(closedReservation.rows, [{
      state: 'CONSUMED',
      cashbox_day_id: closed.id,
      business_number: closed.businessNumber,
      count: 1,
    }]);
    for (const statement of [
      `UPDATE cashbox_day_counts SET counted_amount = 1 WHERE cashbox_day_id = '${closed.id}'`,
      `DELETE FROM cashbox_day_counts WHERE cashbox_day_id = '${closed.id}'`,
      `INSERT INTO cashbox_day_counts (
        cashbox_day_id, organization_id, currency, book_amount, counted_amount, variance_amount
      ) VALUES ('${closed.id}', '${fixture.organizationId}', 'EUR', 0, 0, 0)`,
    ]) {
      await assert.rejects(database.pool.query(statement), /count evidence is immutable/u);
    }

    const rollbackCashbox = await service.create(
      fixture.organizationId,
      fixture.primaryUserId,
      createDto(fixture, 'CLOSE_ROLLBACK'),
      'cashbox-close-final-rollback',
      'request-create-close-final-rollback',
    );
    const appendOutbox = effects.appendOutbox.bind(effects);
    effects.appendOutbox = async () => { throw new Error('FORCED_FINAL_FAILURE'); };
    try {
      await assert.rejects(
        operations.closeDay({
          organizationId: fixture.organizationId,
          actorUserId: fixture.primaryUserId,
          key: 'close-final-rollback',
          requestId: 'request-close-final-rollback',
        }, rollbackCashbox.id, '2026-08-08', {
          counts: [{ currency: 'USD', countedAmount: '0' }],
          observedInstrumentIds: [],
        }),
        /FORCED_FINAL_FAILURE/u,
      );
    } finally {
      effects.appendOutbox = appendOutbox;
    }
    const rollbackEvidence = await database.pool.query<{ days: number; reserved: number }>(`
      SELECT
        (SELECT count(*)::int FROM cashbox_days WHERE cashbox_id = $1) AS days,
        (SELECT count(*)::int FROM cashbox_day_number_reservations
          WHERE cashbox_id = $1 AND state = 'RESERVED') AS reserved
    `, [rollbackCashbox.id]);
    assert.deepEqual(rollbackEvidence.rows[0], { days: 0, reserved: 1 });

    const reopenRequest = await database.pool.query<{ id: string }>(`
      INSERT INTO cashbox_day_approval_requests (
        organization_id, cashbox_id, business_date, command_kind, command_body,
        command_digest, source_day_id, source_day_version, requested_by_user_id,
        state, version
      ) VALUES ($1, $2, '2026-08-08', 'REOPEN', '{}'::jsonb, repeat('a', 64),
        $3, $4, $5, 'APPROVED', 2)
      RETURNING id
    `, [fixture.organizationId, closeCashbox.id, closed.id, closed.version, fixture.primaryUserId]);
    const reopenAction = await database.pool.query<{ id: string }>(`
      INSERT INTO cashbox_day_approval_actions (
        organization_id, approval_request_id, actor_user_id, action
      ) VALUES ($1, $2, $3, 'APPROVED')
      RETURNING id
    `, [fixture.organizationId, reopenRequest.rows[0]!.id, fixture.otherUserId]);
    const reopened = await database.pool.query<{ id: string }>(`
      INSERT INTO cashbox_days (
        organization_id, cashbox_id, business_date, close_cycle, prior_close_id,
        approval_action_id, reopen_reason, reopened_by_user_id, reopened_at,
        state, version
      ) VALUES ($1, $2, '2026-08-08', 2, $3, $4, 'Governed correction', $5, now(),
        'REOPENED', 0)
      RETURNING id
    `, [
      fixture.organizationId,
      closeCashbox.id,
      closed.id,
      reopenAction.rows[0]!.id,
      fixture.primaryUserId,
    ]);
    await assert.rejects(database.pool.query(
      'UPDATE cashbox_day_counts SET cashbox_day_id = $1 WHERE cashbox_day_id = $2',
      [reopened.rows[0]!.id, closed.id],
    ), /count evidence is immutable/u);
    await database.pool.query(
      `UPDATE cashboxes SET active_from = '2026-08-01T00:00:00Z' WHERE id = $1`,
      [closeCashbox.id],
    );
    await database.db.transaction(async (transaction) => {
      assert.equal(await new ReceiptCashboxEffectsRepository().receivable(
        transaction,
        fixture.organizationId,
        closeCashbox.id,
        'USD',
        '2026-08-08',
      ), 'CLOSED');
      assert.equal(await new PaymentCashboxEffectsRepository().payable(
        transaction,
        fixture.organizationId,
        closeCashbox.id,
        'USD',
        '2026-08-08',
        '00000000-0000-4000-8000-000000000077',
        '1',
      ), 'CLOSED');
      const transferAvailability = await new TransferRepository().sourceAvailability(
        transaction,
        {
          organizationId: fixture.organizationId,
          businessDate: '2026-08-08',
          source: { type: TransferEndpointType.CASHBOX, id: closeCashbox.id },
          sourceMoney: { amount: '1', currency: 'USD' },
        } as TransferView,
      );
      assert.equal(transferAvailability?.active, false);
    });

    const fundCashbox = await service.create(
      fixture.organizationId,
      fixture.primaryUserId,
      { ...createDto(fixture, 'FUND'), type: CashboxType.PETTY_CASH },
      'cashbox-fund',
      'request-create-fund',
    );
    const multiCurrencySource = await service.create(
      fixture.organizationId,
      fixture.primaryUserId,
      {
        ...createDto(fixture, 'SOURCE'),
        mainCurrency: 'EUR',
        currencyControls: [
          { currency: 'EUR', allowNegative: false },
          { currency: 'USD', allowNegative: false },
        ],
      },
      'cashbox-source',
      'request-create-source',
    );
    await assert.rejects(
      operations.createPettyCashFund({
        organizationId: fixture.organizationId,
        actorUserId: fixture.primaryUserId,
        key: 'create-fund-overprecision',
        requestId: 'request-create-fund-overprecision',
      }, {
        cashboxId: fundCashbox.id,
        ceiling: { amount: '100.001', currency: 'USD' },
        expenseCategoryCodes: ['OFFICE'],
        settlementDays: 30,
        replenishmentSource: {
          type: ReplenishmentSourceType.CASHBOX,
          id: multiCurrencySource.id,
        },
      }),
      (error) => problem(error, 'TRS-GEN-001', 422),
    );
    const fund = await operations.createPettyCashFund({
      organizationId: fixture.organizationId,
      actorUserId: fixture.primaryUserId,
      key: 'create-fund',
      requestId: 'request-create-fund-profile',
    }, {
      cashboxId: fundCashbox.id,
      ceiling: { amount: '100', currency: 'USD' },
      expenseCategoryCodes: ['OFFICE'],
      settlementDays: 30,
      replenishmentSource: {
        type: ReplenishmentSourceType.CASHBOX,
        id: multiCurrencySource.id,
      },
    });
    assert.equal(fund.replenishmentSource.id, multiCurrencySource.id);
    assert.equal(fund.ceiling.amount, '100');

    const approvalCashbox = await service.create(
      fixture.organizationId,
      fixture.primaryUserId,
      createDto(fixture, 'APPROVAL'),
      'cashbox-approval',
      'request-create-approval',
    );
    const approval = await operations.requestCloseApproval({
      organizationId: fixture.organizationId,
      actorUserId: fixture.primaryUserId,
      key: 'request-close-approval',
      requestId: 'request-close-approval',
    }, approvalCashbox.id, '2026-08-08', {
      counts: [{ currency: 'USD', countedAmount: '1', varianceReason: 'Count variance' }],
      observedInstrumentIds: [],
    });
    await assert.rejects(
      operations.requestCloseApproval({
        organizationId: fixture.organizationId,
        actorUserId: fixture.primaryUserId,
        key: 'request-close-approval',
        requestId: 'request-close-approval-invalid-replay',
      }, approvalCashbox.id, '2026-08-08', {
        counts: [{ currency: 'USD', countedAmount: '1.000', varianceReason: 'Count variance' }],
        observedInstrumentIds: [],
      }),
      (error) => problem(error, 'TRS-GEN-001', 422),
    );
    const actionContext = {
      organizationId: fixture.organizationId,
      actorUserId: fixture.otherUserId,
      physicalSessionId: '00000000-0000-4000-8000-000000000099',
      key: 'approval-stale',
      requestId: 'request-approval-stale',
      ifMatch: '"2"',
      stepUp: {
        proofId: '00000000-0000-4000-8000-000000000098',
        command: {
          operationId: 'actOnCashboxDayApproval',
          method: 'POST',
          path: `/v1/cashbox-day-approval-requests/${approval.id}/actions`,
          bodyDigest: 'stale-before-proof-consumption',
          idempotencyKey: 'approval-stale',
        },
      },
    };
    await assert.rejects(
      operations.actOnApproval(actionContext, approval.id, {
        action: CashboxDayApprovalCommand.APPROVE,
      }),
      (error) => problem(error, 'TRS-GEN-006', 409),
    );

    const proof = await createStepUpProof(database, fixture.otherUserId, {
      method: 'POST',
      path: `/v1/cashbox-day-approval-requests/${approval.id}/actions`,
      bodyDigest: 'approval-replay-body',
      idempotencyKey: 'approval-replay',
    });
    const replayContext = {
      organizationId: fixture.organizationId,
      actorUserId: fixture.otherUserId,
      physicalSessionId: proof.sessionId,
      key: 'approval-replay',
      requestId: 'request-approval-replay',
      ifMatch: '"1"',
      stepUp: {
        proofId: proof.proofId,
        command: {
          operationId: 'actOnCashboxDayApproval',
          method: 'POST',
          path: `/v1/cashbox-day-approval-requests/${approval.id}/actions`,
          bodyDigest: 'approval-replay-body',
          idempotencyKey: 'approval-replay',
        },
      },
    };
    const approved = await operations.actOnApproval(replayContext, approval.id, {
      action: CashboxDayApprovalCommand.APPROVE,
    });
    assert.equal(approved.state, 'APPROVED');
    assert.deepEqual(
      await operations.actOnApproval(replayContext, approval.id, {
        action: CashboxDayApprovalCommand.APPROVE,
      }),
      approved,
    );
    const consumed = await database.pool.query<{ consumed_at: Date | null }>(`
      SELECT consumed_at FROM auth_step_up_proofs WHERE token_digest = $1
    `, [digest(proof.proofId)]);
    assert.ok(consumed.rows[0]!.consumed_at);
    const varianceClosed = await operations.closeDay({
      organizationId: fixture.organizationId,
      actorUserId: fixture.primaryUserId,
      key: 'close-approved-variance',
      requestId: 'request-close-approved-variance',
    }, approvalCashbox.id, '2026-08-08', {
      counts: [{ currency: 'USD', countedAmount: '1', varianceReason: 'Count variance' }],
      observedInstrumentIds: [],
      approvalActionId: approved.action!.id,
    });
    assert.equal(varianceClosed.state, 'CLOSED');

    const concurrentCashbox = await service.create(
      fixture.organizationId,
      fixture.primaryUserId,
      createDto(fixture, 'CONCURRENT_CLOSE'),
      'cashbox-concurrent-close',
      'request-create-concurrent-close',
    );
    const concurrentClose = await Promise.allSettled([
      operations.closeDay({
        organizationId: fixture.organizationId,
        actorUserId: fixture.primaryUserId,
        key: 'concurrent-close-one',
        requestId: 'request-concurrent-close-one',
      }, concurrentCashbox.id, '2026-08-08', {
        counts: [{ currency: 'USD', countedAmount: '0' }],
        observedInstrumentIds: [],
      }),
      operations.closeDay({
        organizationId: fixture.organizationId,
        actorUserId: fixture.primaryUserId,
        key: 'concurrent-close-two',
        requestId: 'request-concurrent-close-two',
      }, concurrentCashbox.id, '2026-08-08', {
        counts: [{ currency: 'USD', countedAmount: '0' }],
        observedInstrumentIds: [],
      }),
    ]);
    assert.equal(concurrentClose.filter(({ status }) => status === 'fulfilled').length, 1);
    const closeRejected = concurrentClose.find(({ status }) => status === 'rejected');
    assert.ok(closeRejected?.status === 'rejected');
    assert.ok(problem(closeRejected.reason, 'TRS-CSH-004', 409));
    const concurrentReservation = await database.pool.query<{ consumed: number }>(`
      SELECT count(*) FILTER (WHERE state = 'CONSUMED')::int AS consumed
      FROM cashbox_day_number_reservations
      WHERE cashbox_id = $1
    `, [concurrentCashbox.id]);
    assert.equal(concurrentReservation.rows[0]!.consumed, 1);
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
      ) VALUES
        ($1, 'USD', 'US Dollar', 2, true),
        ($1, 'EUR', 'Euro', 2, false)
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
    await client.query(`
      INSERT INTO numbering_rules (
        organization_id, operation, branch_id, treasury_unit_id,
        fiscal_year, fiscal_year_starts_on, fiscal_year_ends_on,
        prefix, number_width, next_value
      ) VALUES ($1, 'CASHBOX_DAY_CLOSE', $2, $3,
        '2026', '2026-01-01', '2026-12-31', 'CBD-', 10, 1)
    `, [organizationId, branch.rows[0]!.id, unit.rows[0]!.id]);
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
      VALUES
        ($1, 'cashbox.view'),
        ($1, 'cashbox.manage'),
        ($1, 'cashbox.handover'),
        ($1, 'cashbox.close'),
        ($1, 'cashbox.reopen'),
        ($1, 'cashbox.approve'),
        ($1, 'cashbox.reject'),
        ($1, 'petty-cash.create'),
        ($1, 'petty-cash.view')
    `, [role.rows[0]!.id]);
    let primaryGrantId = '';
    for (const subject of ['primary', 'other']) {
      const grant = await client.query<{ id: string }>(`
        INSERT INTO access_grants (
          organization_id, user_ref_id, role_id, scope_id, organization_wide
        ) VALUES ($1,$2,$3,$1,true)
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
        organization_id, user_ref_id, role_id, scope_id, organization_wide
      ) VALUES ($1,$2,$3,$1,false)
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
    await client.query(`
      TRUNCATE
        cashbox_days,
        movement_facts,
        audit_events,
        outbox_events,
        petty_cash_profiles
      CASCADE
    `);
    for (const table of [
      'outbox_events',
      'audit_events',
      'movement_facts',
      'petty_cash_profiles',
      'cashbox_day_number_reservations',
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
      'totp_enrollment_challenges',
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
      'numbering_rules',
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

async function createStepUpProof(
  database: DatabaseService,
  userId: string,
  command: {
    method: string;
    path: string;
    bodyDigest: string;
    idempotencyKey: string;
  },
): Promise<{ proofId: string; sessionId: string }> {
  const account = await database.pool.query<{ id: string }>(`
    INSERT INTO identity_accounts (user_ref_id, normalized_login, password_hash, privileged)
    VALUES ($1, $2, 'test-only', true)
    RETURNING id
  `, [userId, `cashbox-approver-${userId}`]);
  const session = await database.pool.query<{ id: string }>(`
    INSERT INTO auth_sessions (
      identity_account_id, token_digest, xsrf_digest, authenticated_at, last_rotated_at,
      idle_expires_at, absolute_expires_at, assurance
    ) VALUES ($1,$2,$3,now(),now(),now() + interval '15 minutes',now() + interval '8 hours','PASSWORD_TOTP')
    RETURNING id
  `, [account.rows[0]!.id, digest(`session:${userId}`), digest(`xsrf:${userId}`)]);
  const proofId = `proof:${userId}`;
  const challenge = await database.pool.query<{ id: string }>(`
    INSERT INTO auth_challenges (
      identity_account_id, session_id, token_digest, kind, http_method, http_path,
      request_body_digest, idempotency_key, expires_at
    ) VALUES ($1,$2,$3,'STEP_UP',$4,$5,$6,$7,now() + interval '5 minutes')
    RETURNING id
  `, [
    account.rows[0]!.id,
    session.rows[0]!.id,
    digest(`challenge:${userId}`),
    command.method,
    command.path,
    command.bodyDigest,
    command.idempotencyKey,
  ]);
  await database.pool.query(`
    INSERT INTO auth_step_up_proofs (challenge_id, token_digest, expires_at)
    VALUES ($1,$2,now() + interval '5 minutes')
  `, [challenge.rows[0]!.id, digest(proofId)]);
  return { proofId, sessionId: session.rows[0]!.id };
}

function problem(error: unknown, code: string, status: number): boolean {
  return error instanceof TreasuryProblem
    && error.getStatus() === status
    && (error.getResponse() as { code?: string }).code === code;
}
