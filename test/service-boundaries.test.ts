import assert from 'node:assert/strict';
import test from 'node:test';

import type { AuthService, SessionContext } from '../src/access-control/auth.service';
import type { AccessAdminRepository } from '../src/access-control/access-admin.repository';
import { AccessAdminService } from '../src/access-control/access-admin.service';
import { SessionRevokeScope } from '../src/access-control/access-admin.dto';
import type { CredentialService } from '../src/access-control/credential.service';
import type { IdentityRepository } from '../src/access-control/identity.repository';
import { IdentityService } from '../src/access-control/identity.service';
import type { ChequeRepository } from '../src/cheques/cheque.repository';
import { ChequeService } from '../src/cheques/cheque.service';
import { digest } from '../src/common/http';
import { TreasuryProblem } from '../src/common/problem';
import {
  MethodBehaviorCategory,
  MethodDirection,
  MethodReference,
  PartyKind,
} from '../src/master-data/master-data.dto';
import type { MasterDataRepository } from '../src/master-data/master-data.repository';
import { MasterDataService } from '../src/master-data/master-data.service';
import {
  PrintTemplateDirection,
  PrintTemplateDocumentKind,
  PrintTemplateLanguage,
  PrintTemplatePageProfile,
} from '../src/master-data/print-template.dto';
import { canonicalizeJson } from '../src/master-data/print-template.jcs';
import type { PrintTemplateRepository } from '../src/master-data/print-template.repository';
import { PrintTemplateService } from '../src/master-data/print-template.service';
import type { ReceiptRepository } from '../src/receipts/receipt.repository';
import { ReceiptService } from '../src/receipts/receipt.service';

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
    assert.rejects(master.createParty('org', {
      code: 'P-1',
      displayName: 'Party',
      partyKinds: [PartyKind.CUSTOMER],
    }, 'x'), shortKeyProblem),
  ]);
  const templateBody = { title: 'Receipt' };
  await assert.rejects(
    new PrintTemplateService({} as PrintTemplateRepository).create(
      'org',
      'actor',
      {
        code: 'RECEIPT_MAIN',
        documentKind: PrintTemplateDocumentKind.RECEIPT,
        language: PrintTemplateLanguage.EN,
        direction: PrintTemplateDirection.LTR,
        pageProfile: PrintTemplatePageProfile.A4_PORTRAIT,
        templateBody,
        templateDigest: digest(canonicalizeJson(templateBody)),
      },
      'x',
      'request',
    ),
    shortKeyProblem,
  );
  await assert.rejects(
    new ReceiptService({} as ReceiptRepository).create(
      'org',
      'actor',
      {
        businessDate: '2026-07-28',
        partyId: '00000000-0000-4000-8000-000000000001',
        treasuryUnitId: '00000000-0000-4000-8000-000000000002',
        baseCurrency: 'IRR',
        lines: [{
          lineNumber: 1,
          methodId: '00000000-0000-4000-8000-000000000003',
          money: { amount: '1000', currency: 'IRR' },
          remainderTreatment: 'UNALLOCATED' as never,
        }],
      },
      'x',
      'request',
    ),
    shortKeyProblem,
  );
  await assert.rejects(
    new ChequeService({} as ChequeRepository).createChequeBook(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      {
        bankAccountId: '00000000-0000-4000-8000-000000000003',
        series: 'SERIES-A',
        firstLeaf: 1,
        lastLeaf: 10,
        receivedDate: '2026-07-27',
      },
      'x',
      'request',
    ),
    shortKeyProblem,
  );

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
          operationId: 'createIdentityAccount',
          method: 'POST',
          path: '/v1/identity-accounts',
          bodyDigest: 'digest',
          idempotencyKey: 'x',
        },
      },
    ),
    shortKeyProblem,
  );

  const access = new AccessAdminService({
    listPermissionGrants: async () => [],
  } as unknown as AccessAdminRepository, auth);
  const stepUp = {
    proofId: 'proof',
    command: {
      operationId: 'createRole',
      method: 'POST',
      path: '/v1/roles',
      bodyDigest: 'digest',
      idempotencyKey: 'x',
    },
  };
  await assert.rejects(
    access.createRole(
      'org',
      { code: 'VIEWER', name: 'Viewer', permissions: ['master-data.view'] },
      'x',
      'request',
      {} as SessionContext,
      stepUp,
    ),
    shortKeyProblem,
  );
  await assert.rejects(
    access.createAccessGrant(
      'org',
      {
        userId: '00000000-0000-4000-8000-000000000001',
        roleId: '00000000-0000-4000-8000-000000000002',
        organizationWide: true,
      },
      'x',
      'request',
      {} as SessionContext,
      { ...stepUp, command: { ...stepUp.command, operationId: 'createAccessGrant' } },
    ),
    shortKeyProblem,
  );
  await assert.rejects(
    access.revokeIdentitySessions(
      'org',
      '00000000-0000-4000-8000-000000000003',
      { reason: 'test', scope: SessionRevokeScope.ALL_FOR_ACCOUNT },
      'x',
      'request',
      {} as SessionContext,
      { ...stepUp, command: { ...stepUp.command, operationId: 'revokeIdentitySessions' } },
    ),
    shortKeyProblem,
  );
});

test('malformed opaque cursors fail as typed 422 boundaries before PostgreSQL casts', async () => {
  const master = new MasterDataService({} as MasterDataRepository);
  for (const call of [
    () => master.listBranches('org', undefined, 'not-a-uuid'),
    () => master.listTreasuryUnits('org', undefined, 'not-a-uuid'),
    () => master.listMethods('org', undefined, 'not-a-uuid'),
    () => master.listParties('org', undefined, 'not-a-uuid'),
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
  await assert.rejects(
    new PrintTemplateService({} as PrintTemplateRepository).list(
      'org',
      'actor',
      undefined,
      'not-a-cursor',
    ),
    shortKeyProblem,
  );
});

test('Party service rejects invalid kinds and maps stable create conflicts', async () => {
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 7).toString('base64');
  const invalid = new MasterDataService({} as MasterDataRepository);
  for (const partyKinds of [
    [],
    [PartyKind.CUSTOMER, PartyKind.CUSTOMER],
    ['UNKNOWN' as PartyKind],
  ]) {
    assert.throws(
      () => invalid.createParty('org', {
        code: 'P-1',
        displayName: 'Party',
        partyKinds,
      }, 'party-key'),
      shortKeyProblem,
    );
  }

  const command = {
    code: 'P-1',
    displayName: 'Party',
    partyKinds: [PartyKind.CUSTOMER],
  };
  const idempotencyConflict = new MasterDataService({
    createParty: async () => {
      throw new SyntaxError('IDEMPOTENCY_CONFLICT');
    },
  } as unknown as MasterDataRepository);
  await assert.rejects(
    idempotencyConflict.createParty('org', command, 'party-key'),
    (error) => error instanceof TreasuryProblem
      && (error.getResponse() as { code?: string }).code === 'TRS-GEN-007',
  );

  const duplicate = new MasterDataService({
    createParty: async () => {
      throw { code: '23505' };
    },
  } as unknown as MasterDataRepository);
  await assert.rejects(
    duplicate.createParty('org', command, 'another-key'),
    (error) => error instanceof TreasuryProblem
      && (error.getResponse() as { code?: string }).code === 'TRS-MST-002',
  );
});
