import assert from 'node:assert/strict';
import test from 'node:test';

import { TreasuryProblem } from '../src/common/problem';
import {
  ReceiptRemainderTreatment,
} from '../src/receipts/receipt.dto';
import type { ReceiptRepository } from '../src/receipts/receipt.repository';
import { ReceiptService } from '../src/receipts/receipt.service';

const baseDraft = {
  businessDate: '2026-07-28',
  partyId: '00000000-0000-4000-8000-000000000001',
  treasuryUnitId: '00000000-0000-4000-8000-000000000002',
  baseCurrency: 'IRR',
  lines: [{
    lineNumber: 1,
    methodId: '00000000-0000-4000-8000-000000000003',
    money: { amount: '1000', currency: 'IRR' },
    remainderTreatment: ReceiptRemainderTreatment.UNALLOCATED,
  }],
};

test('Receipt service accepts an omitted optional Branch and actor-binds create digest', async () => {
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 21).toString('base64');
  let captured: unknown[] = [];
  const service = new ReceiptService({
    create: async (...args: unknown[]) => {
      captured = args;
      return { id: 'receipt', version: 0 };
    },
  } as unknown as ReceiptRepository);
  await service.create('org', 'actor', baseDraft, 'receipt-key', 'request');
  assert.equal(captured[1], 'actor');
  assert.equal(captured[2], baseDraft);
  assert.match(String(captured[4]), /^[a-f0-9]{64}$/u);
});

test('Receipt service rejects duplicate lines, allocation currency drift, and weak If-Match', async () => {
  const service = new ReceiptService({} as ReceiptRepository);
  for (const draft of [
    { ...baseDraft, lines: [...baseDraft.lines, { ...baseDraft.lines[0] }] },
    {
      ...baseDraft,
      lines: [{
        ...baseDraft.lines[0],
        allocations: [{
          externalObjectType: 'INVOICE' as never,
          externalObjectId: 'invoice-1',
          baseMoney: { amount: '1', currency: 'USD' },
        }],
      }],
    },
  ]) {
    await assert.rejects(
      service.create('org', 'actor', draft, 'receipt-key', 'request'),
      isProblem('TRS-GEN-001'),
    );
  }
  await assert.rejects(
    service.replace(
      'org',
      'actor',
      '00000000-0000-4000-8000-000000000004',
      baseDraft,
      'receipt-key',
      '0',
      'request',
    ),
    isProblem('TRS-GEN-001'),
  );
});

test('Receipt service maps numeric overflow at its repository boundary to typed validation', async () => {
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 23).toString('base64');
  const service = new ReceiptService({
    create: async () => {
      throw { code: '22003' };
    },
  } as unknown as ReceiptRepository);
  await assert.rejects(
    service.create('org', 'actor', baseDraft, 'receipt-key', 'request'),
    isProblem('TRS-GEN-001'),
  );
});

function isProblem(code: string) {
  return (error: unknown) => error instanceof TreasuryProblem
    && (error.getResponse() as { code?: string }).code === code;
}
