import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { TreasuryProblem } from '../src/common/problem';
import {
  CollectionEffectsRepository,
  CollectionEffectsService,
  CollectionItemCommand,
} from '../src/collection-and-settlement/collection-effects.service';
import {
  CollectionItemQuery,
  CollectionItemView,
} from '../src/collection-and-settlement/collection-items.dto';
import {
  CollectionItemsRepository,
  CollectionScopeSnapshot,
} from '../src/collection-and-settlement/collection-items.repository';
import { CollectionItemsService } from '../src/collection-and-settlement/collection-items.service';

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001';
const ACTOR_ID = '00000000-0000-4000-8000-000000000002';
const ITEM_ID = '00000000-0000-4000-8000-000000000003';
const RECEIPT_LINE_ID = '00000000-0000-4000-8000-000000000004';

process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 7).toString('base64');

function scope(version = 0): CollectionScopeSnapshot[] {
  return [{
    grantId: '00000000-0000-4000-8000-000000000010',
    grantVersion: version,
    roleId: '00000000-0000-4000-8000-000000000011',
    roleVersion: 0,
    organizationWide: true,
    validFrom: '2026-01-01T00:00:00.000Z',
    validTo: null,
    branches: '',
    treasuryUnits: '',
    bankAccounts: '',
    currencies: '',
  }];
}

function item(): CollectionItemView {
  return {
    id: ITEM_ID,
    organizationId: ORGANIZATION_ID,
    organization: { id: ORGANIZATION_ID, label: 'Treasury Example' },
    sourceFactType: 'RECEIPT_LINE',
    sourceFactId: '00000000-0000-4000-8000-000000000004',
    sourceFact: {
      id: '00000000-0000-4000-8000-000000000004',
      label: 'Receipt R-1 · line 1',
    },
    treasuryUnitId: '00000000-0000-4000-8000-000000000005',
    treasuryUnit: {
      id: '00000000-0000-4000-8000-000000000005',
      label: 'Main Treasury',
    },
    channelType: 'BANK_TRANSFER',
    gross: { amount: '100.00000000', currency: 'IRR' },
    allocated: { amount: '0.00000000', currency: 'IRR' },
    remaining: { amount: '100.00000000', currency: 'IRR' },
    currency: { id: 'IRR', label: 'Iranian rial' },
    destinationBankAccountId: '00000000-0000-4000-8000-000000000006',
    destinationBankAccount: {
      id: '00000000-0000-4000-8000-000000000006',
      label: 'Treasury Example · 1001',
    },
    collectedAt: '2026-07-30T01:00:00.000Z',
    expectedSettlementDate: '2026-07-31',
    state: 'OPEN',
    version: 0,
    createdAt: '2026-07-30T01:00:00.000Z',
    updatedAt: '2026-07-30T01:00:00.000Z',
  };
}

function collectionCommand(
  overrides: Partial<CollectionItemCommand> = {},
): CollectionItemCommand {
  return {
    organizationId: ORGANIZATION_ID,
    receiptLineId: RECEIPT_LINE_ID,
    treasuryUnitId: '00000000-0000-4000-8000-000000000005',
    channelType: 'BANK_TRANSFER',
    providerReference: 'provider-1',
    collectedPartyId: '00000000-0000-4000-8000-000000000007',
    amount: '100',
    currency: 'IRR',
    destinationBankAccountId: '00000000-0000-4000-8000-000000000006',
    collectedAt: new Date('2026-07-30T01:00:00.000Z'),
    expectedSettlementDate: '2026-07-31',
    ...overrides,
  };
}

function existingCollection(command = collectionCommand()) {
  return {
    id: ITEM_ID,
    organizationId: command.organizationId,
    sourceFactType: 'RECEIPT_LINE',
    sourceFactId: command.receiptLineId,
    branchId: command.branchId ?? null,
    treasuryUnitId: command.treasuryUnitId,
    channelType: command.channelType,
    channelId: command.channelId ?? null,
    providerReference: command.providerReference ?? null,
    collectedPartyId: command.collectedPartyId,
    grossAmount: '100.00000000',
    currency: command.currency,
    allocatedAmount: '0.00000000',
    remainingAmount: '100.00000000',
    destinationBankAccountId: command.destinationBankAccountId,
    collectedAt: command.collectedAt,
    expectedSettlementDate: command.expectedSettlementDate,
    state: 'OPEN',
    version: 0,
    createdAt: command.collectedAt,
    updatedAt: command.collectedAt,
  };
}

function collectionEffectsMock(options: {
  insertedId?: string;
  insertError?: unknown;
  existing?: ReturnType<typeof existingCollection>;
}) {
  let insertedCommand: CollectionItemCommand | undefined;
  const repository = {
    insert: async (_transaction: unknown, command: CollectionItemCommand) => {
      insertedCommand = command;
      if (options.insertError) throw options.insertError;
      return options.insertedId;
    },
    bySource: async () => options.existing,
    reversibleSnapshot: async () => undefined,
  } as unknown as CollectionEffectsRepository;
  return {
    service: new CollectionEffectsService(repository),
    insertedCommand: () => insertedCommand,
  };
}

function repositoryMock() {
  let currentScope = scope();
  const inputs: unknown[] = [];
  const repository = {
    currentScope: async () => currentScope,
    list: async (input: unknown) => {
      inputs.push(input);
      return { items: [item()], hasMore: true };
    },
  };
  return {
    repository: repository as unknown as CollectionItemsRepository,
    inputs,
    changeScope: () => { currentScope = scope(1); },
    deny: () => { currentScope = []; },
  };
}

function problem(code: string, status: number) {
  return (error: unknown) => error instanceof TreasuryProblem
    && error.getStatus() === status
    && (error.getResponse() as { code?: string }).code === code;
}

test('listCollectionItems denies a caller without one current applicable grant', async () => {
  const mock = repositoryMock();
  mock.deny();
  const service = new CollectionItemsService(mock.repository);
  await assert.rejects(
    service.list(ORGANIZATION_ID, ACTOR_ID, {}),
    problem('TRS-GEN-003', 403),
  );
  assert.equal(mock.inputs.length, 0);
});

test('listCollectionItems binds signed cursor to scope, filters, limit, order and asOf', async () => {
  const mock = repositoryMock();
  const service = new CollectionItemsService(mock.repository);
  const first = await service.list(ORGANIZATION_ID, ACTOR_ID, {
    state: ['OPEN', 'DELAYED'],
    collectedAtFrom: '2026-07-29T22:00:00+03:00',
    limit: '1',
  });
  assert.equal(first.page.hasMore, true);
  assert.ok(first.page.nextCursor);
  assert.match(first.page.asOf, /Z$/u);

  const second = await service.list(ORGANIZATION_ID, ACTOR_ID, {
    state: ['DELAYED', 'OPEN'],
    collectedAtFrom: '2026-07-29T19:00:00.000Z',
    limit: '1',
    cursor: first.page.nextCursor,
  });
  assert.equal(second.page.asOf, first.page.asOf);
  assert.equal(mock.inputs.length, 2);

  await assert.rejects(
    service.list(ORGANIZATION_ID, ACTOR_ID, {
      state: ['OPEN'],
      collectedAtFrom: '2026-07-29T19:00:00.000Z',
      limit: '1',
      cursor: first.page.nextCursor,
    }),
    problem('TRS-GEN-001', 422),
  );
  mock.changeScope();
  await assert.rejects(
    service.list(ORGANIZATION_ID, ACTOR_ID, {
      state: ['DELAYED', 'OPEN'],
      collectedAtFrom: '2026-07-29T19:00:00.000Z',
      limit: '1',
      cursor: first.page.nextCursor,
    }),
    problem('TRS-GEN-001', 422),
  );
});

test('listCollectionItems rejects invalid exact ranges and malformed filters', async () => {
  const service = new CollectionItemsService(repositoryMock().repository);
  for (const query of [
    {
      collectedAtFrom: '2026-07-30T00:00:00Z',
      collectedAtTo: '2026-07-30T00:00:00Z',
    },
    {
      expectedSettlementDateFrom: '2026-07-31',
      expectedSettlementDateTo: '2026-07-30',
    },
    { state: ['OPEN', 'OPEN'] },
    { destinationBankAccountId: 'raw-id' },
    { channelType: 'RAW_ENUM' },
  ]) {
    await assert.rejects(
      service.list(ORGANIZATION_ID, ACTOR_ID, query),
      problem('TRS-GEN-001', 422),
    );
  }
});

test('listCollectionItems rejects repeated or non-string scalar query shapes', async () => {
  const service = new CollectionItemsService(repositoryMock().repository);
  const malformed: CollectionItemQuery[] = [
    { collectedAtFrom: ['2026-07-30T00:00:00Z'] as unknown as string },
    { collectedAtTo: { value: '2026-07-30T00:00:00Z' } as unknown as string },
    { expectedSettlementDateFrom: ['2026-07-30'] as unknown as string },
    { expectedSettlementDateTo: ['2026-07-31'] as unknown as string },
    { destinationBankAccountId: [ITEM_ID] as unknown as string },
    { currency: ['IRR', 'USD'] as unknown as string },
    { channelType: ['BANK_TRANSFER'] as unknown as string },
    { limit: ['50'] as unknown as string },
    { cursor: ['cursor'] as unknown as string },
    { state: [{ value: 'OPEN' }] as unknown as string[] },
  ];
  for (const query of malformed) {
    await assert.rejects(
      service.list(ORGANIZATION_ID, ACTOR_ID, query),
      problem('TRS-GEN-001', 422),
    );
  }
});

test('Collection Effect creation normalizes provider references and replays exact source payload', async () => {
  const command = collectionCommand({ providerReference: '  provider-1  ' });
  const existingCommand = { ...command, providerReference: 'provider-1' };
  const existing = {
    ...existingCollection(existingCommand),
    allocatedAmount: '40.00000000',
    remainingAmount: '60.00000000',
    state: 'PARTIALLY_ALLOCATED',
    version: 3,
  };
  const mock = collectionEffectsMock({ existing });
  const transaction = {} as Parameters<CollectionEffectsService['create']>[0];

  assert.equal(await mock.service.create(transaction, command), ITEM_ID);
  assert.equal(mock.insertedCommand()?.providerReference, 'provider-1');

  const emptyReference = collectionEffectsMock({ insertedId: ITEM_ID });
  await emptyReference.service.create(
    transaction,
    collectionCommand({ providerReference: '   ' }),
  );
  assert.equal(emptyReference.insertedCommand()?.providerReference, undefined);
});

test('Collection Effect creation rejects changed source payload and provider-scope conflicts', async () => {
  const transaction = {} as Parameters<CollectionEffectsService['create']>[0];
  const changedPayload = collectionEffectsMock({
    existing: existingCollection(collectionCommand({
      treasuryUnitId: '00000000-0000-4000-8000-000000000099',
    })),
  });
  await assert.rejects(
    changedPayload.service.create(transaction, collectionCommand()),
    (error: unknown) => error instanceof Error
      && error.message === 'COLLECTION_IDENTITY_CONFLICT',
  );

  const providerConflict = collectionEffectsMock({
    insertError: {
      code: '23505',
      constraint: 'uq_collection_item_provider_reference',
    },
  });
  await assert.rejects(
    providerConflict.service.create(transaction, collectionCommand()),
    (error: unknown) => error instanceof Error
      && error.message === 'COLLECTION_IDENTITY_CONFLICT',
  );
});

test('INC-2D migration and repository preserve tenant, money and one-grant laws', async () => {
  const [migration, repository] = await Promise.all([
    readFile('migrations/0016_collection_items_queue.sql', 'utf8'),
    readFile(
      'src/collection-and-settlement/collection-items.repository.ts',
      'utf8',
    ),
  ]);
  assert.match(migration, /collection_items_money_balance/u);
  assert.match(migration, /collection_items_state_money_shape/u);
  assert.match(migration, /collection_item_destination_scope_chain_consistency/u);
  assert.match(migration, /collection_item_source_fact_consistency/u);
  assert.match(migration, /uq_collection_item_provider_reference/u);
  assert.match(migration, /expected_settlement_date SET NOT NULL/u);
  assert.match(
    migration,
    /DROP CONSTRAINT collection_items_state_check;[\s\S]+ADD CONSTRAINT collection_items_state_check/u,
  );
  assert.match(
    migration,
    /UPDATE collection_items[\s\S]+btrim\(provider_reference\) = '';[\s\S]+CREATE UNIQUE INDEX uq_collection_item_provider_reference/u,
  );
  assert.doesNotMatch(migration, /collection_items_channel_identity_check/u);
  assert.match(repository, /EXISTS \(\s+SELECT 1\s+FROM access_grants AS grant/u);
  assert.doesNotMatch(repository, /\bpool\.query\b|\bclient\.query\b|\bany\b/u);
});

test('Receipt execution maps Collection provider identity conflicts to its declared 409', async () => {
  const source = await readFile('src/receipts/receipt-execution.service.ts', 'utf8');
  assert.match(
    source,
    /COLLECTION_IDENTITY_CONFLICT: \['TRS-GEN-005', 409\]/u,
  );
});
