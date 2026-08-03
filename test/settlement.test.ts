import assert from 'node:assert/strict';
import test from 'node:test';

import { AccessAuthorizationService } from '../src/access-control/access-authorization.service';
import type {
  AccessAuthorizationRepository,
  PaymentGrant,
} from '../src/access-control/access-authorization.repository';
import { TreasuryProblem } from '../src/common/problem';
import type { DatabaseService, DatabaseTransaction } from '../src/database/database.service';
import type { FoundationEffectsService } from '../src/foundation-effects/foundation-effects.service';
import {
  SettlementBatchView,
  SettlementCreateDto,
  SettlementDiscrepancyDisposition,
  SettlementMatchKind,
} from '../src/collection-and-settlement/settlement.dto';
import type {
  LockedSettlement,
  SettlementRepository,
} from '../src/collection-and-settlement/settlement.repository';
import { SettlementService } from '../src/collection-and-settlement/settlement.service';

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001';
const CREATOR_ID = '00000000-0000-4000-8000-000000000002';
const CONFIRMER_ID = '00000000-0000-4000-8000-000000000003';
const ACCOUNT_ID = '00000000-0000-4000-8000-000000000004';
const ITEM_ID = '00000000-0000-4000-8000-000000000005';
const ATTACHMENT_ID = '00000000-0000-4000-8000-000000000006';
const BATCH_ID = '00000000-0000-4000-8000-000000000007';

const grant = (overrides: Partial<PaymentGrant> = {}): PaymentGrant => ({
  id: 'grant',
  grantUserId: 'actor',
  delegatedFromUserId: null,
  amountCeiling: null,
  amountCeilingCurrency: null,
  branchIds: [],
  treasuryUnitIds: [],
  cashboxIds: [],
  bankAccountIds: [],
  documentTypes: [],
  methodCategories: [],
  currencies: [],
  ...overrides,
});

process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 9).toString('base64');

test('Settlement authorization requires one grant to cover every frozen item anchor', async () => {
  let grants = [
    grant({ branchIds: ['branch-a'], treasuryUnitIds: ['unit-a', 'unit-b'] }),
    grant({ branchIds: ['branch-a', 'branch-b'], treasuryUnitIds: ['unit-a'] }),
  ];
  const service = new AccessAuthorizationService({
    paymentGrants: async () => grants,
  } as unknown as AccessAuthorizationRepository);
  const context = {
    branchIds: ['branch-a', 'branch-b'],
    treasuryUnitIds: ['unit-a', 'unit-b'],
    bankAccountId: 'bank-a',
    currency: 'IRR',
    amount: '100',
  };
  const transaction = {} as DatabaseTransaction;
  assert.equal(await service.resolveSettlementAuthority(
    transaction, 'org', 'actor', context, 'settlement.create',
  ), null);
  grants = [grant({
    branchIds: context.branchIds,
    treasuryUnitIds: context.treasuryUnitIds,
    bankAccountIds: [context.bankAccountId],
    currencies: [context.currency],
    amountCeiling: '100',
    amountCeilingCurrency: 'IRR',
  })];
  assert.deepEqual(await service.resolveSettlementAuthority(
    transaction, 'org', 'actor', context, 'settlement.create',
  ), {});
});

function problem(code: string, status: number) {
  return (error: unknown) => error instanceof TreasuryProblem
    && error.getStatus() === status
    && (error.getResponse() as { code?: string }).code === code;
}

function dto(overrides: Partial<SettlementCreateDto> = {}): SettlementCreateDto {
  return {
    destinationBankAccountId: ACCOUNT_ID,
    settlementDate: '2026-08-03',
    match: {
      kind: SettlementMatchKind.MANUAL,
      reason: 'Statement credit selected by operator',
    },
    gross: { amount: '100', currency: 'IRR' },
    fee: { amount: '2', currency: 'IRR' },
    deduction: { amount: '3', currency: 'IRR' },
    expectedNet: { amount: '95', currency: 'IRR' },
    actualNet: { amount: '95', currency: 'IRR' },
    discrepancy: { amount: '0', currency: 'IRR' },
    discrepancyDisposition: SettlementDiscrepancyDisposition.NONE,
    allocations: [{
      collectionItemId: ITEM_ID,
      collectionItemVersion: 4,
      amount: { amount: '100', currency: 'IRR' },
    }],
    attachments: [{
      id: ATTACHMENT_ID,
      contentDigest: 'a'.repeat(64),
      purpose: 'BANK_CREDIT_EVIDENCE',
    }],
    ...overrides,
  };
}

function database(transactionOptions?: unknown[]): DatabaseService {
  return {
    db: {
      transaction: async <T>(
        work: (transaction: object) => Promise<T>,
        options?: unknown,
      ) => {
        transactionOptions?.push(options);
        return work({});
      },
    },
  } as unknown as DatabaseService;
}

function authorization(
  allowed = true,
  readScope: { grantIds: string[]; fingerprint: string } | null = {
    grantIds: ['00000000-0000-4000-8000-000000000020'],
    fingerprint: 'a'.repeat(64),
  },
): AccessAuthorizationService {
  return {
    resolveSettlementAuthority: async () => allowed ? {} : null,
    settlementReadScope: async () => readScope ?? undefined,
    consumeStepUpProof: async () => true,
  } as unknown as AccessAuthorizationService;
}

function foundation(): FoundationEffectsService {
  return {
    appendMovement: async () => '00000000-0000-4000-8000-000000000099',
    appendAudit: async () => undefined,
    appendOutbox: async () => undefined,
  } as unknown as FoundationEffectsService;
}

function batchView(overrides: Partial<SettlementBatchView> = {}): SettlementBatchView {
  return {
    id: BATCH_ID,
    organizationId: ORGANIZATION_ID,
    organization: { id: ORGANIZATION_ID, label: 'Treasury' },
    businessNumber: 'SET-00000001',
    destinationBankAccountId: ACCOUNT_ID,
    destinationBankAccount: { id: ACCOUNT_ID, label: 'Treasury • 1001' },
    settlementDate: '2026-08-03',
    match: { kind: SettlementMatchKind.MANUAL, reason: 'Verified credit' },
    gross: { amount: '100', currency: 'IRR' },
    fee: { amount: '0', currency: 'IRR' },
    deduction: { amount: '0', currency: 'IRR' },
    expectedNet: { amount: '100', currency: 'IRR' },
    actualNet: { amount: '100', currency: 'IRR' },
    discrepancy: { amount: '0', currency: 'IRR' },
    discrepancyDisposition: SettlementDiscrepancyDisposition.NONE,
    allocations: [],
    attachments: [],
    creatorUserId: CREATOR_ID,
    creator: { id: CREATOR_ID, label: 'Creator' },
    effects: [],
    state: 'MATCHED',
    version: 0,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
    ...overrides,
  };
}

test('settlement handoff binds pagination to the current one-grant scope', async () => {
  let fingerprint = 'a'.repeat(64);
  const transactionOptions: unknown[] = [];
  const repository = {
    list: async (_transaction: unknown, input: { states: string[] }) => ({
      items: [batchView()],
      hasMore: true,
      input,
    }),
  } as unknown as SettlementRepository;
  const access = {
    settlementReadScope: async () => ({
      grantIds: ['00000000-0000-4000-8000-000000000020'],
      fingerprint,
    }),
  } as unknown as AccessAuthorizationService;
  const service = new SettlementService(database(transactionOptions), repository, access, foundation());
  const first = await service.list(ORGANIZATION_ID, CREATOR_ID, { limit: '1' });
  assert.equal(first.items[0]?.businessNumber, 'SET-00000001');
  assert.ok(first.page.nextCursor);
  assert.deepEqual(transactionOptions[0], {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  });
  fingerprint = 'b'.repeat(64);
  await assert.rejects(
    service.list(ORGANIZATION_ID, CREATOR_ID, { limit: '1', cursor: first.page.nextCursor }),
    problem('TRS-GEN-001', 422),
  );
});

test('settlement exact read does not disclose hidden or out-of-scope batches', async () => {
  const transactionOptions: unknown[] = [];
  const hidden = new SettlementService(
    database(transactionOptions),
    { readView: async () => undefined } as unknown as SettlementRepository,
    authorization(),
    foundation(),
  );
  await assert.rejects(hidden.get(ORGANIZATION_ID, CREATOR_ID, BATCH_ID), problem('TRS-GEN-004', 404));
  assert.deepEqual(transactionOptions[0], {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  });
  const denied = new SettlementService(
    database(),
    {} as SettlementRepository,
    authorization(true, null),
    foundation(),
  );
  await assert.rejects(denied.get(ORGANIZATION_ID, CREATOR_ID, BATCH_ID), problem('TRS-GEN-003', 403));
});

function createRepository(options: { evidenceState?: string; replay?: object } = {}) {
  let inserted = 0;
  const repository = {
    acquireIdempotencyLock: async () => undefined,
    findIdempotency: async () => options.replay,
    startIdempotency: async () => undefined,
    finishIdempotency: async () => undefined,
    facts: async () => ({
      organization: { id: ORGANIZATION_ID, label: 'Treasury' },
      actor: { id: CREATOR_ID, label: 'Creator', state: 'ACTIVE' },
      account: {
        id: ACCOUNT_ID,
        label: 'Main • 1001',
        currency: 'IRR',
        state: 'ACTIVE',
        canReceive: true,
      },
      attachments: [{
        id: ATTACHMENT_ID,
        contentDigest: 'a'.repeat(64),
        label: 'credit.pdf',
        state: options.evidenceState ?? 'ACTIVE',
      }],
      items: [{
        id: ITEM_ID,
        branchId: null,
        treasuryUnitId: '00000000-0000-4000-8000-000000000011',
        destinationBankAccountId: ACCOUNT_ID,
        currency: 'IRR',
        state: 'OPEN',
        version: 4,
        remainingAmount: '100',
      }],
    }),
    nextNumber: async () => 'SET-00000001',
    insertProposal: async () => { inserted += 1; },
    view: async () => ({ id: BATCH_ID, version: 0 }),
  } as unknown as SettlementRepository;
  return { repository, inserted: () => inserted };
}

function locked(overrides: Record<string, unknown> = {}): LockedSettlement {
  const now = new Date('2026-08-03T00:00:00.000Z');
  return {
    batch: {
      id: BATCH_ID,
      organizationId: ORGANIZATION_ID,
      businessNumber: 'SET-00000001',
      destinationBankAccountId: ACCOUNT_ID,
      bankStatementLineId: null,
      providerReference: null,
      settlementDate: '2026-08-03',
      matchKind: 'MANUAL',
      matchRuleId: null,
      matchRuleVersion: null,
      manualMatchReason: 'Manual',
      currency: 'IRR',
      grossAmount: '100',
      feeAmount: '2',
      deductionAmount: '3',
      expectedNetAmount: '95',
      actualNetAmount: '95',
      discrepancyAmount: '0',
      discrepancyDisposition: 'NONE',
      discrepancyReason: null,
      creatorUserId: CREATOR_ID,
      confirmedBy: null,
      confirmedAt: null,
      reversedBy: null,
      reversedAt: null,
      reversalOfBatchId: null,
      replacementForBatchId: null,
      reversalReason: null,
      state: 'MATCHED',
      version: 0,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    },
    allocations: [{
      id: '00000000-0000-4000-8000-000000000008',
      organizationId: ORGANIZATION_ID,
      settlementBatchId: BATCH_ID,
      collectionItemId: ITEM_ID,
      collectionItemVersion: 4,
      allocatedAmount: '100',
      currency: 'IRR',
      state: 'PROPOSED',
      version: 0,
    }],
    items: [{
      id: ITEM_ID,
      organizationId: ORGANIZATION_ID,
      sourceFactType: 'RECEIPT_LINE',
      sourceFactId: '00000000-0000-4000-8000-000000000010',
      branchId: null,
      treasuryUnitId: '00000000-0000-4000-8000-000000000011',
      channelType: 'POS',
      channelId: null,
      providerReference: null,
      collectedPartyId: null,
      grossAmount: '100',
      currency: 'IRR',
      allocatedAmount: '0',
      remainingAmount: '100',
      destinationBankAccountId: ACCOUNT_ID,
      collectedAt: now,
      expectedSettlementDate: '2026-08-03',
      state: 'OPEN',
      version: 4,
      createdAt: now,
      updatedAt: now,
    }],
    effects: [],
  } as LockedSettlement;
}

test('createSettlementBatch rejects arithmetic mismatch before opening a transaction', async () => {
  const mock = createRepository();
  const service = new SettlementService(database(), mock.repository, authorization(), foundation());
  await assert.rejects(
    service.create(
      ORGANIZATION_ID,
      CREATOR_ID,
      dto({ expectedNet: { amount: '94', currency: 'IRR' } }),
      'create-key-1',
      'request-1',
    ),
    problem('TRS-COL-002', 422),
  );
  assert.equal(mock.inserted(), 0);
});

test('createSettlementBatch rejects inactive digest-bound bank evidence without mutation', async () => {
  const mock = createRepository({ evidenceState: 'REDACTED' });
  const service = new SettlementService(database(), mock.repository, authorization(), foundation());
  await assert.rejects(
    service.create(ORGANIZATION_ID, CREATOR_ID, dto(), 'create-key-2', 'request-2'),
    problem('TRS-COL-006', 422),
  );
  assert.equal(mock.inserted(), 0);
});

test('createSettlementBatch authorizes one grant across every selected item scope anchor', async () => {
  const mock = createRepository();
  let context: unknown;
  const scopedAuthorization = {
    resolveSettlementAuthority: async (
      _transaction: unknown,
      _organizationId: string,
      _actorUserId: string,
      value: unknown,
    ) => { context = value; return {}; },
  } as unknown as AccessAuthorizationService;
  const service = new SettlementService(
    database(), mock.repository, scopedAuthorization, foundation(),
  );
  await service.create(
    ORGANIZATION_ID, CREATOR_ID, dto(), 'create-key-3', 'request-3',
  );
  assert.deepEqual(context, {
    branchIds: [],
    treasuryUnitIds: ['00000000-0000-4000-8000-000000000011'],
    bankAccountId: ACCOUNT_ID,
    currency: 'IRR',
    amount: '100',
  });
});

test('confirmSettlementBatch denies the creator before any lifecycle mutation', async () => {
  let mutations = 0;
  const repository = {
    acquireIdempotencyLock: async () => undefined,
    lock: async () => locked(),
    findIdempotency: async () => undefined,
    startIdempotency: async () => undefined,
    confirmBatch: async () => { mutations += 1; },
  } as unknown as SettlementRepository;
  const service = new SettlementService(database(), repository, authorization(), foundation());
  await assert.rejects(service.confirm({
    organizationId: ORGANIZATION_ID,
    actorUserId: CREATOR_ID,
    physicalSessionId: 'session',
    batchId: BATCH_ID,
    key: 'confirm-key-1',
    ifMatch: '"0"',
    requestId: 'request-3',
  }), problem('TRS-GEN-003', 403));
  assert.equal(mutations, 0);
});

test('confirmSettlementBatch rejects stale If-Match before allocation or bank effects', async () => {
  let mutations = 0;
  const repository = {
    acquireIdempotencyLock: async () => undefined,
    lock: async () => locked({ version: 2 }),
    findIdempotency: async () => undefined,
    startIdempotency: async () => undefined,
    confirmBatch: async () => { mutations += 1; },
  } as unknown as SettlementRepository;
  const service = new SettlementService(database(), repository, authorization(), foundation());
  await assert.rejects(service.confirm({
    organizationId: ORGANIZATION_ID,
    actorUserId: CONFIRMER_ID,
    physicalSessionId: 'session',
    batchId: BATCH_ID,
    key: 'confirm-key-2',
    ifMatch: '"1"',
    requestId: 'request-4',
  }), problem('TRS-GEN-006', 409));
  assert.equal(mutations, 0);
});

test('confirmSettlementBatch rejects a changed collection snapshot before effects', async () => {
  let mutations = 0;
  const snapshot = locked();
  snapshot.items[0]!.version = 5;
  const repository = {
    acquireIdempotencyLock: async () => undefined,
    lock: async () => snapshot,
    findIdempotency: async () => undefined,
    startIdempotency: async () => undefined,
    confirmationFacts: async () => ({
      account: { state: 'ACTIVE', canReceive: true, currency: 'IRR' },
      attachments: [{
        id: ATTACHMENT_ID,
        linkedDigest: 'a'.repeat(64),
        currentDigest: 'a'.repeat(64),
        state: 'ACTIVE',
      }],
    }),
    confirmBatch: async () => { mutations += 1; },
  } as unknown as SettlementRepository;
  const service = new SettlementService(database(), repository, authorization(), foundation());
  await assert.rejects(service.confirm({
    organizationId: ORGANIZATION_ID,
    actorUserId: CONFIRMER_ID,
    physicalSessionId: 'session',
    batchId: BATCH_ID,
    key: 'confirm-key-3',
    ifMatch: '"0"',
    requestId: 'request-5',
  }), problem('TRS-COL-001', 409));
  assert.equal(mutations, 0);
});

test('confirmSettlementBatch rejects any changed frozen attachment digest', async () => {
  let mutations = 0;
  const repository = {
    acquireIdempotencyLock: async () => undefined,
    lock: async () => locked(),
    findIdempotency: async () => undefined,
    startIdempotency: async () => undefined,
    confirmationFacts: async () => ({
      account: { state: 'ACTIVE', canReceive: true, currency: 'IRR' },
      attachments: [{
        id: ATTACHMENT_ID,
        linkedDigest: 'a'.repeat(64),
        currentDigest: 'b'.repeat(64),
        state: 'ACTIVE',
      }],
    }),
    confirmBatch: async () => { mutations += 1; },
  } as unknown as SettlementRepository;
  const service = new SettlementService(database(), repository, authorization(), foundation());
  await assert.rejects(service.confirm({
    organizationId: ORGANIZATION_ID,
    actorUserId: CONFIRMER_ID,
    physicalSessionId: 'session',
    batchId: BATCH_ID,
    key: 'confirm-key-4',
    ifMatch: '"0"',
    requestId: 'request-6',
  }), problem('TRS-COL-006', 422));
  assert.equal(mutations, 0);
});
