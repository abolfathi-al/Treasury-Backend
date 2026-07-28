import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  CashboxCreateDto,
  CashboxType,
  HandoverCreateDto,
} from '../src/cashbox-and-custody/cashbox.dto';
import type { CashboxRepository } from '../src/cashbox-and-custody/cashbox.repository';
import { CashboxService } from '../src/cashbox-and-custody/cashbox.service';
import { TreasuryProblem } from '../src/common/problem';
import type { DatabaseService } from '../src/database/database.service';
import type { AccessAuthorizationService } from '../src/access-control/access-authorization.service';
import type { IdentityService } from '../src/access-control/identity.service';
import type { MasterDataService } from '../src/master-data/master-data.service';

const id = (last: number) => `00000000-0000-4000-8000-${String(last).padStart(12, '0')}`;
const baseCreate = (): CashboxCreateDto => ({
  code: 'MAIN',
  name: 'Main Cashbox',
  type: CashboxType.CASH,
  treasuryUnitId: id(1),
  mainCurrency: 'USD',
  currencyControls: [{ currency: 'USD', allowNegative: false }],
  primaryCustodianId: id(2),
  capabilities: { receive: true, pay: true, transfer: true },
  requiresApproval: false,
});
const baseHandover = (): HandoverCreateDto => ({
  incomingUserId: id(3),
  moneyCounts: [{ currency: 'USD', countedAmount: '0' }],
  observedInstrumentIds: [],
});

test('Cashbox service rejects invalid controls, cursor, and strong version before SQL', () => {
  const service = new CashboxService(
    {} as CashboxRepository,
    {} as DatabaseService,
    {} as AccessAuthorizationService,
    {} as IdentityService,
    {} as MasterDataService,
  );
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 21).toString('base64');

  for (const dto of [
    { ...baseCreate(), currencyControls: [{ currency: 'EUR' }] },
    {
      ...baseCreate(),
      currencyControls: [{ currency: 'USD' }, { currency: 'USD' }],
    },
    {
      ...baseCreate(),
      currencyControls: [{ currency: 'USD', minimumPosition: '-1', allowNegative: false }],
    },
    {
      ...baseCreate(),
      substituteCustodianId: id(2),
    },
  ]) {
    assert.throws(
      () => service.create(id(9), id(2), dto, 'cashbox-key', 'request'),
      (error) => problem(error, 'TRS-GEN-001', 422),
    );
  }
  assert.rejects(
    service.list(id(9), id(2), undefined, 'broken'),
    (error) => problem(error, 'TRS-GEN-001', 422),
  );
  assert.throws(
    () => service.createHandover(
      id(9),
      id(2),
      id(4),
      baseHandover(),
      'handover-key',
      'W/"0"',
      'request',
    ),
    (error) => problem(error, 'TRS-GEN-001', 422),
  );
  assert.throws(
    () => service.create(
      id(9),
      id(2),
      { ...baseCreate(), capabilities: undefined } as unknown as CashboxCreateDto,
      'cashbox-key',
      'request',
    ),
    (error) => problem(error, 'TRS-GEN-001', 422),
  );
});

test('Cashbox DTO requires capabilities and a timezone-bearing RFC3339 activeTo', async () => {
  const missingCapabilities = await validate(plainToInstance(
    CashboxCreateDto,
    { ...baseCreate(), capabilities: undefined },
  ));
  assert.ok(missingCapabilities.some(({ property }) => property === 'capabilities'));

  for (const activeTo of ['2099-01-01', '2099-01-01T12:00:00']) {
    const errors = await validate(plainToInstance(
      CashboxCreateDto,
      { ...baseCreate(), activeTo },
    ));
    assert.ok(errors.some(({ property }) => property === 'activeTo'));
  }
});

test('Cashbox service maps stable create, stale-version, and custody failures', async () => {
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 22).toString('base64');
  for (const [failure, code] of [
    [new SyntaxError('IDEMPOTENCY_CONFLICT'), 'TRS-GEN-007'],
    [new RangeError('STALE_VERSION'), 'TRS-GEN-006'],
    [new RangeError('CUSTODY_CONFLICT'), 'TRS-CSH-002'],
  ] as const) {
    const service = new CashboxService(
      {} as CashboxRepository,
      {
        db: {
          transaction: async () => {
            throw failure;
          },
        },
      } as unknown as DatabaseService,
      {} as AccessAuthorizationService,
      {} as IdentityService,
      {} as MasterDataService,
    );
    await assert.rejects(
      service.createHandover(
        id(9),
        id(2),
        id(4),
        baseHandover(),
        `failure-${code}`,
        '"0"',
        'request',
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
