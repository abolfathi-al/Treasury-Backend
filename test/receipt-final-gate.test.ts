import assert from 'node:assert/strict';
import test from 'node:test';

import { consumeSecretChunk } from '../scripts/bootstrap';
import {
  assertGateEntry,
  GateCleanup,
  generatedDatabaseUrl,
  localAdminDatabaseUrl,
  redactGateError,
  RECEIPT_QA_PERMISSIONS,
} from '../scripts/receipt-final-gate';

test('chunked secret input consumes every character and stops exactly at submit or cancel', () => {
  assert.deepEqual(
    consumeSecretChunk('', 'safe secret\u007f!\nignored'),
    { value: 'safe secre!', outcome: 'submit' },
  );
  assert.deepEqual(
    consumeSecretChunk('kept', '\u0003ignored'),
    { value: 'kept', outcome: 'cancel' },
  );
  assert.deepEqual(
    consumeSecretChunk('', 'رمز امن'),
    { value: 'رمز امن', outcome: 'continue' },
  );
});

test('receipt gate refuses missing authorization, non-TTY use, remote and arbitrary databases', () => {
  assert.deepEqual(RECEIPT_QA_PERMISSIONS, [
    'cashbox.view',
    'master-data.view',
    'party.view',
    'receipt.approve',
    'receipt.create',
    'receipt.edit-draft',
    'receipt.reject',
    'receipt.submit',
    'receipt.view',
  ]);
  assert.throws(() => assertGateEntry([], true, true), /Explicit/u);
  assert.throws(
    () => assertGateEntry(['--authorize-fresh-identity'], false, true),
    /protected interactive TTY/u,
  );
  assert.throws(
    () => localAdminDatabaseUrl('postgresql://qa:secret@example.com/postgres'),
    /localhost/u,
  );
  assert.throws(
    () => localAdminDatabaseUrl('postgresql://qa:secret@127.0.0.1/treasury'),
    /maintenance database/u,
  );
  const admin = localAdminDatabaseUrl('postgresql://qa:secret@127.0.0.1/postgres');
  assert.throws(() => generatedDatabaseUrl(admin, 'treasury'), /non-generated/u);
  assert.equal(
    new URL(generatedDatabaseUrl(
      admin,
      'treasury_receipt_qa_0123456789abcdef0123456789abcdef',
    )).pathname,
    '/treasury_receipt_qa_0123456789abcdef0123456789abcdef',
  );
});

test('receipt gate redacts database URLs and cleans process/database resources exactly once', async () => {
  assert.equal(
    redactGateError(
      new Error('connect postgresql://qa:plain-secret@127.0.0.1/treasury_receipt_qa_deadbeef'),
    ),
    'connect [database-url-redacted]',
  );

  const calls: string[] = [];
  const cleanup = new GateCleanup(async () => {
    calls.push('drop');
  });
  cleanup.setActive(async () => {
    calls.push('active');
    throw new Error('child stop failed');
  });
  cleanup.setBackend(async () => {
    calls.push('backend');
  });
  cleanup.markDatabaseCreated();

  await assert.rejects(cleanup.cleanup(), /child stop failed/u);
  await assert.rejects(cleanup.cleanup(), /child stop failed/u);
  assert.deepEqual(calls, ['active', 'backend', 'drop']);

  let preCreateDrops = 0;
  const preCreateCleanup = new GateCleanup(async () => {
    preCreateDrops += 1;
  });
  preCreateCleanup.markDatabaseCreated();
  await preCreateCleanup.cleanup();
  await preCreateCleanup.cleanup();
  assert.equal(preCreateDrops, 1);
});
