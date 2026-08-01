import assert from 'node:assert/strict';
import test from 'node:test';

import { AccessAuthorizationService } from '../src/access-control/access-authorization.service';
import type {
  AccessAuthorizationRepository,
  PaymentGrant,
} from '../src/access-control/access-authorization.repository';
import { TreasuryProblem } from '../src/common/problem';
import type { DatabaseService, DatabaseTransaction } from '../src/database/database.service';
import type { PaymentRepository } from '../src/payments/payment.repository';
import { deriveTarget, PaymentService } from '../src/payments/payment.service';

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

test('Named payment authority ignores unrelated direct grants during execution and replay', async () => {
  const namedApproverId = 'named-approver';
  const service = new AccessAuthorizationService({
    paymentGrants: async () => [
      grant({ id: 'unrelated-direct', grantUserId: 'delegate' }),
      grant({
        id: 'named-delegation',
        grantUserId: namedApproverId,
        delegatedFromUserId: namedApproverId,
      }),
    ],
  } as unknown as AccessAuthorizationRepository);
  const transaction = {} as DatabaseTransaction;

  const resolve = () => service.resolvePaymentAuthority(
    transaction,
    'org',
    'delegate',
    context,
    'payment.approve',
    undefined,
    namedApproverId,
  );
  assert.deepEqual(await resolve(), { delegatedFromUserId: namedApproverId });
  assert.deepEqual(await resolve(), { delegatedFromUserId: namedApproverId });
});

const context = {
  branchId: 'branch',
  treasuryUnitId: 'unit',
  cashboxIds: ['cashbox'],
  bankAccountIds: [] as string[],
  currencies: ['IRR'],
  methodCategories: ['CASH'],
  documentType: 'PAYMENT' as const,
  amount: '100',
  amountCurrency: 'IRR',
};

test('Payment authorization requires one current grant to cover every dimension', async () => {
  let grants = [
    grant({ id: 'cash', cashboxIds: ['cashbox'], currencies: ['USD'] }),
    grant({ id: 'currency', cashboxIds: ['other'], currencies: ['IRR'] }),
  ];
  const service = new AccessAuthorizationService({
    paymentGrants: async () => grants,
  } as unknown as AccessAuthorizationRepository);
  const transaction = {} as DatabaseTransaction;
  assert.equal(await service.canCreatePayment(transaction, 'org', 'actor', context), false);

  grants = [grant({
    cashboxIds: ['cashbox'],
    currencies: ['IRR'],
    documentTypes: ['PAYMENT'],
    methodCategories: ['CASH'],
    amountCeiling: '100',
    amountCeilingCurrency: 'IRR',
  })];
  assert.equal(await service.canCreatePayment(transaction, 'org', 'actor', context), true);
  assert.equal(await service.canCreatePayment(
    transaction,
    'org',
    'actor',
    { ...context, amount: '100.000000000001' },
  ), false);

  grants = [grant({
    cashboxIds: ['unrelated-cashbox-scope'],
    bankAccountIds: ['unrelated-account-scope'],
    currencies: ['IRR'],
    documentTypes: ['PAYMENT_REQUEST'],
    methodCategories: ['UNRELATED_METHOD_SCOPE'],
    amountCeiling: '100',
    amountCeilingCurrency: 'IRR',
  })];
  assert.equal(await service.canCreatePaymentRequest(
    transaction,
    'org',
    'actor',
    {
      ...context,
      cashboxIds: [],
      bankAccountIds: [],
      methodCategories: [],
      documentType: 'PAYMENT_REQUEST',
    },
  ), true);
});

test('Payment derivation uses deterministic half-up rounding and records the difference', () => {
  assert.deepEqual(deriveTarget('10.005', '1', 2), {
    targetAmount: '10.01',
    roundingDifference: '-0.00500000',
  });
  assert.deepEqual(deriveTarget('100', '2.5', 0), {
    targetAmount: '250',
    roundingDifference: '0.00000000',
  });
});

test('Payment rejects explicit nulls before opening a transaction', async () => {
  const service = new PaymentService(
    {} as PaymentRepository,
    {} as DatabaseService,
    {} as AccessAuthorizationService,
  );
  await assert.rejects(
    service.createRequest('org', 'actor', {
      beneficiaryPartyId: '00000000-0000-4000-8000-000000000001',
      requestedMoney: { amount: '1', currency: 'IRR' },
      purpose: 'Draft',
      dueDate: null,
    } as never, 'payment-request-key', 'request-id'),
    (error: unknown) => error instanceof TreasuryProblem
      && (error.getResponse() as { code?: string }).code === 'TRS-GEN-001',
  );
});

test('Payment rejects whitespace-only purposes before opening a transaction', async () => {
  const service = new PaymentService(
    {} as PaymentRepository,
    {} as DatabaseService,
    {} as AccessAuthorizationService,
  );
  await assert.rejects(
    service.createRequest('org', 'actor', {
      beneficiaryPartyId: '00000000-0000-4000-8000-000000000001',
      requestedMoney: { amount: '1', currency: 'IRR' },
      purpose: '   ',
    }, 'payment-request-key', 'request-id'),
    (error: unknown) => error instanceof TreasuryProblem
      && (error.getResponse() as { code?: string }).code === 'TRS-GEN-001',
  );
});

test('Payment maps PostgreSQL numeric overflow to validation', async () => {
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 17).toString('base64');
  const overflow = Object.assign(new Error('numeric field overflow'), { code: '22003' });
  const service = new PaymentService(
    {} as PaymentRepository,
    { db: { transaction: async () => { throw overflow; } } } as unknown as DatabaseService,
    {} as AccessAuthorizationService,
  );
  await assert.rejects(
    service.createRequest('org', 'actor', {
      beneficiaryPartyId: '00000000-0000-4000-8000-000000000001',
      requestedMoney: { amount: '1', currency: 'IRR' },
      purpose: 'Draft',
    }, 'payment-request-key', 'request-id'),
    (error: unknown) => error instanceof TreasuryProblem
      && (error.getResponse() as { code?: string }).code === 'TRS-GEN-001',
  );
});
