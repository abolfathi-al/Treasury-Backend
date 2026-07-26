import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AuthController } from '../src/access-control/auth.controller';
import { AccessAdminController } from '../src/access-control/access-admin.controller';
import {
  AUTHORIZATION_OPERATION,
  PERMISSION_SCOPE_MODE,
  REQUIRED_PERMISSION,
  STEP_UP_REQUIRED,
} from '../src/access-control/auth.decorators';
import { IdentityController } from '../src/access-control/identity.controller';
import { MasterDataController } from '../src/master-data/master-data.controller';

const expectedOperations = [
  ['POST', 'v1/auth/sessions'],
  ['POST', 'v1/auth/totp-verifications'],
  ['GET', 'v1/auth/sessions/current'],
  ['DELETE', 'v1/auth/sessions/:resourceId'],
  ['POST', 'v1/auth/password-recoveries'],
  ['GET', 'v1/organization'],
  ['GET', 'v1/branches'],
  ['POST', 'v1/branches'],
  ['GET', 'v1/treasury-units'],
  ['POST', 'v1/treasury-units'],
  ['GET', 'v1/user-refs'],
  ['POST', 'v1/user-refs'],
  ['POST', 'v1/identity-accounts'],
  ['GET', 'v1/identity-accounts'],
  ['GET', 'v1/identity-accounts/:resourceId/sessions'],
  ['POST', 'v1/identity-accounts/:resourceId/session-revocations'],
  ['GET', 'v1/roles'],
  ['POST', 'v1/roles'],
  ['GET', 'v1/access-grants'],
  ['POST', 'v1/access-grants'],
  ['GET', 'v1/currencies'],
  ['POST', 'v1/currencies'],
  ['GET', 'v1/parties'],
  ['POST', 'v1/parties'],
  ['GET', 'v1/method-definitions'],
  ['POST', 'v1/method-definitions'],
] as const;

test('all authorized operations through INC-1C are present in owner-local controllers', async () => {
  const operations = new Set<string>();
  for (const controller of [
    AuthController,
    IdentityController,
    AccessAdminController,
    MasterDataController,
  ]) {
    const prefix = Reflect.getMetadata(PATH_METADATA, controller) as string;
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = controller.prototype[name as keyof typeof controller.prototype];
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      if (method === undefined || path === undefined) continue;
      operations.add(`${RequestMethod[method]} ${prefix}/${path}`);
    }
  }
  for (const [method, path] of expectedOperations) {
    assert.ok(operations.has(`${method} ${path}`), `${method} ${path}`);
  }
});

test('Party operations use exact organization-wide permissions and operation IDs', () => {
  for (const [handler, permission, operationId] of [
    [MasterDataController.prototype.parties, 'party.view', 'listParties'],
    [MasterDataController.prototype.createParty, 'party.manage', 'createParty'],
  ] as const) {
    assert.equal(Reflect.getMetadata(REQUIRED_PERMISSION, handler), permission);
    assert.equal(Reflect.getMetadata(AUTHORIZATION_OPERATION, handler), operationId);
    assert.equal(Reflect.getMetadata(PERMISSION_SCOPE_MODE, handler), 'ORGANIZATION_WIDE');
  }
});

test('protected commands bind step-up digests to their exact operation IDs', () => {
  assert.equal(
    Reflect.getMetadata(STEP_UP_REQUIRED, IdentityController.prototype.createIdentity),
    'createIdentityAccount',
  );
  assert.equal(
    Reflect.getMetadata(STEP_UP_REQUIRED, AccessAdminController.prototype.createRole),
    'createRole',
  );
  assert.equal(
    Reflect.getMetadata(STEP_UP_REQUIRED, AccessAdminController.prototype.createAccessGrant),
    'createAccessGrant',
  );
  assert.equal(
    Reflect.getMetadata(
      STEP_UP_REQUIRED,
      AccessAdminController.prototype.revokeIdentitySessions,
    ),
    'revokeIdentitySessions',
  );
});

test('migration locks bootstrap, normalized method children, sessions, and idempotency in PostgreSQL', async () => {
  const migration = await readFile('migrations/0001_foundation.sql', 'utf8');
  for (const table of [
    'auth_sessions',
    'auth_challenges',
    'auth_password_attempt_reservations',
    'auth_recovery_attempts',
    'method_mappings',
    'method_required_references',
    'method_allowed_currencies',
    'method_amount_limits',
    'idempotency_records',
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table}`, 'u'));
  }
  assert.match(migration, /UNIQUE \(organization_id, scope, idempotency_key\)/u);
  assert.match(migration, /amount numeric\(38, 8\)/u);
  assert.match(migration, /CHECK \(amount > 0\)/u);
  assert.match(migration, /previous_xsrf_digest char\(64\)/u);
  assert.match(migration, /auth_password_attempt_reservations_active_idx/u);
  assert.match(migration, /expires_at timestamptz NOT NULL/u);
  assert.match(migration, /'INVITED', 'ACTIVE', 'LOCKED', 'SUSPENDED', 'CLOSED'/u);
  assert.doesNotMatch(migration, /debit_mapping_ref varchar/u);
});

test('Drizzle structure mirrors migration-level singleton, composite, mapping, and session invariants', async () => {
  await import('../src/database/schema');
  const schema = await readFile('src/database/schema.ts', 'utf8');
  for (const invariant of [
    'singleton_key',
    'currencies_one_base_per_organization',
    'treasury_units_branch_fk',
    'treasury_units_currency_fk',
    'organizations_base_currency_fk',
    'method_mappings',
    'method_allowed_currencies_currency_fk',
    'method_amount_limits_allowed_currency_fk',
    'method_amount_limits_positive',
    'previous_xsrf_digest',
    'auth_recovery_attempts',
    'auth_password_attempt_reservations',
    'auth_password_attempt_reservations_active_idx',
  ]) {
    assert.match(schema, new RegExp(invariant, 'u'));
  }
});

test('INC-1B migration normalizes scopes, constrains permissions, and versions session chains', async () => {
  const migration = await readFile('migrations/0002_access_control.sql', 'utf8');
  for (const table of [
    'operation_permissions',
    'access_grant_branch_scopes',
    'access_grant_treasury_unit_scopes',
    'access_grant_cashbox_scopes',
    'access_grant_bank_account_scopes',
    'access_grant_document_type_scopes',
    'access_grant_method_category_scopes',
    'access_grant_currency_scopes',
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table}`, 'u'));
  }
  for (const invariant of [
    'authorization_epoch',
    'logical_session_id',
    'authorized_epoch',
    'rotation_parent_id',
    'predecessor_valid_until',
    'access_grants_valid_interval',
    'role_permissions_permission_fk',
  ]) {
    assert.match(migration, new RegExp(invariant, 'u'));
  }
});

test('INC-1C migration and Drizzle schema normalize organization-scoped Party kinds', async () => {
  const migration = await readFile('migrations/0003_party_directory.sql', 'utf8');
  const schema = await readFile('src/database/schema.ts', 'utf8');
  for (const source of [migration, schema]) {
    assert.match(source, /parties/u);
    assert.match(source, /party_kinds/u);
    assert.match(source, /CUSTOMER/u);
    assert.match(source, /LEGAL_PERSON/u);
  }
  assert.match(migration, /UNIQUE \(organization_id, code\)/u);
  assert.match(migration, /PRIMARY KEY \(party_id, party_kind\)/u);
  assert.doesNotMatch(migration, /party_kind varchar\(32\).*\[\]/u);
  assert.doesNotMatch(migration, /accounting/u);
  assert.doesNotMatch(schema, /accessGrantParty/u);
});

test('operator bootstrap is local-only, advisory-locked, and transactional', async () => {
  const bootstrap = await readFile('scripts/bootstrap.ts', 'utf8');
  assert.match(bootstrap, /process\.stdin\.isTTY/u);
  assert.match(bootstrap, /pg_advisory_xact_lock/u);
  assert.match(bootstrap, /await client\.query\('BEGIN'\)/u);
  assert.match(bootstrap, /await client\.query\('COMMIT'\)/u);
  assert.match(bootstrap, /await client\.query\('ROLLBACK'\)/u);
  assert.match(bootstrap, /const secondCounter = await requireTotp/u);
  assert.match(bootstrap, /totp_last_counter/u);
});
