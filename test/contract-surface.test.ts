import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AuthController } from '../src/access-control/auth.controller';
import { AccessAdminController } from '../src/access-control/access-admin.controller';
import { CANON_PERMISSIONS } from '../src/access-control/access-admin.dto';
import {
  AUTHORIZATION_OPERATION,
  PERMISSION_SCOPE_MODE,
  REQUIRED_PERMISSION,
  STEP_UP_REQUIRED,
} from '../src/access-control/auth.decorators';
import { IdentityController } from '../src/access-control/identity.controller';
import { BankingController } from '../src/banking/banking.controller';
import { CashboxController } from '../src/cashbox-and-custody/cashbox.controller';
import { ChequeController } from '../src/cheques/cheque.controller';
import { MasterDataController } from '../src/master-data/master-data.controller';
import { PrintTemplateController } from '../src/master-data/print-template.controller';

const expectedOperations = [
  ['POST', 'v1/auth/sessions'],
  ['POST', 'v1/auth/totp-verifications'],
  ['POST', 'v1/auth/totp-enrollments'],
  ['POST', 'v1/auth/totp-enrollment-completions'],
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
  ['GET', 'v1/print-templates'],
  ['POST', 'v1/print-templates'],
  ['GET', 'v1/cashboxes'],
  ['POST', 'v1/cashboxes'],
  ['POST', 'v1/cashboxes/:cashboxId/handovers'],
  ['GET', 'v1/bank-types'],
  ['POST', 'v1/bank-types'],
  ['GET', 'v1/banks'],
  ['POST', 'v1/banks'],
  ['GET', 'v1/bank-branches'],
  ['POST', 'v1/bank-branches'],
  ['GET', 'v1/bank-accounts'],
  ['POST', 'v1/bank-accounts'],
  ['GET', 'v1/pos-terminals'],
  ['POST', 'v1/pos-terminals'],
  ['GET', 'v1/payment-gateways'],
  ['POST', 'v1/payment-gateways'],
  ['POST', 'v1/cheque-books'],
  ['POST', 'v1/cheque-books/:chequeBookId/leaves/:leafNumber/transitions'],
] as const;

test('all authorized operations through INC-1H are present in owner-local controllers', async () => {
  const operations = new Set<string>();
  for (const controller of [
    AuthController,
    IdentityController,
    AccessAdminController,
    MasterDataController,
    PrintTemplateController,
    CashboxController,
    BankingController,
    ChequeController,
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

test('Cheque Foundation operations use exact scoped permissions without step-up', () => {
  for (const [handler, permission, operationId] of [
    [
      ChequeController.prototype.createChequeBook,
      'cheque-book.manage',
      'createChequeBook',
    ],
    [
      ChequeController.prototype.transitionCheque,
      'cheque.transition',
      'transitionCheque',
    ],
  ] as const) {
    assert.equal(Reflect.getMetadata(REQUIRED_PERMISSION, handler), permission);
    assert.equal(Reflect.getMetadata(AUTHORIZATION_OPERATION, handler), operationId);
    assert.equal(Reflect.getMetadata(PERMISSION_SCOPE_MODE, handler), 'ONE_GRANT_RESOURCE');
    assert.equal(Reflect.getMetadata(STEP_UP_REQUIRED, handler), undefined);
  }
});

test('the bootstrap administrator can execute both Cheque Foundation operations', async () => {
  const bootstrap = await readFile('scripts/bootstrap.ts', 'utf8');
  assert.match(bootstrap, /'cheque-book\.manage'/u);
  assert.match(bootstrap, /'cheque\.transition'/u);
});

test('Print Template operations use exact scoped permissions and operation IDs', () => {
  for (const [handler, permission, operationId] of [
    [
      PrintTemplateController.prototype.list,
      'print-template.view',
      'listPrintTemplates',
    ],
    [
      PrintTemplateController.prototype.create,
      'print-template.manage',
      'createPrintTemplate',
    ],
  ] as const) {
    assert.equal(Reflect.getMetadata(REQUIRED_PERMISSION, handler), permission);
    assert.equal(Reflect.getMetadata(AUTHORIZATION_OPERATION, handler), operationId);
    assert.equal(Reflect.getMetadata(PERMISSION_SCOPE_MODE, handler), 'ONE_GRANT_RESOURCE');
  }
});

test('Banking operations use exact permissions, operation IDs, and scope modes', () => {
  for (const [handler, permission, operationId, scope] of [
    [BankingController.prototype.listBankTypes, 'bank-type.view', 'listBankTypes', 'ORGANIZATION_WIDE'],
    [BankingController.prototype.createBankType, 'bank-type.manage', 'createBankType', 'ORGANIZATION_WIDE'],
    [BankingController.prototype.listBanks, 'bank.view', 'listBanks', 'ORGANIZATION_WIDE'],
    [BankingController.prototype.createBank, 'bank.manage', 'createBank', 'ORGANIZATION_WIDE'],
    [BankingController.prototype.listBankBranches, 'bank-branch.view', 'listBankBranches', 'ORGANIZATION_WIDE'],
    [BankingController.prototype.createBankBranch, 'bank-branch.manage', 'createBankBranch', 'ORGANIZATION_WIDE'],
    [BankingController.prototype.listBankAccounts, 'bank-account.view', 'listBankAccounts', 'ONE_GRANT_RESOURCE'],
    [BankingController.prototype.createBankAccount, 'bank-account.manage', 'createBankAccount', 'ONE_GRANT_RESOURCE'],
    [BankingController.prototype.listPosTerminals, 'pos-terminal.view', 'listPosTerminals', 'ONE_GRANT_RESOURCE'],
    [BankingController.prototype.createPosTerminal, 'pos-terminal.manage', 'createPosTerminal', 'ONE_GRANT_RESOURCE'],
    [BankingController.prototype.listPaymentGateways, 'payment-gateway.view', 'listPaymentGateways', 'ONE_GRANT_RESOURCE'],
    [BankingController.prototype.createPaymentGateway, 'payment-gateway.manage', 'createPaymentGateway', 'ONE_GRANT_RESOURCE'],
  ] as const) {
    assert.equal(Reflect.getMetadata(REQUIRED_PERMISSION, handler), permission);
    assert.equal(Reflect.getMetadata(AUTHORIZATION_OPERATION, handler), operationId);
    assert.equal(Reflect.getMetadata(PERMISSION_SCOPE_MODE, handler), scope);
  }
});

test('Cashbox operations use exact scoped permissions and operation IDs', () => {
  for (const [handler, permission, operationId] of [
    [CashboxController.prototype.list, 'cashbox.view', 'listCashboxes'],
    [CashboxController.prototype.create, 'cashbox.manage', 'createCashbox'],
    [
      CashboxController.prototype.createHandover,
      'cashbox.handover',
      'createCashboxHandover',
    ],
  ] as const) {
    assert.equal(Reflect.getMetadata(REQUIRED_PERMISSION, handler), permission);
    assert.equal(Reflect.getMetadata(AUTHORIZATION_OPERATION, handler), operationId);
    assert.equal(Reflect.getMetadata(PERMISSION_SCOPE_MODE, handler), 'ONE_GRANT_RESOURCE');
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

test('TOTP enrollment migration keeps one encrypted same-organization OPEN challenge', async () => {
  const migration = await readFile('migrations/0008_totp_enrollment.sql', 'utf8');
  const schema = await readFile('src/database/schema.ts', 'utf8');
  for (const invariant of [
    'CREATE TABLE totp_enrollment_challenges',
    'totp_enrollment_account_fk',
    'totp_enrollment_organization_user_fk',
    'uq_totp_enrollment_challenges_open_account',
    'ix_totp_enrollment_challenges_open_expiry',
    'totp_enrollment_secret_state_check',
  ]) {
    assert.match(migration, new RegExp(invariant, 'u'));
  }
  assert.match(migration, /pending_secret_ciphertext IS NULL/u);
  assert.match(schema, /totpEnrollmentChallenges/u);
  assert.match(schema, /totp_enrollment_secret_state_check/u);
});

test('Auth hardening migration and Drizzle schema reject partial TOTP secret tuples', async () => {
  const migration = await readFile('migrations/0009_auth_production_hardening.sql', 'utf8');
  const schema = await readFile('src/database/schema.ts', 'utf8');
  assert.match(migration, /identity_accounts_totp_secret_tuple_check/u);
  assert.match(migration, /totp_ciphertext IS NULL/u);
  assert.match(migration, /totp_key_version IS NOT NULL/u);
  assert.match(schema, /identity_accounts_totp_secret_tuple_check/u);
  assert.match(schema, /table\.totpCiphertext/u);
  assert.match(schema, /table\.totpKeyVersion/u);
});

test('TOTP enrollment stores an INVITED password verifier only in the pending challenge', async () => {
  const migration = await readFile(
    'migrations/0010_auth_recovery_enrollment_methods.sql',
    'utf8',
  );
  const schema = await readFile('src/database/schema.ts', 'utf8');
  const repository = await readFile('src/access-control/auth.repository.ts', 'utf8');
  assert.match(migration, /ADD COLUMN pending_password_hash text/u);
  assert.match(migration, /WHERE state = 'OPEN'/u);
  assert.match(migration, /pending_password_hash = NULL/u);
  assert.match(schema, /pendingPasswordHash: text\('pending_password_hash'\)/u);
  assert.match(repository, /WHEN state = 'INVITED' THEN \$9::text/u);
  assert.match(repository, /enrollment\.pending_password_hash/u);
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

test('CHG-017 requires explicit Access Grant scope mode across contract and persistence', async () => {
  const migration = await readFile(
    'migrations/0011_explicit_access_grant_scope.sql',
    'utf8',
  );
  const dto = await readFile('src/access-control/access-admin.dto.ts', 'utf8');
  const repository = await readFile('src/access-control/access-admin.repository.ts', 'utf8');
  const auth = await readFile('src/access-control/auth.repository.ts', 'utf8');
  const schema = await readFile('src/database/schema.ts', 'utf8');
  for (const source of [migration, dto, repository, schema]) {
    assert.match(source, /organizationWide|organization_wide/u);
  }
  for (const invariant of [
    'access_grants_wide_without_amount',
    'access_grants_scope_mode_consistency',
    'DEFERRABLE INITIALLY DEFERRED',
    'access_grant_currency_scopes_mode_guard',
  ]) {
    assert.match(migration, new RegExp(invariant, 'u'));
  }
  assert.match(auth, /AND ag\.organization_wide/u);
});

test('CHG-017 admits the emergency separation override permission', async () => {
  const migrations = await Promise.all([
    readFile('migrations/0002_access_control.sql', 'utf8'),
    readFile('migrations/0012_separation_override_permission.sql', 'utf8'),
  ]);
  const persisted = [...migrations.join('\n').matchAll(/\('([^']+)'\)/gu)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(persisted, [...CANON_PERMISSIONS].sort());
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

test('INC-1D migration and Drizzle schema constrain Cashbox custody and handover', async () => {
  const migration = await readFile('migrations/0004_cashbox_base_data.sql', 'utf8');
  const schema = await readFile('src/database/schema.ts', 'utf8');
  for (const source of [migration, schema]) {
    for (const invariant of [
      'cashboxes',
      'cashbox_currency_controls',
      'cashbox_assignments',
      'cashbox_handovers',
      'cashbox_handover_money',
      'cashbox_handover_instruments',
      'cashbox_current_primary_assignment_unique',
      'cashbox_nonterminal_handover_unique',
      'cashboxes_main_currency_control_fk',
    ]) assert.match(source, new RegExp(invariant, 'u'));
  }
  assert.match(migration, /enforce_cashbox_treasury_unit_branch/u);
  assert.match(migration, /enforce_treasury_unit_cashbox_branches/u);
  assert.match(migration, /variance_amount = counted_amount - book_amount/u);
  assert.match(migration, /created_by_user_id = outgoing_user_id/u);
});

test('INC-1E migration and Drizzle schema constrain Banking Base Data', async () => {
  const migration = await readFile('migrations/0005_banking_base_data.sql', 'utf8');
  const schema = await readFile('src/database/schema.ts', 'utf8');
  for (const source of [migration, schema]) {
    for (const invariant of [
      'bank_types',
      'banks',
      'bank_branches',
      'bank_accounts',
      'pos_terminals',
      'payment_gateways',
      'bank_accounts_cheque_eligibility',
      'bank_accounts_withdrawal_ceiling',
      'access_grant_bank_account_scopes_account_fk',
    ]) assert.match(source, new RegExp(invariant, 'u'));
  }
  for (const invariant of [
    'enforce_banking_institution_availability',
    'enforce_bank_account_references',
    'enforce_collection_endpoint_references',
  ]) {
    assert.match(migration, new RegExp(invariant, 'u'));
  }
  assert.match(
    await readFile('src/banking/banking.repository.ts', 'utf8'),
    /SET state = 'ACTIVE', version = version \+ 1/u,
  );
});

test('INC-1F migration and Drizzle schema constrain immutable Print Template versions', async () => {
  const migration = await readFile('migrations/0006_print_templates.sql', 'utf8');
  const schema = await readFile('src/database/schema.ts', 'utf8');
  for (const source of [migration, schema]) {
    for (const invariant of [
      'cheque_books',
      'print_templates',
      'template_body',
      'template_digest',
      'template_version',
      'print_templates_scope_check',
      'print_templates_list_idx',
    ]) assert.match(source, new RegExp(invariant, 'u'));
  }
  assert.match(migration, /enforce_print_template_reference_availability/u);
  assert.match(migration, /enforce_print_template_version_immutability/u);
  assert.match(migration, /jsonb_typeof\(template_body\) = 'object'/u);
  assert.match(migration, /UNIQUE \(organization_id, code, template_version\)/u);
});

test('INC-1G migration and Drizzle schema constrain Cheque Foundation facts', async () => {
  const migration = await readFile('migrations/0007_cheque_foundation.sql', 'utf8');
  const schema = await readFile('src/database/schema.ts', 'utf8');
  const repository = await readFile('src/cheques/cheque.repository.ts', 'utf8');
  for (const source of [migration, schema]) {
    for (const invariant of [
      'cheque_books_leaf_count',
      'cheque_leaves',
      'cheque_events',
      'AVAILABLE',
      'CONSUMED',
      'cheque_events_foundation_reason',
      'cheque_leaves_available_idx',
    ]) assert.match(source, new RegExp(invariant, 'u'));
  }
  assert.match(migration, /pg_advisory_xact_lock/u);
  assert.match(migration, /int8range/u);
  assert.match(migration, /reject_cheque_event_mutation/u);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON cheque_events/u);
  assert.match(repository, /generate_series/u);
  assert.match(repository, /FOR UPDATE/u);
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
  assert.match(bootstrap, /'cashbox\.handover'/u);
});
