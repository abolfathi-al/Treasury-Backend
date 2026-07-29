import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  ChequeBookCreateDto,
  ChequeLeafCommand,
  ChequeLeafTransitionDto,
} from '../src/cheques/cheque.dto';
import type { ChequeRepository } from '../src/cheques/cheque.repository';
import { ChequeService } from '../src/cheques/cheque.service';
import { TreasuryProblem } from '../src/common/problem';

const id = (last: number) => `00000000-0000-4000-8000-${String(last).padStart(12, '0')}`;
const command = (): ChequeBookCreateDto => ({
  bankAccountId: id(1),
  series: 'SERIES-A',
  firstLeaf: 100,
  lastLeaf: 109,
  receivedDate: '2026-07-27',
  custodianUserId: id(2),
  notes: 'Primary book',
});

test('Cheque DTO closes the Foundation range and transition command boundary', async () => {
  const validBook = plainToInstance(ChequeBookCreateDto, {
    ...command(),
    series: ' SERIES-A ',
  });
  assert.equal(validBook.series, 'SERIES-A');
  assert.deepEqual(await validate(validBook), []);

  const invalidBook = plainToInstance(ChequeBookCreateDto, {
    ...command(),
    bankAccountId: 'raw-id',
    firstLeaf: 0,
    receivedDate: '2026-02-30',
  });
  const bookProperties = new Set(
    (await validate(invalidBook)).map(({ property }) => property),
  );
  assert.ok(bookProperties.has('bankAccountId'));
  assert.ok(bookProperties.has('firstLeaf'));

  assert.deepEqual(
    await validate(plainToInstance(ChequeLeafTransitionDto, {
      command: ChequeLeafCommand.VOID,
      reason: ' Administrative control ',
    })),
    [],
  );
  const invalidTransition = await validate(plainToInstance(
    ChequeLeafTransitionDto,
    { command: 'RESERVE', reason: '' },
  ));
  assert.deepEqual(
    new Set(invalidTransition.map(({ property }) => property)),
    new Set(['command', 'reason']),
  );
});

test('Cheque service normalizes commands and rejects unsafe range and version input', async () => {
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 41).toString('base64');
  let receivedSeries = '';
  let receivedReason = '';
  const service = new ChequeService({
    createChequeBook: async (
      organizationId: string,
      _actorUserId: string,
      dto: ChequeBookCreateDto,
    ) => {
      receivedSeries = dto.series;
      return {
        id: id(10),
        organizationId,
        bankAccountId: dto.bankAccountId,
        bankAccount: { id: dto.bankAccountId, label: 'First Bank · A-1' },
        series: dto.series,
        firstLeaf: dto.firstLeaf,
        lastLeaf: dto.lastLeaf,
        leafCount: 1,
        receivedDate: dto.receivedDate,
        state: 'ACTIVE',
        version: 0,
        leaves: [],
        createdAt: '2026-07-27T00:00:00.000Z',
        updatedAt: '2026-07-27T00:00:00.000Z',
      };
    },
    transitionCheque: async (
      _organizationId: string,
      _actorUserId: string,
      chequeBookId: string,
      leafNumber: number,
      dto: ChequeLeafTransitionDto,
    ) => {
      receivedReason = dto.reason;
      return {
        id: id(11),
        chequeBookId,
        series: 'SERIES-A',
        leafNumber,
        label: `SERIES-A-${leafNumber}`,
        state: 'VOID',
        version: 1,
      };
    },
  } as unknown as ChequeRepository);

  await service.createChequeBook(
    id(9),
    id(3),
    { ...command(), series: ' SERIES-A ' },
    'cheque-book-key',
    'request-create',
  );
  assert.equal(receivedSeries, 'SERIES-A');
  await service.transitionCheque(
    id(9),
    id(3),
    id(10),
    '100',
    { command: ChequeLeafCommand.VOID, reason: ' reason ' },
    'leaf-transition-key',
    '"0"',
    'request-transition',
  );
  assert.equal(receivedReason, 'reason');

  for (const invalid of [
    { ...command(), lastLeaf: command().firstLeaf + 500 },
    { ...command(), firstLeaf: Number.MAX_SAFE_INTEGER + 1 },
    { ...command(), receivedDate: '2026-02-30' },
    { ...command(), custodianUserId: null as unknown as string },
  ]) {
    assert.throws(
      () => service.createChequeBook(
        id(9),
        id(3),
        invalid,
        'cheque-book-key',
        'request-create',
      ),
      (error) => problem(error, 'TRS-GEN-001', 422),
    );
  }
  assert.throws(
    () => service.transitionCheque(
      id(9),
      id(3),
      id(10),
      '100',
      { command: ChequeLeafCommand.VOID, reason: 'reason' },
      'leaf-transition-key',
      'W/"0"',
      'request-transition',
    ),
    (error) => problem(error, 'TRS-GEN-001', 422),
  );
});

test('Cheque service maps the exact Foundation repository failures', async () => {
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 42).toString('base64');
  for (const [message, code] of [
    ['SCOPE_DENIED', 'TRS-GEN-003'],
    ['RESOURCE_HIDDEN', 'TRS-GEN-004'],
    ['INACTIVE_REFERENCE', 'TRS-MST-001'],
    ['BANK_ACCOUNT_UNAVAILABLE', 'TRS-BNK-001'],
    ['RANGE_OVERLAP', 'TRS-CHQ-002'],
    ['IDEMPOTENCY_CONFLICT', 'TRS-GEN-007'],
  ] as const) {
    const service = new ChequeService({
      createChequeBook: async () => {
        throw new Error(message);
      },
    } as unknown as ChequeRepository);
    await assert.rejects(
      service.createChequeBook(
        id(9),
        id(3),
        command(),
        `failure-${code}`,
        'request-create',
      ),
      (error) => problem(error, code, message === 'SCOPE_DENIED' ? 403 : (
        message === 'RESOURCE_HIDDEN' ? 404 : 409
      )),
    );
  }

  for (const [message, code] of [
    ['STALE_VERSION', 'TRS-GEN-006'],
    ['LEAF_UNAVAILABLE', 'TRS-CHQ-001'],
    ['ILLEGAL_TRANSITION', 'TRS-CHQ-003'],
  ] as const) {
    const service = new ChequeService({
      transitionCheque: async () => {
        throw new Error(message);
      },
    } as unknown as ChequeRepository);
    await assert.rejects(
      service.transitionCheque(
        id(9),
        id(3),
        id(10),
        '100',
        { command: ChequeLeafCommand.REPORT_LOST, reason: 'lost' },
        `failure-${code}`,
        '"0"',
        'request-transition',
      ),
      (error) => problem(error, code, 409),
    );
  }
});

function problem(error: unknown, code: string, status: number): boolean {
  return error instanceof TreasuryProblem
    && error.getStatus() === status
    && (error.getResponse() as { code?: string }).code === code;
}
