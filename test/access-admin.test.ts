import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANON_PERMISSIONS,
  CanonicalGrantScope,
  PRIVILEGED_PERMISSIONS,
} from '../src/access-control/access-admin.dto';
import {
  canonicalScope,
  grantContains,
  prepareGrant,
} from '../src/access-control/access-admin.service';
import { operationPermissionGranted } from '../src/access-control/auth.guard';
import type { SessionContext } from '../src/access-control/auth.service';
import { TreasuryProblem } from '../src/common/problem';

const id = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

test('Role permission admission is the exact Canon vocabulary including conditional step-up', () => {
  assert.equal(CANON_PERMISSIONS.length, 71);
  assert.equal(new Set(CANON_PERMISSIONS).size, CANON_PERMISSIONS.length);
  assert.deepEqual([...PRIVILEGED_PERMISSIONS].sort(), [
    'access-grant.manage',
    'approval-policy.manage',
    'cashbox.reopen',
    'cheque.transition',
    'delegation.manage',
    'identity-account.manage',
    'payment.execute',
    'payment.reverse',
    'receipt.reverse',
    'role.manage',
    'settlement.reverse',
  ]);
});

test('permission scope metadata is mandatory and missing context fails closed', () => {
  const auth = {
    organizationPermissions: ['access-control.view'],
    session: { effectivePermissions: ['access-control.view'] },
  } as SessionContext;
  assert.equal(
    operationPermissionGranted(auth, undefined, 'access-control.view', 'ORGANIZATION_WIDE'),
    false,
  );
  assert.equal(
    operationPermissionGranted(auth, 'listUserRefs', 'access-control.view', undefined),
    false,
  );
});

test('Grant scope rejects explicit empty objects and invalid amount-currency combinations', () => {
  assert.throws(
    () => canonicalScope({}),
    (error) => problem(error, 'TRS-GEN-001', 422),
  );
  assert.throws(
    () => canonicalScope({
      currencies: ['USD'],
      amountCeiling: { amount: '10', currency: 'EUR' },
    }),
    (error) => problem(error, 'TRS-GEN-001', 422),
  );
  assert.throws(
    () => canonicalScope({
      amountCeiling: { amount: '1234567890123456789012345678901', currency: 'USD' },
    }),
    (error) => problem(error, 'TRS-GEN-001', 422),
  );
  assert.throws(
    () => canonicalScope({
      amountCeiling: { amount: '1.123456789', currency: 'USD' },
    }),
    (error) => problem(error, 'TRS-GEN-001', 422),
  );
});

test('one grant must satisfy every dimension without cross-grant restriction mixing', () => {
  const first = authorization({
    branchIds: [id(1)],
    currencies: ['USD'],
  });
  const second = authorization({
    branchIds: [id(2)],
    currencies: ['EUR'],
  });
  const mixedTarget = authorization({
    branchIds: [id(1)],
    currencies: ['EUR'],
  });
  assert.equal([first, second].some((grant) => grantContains(grant, mixedTarget)), false);

  const oneGrant = authorization({
    branchIds: [id(1), id(2)],
    currencies: ['EUR', 'USD'],
    documentTypes: ['PAYMENT'],
  });
  assert.equal(grantContains(oneGrant, authorization({
    branchIds: [id(2)],
    currencies: ['USD'],
    documentTypes: ['PAYMENT'],
  })), true);
  assert.equal(grantContains(oneGrant, authorization({
    branchIds: [id(2)],
    currencies: ['USD'],
    documentTypes: ['RECEIPT'],
  })), false);
});

test('organization-wide omission, validity, and exact decimal ceilings fail closed', () => {
  const organizationWide = authorization({});
  const scoped = authorization({
    amountCeiling: { amount: '100.00', currency: 'USD' },
  });
  assert.equal(grantContains(organizationWide, scoped), true);
  assert.equal(grantContains(scoped, organizationWide), false);
  assert.equal(grantContains(scoped, authorization({
    amountCeiling: { amount: '99.999', currency: 'USD' },
  })), true);
  assert.equal(grantContains(scoped, authorization({
    amountCeiling: { amount: '100.001', currency: 'USD' },
  })), false);

  const bounded = {
    ...organizationWide,
    validTo: new Date('2027-01-01T00:00:00.000Z'),
  };
  assert.equal(grantContains(bounded, {
    ...organizationWide,
    validTo: null,
  }), false);
});

test('cashbox scope is admitted after the Cashbox owner table is authorized', () => {
  assert.deepEqual(
    prepareGrant({
      userId: id(1),
      roleId: id(2),
      scope: { cashboxIds: [id(3)] },
    }).scope.cashboxIds,
    [id(3)],
  );
});

test('bank-account scope fails closed while the BankAccount owner table is absent', () => {
  assert.throws(
    () => prepareGrant({
      userId: id(1),
      roleId: id(2),
      scope: { bankAccountIds: [id(3)] },
    }),
    (error) => problem(error, 'TRS-GEN-004', 404),
  );
});

function authorization(partial: Partial<CanonicalGrantScope>) {
  return {
    scope: {
      branchIds: [],
      treasuryUnitIds: [],
      cashboxIds: [],
      bankAccountIds: [],
      documentTypes: [],
      methodCategories: [],
      currencies: [],
      ...partial,
    },
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
    validTo: new Date('2028-01-01T00:00:00.000Z'),
  };
}

function problem(error: unknown, code: string, status: number): boolean {
  if (!(error instanceof TreasuryProblem) || error.getStatus() !== status) return false;
  return (error.getResponse() as { code?: string }).code === code;
}
