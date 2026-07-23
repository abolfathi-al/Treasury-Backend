import assert from 'node:assert/strict';
import test from 'node:test';

import { TreasuryProblem } from '../src/common/problem';
import {
  MethodBehaviorCategory as Category,
  MethodCreateDto,
  MethodDirection,
  MethodReference as Reference,
} from '../src/master-data/master-data.dto';
import { validateMethodSemantics } from '../src/master-data/method-policy';

function method(overrides: Partial<MethodCreateDto> = {}): MethodCreateDto {
  return {
    code: 'WIRE',
    name: 'Bank transfer',
    direction: MethodDirection.BOTH,
    behaviorCategory: Category.BANK_TRANSFER,
    requiredReferences: [Reference.BANK_ACCOUNT, Reference.TRACKING_NUMBER],
    createsFundsInTransit: true,
    requiresApproval: true,
    allowedCurrencies: ['USD'],
    ...overrides,
  };
}

test('accepts the exact bank-transfer anchor and tracking semantics', () => {
  assert.doesNotThrow(() => validateMethodSemantics(method()));
});

test('rejects an anchor from another behavior category', () => {
  assert.throws(
    () => validateMethodSemantics(method({
      requiredReferences: [Reference.CASHBOX, Reference.TRACKING_NUMBER],
    })),
    (error) => error instanceof TreasuryProblem && error.getStatus() === 422,
  );
});

test('locks amount limits to a unique allowed currency', () => {
  assert.throws(
    () => validateMethodSemantics(method({
      amountLimits: [
        { currency: 'USD', amount: '100.00' },
        { currency: 'USD', amount: '200.00' },
      ],
    })),
    TreasuryProblem,
  );
  assert.throws(
    () => validateMethodSemantics(method({
      amountLimits: [{ currency: 'EUR', amount: '100.00' }],
    })),
    TreasuryProblem,
  );
  assert.throws(
    () => validateMethodSemantics(method({
      amountLimits: [{ currency: 'USD', amount: '1.123456789' }],
    })),
    TreasuryProblem,
  );
});

test('OTHER_CONTROLLED requires all mappings and forbids balance behavior', () => {
  assert.throws(
    () => validateMethodSemantics(method({
      behaviorCategory: Category.OTHER_CONTROLLED,
      requiredReferences: [],
      createsFundsInTransit: false,
    })),
    TreasuryProblem,
  );
  assert.doesNotThrow(() => validateMethodSemantics(method({
    behaviorCategory: Category.OTHER_CONTROLLED,
    requiredReferences: [],
    createsFundsInTransit: false,
    debitMappingRef: 'debit',
    creditMappingRef: 'credit',
    feeMappingRef: 'fee',
    discrepancyMappingRef: 'discrepancy',
    templateMappingRef: 'template',
  })));
});
