import assert from 'node:assert/strict';
import test from 'node:test';

import type { AuthService, SessionContext } from '../src/access-control/auth.service';
import type { CredentialService } from '../src/access-control/credential.service';
import type { IdentityRepository } from '../src/access-control/identity.repository';
import { IdentityService } from '../src/access-control/identity.service';
import { TreasuryProblem } from '../src/common/problem';
import {
  MethodBehaviorCategory,
  MethodDirection,
  MethodReference,
} from '../src/master-data/master-data.dto';
import type { MasterDataRepository } from '../src/master-data/master-data.repository';
import { MasterDataService } from '../src/master-data/master-data.service';

const shortKeyProblem = (error: unknown) => error instanceof TreasuryProblem && error.getStatus() === 422;

test('all business create boundaries enforce the OpenAPI Idempotency-Key length', async () => {
  const master = new MasterDataService({} as MasterDataRepository);
  await Promise.all([
    assert.rejects(master.createBranch('org', { code: 'B', name: 'Branch' }, 'x'), shortKeyProblem),
    assert.rejects(master.createTreasuryUnit('org', {
      code: 'T',
      name: 'Unit',
      defaultCurrency: 'USD',
    }, 'x'), shortKeyProblem),
    assert.rejects(master.createCurrency('org', {
      code: 'USD',
      name: 'Dollar',
      decimalPlaces: 2,
    }, 'x'), shortKeyProblem),
    assert.rejects(master.createMethod('org', {
      code: 'WIRE',
      name: 'Wire',
      direction: MethodDirection.BOTH,
      behaviorCategory: MethodBehaviorCategory.BANK_TRANSFER,
      requiredReferences: [MethodReference.BANK_ACCOUNT, MethodReference.TRACKING_NUMBER],
      createsFundsInTransit: true,
      requiresApproval: true,
      allowedCurrencies: ['USD'],
    }, 'x'), shortKeyProblem),
  ]);

  const identityRepository = {
    userContext: async () => [],
  } as unknown as IdentityRepository;
  const credentials = {
    normalizeLogin: (value: string) => value,
    validatePassword: (value: string) => value,
    hashPassword: async () => 'hash',
  } as unknown as CredentialService;
  const auth = {} as AuthService;
  const identity = new IdentityService(identityRepository, credentials, auth);
  await assert.rejects(
    identity.createUser('org', { subjectKey: 'user', displayName: 'User' }, 'x'),
    shortKeyProblem,
  );
  await assert.rejects(
    identity.createIdentity(
      'org',
      {
        userId: '00000000-0000-4000-8000-000000000000',
        login: 'user',
        temporaryPassword: 'a sufficiently long temporary password',
        privileged: false,
      },
      'x',
      {} as SessionContext,
      {
        proofId: 'proof',
        command: {
          method: 'POST',
          path: '/v1/identity-accounts',
          bodyDigest: 'digest',
          idempotencyKey: 'x',
        },
      },
    ),
    shortKeyProblem,
  );
});

test('malformed opaque cursors fail as typed 422 boundaries before PostgreSQL casts', () => {
  const master = new MasterDataService({} as MasterDataRepository);
  for (const call of [
    () => master.listBranches('org', undefined, 'not-a-uuid'),
    () => master.listTreasuryUnits('org', undefined, 'not-a-uuid'),
    () => master.listMethods('org', undefined, 'not-a-uuid'),
    () => master.listCurrencies('org', undefined, '%broken'),
  ]) {
    assert.throws(call, shortKeyProblem);
  }
  const identity = new IdentityService(
    {} as IdentityRepository,
    {} as CredentialService,
    {} as AuthService,
  );
  assert.throws(() => identity.list('org', undefined, 'not-a-uuid'), shortKeyProblem);
});
