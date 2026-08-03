import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { AccessAuthorizationService } from '../src/access-control/access-authorization.service';
import type { AccessAuthorizationRepository, PaymentGrant } from '../src/access-control/access-authorization.repository';
import { TreasuryProblem } from '../src/common/problem';
import type { DatabaseService, DatabaseTransaction } from '../src/database/database.service';
import type { FoundationEffectsService } from '../src/foundation-effects/foundation-effects.service';
import { TransferAssetType, TransferEndpointType, TransferRoute, type TransferCreateDto } from '../src/transfers/transfer.dto';
import type { TransferFacts, TransferRepository } from '../src/transfers/transfer.repository';
import { TransferService } from '../src/transfers/transfer.service';

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

test('Transfer authorization requires one grant to cover both endpoint scopes and currencies', async () => {
  let grants = [
    grant({ cashboxIds: ['source'], bankAccountIds: ['other'], currencies: ['IRR', 'USD'] }),
    grant({ cashboxIds: ['other'], bankAccountIds: ['destination'], currencies: ['IRR', 'USD'] }),
  ];
  const service = new AccessAuthorizationService({ paymentGrants: async () => grants } as unknown as AccessAuthorizationRepository);
  const transaction = {} as DatabaseTransaction;
  const context = {
    branchIds: ['branch-a', 'branch-b'],
    treasuryUnitIds: ['unit-a', 'unit-b'],
    cashboxIds: ['source'],
    bankAccountIds: ['destination'],
    currencies: ['IRR', 'USD'],
    amount: '100',
    amountCurrency: 'IRR',
  };
  assert.equal(await service.resolveTransferAuthority(transaction, 'org', 'actor', context, 'transfer.create'), null);
  grants = [grant({
    branchIds: context.branchIds,
    treasuryUnitIds: context.treasuryUnitIds,
    cashboxIds: context.cashboxIds,
    bankAccountIds: context.bankAccountIds,
    currencies: context.currencies,
    documentTypes: ['TRANSFER'],
    amountCeiling: '100',
    amountCeilingCurrency: 'IRR',
  })];
  assert.deepEqual(await service.resolveTransferAuthority(transaction, 'org', 'actor', context, 'transfer.create'), {});
  assert.equal(await service.resolveTransferAuthority(transaction, 'org', 'actor', { ...context, amount: '100.000000000001' }, 'transfer.create'), null);
});

test('Transfer rejects explicit nulls and whitespace before opening a transaction', async () => {
  const service = new TransferService({} as DatabaseService, {} as TransferRepository, {} as AccessAuthorizationService, {} as FoundationEffectsService);
  const body = {
    businessDate: '2026-08-02',
    route: TransferRoute.USER_TO_USER,
    source: { type: TransferEndpointType.USER, id: '00000000-0000-4000-8000-000000000001' },
    destination: { type: TransferEndpointType.USER, id: '00000000-0000-4000-8000-000000000002' },
    sourceMoney: { amount: '1', currency: 'IRR' },
    destinationCurrency: 'IRR',
    purpose: 'Draft',
  };
  for (const invalid of [{ ...body, expectedReceiptAt: null }, { ...body, purpose: '   ' }, { ...body, accountingDimensions: { project: 'invented' } }]) {
    assert.throws(
      () => service.create('org', 'actor', invalid as never, 'transfer-key', 'request-id'),
      (error: unknown) => error instanceof TreasuryProblem && (error.getResponse() as { code?: string }).code === 'TRS-GEN-001',
    );
  }
});

test('Transfer accepts an active received cheque and rejects its inactive lifecycle states', () => {
  const service = new TransferService({} as DatabaseService, {} as TransferRepository, {} as AccessAuthorizationService, {} as FoundationEffectsService);
  const dto: TransferCreateDto = {
    businessDate: '2026-08-02', route: TransferRoute.USER_TO_USER,
    source: { type: TransferEndpointType.USER, id: '00000000-0000-4000-8000-000000000001' },
    destination: { type: TransferEndpointType.USER, id: '00000000-0000-4000-8000-000000000002' },
    sourceMoney: { amount: '1', currency: 'IRR' }, destinationCurrency: 'IRR', purpose: 'Asset transfer',
    assets: [{ type: TransferAssetType.RECEIVED_CHEQUE, id: '00000000-0000-4000-8000-000000000003' }],
  };
  const facts: TransferFacts = {
    organization: { id: 'org', label: 'Organization' }, creator: { id: 'creator', label: 'Creator', state: 'ACTIVE' },
    source: { id: dto.source.id, type: dto.source.type, label: 'Source', state: 'ACTIVE', branchId: null, treasuryUnitId: null, canTransfer: true, currencies: [] },
    destination: { id: dto.destination.id, type: dto.destination.type, label: 'Destination', state: 'ACTIVE', branchId: null, treasuryUnitId: null, canTransfer: true, currencies: [] },
    currencies: [{ code: 'IRR', label: 'Rial', decimalPlaces: 2, state: 'ACTIVE' }], rates: [], attachments: [],
    assets: [{ id: dto.assets![0]!.id, type: TransferAssetType.RECEIVED_CHEQUE, label: 'Cheque', state: 'IN_CUSTODY' }],
  };
  const validate = (service as unknown as { validateFacts(input: TransferCreateDto, resolved: TransferFacts): void }).validateFacts.bind(service);
  assert.doesNotThrow(() => validate(dto, facts));
  assert.throws(() => validate(dto, { ...facts, assets: [{ ...facts.assets[0]!, state: 'CANCELLED' }] }), /INACTIVE_REFERENCE/u);
});

test('Stale Transfer submission stops before approval evidence is written', async () => {
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 19).toString('base64');
  let snapshotWrites = 0;
  const repository = {
    acquireIdempotencyLock: async () => undefined,
    findIdempotency: async () => undefined,
    startIdempotency: async () => undefined,
    lock: async () => ({ state: 'DRAFT', version: 1 }),
    insertSnapshot: async () => { snapshotWrites += 1; },
  } as unknown as TransferRepository;
  const database = { db: { transaction: async (work: (transaction: DatabaseTransaction) => unknown) => work({} as DatabaseTransaction) } } as unknown as DatabaseService;
  const service = new TransferService(database, repository, {} as AccessAuthorizationService, {} as FoundationEffectsService);
  await assert.rejects(
    service.submit('org', 'actor', '00000000-0000-4000-8000-000000000001', 'transfer-key', '"0"', 'request-id'),
    (error: unknown) => error instanceof TreasuryProblem && (error.getResponse() as { code?: string }).code === 'TRS-GEN-006',
  );
  assert.equal(snapshotWrites, 0);
});

test('Changed Transfer idempotency replay fails before mutation', async () => {
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 23).toString('base64');
  let started = 0;
  const repository = {
    acquireIdempotencyLock: async () => undefined,
    findIdempotency: async () => ({ requestDigest: 'different', response: {} }),
    startIdempotency: async () => { started += 1; },
  } as unknown as TransferRepository;
  const database = { db: { transaction: async (work: (transaction: DatabaseTransaction) => unknown) => work({} as DatabaseTransaction) } } as unknown as DatabaseService;
  const service = new TransferService(database, repository, {} as AccessAuthorizationService, {} as FoundationEffectsService);
  await assert.rejects(
    service.submit('org', 'actor', '00000000-0000-4000-8000-000000000001', 'transfer-key', '"0"', 'request-id'),
    (error: unknown) => error instanceof TreasuryProblem && (error.getResponse() as { code?: string }).code === 'TRS-GEN-007',
  );
  assert.equal(started, 0);
});

test('INC-4A migration preserves Transfer route, rate, approval, and custody constraints', async () => {
  const migration = await readFile('migrations/0021_transfer_draft_approval.sql', 'utf8');
  for (const table of [
    'transfer_documents',
    'transfer_asset_items',
    'transfer_attachment_links',
    'transfer_approval_policies',
    'transfer_approval_policy_steps',
    'transfer_approval_snapshots',
    'transfer_approval_snapshot_steps',
    'transfer_approval_actions',
  ]) assert.match(migration, new RegExp(`CREATE TABLE ${table}`, 'u'));
  assert.match(migration, /transfer_documents_snapshot_fk/u);
  assert.match(migration, /FOREIGN KEY \(organization_id, id, current_approval_snapshot_id\)\s+REFERENCES transfer_approval_snapshots\(organization_id, transfer_document_id, id\)/u);
  assert.match(migration, /CREATE TABLE transfer_approval_snapshot_steps \(\s*id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/u);
  assert.match(migration, /CREATE TABLE transfer_approval_actions \(\s*id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/u);
  assert.match(migration, /purpose VARCHAR\(64\)/u);
  assert.match(migration, /transfer_approval_snapshots_immutable/u);
  assert.match(migration, /transfer_approval_snapshot_steps_immutable/u);
  assert.match(migration, /transfer_approval_actions_immutable/u);
  assert.match(migration, /SOURCE_CUSTODIAN_NOT_APPROVER/u);
  assert.match(migration, /transfer_endpoint_scope_guard/u);
  assert.match(migration, /source_custodian_user_id <> destination_custodian_user_id/u);
  assert.match(migration, /INSERT INTO operation_permissions\(permission\) VALUES \('transfer\.reject'\)/u);
});

test('INC-4B migration binds exact movements to one transit obligation', async () => {
  const migration = await readFile('migrations/0022_transfer_release_ack.sql', 'utf8');
  assert.match(migration, /CREATE TABLE transfer_transit_obligations/u);
  assert.match(migration, /endpoint_type IN \('CASHBOX', 'BANK_ACCOUNT', 'USER'\)/u);
  assert.match(migration, /UNIQUE \(organization_id, transfer_document_id\)/u);
  assert.match(migration, /source_fact\.effect_key = 'SOURCE_RELEASE'/u);
  assert.match(migration, /destination_fact\.effect_key = 'DESTINATION_RECEIPT'/u);
  assert.match(migration, /transfer_transit_obligation_consistency_guard/u);
  assert.match(migration, /transfer_transit_obligations_no_delete/u);
  assert.match(migration, /received_by_user_id = destination_custodian_user_id/u);
  assert.match(migration, /received_by_user_id <> released_by_user_id/u);
});
