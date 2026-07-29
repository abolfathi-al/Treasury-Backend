import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  BankAccountCreateDto,
  BankAccountType,
  BankCreateDto,
  BankTypeCreateDto,
  PaymentGatewayCreateDto,
} from '../src/banking/banking.dto';
import type { BankingRepository } from '../src/banking/banking.repository';
import { BankingService } from '../src/banking/banking.service';
import { TreasuryProblem } from '../src/common/problem';

const id = (last: number) => `00000000-0000-4000-8000-${String(last).padStart(12, '0')}`;
const account = (): BankAccountCreateDto => ({
  bankId: id(1),
  accountType: BankAccountType.CURRENT,
  accountNumber: '10001',
  currency: 'USD',
  legalOwnerName: 'Example Organization',
  chequeEnabled: true,
  capabilities: { receive: true, pay: true, transfer: true },
  openingDate: '2026-07-26',
});

test('Banking service normalizes declared natural codes before digest and persistence', async () => {
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 30).toString('base64');
  let received: BankTypeCreateDto | undefined;
  const service = new BankingService({
    createBankType: async (
      _organization: string,
      _actor: string,
      dto: BankTypeCreateDto,
    ) => {
      received = dto;
      return {
        id: id(3),
        organizationId: id(9),
        code: dto.code,
        displayName: dto.displayName,
        state: 'ACTIVE',
        version: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    },
  } as unknown as BankingRepository);
  const created = await service.createBankType(
    id(9),
    id(2),
    { code: '  retail_bank ', displayName: 'Retail Bank' },
    'bank-type-key',
    'request-1',
  );
  assert.equal(received?.code, 'RETAIL_BANK');
  assert.equal(created.code, 'RETAIL_BANK');
});

test('Banking DTO transformations and masks enforce the typed HTTP boundary', async () => {
  const bank = plainToInstance(BankCreateDto, {
    bankTypeId: id(1),
    code: '  local_bank ',
    displayName: 'Local Bank',
    countryCode: ' us ',
    nationalBankCode: ' code-1 ',
    swiftCode: ' abcdef12 ',
  });
  assert.equal(bank.code, 'LOCAL_BANK');
  assert.equal(bank.countryCode, 'US');
  assert.equal(bank.nationalBankCode, 'CODE-1');
  assert.equal(bank.swiftCode, 'ABCDEF12');
  assert.deepEqual(await validate(bank), []);

  const invalid = plainToInstance(BankAccountCreateDto, {
    ...account(),
    maskedCardNumber: '4111111111111111',
  });
  assert.ok((await validate(invalid)).some(({ property }) => property === 'maskedCardNumber'));

  const gateway = plainToInstance(PaymentGatewayCreateDto, {
    bankAccountId: id(1),
    providerCode: ' provider.one ',
    merchantId: 'merchant',
    terminalId: 'terminal',
    treasuryUnitId: id(2),
    currency: 'USD',
    settlementCycle: 'DAILY',
  });
  assert.equal(gateway.providerCode, 'PROVIDER.ONE');
  assert.deepEqual(await validate(gateway), []);
});

test('Bank Account activation guard fails before SQL', () => {
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 31).toString('base64');
  const service = new BankingService({} as BankingRepository);
  for (const dto of [
    {
      ...account(),
      accountType: BankAccountType.SAVINGS,
    },
    {
      ...account(),
      withdrawalCeiling: { amount: '10', currency: 'EUR' },
    },
    {
      ...account(),
      withdrawalCeiling: {
        amount: '1234567890123456789012345678901',
        currency: 'USD',
      },
    },
    {
      ...account(),
      openingDate: '2026-02-30',
    },
    {
      ...account(),
      capabilities: undefined,
    },
  ]) {
    assert.throws(
      () => service.createBankAccount(
        id(9),
        id(2),
        dto as BankAccountCreateDto,
        'account-key',
        'request-2',
      ),
      (error) => problem(error, 'TRS-GEN-001', 422),
    );
  }
});

test('Banking service rejects malformed keyset cursors and maps stable repository failures', async () => {
  const service = new BankingService({
    listBankAccounts: async () => ({ items: [], hasMore: false }),
    createPaymentGateway: async () => {
      throw new RangeError('ACCOUNT_UNAVAILABLE');
    },
  } as unknown as BankingRepository);
  assert.throws(
    () => service.listBankAccounts(id(9), id(2), undefined, 'broken'),
    (error) => problem(error, 'TRS-GEN-001', 422),
  );
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 32).toString('base64');
  await assert.rejects(
    service.createPaymentGateway(
      id(9),
      id(2),
      {
        bankAccountId: id(1),
        providerCode: 'provider',
        merchantId: 'merchant',
        terminalId: 'terminal',
        treasuryUnitId: id(2),
        currency: 'USD',
        settlementCycle: 'DAILY',
      },
      'gateway-key',
      'request-3',
    ),
    (error) => problem(error, 'TRS-BNK-001', 409),
  );
});

function problem(error: unknown, code: string, status: number): boolean {
  return error instanceof TreasuryProblem
    && error.getStatus() === status
    && (error.getResponse() as { code?: string }).code === code;
}
