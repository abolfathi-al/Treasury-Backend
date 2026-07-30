import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { stepUpRequiredForBody } from '../src/access-control/auth.guard';
import { ReceiptExecutionService } from '../src/receipts/receipt-execution.service';

test('executeReceipt requires step-up only for the governed override envelope', () => {
  assert.equal(stepUpRequiredForBody(undefined, 'separationOverride'), false);
  assert.equal(stepUpRequiredForBody({}, 'separationOverride'), false);
  assert.equal(stepUpRequiredForBody({ separationOverride: {} }, 'separationOverride'), true);
  assert.equal(stepUpRequiredForBody({}, undefined), true);
});

test('reverseReceipt permits only Canon-safe lifecycle and accounting combinations', () => {
  const policy = Object.create(ReceiptExecutionService.prototype) as unknown as {
    isReversalBlocked(document: {
      state: string;
      accountingState: string;
      reversalReceiptId: string | null;
    }): boolean;
  };
  for (const [state, accountingState] of [
    ['EXECUTED', 'READY'],
    ['ACCOUNTING_READY', 'READY'],
    ['ACCOUNTING_POSTED', 'RETURNED'],
    ['ACCOUNTING_POSTED', 'CORRECTED'],
  ]) {
    assert.equal(policy.isReversalBlocked({
      state,
      accountingState,
      reversalReceiptId: null,
    }), false, `${state} + ${accountingState} must be reversible`);
  }
  for (const accountingState of ['QUEUED', 'SENDING', 'SENDING_UNKNOWN', 'ACCEPTED']) {
    assert.equal(policy.isReversalBlocked({
      state: 'EXECUTED',
      accountingState,
      reversalReceiptId: null,
    }), true, `${accountingState} must block reversal`);
  }
  for (const accountingState of ['NOT_READY', 'MAPPING_REQUIRED', 'READY', 'FAILED']) {
    assert.equal(policy.isReversalBlocked({
      state: 'ACCOUNTING_POSTED',
      accountingState,
      reversalReceiptId: null,
    }), true, `ACCOUNTING_POSTED + ${accountingState} must block reversal`);
  }
  assert.equal(policy.isReversalBlocked({
    state: 'APPROVED',
    accountingState: 'NOT_READY',
    reversalReceiptId: null,
  }), true);
  assert.equal(policy.isReversalBlocked({
    state: 'EXECUTED',
    accountingState: 'READY',
    reversalReceiptId: '00000000-0000-4000-8000-000000000000',
  }), true);
});

test('INC-2C migration owns exact effects, linkage, uniqueness and append-only evidence', async () => {
  const migration = await readFile('migrations/0015_receipt_execute_reverse.sql', 'utf8');
  for (const table of [
    'movement_facts',
    'received_cheques',
    'collection_items',
    'receipt_execution_effects',
    'audit_events',
    'outbox_events',
  ]) assert.match(migration, new RegExp(`CREATE TABLE ${table}`));
  assert.match(migration, /UNIQUE \(organization_id, receipt_line_id, effect_key, direction\)/u);
  assert.match(migration, /UNIQUE \(organization_id, reversal_of_effect_id\)/u);
  assert.match(migration, /receipt_execution_effects_append_only/u);
  assert.match(migration, /movement_facts_append_only/u);
  assert.match(migration, /audit_events_append_only/u);
  assert.match(migration, /outbox_events_append_only/u);
  assert.match(migration, /receipt_execution_effect_evidence_guard/u);
  assert.match(migration, /original_effect\.effect_type <> NEW\.effect_type/u);
  assert.match(migration, /currency = NEW\.currency\s+AND amount = NEW\.amount/u);
  assert.match(migration, /receipt_line_id = NEW\.receipt_line_id/u);
  assert.match(
    migration,
    /owner_cheque_event\.cheque_id <> original_effect\.received_cheque_id/u,
  );
  assert.match(
    migration,
    /owner_cheque_event\.to_state NOT IN \(\s+'RETURNED',\s+'RETURNED_AFTER_CLEARANCE',\s+'RETURNED_TO_PARTY',\s+'CANCELLED'/u,
  );
  assert.match(
    migration,
    /owner_collection\.source_fact_type <> 'RECEIPT_LINE'/u,
  );
  assert.match(migration, /owner_collection\.version <> NEW\.collection_item_version/u);
});

test('INC-2C execution path is Drizzle-first and keeps raw pg out of new repositories', async () => {
  const paths = [
    'src/receipts/receipt-execution.repository.ts',
    'src/foundation-effects/foundation-effects.service.ts',
    'src/collection-and-settlement/collection-effects.service.ts',
    'src/cheques/receipt-cheque-effects.service.ts',
    'src/cashbox-and-custody/receipt-cashbox-effects.service.ts',
    'src/banking/receipt-banking-effects.service.ts',
  ];
  const sources = await Promise.all(paths.map((path) => readFile(path, 'utf8')));
  for (const source of sources) {
    assert.doesNotMatch(source, /\bpool\.query\b|\bclient\.query\b/u);
    assert.doesNotMatch(source, /\bany\b/u);
  }
  assert.match(sources[0]!, /InferSelectModel/u);
});
