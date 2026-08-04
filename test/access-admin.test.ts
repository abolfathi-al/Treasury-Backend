import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AccessGrantCreateDto,
  CANON_PERMISSIONS,
  CanonicalGrantScope,
  PRIVILEGED_PERMISSIONS,
} from '../src/access-control/access-admin.dto';
import {
  AccessAdminService,
  canonicalScope,
  grantContains,
  prepareApprovalPolicy,
  prepareDelegation,
  prepareGrant,
} from '../src/access-control/access-admin.service';
import type { AccessAdminRepository } from '../src/access-control/access-admin.repository';
import { operationPermissionGranted } from '../src/access-control/auth.guard';
import type { AuthService, SessionContext } from '../src/access-control/auth.service';
import { TreasuryProblem } from '../src/common/problem';

const id = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

test('Role permission admission is the exact Canon vocabulary including conditional step-up', () => {
  assert.equal(CANON_PERMISSIONS.length, 75);
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
    'separation.override',
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

test('Access Grant creation requires one explicit and consistent scope mode', () => {
  const base = { userId: id(1), roleId: id(2) };
  for (const command of [
    base as AccessGrantCreateDto,
    { ...base, organizationWide: true, scope: { branchIds: [id(3)] } },
    { ...base, organizationWide: false },
    { ...base, organizationWide: false, scope: {} },
  ]) {
    assert.throws(
      () => prepareGrant(command as AccessGrantCreateDto),
      (error) => problem(error, 'TRS-GEN-001', 422),
    );
  }

  const wide = prepareGrant({ ...base, organizationWide: true });
  assert.equal(wide.organizationWide, true);
  assert.deepEqual(wide.scope, {
    branchIds: [],
    treasuryUnitIds: [],
    cashboxIds: [],
    bankAccountIds: [],
    documentTypes: [],
    methodCategories: [],
    currencies: [],
  });

  const restricted = prepareGrant({
    ...base,
    organizationWide: false,
    scope: { branchIds: [id(3)] },
  });
  assert.equal(restricted.organizationWide, false);
  assert.deepEqual(restricted.scope.branchIds, [id(3)]);
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
      organizationWide: false,
      scope: { cashboxIds: [id(3)] },
    }).scope.cashboxIds,
    [id(3)],
  );
});

test('bank-account scope is admitted after the BankAccount owner table is authorized', () => {
  assert.deepEqual(
    prepareGrant({
      userId: id(1),
      roleId: id(2),
      organizationWide: false,
      scope: { bankAccountIds: [id(3)] },
    }).scope.bankAccountIds,
    [id(3)],
  );
});

test('INC-5A policy preparation preserves explicit zero-step outcomes and rejects ambiguity', () => {
  assert.deepEqual(prepareApprovalPolicy({
    code: 'ZERO_STEP_PAYMENT',
    documentType: 'PAYMENT',
    organizationWide: true,
    steps: [],
  }).steps, []);
  assert.throws(() => prepareApprovalPolicy({
    code: 'BROKEN_ORDER',
    documentType: 'PAYMENT',
    organizationWide: true,
    steps: [{ order: 2, roleId: id(1), approvalsRequired: 1 }],
  }), shortValidation);
  assert.throws(() => prepareApprovalPolicy({
    code: 'TWO_SUBJECTS',
    documentType: 'PAYMENT',
    organizationWide: true,
    steps: [{
      order: 1,
      roleId: id(1),
      approverUserId: id(2),
      approvalsRequired: 1,
    }],
  }), shortValidation);
  assert.throws(() => prepareApprovalPolicy({
    code: 'RECEIPT_AGGREGATION',
    documentType: 'RECEIPT',
    organizationWide: true,
    steps: [],
    paymentAggregation: {
      windowKind: 'BUSINESS_DATE',
      keys: ['BENEFICIARY'],
      overrideRequiresSecondApproval: true,
    },
  }), shortValidation);
  assert.throws(() => prepareApprovalPolicy({
    code: 'UNREPRESENTABLE_AMOUNT',
    documentType: 'PAYMENT',
    organizationWide: false,
    scope: { minimumBaseAmount: '1'.repeat(31) },
    steps: [],
  }), shortValidation);
});

test('INC-5A delegation preparation requires finite non-empty narrowing input', () => {
  assert.throws(() => prepareDelegation({
    accessGrantId: id(1),
    delegateUserId: id(2),
    scope: {},
    reason: 'cover leave',
    validFrom: '2027-01-01T00:00:00.000Z',
    validTo: '2027-01-02T00:00:00.000Z',
  }), shortValidation);
  assert.throws(() => prepareDelegation({
    accessGrantId: id(1),
    delegateUserId: id(2),
    scope: { currency: 'USD', amountCeiling: { amount: '10', currency: 'EUR' } },
    reason: 'cover leave',
    validFrom: '2027-01-01T00:00:00.000Z',
    validTo: '2027-01-02T00:00:00.000Z',
  }), shortValidation);
  assert.throws(() => prepareDelegation({
    accessGrantId: id(1),
    delegateUserId: id(2),
    scope: { branchId: id(3) },
    reason: '   ',
    validFrom: '2027-01-01T00:00:00.000Z',
    validTo: '2027-01-02T00:00:00.000Z',
  }), shortValidation);
  assert.equal(prepareDelegation({
    accessGrantId: id(1),
    delegateUserId: id(2),
    scope: { branchId: id(3) },
    reason: '  cover leave  ',
    validFrom: '2027-01-01T00:00:00.000Z',
    validTo: '2027-01-02T00:00:00.000Z',
  }).reason, 'cover leave');
});

function authorization(partial: Partial<CanonicalGrantScope>) {
  const scope = {
    branchIds: [],
    treasuryUnitIds: [],
    cashboxIds: [],
    bankAccountIds: [],
    documentTypes: [],
    methodCategories: [],
    currencies: [],
    ...partial,
  };
  return {
    organizationWide: !Object.values(scope).some((value) => (
      Array.isArray(value) ? value.length > 0 : Boolean(value)
    )),
    scope,
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
    validTo: new Date('2028-01-01T00:00:00.000Z'),
  };
}

function problem(error: unknown, code: string, status: number): boolean {
  if (!(error instanceof TreasuryProblem) || error.getStatus() !== status) return false;
  return (error.getResponse() as { code?: string }).code === code;
}

const shortValidation = (error: unknown) => problem(error, 'TRS-GEN-001', 422);

test('INC-5A scoped cursors are signed and resource-bound', async () => {
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 11).toString('base64');
  const repository = {
    listPermissionGrants: async () => [authorization({})],
    organizationBaseCurrency: async () => 'USD',
    findApprovalPolicies: async () => [
      { id: id(10), documentType: 'PAYMENT', createdAt: new Date('2026-08-08T10:00:00Z') },
      { id: id(11), documentType: 'PAYMENT', createdAt: new Date('2026-08-08T09:00:00Z') },
    ],
    findDelegations: async () => {
      throw new Error('A policy cursor reached the delegation query.');
    },
  } as unknown as AccessAdminRepository;
  const service = new AccessAdminService(repository, {} as AuthService);
  const first = await service.listApprovalPolicies(id(1), id(2), '1');
  const cursor = first.page.nextCursor!;

  await assert.rejects(
    service.listDelegations(id(1), id(2), '1', cursor),
    shortValidation,
  );

  const signed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
    payload: { cutoff: string };
  };
  signed.payload.cutoff = '2027-01-01T00:00:00.000Z';
  const tampered = Buffer.from(JSON.stringify(signed)).toString('base64url');
  await assert.rejects(
    service.listApprovalPolicies(id(1), id(2), '1', tampered),
    shortValidation,
  );
});
