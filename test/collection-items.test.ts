import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { TreasuryProblem } from '../src/common/problem';
import { CollectionItemView } from '../src/collection-and-settlement/collection-items.dto';
import {
  CollectionItemsRepository,
  CollectionScopeSnapshot,
} from '../src/collection-and-settlement/collection-items.repository';
import { CollectionItemsService } from '../src/collection-and-settlement/collection-items.service';

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001';
const ACTOR_ID = '00000000-0000-4000-8000-000000000002';
const ITEM_ID = '00000000-0000-4000-8000-000000000003';

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
  assert.match(repository, /EXISTS \(\s+SELECT 1\s+FROM access_grants AS grant/u);
  assert.doesNotMatch(repository, /\bpool\.query\b|\bclient\.query\b|\bany\b/u);
});
