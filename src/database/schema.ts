import {
  bigint,
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Explicit annotations break the intentional organization/currency FK cycle.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const currencies: any = pgTable('currencies', {
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  code: varchar('code', { length: 8 }).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  englishName: varchar('english_name', { length: 100 }),
  symbol: varchar('symbol', { length: 16 }),
  decimalPlaces: integer('decimal_places').notNull(),
  baseCurrency: boolean('base_currency').notNull().default(false),
  state: varchar('state', { length: 16 }).notNull().default('ACTIVE'),
  version: integer('version').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.code] }),
  uniqueIndex('currencies_one_base_per_organization').on(table.organizationId)
    .where(sql`${table.baseCurrency}`),
  check('currencies_code_format', sql`${table.code} ~ '^[A-Z0-9]{3,8}$'`),
  check('currencies_decimal_places_range', sql`${table.decimalPlaces} BETWEEN 0 AND 8`),
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const organizations: any = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  singletonKey: boolean('singleton_key').notNull().default(true).unique(),
  code: varchar('code', { length: 32 }).notNull().unique(),
  legalName: varchar('legal_name', { length: 200 }).notNull(),
  timezone: varchar('timezone', { length: 64 }).notNull(),
  baseCurrency: varchar('base_currency', { length: 8 }).notNull(),
  state: varchar('state', { length: 16 }).notNull().default('ACTIVE'),
  version: integer('version').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check('organizations_singleton_key_true', sql`${table.singletonKey}`),
  foreignKey({
    columns: [table.id, table.baseCurrency],
    foreignColumns: [currencies.organizationId, currencies.code],
    name: 'organizations_base_currency_fk',
  }),
]);

export const branches = pgTable('branches', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  code: varchar('code', { length: 32 }).notNull(),
  name: varchar('name', { length: 160 }).notNull(),
  state: varchar('state', { length: 16 }).notNull().default('ACTIVE'),
  version: integer('version').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.code),
  unique().on(table.organizationId, table.id),
]);

export const treasuryUnits = pgTable('treasury_units', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  branchId: uuid('branch_id'),
  code: varchar('code', { length: 32 }).notNull(),
  name: varchar('name', { length: 160 }).notNull(),
  defaultCurrency: varchar('default_currency', { length: 8 }).notNull(),
  state: varchar('state', { length: 16 }).notNull().default('ACTIVE'),
  version: integer('version').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.code),
  unique().on(table.organizationId, table.id),
  foreignKey({
    columns: [table.organizationId, table.branchId],
    foreignColumns: [branches.organizationId, branches.id],
    name: 'treasury_units_branch_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.defaultCurrency],
    foreignColumns: [currencies.organizationId, currencies.code],
    name: 'treasury_units_currency_fk',
  }),
]);

export const userRefs = pgTable('user_refs', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  subjectKey: varchar('subject_key', { length: 128 }).notNull(),
  displayName: varchar('display_name', { length: 200 }).notNull(),
  state: varchar('state', { length: 16 }).notNull().default('ACTIVE'),
  version: integer('version').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.subjectKey),
  unique().on(table.organizationId, table.id),
]);

export const identityAccounts = pgTable('identity_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userRefId: uuid('user_ref_id').notNull().unique().references(() => userRefs.id),
  normalizedLogin: varchar('normalized_login', { length: 254 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  passwordProfileVersion: integer('password_profile_version').notNull().default(1),
  totpCiphertext: text('totp_ciphertext'),
  totpIv: text('totp_iv'),
  totpAuthTag: text('totp_auth_tag'),
  totpKeyVersion: integer('totp_key_version'),
  totpLastCounter: bigint('totp_last_counter', { mode: 'number' }),
  recoveryCodeHash: text('recovery_code_hash'),
  recoveryVersion: integer('recovery_version').notNull().default(1),
  state: varchar('state', { length: 16 }).notNull().default('ACTIVE'),
  privileged: boolean('privileged').notNull().default(false),
  authorizationEpoch: bigint('authorization_epoch', { mode: 'number' }).notNull().default(0),
  version: integer('version').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.id, table.userRefId),
  check('identity_accounts_totp_secret_tuple_check', sql`(
    (
      ${table.totpCiphertext} IS NULL
      AND ${table.totpIv} IS NULL
      AND ${table.totpAuthTag} IS NULL
      AND ${table.totpKeyVersion} IS NULL
    )
    OR
    (
      ${table.totpCiphertext} IS NOT NULL
      AND ${table.totpIv} IS NOT NULL
      AND ${table.totpAuthTag} IS NOT NULL
      AND ${table.totpKeyVersion} IS NOT NULL
    )
  )`),
]);

export const roles = pgTable('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  code: varchar('code', { length: 64 }).notNull(),
  name: varchar('name', { length: 160 }).notNull(),
  state: varchar('state', { length: 16 }).notNull().default('ACTIVE'),
  version: integer('version').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.code),
  unique().on(table.organizationId, table.id),
]);

export const operationPermissions = pgTable('operation_permissions', {
  permission: varchar('permission', { length: 128 }).primaryKey(),
});

export const rolePermissions = pgTable('role_permissions', {
  roleId: uuid('role_id').notNull().references(() => roles.id),
  permission: varchar('permission', { length: 128 }).notNull()
    .references(() => operationPermissions.permission),
}, (table) => [primaryKey({ columns: [table.roleId, table.permission] })]);

export const accessGrants = pgTable('access_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  userRefId: uuid('user_ref_id').notNull().references(() => userRefs.id),
  roleId: uuid('role_id').notNull().references(() => roles.id),
  scopeType: varchar('scope_type', { length: 32 }).notNull().default('ORGANIZATION'),
  scopeId: uuid('scope_id').notNull().references(() => organizations.id),
  organizationWide: boolean('organization_wide').notNull(),
  amountCeiling: numeric('amount_ceiling', { precision: 38, scale: 8 }),
  amountCeilingCurrency: varchar('amount_ceiling_currency', { length: 8 }),
  validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
  validTo: timestamp('valid_to', { withTimezone: true }),
  reason: varchar('reason', { length: 500 }),
  state: varchar('state', { length: 16 }).notNull().default('ACTIVE'),
  version: integer('version').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  foreignKey({
    columns: [table.organizationId, table.amountCeilingCurrency],
    foreignColumns: [currencies.organizationId, currencies.code],
    name: 'access_grants_amount_currency_fk',
  }),
  check('access_grants_amount_positive', sql`${table.amountCeiling} IS NULL OR ${table.amountCeiling} > 0`),
  check(
    'access_grants_wide_without_amount',
    sql`NOT ${table.organizationWide} OR ${table.amountCeiling} IS NULL`,
  ),
  check('access_grants_valid_interval', sql`${table.validTo} IS NULL OR ${table.validTo} > ${table.validFrom}`),
]);

export const accessGrantBranchScopes = pgTable('access_grant_branch_scopes', {
  accessGrantId: uuid('access_grant_id').notNull().references(() => accessGrants.id),
  branchId: uuid('branch_id').notNull().references(() => branches.id),
}, (table) => [primaryKey({ columns: [table.accessGrantId, table.branchId] })]);

export const accessGrantTreasuryUnitScopes = pgTable('access_grant_treasury_unit_scopes', {
  accessGrantId: uuid('access_grant_id').notNull().references(() => accessGrants.id),
  treasuryUnitId: uuid('treasury_unit_id').notNull().references(() => treasuryUnits.id),
}, (table) => [primaryKey({ columns: [table.accessGrantId, table.treasuryUnitId] })]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const accessGrantCashboxScopes: any = pgTable('access_grant_cashbox_scopes', {
  accessGrantId: uuid('access_grant_id').notNull().references(() => accessGrants.id),
  cashboxId: uuid('cashbox_id').notNull(),
}, (table) => [
  primaryKey({ columns: [table.accessGrantId, table.cashboxId] }),
  foreignKey({
    columns: [table.cashboxId],
    foreignColumns: [cashboxes.id],
    name: 'access_grant_cashbox_scopes_cashbox_fk',
  }),
]);

// The Banking owner table is declared later in this one-file Drizzle mirror.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const accessGrantBankAccountScopes: any = pgTable('access_grant_bank_account_scopes', {
  accessGrantId: uuid('access_grant_id').notNull().references(() => accessGrants.id),
  bankAccountId: uuid('bank_account_id').notNull(),
}, (table) => [
  primaryKey({ columns: [table.accessGrantId, table.bankAccountId] }),
  foreignKey({
    columns: [table.bankAccountId],
    foreignColumns: [bankAccounts.id],
    name: 'access_grant_bank_account_scopes_account_fk',
  }),
]);

export const accessGrantDocumentTypeScopes = pgTable('access_grant_document_type_scopes', {
  accessGrantId: uuid('access_grant_id').notNull().references(() => accessGrants.id),
  documentType: varchar('document_type', { length: 64 }).notNull(),
}, (table) => [primaryKey({ columns: [table.accessGrantId, table.documentType] })]);

export const accessGrantMethodCategoryScopes = pgTable('access_grant_method_category_scopes', {
  accessGrantId: uuid('access_grant_id').notNull().references(() => accessGrants.id),
  methodCategory: varchar('method_category', { length: 64 }).notNull(),
}, (table) => [primaryKey({ columns: [table.accessGrantId, table.methodCategory] })]);

export const accessGrantCurrencyScopes = pgTable('access_grant_currency_scopes', {
  accessGrantId: uuid('access_grant_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  currency: varchar('currency', { length: 8 }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.accessGrantId, table.currency] }),
  foreignKey({
    columns: [table.organizationId, table.accessGrantId],
    foreignColumns: [accessGrants.organizationId, accessGrants.id],
    name: 'access_grant_currency_scopes_grant_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.currency],
    foreignColumns: [currencies.organizationId, currencies.code],
    name: 'access_grant_currency_scopes_currency_fk',
  }),
]);

export const authThrottleBuckets = pgTable('auth_throttle_buckets', {
  bucketDigest: char('bucket_digest', { length: 64 }).primaryKey(),
  failureCount: integer('failure_count').notNull().default(0),
  generation: bigint('generation', { mode: 'number' }).notNull().default(0),
  delayUntil: timestamp('delay_until', { withTimezone: true }),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check('auth_throttle_generation_nonnegative', sql`${table.generation} >= 0`),
]);

export const authPasswordAttemptReservations = pgTable('auth_password_attempt_reservations', {
  id: uuid('id').primaryKey(),
  bucketDigest: char('bucket_digest', { length: 64 }).notNull()
    .references(() => authThrottleBuckets.bucketDigest, { onDelete: 'cascade' }),
  generation: bigint('generation', { mode: 'number' }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('auth_password_attempt_reservations_active_idx')
    .on(table.bucketDigest, table.generation, table.expiresAt),
  check('auth_password_attempt_reservations_generation_nonnegative', sql`${table.generation} >= 0`),
]);

export const authRecoveryAttempts = pgTable('auth_recovery_attempts', {
  bucketDigest: char('bucket_digest', { length: 64 }).primaryKey(),
  attempts: integer('attempts').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check('auth_recovery_attempts_range', sql`${table.attempts} BETWEEN 0 AND 5`),
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const authSessions: any = pgTable('auth_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  identityAccountId: uuid('identity_account_id').notNull().references(() => identityAccounts.id),
  logicalSessionId: uuid('logical_session_id').notNull(),
  authorizedEpoch: bigint('authorized_epoch', { mode: 'number' }).notNull().default(0),
  tokenDigest: char('token_digest', { length: 64 }).notNull().unique(),
  previousTokenDigest: char('previous_token_digest', { length: 64 }).unique(),
  previousValidUntil: timestamp('previous_valid_until', { withTimezone: true }),
  xsrfDigest: char('xsrf_digest', { length: 64 }).notNull(),
  previousXsrfDigest: char('previous_xsrf_digest', { length: 64 }),
  authenticatedAt: timestamp('authenticated_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastRotatedAt: timestamp('last_rotated_at', { withTimezone: true }).notNull(),
  idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
  absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
  assurance: varchar('assurance', { length: 32 }).notNull(),
  deviceLabel: varchar('device_label', { length: 160 }),
  rotationParentId: uuid('rotation_parent_id'),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  predecessorValidUntil: timestamp('predecessor_valid_until', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revocationReason: varchar('revocation_reason', { length: 500 }),
  state: varchar('state', { length: 16 }).notNull().default('ACTIVE'),
}, (table) => [
  foreignKey({
    columns: [table.logicalSessionId],
    foreignColumns: [table.id],
    name: 'auth_sessions_logical_session_fk',
  }),
  foreignKey({
    columns: [table.rotationParentId],
    foreignColumns: [table.id],
    name: 'auth_sessions_rotation_parent_fk',
  }),
  unique().on(table.rotationParentId),
]);

export const authChallenges = pgTable('auth_challenges', {
  id: uuid('id').primaryKey().defaultRandom(),
  identityAccountId: uuid('identity_account_id').notNull().references(() => identityAccounts.id),
  sessionId: uuid('session_id').references(() => authSessions.id),
  tokenDigest: char('token_digest', { length: 64 }).notNull().unique(),
  kind: varchar('kind', { length: 24 }).notNull(),
  httpMethod: varchar('http_method', { length: 12 }),
  httpPath: text('http_path'),
  requestBodyDigest: char('request_body_digest', { length: 64 }),
  idempotencyKey: varchar('idempotency_key', { length: 128 }),
  deviceLabel: varchar('device_label', { length: 160 }),
  attempts: integer('attempts').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const totpEnrollmentChallenges = pgTable('totp_enrollment_challenges', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  identityAccountId: uuid('identity_account_id').notNull(),
  userRefId: uuid('user_ref_id').notNull(),
  enrollmentIdDigest: char('enrollment_id_digest', { length: 64 }).notNull().unique(),
  pendingSecretCiphertext: text('pending_secret_ciphertext'),
  pendingSecretIv: text('pending_secret_iv'),
  pendingSecretAuthTag: text('pending_secret_auth_tag'),
  pendingSecretKeyVersion: integer('pending_secret_key_version'),
  pendingPasswordHash: text('pending_password_hash'),
  accountVersion: integer('account_version').notNull(),
  attemptCount: integer('attempt_count').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  state: varchar('state', { length: 24 }).notNull().default('OPEN'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    columns: [table.identityAccountId, table.userRefId],
    foreignColumns: [identityAccounts.id, identityAccounts.userRefId],
    name: 'totp_enrollment_account_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.userRefId],
    foreignColumns: [userRefs.organizationId, userRefs.id],
    name: 'totp_enrollment_organization_user_fk',
  }),
  uniqueIndex('uq_totp_enrollment_challenges_open_account')
    .on(table.organizationId, table.identityAccountId)
    .where(sql`${table.state} = 'OPEN'`),
  index('ix_totp_enrollment_challenges_open_expiry')
    .on(table.expiresAt)
    .where(sql`${table.state} = 'OPEN'`),
  check('totp_enrollment_attempt_count_check', sql`${table.attemptCount} BETWEEN 0 AND 5`),
  check('totp_enrollment_account_version_check', sql`${table.accountVersion} >= 0`),
  check('totp_enrollment_state_check', sql`${table.state} IN (
    'OPEN', 'CONSUMED', 'EXPIRED', 'ATTEMPTS_EXHAUSTED'
  )`),
  check('totp_enrollment_secret_state_check', sql`(
    (
      ${table.state} = 'OPEN'
      AND ${table.closedAt} IS NULL
      AND ${table.pendingSecretCiphertext} IS NOT NULL
      AND ${table.pendingSecretIv} IS NOT NULL
      AND ${table.pendingSecretAuthTag} IS NOT NULL
      AND ${table.pendingSecretKeyVersion} IS NOT NULL
    )
    OR
    (
      ${table.state} <> 'OPEN'
      AND ${table.closedAt} IS NOT NULL
      AND ${table.pendingSecretCiphertext} IS NULL
      AND ${table.pendingSecretIv} IS NULL
      AND ${table.pendingSecretAuthTag} IS NULL
      AND ${table.pendingSecretKeyVersion} IS NULL
      AND ${table.pendingPasswordHash} IS NULL
    )
  )`),
]);

export const authStepUpProofs = pgTable('auth_step_up_proofs', {
  id: uuid('id').primaryKey().defaultRandom(),
  challengeId: uuid('challenge_id').notNull().unique().references(() => authChallenges.id),
  tokenDigest: char('token_digest', { length: 64 }).notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
});

export const securityAuditEvents = pgTable('security_audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').references(() => organizations.id),
  identityAccountId: uuid('identity_account_id').references(() => identityAccounts.id),
  requestId: varchar('request_id', { length: 128 }).notNull(),
  eventType: varchar('event_type', { length: 96 }).notNull(),
  outcome: varchar('outcome', { length: 32 }).notNull(),
  details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const parties: any = pgTable('parties', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  code: varchar('code', { length: 64 }).notNull(),
  displayName: varchar('display_name', { length: 200 }).notNull(),
  legalName: varchar('legal_name', { length: 200 }),
  nationalId: varchar('national_id', { length: 64 }),
  registrationId: varchar('registration_id', { length: 64 }),
  phone: varchar('phone', { length: 64 }),
  email: varchar('email', { length: 254 }),
  notes: varchar('notes', { length: 1000 }),
  state: varchar('state', { length: 16 }).notNull().default('ACTIVE'),
  mergedIntoPartyId: uuid('merged_into_party_id'),
  version: integer('version').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.code),
  index('parties_organization_id_id_idx').on(table.organizationId, table.id),
  foreignKey({
    columns: [table.mergedIntoPartyId],
    foreignColumns: [table.id],
    name: 'parties_merged_into_party_fk',
  }),
  check('parties_state_check', sql`${table.state} IN ('ACTIVE', 'INACTIVE', 'MERGED')`),
]);

export const partyKinds = pgTable('party_kinds', {
  partyId: uuid('party_id').notNull().references(() => parties.id),
  partyKind: varchar('party_kind', { length: 32 }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.partyId, table.partyKind] }),
  check('party_kinds_value_check', sql`${table.partyKind} IN (
    'CUSTOMER', 'SUPPLIER', 'EMPLOYEE', 'SHAREHOLDER', 'REPRESENTATIVE',
    'BANK', 'COMPANY', 'ORGANIZATION', 'NATURAL_PERSON', 'LEGAL_PERSON', 'OTHER'
  )`),
]);

export const methodDefinitions = pgTable('method_definitions', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  code: varchar('code', { length: 64 }).notNull(),
  name: varchar('name', { length: 160 }).notNull(),
  direction: varchar('direction', { length: 16 }).notNull(),
  behaviorCategory: varchar('behavior_category', { length: 32 }).notNull(),
  createsFundsInTransit: boolean('creates_funds_in_transit').notNull(),
  requiresApproval: boolean('requires_approval').notNull(),
  state: varchar('state', { length: 16 }).notNull().default('ACTIVE'),
  version: integer('version').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique().on(table.organizationId, table.code)]);

export const methodMappings = pgTable('method_mappings', {
  methodId: uuid('method_id').notNull().references(() => methodDefinitions.id),
  mappingKind: varchar('mapping_kind', { length: 16 }).notNull(),
  mappingRef: varchar('mapping_ref', { length: 128 }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.methodId, table.mappingKind] }),
  check(
    'method_mappings_kind',
    sql`${table.mappingKind} IN ('DEBIT', 'CREDIT', 'FEE', 'DISCREPANCY', 'TEMPLATE')`,
  ),
]);

export const methodRequiredReferences = pgTable('method_required_references', {
  methodId: uuid('method_id').notNull().references(() => methodDefinitions.id),
  reference: varchar('reference', { length: 32 }).notNull(),
}, (table) => [primaryKey({ columns: [table.methodId, table.reference] })]);

export const methodAllowedCurrencies = pgTable('method_allowed_currencies', {
  methodId: uuid('method_id').notNull().references(() => methodDefinitions.id),
  organizationId: uuid('organization_id').notNull(),
  currencyCode: varchar('currency_code', { length: 8 }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.methodId, table.currencyCode] }),
  foreignKey({
    columns: [table.organizationId, table.currencyCode],
    foreignColumns: [currencies.organizationId, currencies.code],
    name: 'method_allowed_currencies_currency_fk',
  }),
]);

export const methodAmountLimits = pgTable('method_amount_limits', {
  methodId: uuid('method_id').notNull(),
  currencyCode: varchar('currency_code', { length: 8 }).notNull(),
  amount: numeric('amount', { precision: 38, scale: 8 }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.methodId, table.currencyCode] }),
  foreignKey({
    columns: [table.methodId, table.currencyCode],
    foreignColumns: [methodAllowedCurrencies.methodId, methodAllowedCurrencies.currencyCode],
    name: 'method_amount_limits_allowed_currency_fk',
  }),
  check('method_amount_limits_positive', sql`${table.amount} > 0`),
]);

export const idempotencyRecords = pgTable('idempotency_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  scope: varchar('scope', { length: 96 }).notNull(),
  idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
  requestDigest: char('request_digest', { length: 64 }).notNull(),
  responseStatus: integer('response_status'),
  responseBody: jsonb('response_body').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique().on(table.organizationId, table.scope, table.idempotencyKey)]);

// Explicit annotations break the intentional Cashbox/main-control FK cycle.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const cashboxes: any = pgTable('cashboxes', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  branchId: uuid('branch_id'),
  treasuryUnitId: uuid('treasury_unit_id').notNull(),
  code: varchar('code', { length: 64 }).notNull(),
  name: varchar('name', { length: 160 }).notNull(),
  cashboxType: varchar('cashbox_type', { length: 32 }).notNull(),
  mainCurrency: varchar('main_currency', { length: 8 }).notNull(),
  canReceive: boolean('can_receive').notNull(),
  canPay: boolean('can_pay').notNull(),
  canTransfer: boolean('can_transfer').notNull(),
  requiresApproval: boolean('requires_approval').notNull(),
  accountingDimensions: jsonb('accounting_dimensions').$type<Record<string, string>>(),
  activeFrom: timestamp('active_from', { withTimezone: true }).notNull(),
  activeTo: timestamp('active_to', { withTimezone: true }),
  state: varchar('state', { length: 16 }).notNull().default('ACTIVE'),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.code),
  unique().on(table.organizationId, table.id),
  foreignKey({
    columns: [table.organizationId, table.branchId],
    foreignColumns: [branches.organizationId, branches.id],
    name: 'cashboxes_branch_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.treasuryUnitId],
    foreignColumns: [treasuryUnits.organizationId, treasuryUnits.id],
    name: 'cashboxes_treasury_unit_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.mainCurrency],
    foreignColumns: [currencies.organizationId, currencies.code],
    name: 'cashboxes_main_currency_fk',
  }),
  foreignKey({
    columns: [table.id, table.mainCurrency],
    foreignColumns: [cashboxCurrencyControls.cashboxId, cashboxCurrencyControls.currency],
    name: 'cashboxes_main_currency_control_fk',
  }),
  check(
    'cashboxes_type_check',
    sql`${table.cashboxType} IN (
      'CASH', 'FOREIGN_CURRENCY', 'SALES', 'BRANCH', 'TEMPORARY', 'VIRTUAL',
      'INSTRUMENT', 'CHEQUE', 'COLLECTION', 'CUSTODIAL', 'PETTY_CASH'
    )`,
  ),
  check('cashboxes_state_check', sql`${table.state} IN ('DRAFT', 'ACTIVE', 'SUSPENDED', 'CLOSED')`),
  check('cashboxes_version_nonnegative', sql`${table.version} >= 0`),
  check('cashboxes_active_interval', sql`${table.activeTo} IS NULL OR ${table.activeTo} > ${table.activeFrom}`),
  index('cashboxes_list_idx').on(table.organizationId, table.code, table.id),
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const cashboxCurrencyControls: any = pgTable('cashbox_currency_controls', {
  cashboxId: uuid('cashbox_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  currency: varchar('currency', { length: 8 }).notNull(),
  transactionCeiling: numeric('transaction_ceiling', { precision: 38, scale: 8 }),
  minimumPosition: numeric('minimum_position', { precision: 38, scale: 8 }),
  maximumHolding: numeric('maximum_holding', { precision: 38, scale: 8 }),
  allowNegative: boolean('allow_negative').notNull().default(false),
}, (table) => [
  primaryKey({ columns: [table.cashboxId, table.currency] }),
  foreignKey({
    columns: [table.organizationId, table.cashboxId],
    foreignColumns: [cashboxes.organizationId, cashboxes.id],
    name: 'cashbox_currency_controls_cashbox_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.currency],
    foreignColumns: [currencies.organizationId, currencies.code],
    name: 'cashbox_currency_controls_currency_fk',
  }),
  check(
    'cashbox_currency_controls_transaction_nonnegative',
    sql`${table.transactionCeiling} IS NULL OR ${table.transactionCeiling} >= 0`,
  ),
  check(
    'cashbox_currency_controls_maximum_nonnegative',
    sql`${table.maximumHolding} IS NULL OR ${table.maximumHolding} >= 0`,
  ),
  check(
    'cashbox_currency_controls_minimum_maximum',
    sql`${table.minimumPosition} IS NULL OR ${table.maximumHolding} IS NULL
      OR ${table.minimumPosition} <= ${table.maximumHolding}`,
  ),
  check(
    'cashbox_currency_controls_negative_permission',
    sql`${table.minimumPosition} IS NULL OR ${table.minimumPosition} >= 0 OR ${table.allowNegative}`,
  ),
]);

export const cashboxAssignments = pgTable('cashbox_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  cashboxId: uuid('cashbox_id').notNull(),
  userId: uuid('user_id').notNull(),
  assignmentType: varchar('assignment_type', { length: 16 }).notNull(),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
  effectiveTo: timestamp('effective_to', { withTimezone: true }),
  state: varchar('state', { length: 16 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.cashboxId, table.id),
  foreignKey({
    columns: [table.organizationId, table.cashboxId],
    foreignColumns: [cashboxes.organizationId, cashboxes.id],
    name: 'cashbox_assignments_cashbox_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.userId],
    foreignColumns: [userRefs.organizationId, userRefs.id],
    name: 'cashbox_assignments_user_fk',
  }),
  uniqueIndex('cashbox_current_primary_assignment_unique').on(table.cashboxId)
    .where(sql`${table.assignmentType} = 'PRIMARY' AND ${table.state} = 'ACTIVE'`),
  check(
    'cashbox_assignments_type_check',
    sql`${table.assignmentType} IN ('PRIMARY', 'SUBSTITUTE')`,
  ),
  check(
    'cashbox_assignments_state_check',
    sql`${table.state} IN ('SCHEDULED', 'ACTIVE', 'ENDED', 'CANCELLED')`,
  ),
  check(
    'cashbox_assignments_interval',
    sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} > ${table.effectiveFrom}`,
  ),
]);

export const cashboxHandovers = pgTable('cashbox_handovers', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  cashboxId: uuid('cashbox_id').notNull(),
  currentAssignmentId: uuid('current_assignment_id').notNull(),
  handoverNumber: varchar('handover_number', { length: 64 }).notNull(),
  outgoingUserId: uuid('outgoing_user_id').notNull(),
  incomingUserId: uuid('incoming_user_id').notNull(),
  bookSnapshotDigest: varchar('book_snapshot_digest', { length: 128 }).notNull(),
  hasDiscrepancy: boolean('has_discrepancy').notNull(),
  reason: varchar('reason', { length: 500 }),
  state: varchar('state', { length: 24 }).notNull(),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
  createdByUserId: uuid('created_by_user_id').notNull(),
  requestId: varchar('request_id', { length: 128 }).notNull(),
  countedAt: timestamp('counted_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => [
  unique().on(table.cashboxId, table.handoverNumber),
  unique().on(table.organizationId, table.id),
  foreignKey({
    columns: [table.organizationId, table.cashboxId],
    foreignColumns: [cashboxes.organizationId, cashboxes.id],
    name: 'cashbox_handovers_cashbox_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.cashboxId, table.currentAssignmentId],
    foreignColumns: [
      cashboxAssignments.organizationId,
      cashboxAssignments.cashboxId,
      cashboxAssignments.id,
    ],
    name: 'cashbox_handovers_assignment_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.outgoingUserId],
    foreignColumns: [userRefs.organizationId, userRefs.id],
    name: 'cashbox_handovers_outgoing_user_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.incomingUserId],
    foreignColumns: [userRefs.organizationId, userRefs.id],
    name: 'cashbox_handovers_incoming_user_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.createdByUserId],
    foreignColumns: [userRefs.organizationId, userRefs.id],
    name: 'cashbox_handovers_actor_user_fk',
  }),
  uniqueIndex('cashbox_nonterminal_handover_unique').on(table.cashboxId)
    .where(sql`${table.state} NOT IN ('COMPLETED', 'REJECTED', 'CANCELLED')`),
  check(
    'cashbox_handovers_state_check',
    sql`${table.state} IN (
      'DRAFT', 'COUNTED', 'OFFERED', 'ACCEPTED', 'APPROVED', 'COMPLETED',
      'REJECTED', 'CANCELLED'
    )`,
  ),
  check('cashbox_handovers_version_nonnegative', sql`${table.version} >= 0`),
  check('cashbox_handovers_distinct_users', sql`${table.outgoingUserId} <> ${table.incomingUserId}`),
  check('cashbox_handovers_actor_is_outgoing', sql`${table.createdByUserId} = ${table.outgoingUserId}`),
  check(
    'cashbox_handovers_discrepancy_reason',
    sql`NOT ${table.hasDiscrepancy}
      OR (${table.reason} IS NOT NULL AND char_length(btrim(${table.reason})) > 0)`,
  ),
  check(
    'cashbox_handovers_completion_time',
    sql`(${table.state} = 'COMPLETED' AND ${table.completedAt} IS NOT NULL)
      OR (${table.state} <> 'COMPLETED' AND ${table.completedAt} IS NULL)`,
  ),
]);

export const cashboxHandoverMoney = pgTable('cashbox_handover_money', {
  handoverId: uuid('handover_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  currency: varchar('currency', { length: 8 }).notNull(),
  bookAmount: numeric('book_amount', { precision: 38, scale: 8 }).notNull(),
  countedAmount: numeric('counted_amount', { precision: 38, scale: 8 }).notNull(),
  varianceAmount: numeric('variance_amount', { precision: 38, scale: 8 }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.handoverId, table.currency] }),
  foreignKey({
    columns: [table.organizationId, table.handoverId],
    foreignColumns: [cashboxHandovers.organizationId, cashboxHandovers.id],
    name: 'cashbox_handover_money_handover_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.currency],
    foreignColumns: [currencies.organizationId, currencies.code],
    name: 'cashbox_handover_money_currency_fk',
  }),
  check(
    'cashbox_handover_money_variance',
    sql`${table.varianceAmount} = ${table.countedAmount} - ${table.bookAmount}`,
  ),
]);

export const cashboxHandoverInstruments = pgTable('cashbox_handover_instruments', {
  handoverId: uuid('handover_id').notNull().references(() => cashboxHandovers.id),
  instrumentId: varchar('instrument_id', { length: 128 }).notNull(),
  instrumentType: varchar('instrument_type', { length: 16 }).notNull(),
  reference: varchar('reference', { length: 200 }).notNull(),
  observed: boolean('observed').notNull(),
}, (table) => [
  primaryKey({ columns: [table.handoverId, table.instrumentId] }),
  check(
    'cashbox_handover_instruments_type',
    sql`${table.instrumentType} IN ('CHEQUE', 'DOCUMENT', 'OTHER')`,
  ),
  check(
    'cashbox_handover_instruments_reference',
    sql`char_length(btrim(${table.reference})) > 0`,
  ),
]);

export const bankTypes = pgTable('bank_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  code: varchar('code', { length: 32 }).notNull(),
  displayName: varchar('display_name', { length: 160 }).notNull(),
  description: varchar('description', { length: 500 }),
  state: varchar('state', { length: 16 }).notNull().default('ACTIVE'),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.code),
  unique().on(table.organizationId, table.id),
  check('bank_types_code_format', sql`${table.code} ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'`),
  check('bank_types_state_check', sql`${table.state} IN ('ACTIVE', 'INACTIVE')`),
  check('bank_types_version_nonnegative', sql`${table.version} >= 0`),
  index('bank_types_list_idx').on(table.organizationId, table.code, table.id),
]);

export const banks = pgTable('banks', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  bankTypeId: uuid('bank_type_id').notNull(),
  code: varchar('code', { length: 32 }).notNull(),
  displayName: varchar('display_name', { length: 200 }).notNull(),
  englishName: varchar('english_name', { length: 200 }),
  countryCode: char('country_code', { length: 2 }).notNull(),
  nationalBankCode: varchar('national_bank_code', { length: 32 }),
  swiftCode: varchar('swift_code', { length: 11 }),
  logoRef: varchar('logo_ref', { length: 256 }),
  state: varchar('state', { length: 16 }).notNull().default('ACTIVE'),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.code),
  unique().on(table.organizationId, table.id),
  foreignKey({
    columns: [table.organizationId, table.bankTypeId],
    foreignColumns: [bankTypes.organizationId, bankTypes.id],
    name: 'banks_bank_type_fk',
  }),
  check('banks_code_format', sql`${table.code} ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'`),
  check('banks_country_code_format', sql`${table.countryCode} ~ '^[A-Z]{2}$'`),
  check(
    'banks_national_code_format',
    sql`${table.nationalBankCode} IS NULL
      OR ${table.nationalBankCode} ~ '^[A-Z0-9][A-Z0-9._-]{0,31}$'`,
  ),
  check(
    'banks_swift_code_format',
    sql`${table.swiftCode} IS NULL OR ${table.swiftCode} ~ '^[A-Z0-9]{8}([A-Z0-9]{3})?$'`,
  ),
  check('banks_state_check', sql`${table.state} IN ('ACTIVE', 'INACTIVE')`),
  check('banks_version_nonnegative', sql`${table.version} >= 0`),
  index('banks_list_idx').on(table.organizationId, table.code, table.id),
]);

export const bankBranches = pgTable('bank_branches', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  bankId: uuid('bank_id').notNull(),
  code: varchar('code', { length: 32 }).notNull(),
  name: varchar('name', { length: 200 }).notNull(),
  city: varchar('city', { length: 100 }),
  address: varchar('address', { length: 500 }),
  contactReference: varchar('contact_reference', { length: 256 }),
  state: varchar('state', { length: 16 }).notNull().default('ACTIVE'),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.bankId, table.code),
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.bankId, table.id),
  foreignKey({
    columns: [table.organizationId, table.bankId],
    foreignColumns: [banks.organizationId, banks.id],
    name: 'bank_branches_bank_fk',
  }),
  check('bank_branches_code_format', sql`${table.code} ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'`),
  check('bank_branches_state_check', sql`${table.state} IN ('ACTIVE', 'INACTIVE')`),
  check('bank_branches_version_nonnegative', sql`${table.version} >= 0`),
  index('bank_branches_list_idx').on(
    table.organizationId,
    table.bankId,
    table.code,
    table.id,
  ),
]);

// Explicit annotations break the AccessGrant/BankAccount scope FK cycle.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const bankAccounts: any = pgTable('bank_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  bankId: uuid('bank_id').notNull(),
  bankBranchId: uuid('bank_branch_id'),
  organizationBranchId: uuid('organization_branch_id'),
  treasuryUnitId: uuid('treasury_unit_id'),
  accountType: varchar('account_type', { length: 32 }).notNull(),
  accountNumber: varchar('account_number', { length: 64 }).notNull(),
  iban: varchar('iban', { length: 64 }),
  maskedCardNumber: varchar('masked_card_number', { length: 32 }),
  currency: varchar('currency', { length: 8 }).notNull(),
  legalOwnerName: varchar('legal_owner_name', { length: 200 }).notNull(),
  openingDate: date('opening_date').notNull(),
  closingDate: date('closing_date'),
  chequeEnabled: boolean('cheque_enabled').notNull().default(false),
  canReceive: boolean('can_receive').notNull(),
  canPay: boolean('can_pay').notNull(),
  canTransfer: boolean('can_transfer').notNull(),
  withdrawalCeiling: numeric('withdrawal_ceiling', { precision: 38, scale: 8 }),
  withdrawalCeilingCurrency: varchar('withdrawal_ceiling_currency', { length: 8 }),
  accountingDimensions: jsonb('accounting_dimensions').$type<Record<string, string>>(),
  state: varchar('state', { length: 16 }).notNull().default('DRAFT'),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.bankId, table.accountNumber),
  unique().on(table.organizationId, table.iban),
  unique().on(table.organizationId, table.id),
  foreignKey({
    columns: [table.organizationId, table.bankId],
    foreignColumns: [banks.organizationId, banks.id],
    name: 'bank_accounts_bank_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.bankId, table.bankBranchId],
    foreignColumns: [
      bankBranches.organizationId,
      bankBranches.bankId,
      bankBranches.id,
    ],
    name: 'bank_accounts_bank_branch_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.organizationBranchId],
    foreignColumns: [branches.organizationId, branches.id],
    name: 'bank_accounts_organization_branch_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.treasuryUnitId],
    foreignColumns: [treasuryUnits.organizationId, treasuryUnits.id],
    name: 'bank_accounts_treasury_unit_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.currency],
    foreignColumns: [currencies.organizationId, currencies.code],
    name: 'bank_accounts_currency_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.withdrawalCeilingCurrency],
    foreignColumns: [currencies.organizationId, currencies.code],
    name: 'bank_accounts_withdrawal_currency_fk',
  }),
  check(
    'bank_accounts_type_check',
    sql`${table.accountType} IN (
      'CURRENT', 'SAVINGS', 'SHORT_TERM', 'LONG_TERM', 'FOREIGN_CURRENCY',
      'DEPOSIT', 'INTERMEDIARY', 'FUNDS_IN_TRANSIT', 'FACILITY_REFERENCE',
      'GUARANTEE_REFERENCE'
    )`,
  ),
  check(
    'bank_accounts_state_check',
    sql`${table.state} IN ('DRAFT', 'ACTIVE', 'SUSPENDED', 'CLOSED')`,
  ),
  check(
    'bank_accounts_closing_state',
    sql`(${table.state} = 'CLOSED') = (${table.closingDate} IS NOT NULL)`,
  ),
  check(
    'bank_accounts_closing_date',
    sql`${table.closingDate} IS NULL OR ${table.closingDate} >= ${table.openingDate}`,
  ),
  check(
    'bank_accounts_masked_card',
    sql`${table.maskedCardNumber} IS NULL
      OR ${table.maskedCardNumber} ~ '^[*Xx][*Xx -]*[0-9]{4}$'`,
  ),
  check(
    'bank_accounts_cheque_eligibility',
    sql`NOT ${table.chequeEnabled} OR ${table.accountType} = 'CURRENT'`,
  ),
  check(
    'bank_accounts_withdrawal_ceiling',
    sql`(${table.withdrawalCeiling} IS NULL AND ${table.withdrawalCeilingCurrency} IS NULL)
      OR (
        ${table.withdrawalCeiling} IS NOT NULL
        AND ${table.withdrawalCeilingCurrency} IS NOT NULL
        AND ${table.withdrawalCeiling} >= 0
        AND ${table.withdrawalCeilingCurrency} = ${table.currency}
      )`,
  ),
  check('bank_accounts_version_nonnegative', sql`${table.version} >= 0`),
  index('bank_accounts_list_idx').on(
    table.organizationId,
    table.bankId,
    table.accountNumber,
    table.id,
  ),
  index('bank_accounts_scope_idx').on(
    table.organizationId,
    table.organizationBranchId,
    table.treasuryUnitId,
    table.currency,
    table.state,
  ),
]);

export const posTerminals = pgTable('pos_terminals', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  bankAccountId: uuid('bank_account_id').notNull(),
  treasuryUnitId: uuid('treasury_unit_id').notNull(),
  terminalNumber: varchar('terminal_number', { length: 64 }).notNull(),
  merchantNumber: varchar('merchant_number', { length: 64 }).notNull(),
  providerLabel: varchar('provider_label', { length: 160 }),
  currency: varchar('currency', { length: 8 }).notNull(),
  settlementCycle: varchar('settlement_cycle', { length: 64 }).notNull(),
  feeRuleRef: varchar('fee_rule_ref', { length: 128 }),
  state: varchar('state', { length: 16 }).notNull().default('ACTIVE'),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.terminalNumber),
  unique().on(table.organizationId, table.id),
  foreignKey({
    columns: [table.organizationId, table.bankAccountId],
    foreignColumns: [bankAccounts.organizationId, bankAccounts.id],
    name: 'pos_terminals_bank_account_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.treasuryUnitId],
    foreignColumns: [treasuryUnits.organizationId, treasuryUnits.id],
    name: 'pos_terminals_treasury_unit_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.currency],
    foreignColumns: [currencies.organizationId, currencies.code],
    name: 'pos_terminals_currency_fk',
  }),
  check('pos_terminals_state_check', sql`${table.state} IN ('ACTIVE', 'SUSPENDED', 'CLOSED')`),
  check('pos_terminals_version_nonnegative', sql`${table.version} >= 0`),
  index('pos_terminals_list_idx').on(table.organizationId, table.terminalNumber, table.id),
]);

export const paymentGateways = pgTable('payment_gateways', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  bankAccountId: uuid('bank_account_id').notNull(),
  treasuryUnitId: uuid('treasury_unit_id').notNull(),
  providerCode: varchar('provider_code', { length: 64 }).notNull(),
  merchantId: varchar('merchant_id', { length: 128 }).notNull(),
  terminalId: varchar('terminal_id', { length: 128 }).notNull(),
  currency: varchar('currency', { length: 8 }).notNull(),
  settlementCycle: varchar('settlement_cycle', { length: 64 }).notNull(),
  feeRuleRef: varchar('fee_rule_ref', { length: 128 }),
  fundsInTransitMappingRef: varchar('funds_in_transit_mapping_ref', { length: 128 }),
  feeMappingRef: varchar('fee_mapping_ref', { length: 128 }),
  state: varchar('state', { length: 16 }).notNull().default('ACTIVE'),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.providerCode, table.merchantId, table.terminalId),
  unique().on(table.organizationId, table.id),
  foreignKey({
    columns: [table.organizationId, table.bankAccountId],
    foreignColumns: [bankAccounts.organizationId, bankAccounts.id],
    name: 'payment_gateways_bank_account_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.treasuryUnitId],
    foreignColumns: [treasuryUnits.organizationId, treasuryUnits.id],
    name: 'payment_gateways_treasury_unit_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.currency],
    foreignColumns: [currencies.organizationId, currencies.code],
    name: 'payment_gateways_currency_fk',
  }),
  check(
    'payment_gateways_provider_code_format',
    sql`${table.providerCode} ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'`,
  ),
  check(
    'payment_gateways_state_check',
    sql`${table.state} IN ('ACTIVE', 'SUSPENDED', 'CLOSED')`,
  ),
  check('payment_gateways_version_nonnegative', sql`${table.version} >= 0`),
  index('payment_gateways_list_idx').on(
    table.organizationId,
    table.providerCode,
    table.merchantId,
    table.terminalId,
    table.id,
  ),
]);

export const chequeBooks = pgTable('cheque_books', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  bankAccountId: uuid('bank_account_id').notNull(),
  series: varchar('series', { length: 32 }).notNull(),
  firstLeaf: bigint('first_leaf', { mode: 'number' }).notNull(),
  lastLeaf: bigint('last_leaf', { mode: 'number' }).notNull(),
  receivedDate: date('received_date').notNull(),
  custodianUserId: uuid('custodian_user_id'),
  notes: varchar('notes', { length: 1000 }),
  state: varchar('state', { length: 16 }).notNull().default('DRAFT'),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.bankAccountId, table.series, table.firstLeaf, table.lastLeaf),
  unique().on(table.organizationId, table.id),
  unique().on(
    table.organizationId,
    table.id,
    table.bankAccountId,
    table.series,
  ),
  foreignKey({
    columns: [table.organizationId, table.bankAccountId],
    foreignColumns: [bankAccounts.organizationId, bankAccounts.id],
    name: 'cheque_books_bank_account_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.custodianUserId],
    foreignColumns: [userRefs.organizationId, userRefs.id],
    name: 'cheque_books_custodian_fk',
  }),
  check('cheque_books_series_nonempty', sql`length(btrim(${table.series})) > 0`),
  check('cheque_books_positive_first_leaf', sql`${table.firstLeaf} >= 1`),
  check(
    'cheque_books_leaf_count',
    sql`${table.lastLeaf} - ${table.firstLeaf} BETWEEN 0 AND 499`,
  ),
  check(
    'cheque_books_state_check',
    sql`${table.state} IN ('DRAFT', 'ACTIVE', 'SUSPENDED', 'EXHAUSTED', 'CLOSED')`,
  ),
  check('cheque_books_version_nonnegative', sql`${table.version} >= 0`),
]);

export const chequeLeaves = pgTable('cheque_leaves', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  chequeBookId: uuid('cheque_book_id').notNull(),
  bankAccountId: uuid('bank_account_id').notNull(),
  series: varchar('series', { length: 32 }).notNull(),
  leafNumber: bigint('leaf_number', { mode: 'number' }).notNull(),
  reservedForPaymentLineId: uuid('reserved_for_payment_line_id'),
  reservationReviewDueAt: timestamp('reservation_review_due_at', { withTimezone: true }),
  state: varchar('state', { length: 24 }).notNull().default('AVAILABLE'),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.bankAccountId, table.series, table.leafNumber),
  foreignKey({
    columns: [
      table.organizationId,
      table.chequeBookId,
      table.bankAccountId,
      table.series,
    ],
    foreignColumns: [
      chequeBooks.organizationId,
      chequeBooks.id,
      chequeBooks.bankAccountId,
      chequeBooks.series,
    ],
    name: 'cheque_leaves_book_fk',
  }),
  check('cheque_leaves_number_positive', sql`${table.leafNumber} >= 1`),
  check(
    'cheque_leaves_state_check',
    sql`${table.state} IN ('AVAILABLE', 'RESERVED', 'CONSUMED', 'VOID', 'LOST', 'STOPPED')`,
  ),
  check('cheque_leaves_version_nonnegative', sql`${table.version} >= 0`),
  index('cheque_leaves_available_idx').on(
    table.chequeBookId,
    table.state,
    table.leafNumber,
  ),
]);

export const chequeEvents = pgTable('cheque_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  chequeType: varchar('cheque_type', { length: 16 }).notNull(),
  chequeId: uuid('cheque_id').notNull(),
  sequenceNo: bigint('sequence_no', { mode: 'number' }).notNull(),
  fromState: varchar('from_state', { length: 24 }),
  toState: varchar('to_state', { length: 24 }).notNull(),
  actorUserId: uuid('actor_user_id').notNull().references(() => userRefs.id),
  reason: varchar('reason', { length: 500 }),
  evidenceDigest: varchar('evidence_digest', { length: 128 }),
  custodianBeforeType: varchar('custodian_before_type', { length: 16 }),
  custodianBeforeId: uuid('custodian_before_id'),
  custodianAfterType: varchar('custodian_after_type', { length: 16 }),
  custodianAfterId: uuid('custodian_after_id'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
}, (table) => [
  unique().on(table.chequeType, table.chequeId, table.sequenceNo),
  unique().on(table.chequeType, table.chequeId, table.idempotencyKey),
  check(
    'cheque_events_type_check',
    sql`${table.chequeType} IN ('RECEIVED', 'ISSUED', 'LEAF')`,
  ),
  check('cheque_events_sequence_positive', sql`${table.sequenceNo} > 0`),
  check(
    'cheque_events_foundation_reason',
    sql`${table.chequeType} <> 'LEAF'
      OR ${table.fromState} <> 'AVAILABLE'
      OR ${table.toState} NOT IN ('VOID', 'LOST')
      OR NULLIF(btrim(${table.reason}), '') IS NOT NULL`,
  ),
]);

export const printTemplates = pgTable('print_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  treasuryUnitId: uuid('treasury_unit_id'),
  bankId: uuid('bank_id'),
  chequeBookId: uuid('cheque_book_id').references(() => chequeBooks.id),
  code: varchar('code', { length: 64 }).notNull(),
  documentKind: varchar('document_kind', { length: 16 }).notNull(),
  language: varchar('language', { length: 8 }).notNull(),
  direction: varchar('direction', { length: 3 }).notNull(),
  pageProfile: varchar('page_profile', { length: 32 }).notNull(),
  calibrationXmm: numeric('calibration_x_mm', { precision: 8, scale: 3 }).notNull().default('0'),
  calibrationYmm: numeric('calibration_y_mm', { precision: 8, scale: 3 }).notNull().default('0'),
  templateBody: jsonb('template_body').$type<Record<string, unknown>>().notNull(),
  templateDigest: char('template_digest', { length: 64 }).notNull(),
  templateVersion: bigint('template_version', { mode: 'number' }).notNull(),
  state: varchar('state', { length: 16 }).notNull().default('DRAFT'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.code, table.templateVersion),
  foreignKey({
    columns: [table.organizationId, table.treasuryUnitId],
    foreignColumns: [treasuryUnits.organizationId, treasuryUnits.id],
    name: 'print_templates_treasury_unit_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.bankId],
    foreignColumns: [banks.organizationId, banks.id],
    name: 'print_templates_bank_fk',
  }),
  check('print_templates_code_format', sql`${table.code} ~ '^[A-Z][A-Z0-9_-]{1,63}$'`),
  check(
    'print_templates_document_kind_check',
    sql`${table.documentKind} IN ('RECEIPT', 'PAYMENT', 'TRANSFER', 'CHEQUE')`,
  ),
  check('print_templates_language_check', sql`${table.language} IN ('fa-IR', 'en')`),
  check('print_templates_direction_check', sql`${table.direction} IN ('RTL', 'LTR')`),
  check(
    'print_templates_page_profile_check',
    sql`${table.pageProfile} IN (
      'A4_PORTRAIT', 'A4_LANDSCAPE', 'A5_PORTRAIT', 'A5_LANDSCAPE',
      'CHEQUE_CUSTOM'
    )`,
  ),
  check(
    'print_templates_calibration_x_range',
    sql`${table.calibrationXmm} BETWEEN -100 AND 100`,
  ),
  check(
    'print_templates_calibration_y_range',
    sql`${table.calibrationYmm} BETWEEN -100 AND 100`,
  ),
  check('print_templates_body_object', sql`jsonb_typeof(${table.templateBody}) = 'object'`),
  check(
    'print_templates_digest_format',
    sql`${table.templateDigest} ~ '^[a-f0-9]{64}$'`,
  ),
  check('print_templates_version_positive', sql`${table.templateVersion} > 0`),
  check(
    'print_templates_state_check',
    sql`${table.state} IN ('DRAFT', 'ACTIVE', 'RETIRED')`,
  ),
  check(
    'print_templates_scope_check',
    sql`(
      ${table.documentKind} = 'CHEQUE'
      AND (${table.bankId} IS NOT NULL OR ${table.chequeBookId} IS NOT NULL)
    ) OR (
      ${table.documentKind} <> 'CHEQUE'
      AND ${table.bankId} IS NULL
      AND ${table.chequeBookId} IS NULL
    )`,
  ),
  index('print_templates_list_idx').on(
    table.organizationId,
    table.code,
    table.templateVersion,
    table.id,
  ),
  index('print_templates_match_idx').on(
    table.organizationId,
    table.documentKind,
    table.treasuryUnitId,
    table.bankId,
    table.chequeBookId,
    table.state,
  ),
]);

export const exchangeRates = pgTable('exchange_rates', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceCurrency: varchar('source_currency', { length: 8 }).notNull(),
  targetCurrency: varchar('target_currency', { length: 8 }).notNull(),
  rateType: varchar('rate_type', { length: 64 }).notNull(),
  rate: numeric('rate', { precision: 38, scale: 18 }).notNull(),
  validAt: timestamp('valid_at', { withTimezone: true }).notNull(),
  sourceName: varchar('source_name', { length: 160 }).notNull(),
  recordedBy: uuid('recorded_by').notNull().references(() => userRefs.id),
  approvedBy: uuid('approved_by').references(() => userRefs.id),
  state: varchar('state', { length: 16 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(
    table.sourceCurrency,
    table.targetCurrency,
    table.rateType,
    table.validAt,
    table.sourceName,
  ),
  check('exchange_rates_positive', sql`${table.rate} > 0`),
  check(
    'exchange_rates_state_check',
    sql`${table.state} IN ('DRAFT', 'APPROVED', 'RETIRED')`,
  ),
  check(
    'exchange_rates_distinct_pair',
    sql`${table.sourceCurrency} <> ${table.targetCurrency}`,
  ),
  index('exchange_rates_selection_idx')
    .on(table.sourceCurrency, table.targetCurrency, table.validAt)
    .where(sql`${table.state} = 'APPROVED'`),
]);

export const attachments = pgTable('attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  contentDigest: char('content_digest', { length: 64 }).notNull(),
  attachmentVersion: integer('attachment_version').notNull(),
  fileName: varchar('file_name', { length: 255 }).notNull(),
  mediaType: varchar('media_type', { length: 128 }).notNull(),
  byteLength: bigint('byte_length', { mode: 'number' }).notNull(),
  storageRef: varchar('storage_ref', { length: 500 }).notNull(),
  state: varchar('state', { length: 16 }).notNull(),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.id, table.contentDigest),
  unique().on(table.organizationId, table.contentDigest, table.attachmentVersion),
  foreignKey({
    columns: [table.organizationId, table.createdBy],
    foreignColumns: [userRefs.organizationId, userRefs.id],
    name: 'attachments_creator_fk',
  }),
  check('attachments_digest_format', sql`${table.contentDigest} ~ '^[a-f0-9]{64}$'`),
  check('attachments_version_positive', sql`${table.attachmentVersion} > 0`),
  check('attachments_byte_length_nonnegative', sql`${table.byteLength} >= 0`),
  check(
    'attachments_state_check',
    sql`${table.state} IN ('ACTIVE', 'SUPERSEDED', 'REDACTED')`,
  ),
]);

export const receiptNumberCounters = pgTable('receipt_number_counters', {
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  businessDate: date('business_date').notNull(),
  nextValue: bigint('next_value', { mode: 'number' }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.businessDate] }),
  check('receipt_number_counters_positive', sql`${table.nextValue} > 0`),
]);

// Explicit annotation breaks the Receipt header/line base-currency FK cycle.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const receiptDocuments: any = pgTable('receipt_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  businessNumber: varchar('business_number', { length: 64 }).notNull(),
  businessDate: date('business_date').notNull(),
  enteredAt: timestamp('entered_at', { withTimezone: true }).notNull(),
  partyId: uuid('party_id').notNull(),
  branchId: uuid('branch_id'),
  treasuryUnitId: uuid('treasury_unit_id').notNull(),
  baseCurrency: varchar('base_currency', { length: 8 }).notNull(),
  totalBaseAmount: numeric('total_base_amount', { precision: 38, scale: 8 }).notNull(),
  description: varchar('description', { length: 1000 }),
  purpose: varchar('purpose', { length: 500 }),
  contractRef: varchar('contract_ref', { length: 128 }),
  invoiceRef: varchar('invoice_ref', { length: 128 }),
  orderRef: varchar('order_ref', { length: 128 }),
  projectRef: varchar('project_ref', { length: 128 }),
  costCenterRef: varchar('cost_center_ref', { length: 128 }),
  origin: varchar('origin', { length: 32 }).notNull().default('MANUAL'),
  creatorUserId: uuid('creator_user_id').notNull(),
  currentApprovalSnapshotId: uuid('current_approval_snapshot_id'),
  state: varchar('state', { length: 32 }).notNull().default('DRAFT'),
  workflowState: varchar('workflow_state', { length: 24 }).notNull().default('DRAFT'),
  executionState: varchar('execution_state', { length: 24 }).notNull().default('NOT_EXECUTED'),
  accountingState: varchar('accounting_state', { length: 24 }).notNull().default('NOT_READY'),
  executedAt: timestamp('executed_at', { withTimezone: true }),
  executedByUserId: uuid('executed_by_user_id'),
  reversalReceiptId: uuid('reversal_receipt_id'),
  reversesReceiptId: uuid('reverses_receipt_id'),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.businessNumber),
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.id, table.baseCurrency),
  foreignKey({
    columns: [table.organizationId, table.partyId],
    foreignColumns: [parties.organizationId, parties.id],
    name: 'receipt_documents_party_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.branchId],
    foreignColumns: [branches.organizationId, branches.id],
    name: 'receipt_documents_branch_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.treasuryUnitId],
    foreignColumns: [treasuryUnits.organizationId, treasuryUnits.id],
    name: 'receipt_documents_treasury_unit_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.baseCurrency],
    foreignColumns: [currencies.organizationId, currencies.code],
    name: 'receipt_documents_currency_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.creatorUserId],
    foreignColumns: [userRefs.organizationId, userRefs.id],
    name: 'receipt_documents_creator_fk',
  }),
  check('receipt_documents_positive_total', sql`${table.totalBaseAmount} > 0`),
  check('receipt_documents_origin_manual', sql`${table.origin} = 'MANUAL'`),
  check(
    'receipt_documents_state_check',
    sql`${table.state} IN (
      'DRAFT', 'SUBMITTED', 'APPROVAL_PENDING', 'APPROVED', 'REJECTED',
      'EXECUTED', 'ACCOUNTING_READY', 'ACCOUNTING_POSTED', 'REVERSED'
    )`,
  ),
  check(
    'receipt_documents_workflow_state_check',
    sql`${table.workflowState} IN (
      'DRAFT', 'SUBMITTED', 'APPROVAL_PENDING', 'APPROVED', 'REJECTED'
    )`,
  ),
  check(
    'receipt_documents_snapshot_state_check',
    sql`(${table.state} = 'DRAFT' AND ${table.currentApprovalSnapshotId} IS NULL)
      OR (
        ${table.state} <> 'DRAFT'
        AND (
          (
            ${table.reversesReceiptId} IS NULL
            AND ${table.currentApprovalSnapshotId} IS NOT NULL
          )
          OR (
            ${table.reversesReceiptId} IS NOT NULL
            AND ${table.currentApprovalSnapshotId} IS NULL
          )
        )
      )`,
  ),
  check(
    'receipt_documents_execution_state_check',
    sql`${table.executionState} IN ('NOT_EXECUTED', 'EXECUTED', 'REVERSED')`,
  ),
  check(
    'receipt_documents_accounting_state_check',
    sql`${table.accountingState} IN (
      'NOT_READY', 'MAPPING_REQUIRED', 'READY', 'QUEUED', 'SENDING',
      'SENDING_UNKNOWN', 'ACCEPTED', 'FAILED', 'RETURNED', 'CORRECTED'
    )`,
  ),
  index('receipt_documents_list_idx')
    .on(table.organizationId, table.businessDate, table.id),
]);

export const receiptApprovalPolicies = pgTable('receipt_approval_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  code: varchar('code', { length: 64 }).notNull(),
  name: varchar('name', { length: 240 }).notNull(),
  documentType: varchar('document_type', { length: 64 }).notNull(),
  branchId: uuid('branch_id'),
  treasuryUnitId: uuid('treasury_unit_id'),
  currency: varchar('currency', { length: 8 }),
  methodCategory: varchar('method_category', { length: 64 }),
  amountMinimum: numeric('amount_minimum', { precision: 38, scale: 8 }),
  amountMaximum: numeric('amount_maximum', { precision: 38, scale: 8 }),
  version: integer('version').notNull(),
  state: varchar('state', { length: 16 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.code, table.version),
  foreignKey({
    columns: [table.organizationId, table.branchId],
    foreignColumns: [branches.organizationId, branches.id],
    name: 'receipt_approval_policies_branch_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.treasuryUnitId],
    foreignColumns: [treasuryUnits.organizationId, treasuryUnits.id],
    name: 'receipt_approval_policies_treasury_unit_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.currency],
    foreignColumns: [currencies.organizationId, currencies.code],
    name: 'receipt_approval_policies_currency_fk',
  }),
  index('receipt_approval_policy_selection_idx').on(
    table.organizationId,
    table.documentType,
    table.state,
    table.branchId,
    table.treasuryUnitId,
    table.currency,
    table.methodCategory,
    table.amountMinimum,
    table.amountMaximum,
  ),
]);

export const receiptApprovalPolicySteps = pgTable('receipt_approval_policy_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  policyId: uuid('policy_id').notNull(),
  stepOrder: integer('step_order').notNull(),
  roleId: uuid('role_id'),
  approverUserId: uuid('approver_user_id'),
  approvalsRequired: integer('approvals_required').notNull(),
  separationRules: varchar('separation_rules', { length: 64 }).array().notNull().default([]),
}, (table) => [
  unique().on(table.organizationId, table.policyId, table.stepOrder),
  unique().on(table.organizationId, table.policyId, table.id),
  foreignKey({
    columns: [table.organizationId, table.policyId],
    foreignColumns: [receiptApprovalPolicies.organizationId, receiptApprovalPolicies.id],
    name: 'receipt_approval_policy_steps_policy_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.roleId],
    foreignColumns: [roles.organizationId, roles.id],
    name: 'receipt_approval_policy_steps_role_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.approverUserId],
    foreignColumns: [userRefs.organizationId, userRefs.id],
    name: 'receipt_approval_policy_steps_approver_fk',
  }),
]);

export const receiptApprovalSnapshots = pgTable('receipt_approval_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  receiptDocumentId: uuid('receipt_document_id').notNull(),
  documentVersion: bigint('document_version', { mode: 'number' }).notNull(),
  amountBasis: numeric('amount_basis', { precision: 38, scale: 8 }).notNull(),
  baseCurrency: varchar('base_currency', { length: 8 }).notNull(),
  evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.receiptDocumentId, table.id),
  foreignKey({
    columns: [table.organizationId, table.receiptDocumentId, table.baseCurrency],
    foreignColumns: [
      receiptDocuments.organizationId,
      receiptDocuments.id,
      receiptDocuments.baseCurrency,
    ],
    name: 'receipt_approval_snapshots_document_fk',
  }),
]);

export const receiptApprovalSnapshotContexts = pgTable('receipt_approval_snapshot_contexts', {
  organizationId: uuid('organization_id').notNull(),
  approvalSnapshotId: uuid('approval_snapshot_id').notNull(),
  contextOrder: integer('context_order').notNull(),
  firstLineNumber: integer('first_line_number').notNull(),
  currency: varchar('currency', { length: 8 }).notNull(),
  methodCategory: varchar('method_category', { length: 64 }).notNull(),
  policyId: uuid('policy_id').notNull(),
  policyCode: varchar('policy_code', { length: 64 }).notNull(),
  policyName: varchar('policy_name', { length: 240 }).notNull(),
  policyVersion: integer('policy_version').notNull(),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.approvalSnapshotId, table.contextOrder] }),
  foreignKey({
    columns: [table.organizationId, table.approvalSnapshotId],
    foreignColumns: [receiptApprovalSnapshots.organizationId, receiptApprovalSnapshots.id],
    name: 'receipt_approval_snapshot_contexts_snapshot_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.policyId],
    foreignColumns: [receiptApprovalPolicies.organizationId, receiptApprovalPolicies.id],
    name: 'receipt_approval_snapshot_contexts_policy_fk',
  }),
]);

export const receiptApprovalSnapshotSteps = pgTable('receipt_approval_snapshot_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  approvalSnapshotId: uuid('approval_snapshot_id').notNull(),
  stepOrder: integer('step_order').notNull(),
  roleId: uuid('role_id'),
  roleName: varchar('role_name', { length: 240 }),
  approverUserId: uuid('approver_user_id'),
  approverName: varchar('approver_name', { length: 240 }),
  approvalsRequired: integer('approvals_required').notNull(),
  separationRules: varchar('separation_rules', { length: 64 }).array().notNull(),
  sourceContextOrders: integer('source_context_orders').array().notNull(),
  obligationKey: text('obligation_key').notNull(),
}, (table) => [
  unique().on(table.organizationId, table.approvalSnapshotId, table.id),
  unique().on(table.organizationId, table.approvalSnapshotId, table.stepOrder),
  unique().on(table.organizationId, table.approvalSnapshotId, table.obligationKey),
  foreignKey({
    columns: [table.organizationId, table.approvalSnapshotId],
    foreignColumns: [receiptApprovalSnapshots.organizationId, receiptApprovalSnapshots.id],
    name: 'receipt_approval_snapshot_steps_snapshot_fk',
  }),
]);

export const receiptApprovalActions = pgTable('receipt_approval_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  approvalSnapshotId: uuid('approval_snapshot_id').notNull(),
  approvalSnapshotStepId: uuid('approval_snapshot_step_id'),
  stepOrder: integer('step_order'),
  actorUserId: uuid('actor_user_id').notNull(),
  delegatedFromUserId: uuid('delegated_from_user_id'),
  action: varchar('action', { length: 16 }).notNull(),
  reason: varchar('reason', { length: 500 }),
  actedAt: timestamp('acted_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  foreignKey({
    columns: [table.organizationId, table.approvalSnapshotId],
    foreignColumns: [receiptApprovalSnapshots.organizationId, receiptApprovalSnapshots.id],
    name: 'receipt_approval_actions_snapshot_fk',
  }),
  foreignKey({
    columns: [
      table.organizationId,
      table.approvalSnapshotId,
      table.approvalSnapshotStepId,
    ],
    foreignColumns: [
      receiptApprovalSnapshotSteps.organizationId,
      receiptApprovalSnapshotSteps.approvalSnapshotId,
      receiptApprovalSnapshotSteps.id,
    ],
    name: 'receipt_approval_actions_step_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.actorUserId],
    foreignColumns: [userRefs.organizationId, userRefs.id],
    name: 'receipt_approval_actions_actor_fk',
  }),
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const receiptLines: any = pgTable('receipt_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  receiptDocumentId: uuid('receipt_document_id').notNull(),
  lineNumber: integer('line_number').notNull(),
  methodId: uuid('method_id').notNull(),
  methodName: varchar('method_name', { length: 160 }).notNull(),
  methodCategory: varchar('method_category', { length: 32 }).notNull(),
  methodRequiredReferences: jsonb('method_required_references').$type<string[]>().notNull(),
  createsFundsInTransit: boolean('creates_funds_in_transit').notNull(),
  requiresApproval: boolean('requires_approval').notNull(),
  amount: numeric('amount', { precision: 38, scale: 8 }).notNull(),
  currency: varchar('currency', { length: 8 }).notNull(),
  baseCurrency: varchar('base_currency', { length: 8 }).notNull(),
  exchangeRate: numeric('exchange_rate', { precision: 38, scale: 18 }).notNull(),
  rateType: varchar('rate_type', { length: 64 }).notNull(),
  rateSource: varchar('rate_source', { length: 24 }).notNull(),
  rateRecordId: uuid('rate_record_id').references(() => exchangeRates.id),
  rateAt: timestamp('rate_at', { withTimezone: true }).notNull(),
  baseAmount: numeric('base_amount', { precision: 38, scale: 8 }).notNull(),
  roundingDifference: numeric('rounding_difference', { precision: 38, scale: 8 }).notNull(),
  cashboxId: uuid('cashbox_id'),
  bankAccountId: uuid('bank_account_id'),
  posTerminalId: uuid('pos_terminal_id'),
  paymentGatewayId: uuid('payment_gateway_id'),
  chequeBankId: uuid('cheque_bank_id'),
  chequeBankBranchId: uuid('cheque_bank_branch_id'),
  chequePayerPartyId: uuid('cheque_payer_party_id'),
  chequeInput: jsonb('cheque_input').$type<Record<string, unknown>>(),
  trackingNumber: varchar('tracking_number', { length: 128 }),
  payerAccountReference: varchar('payer_account_reference', { length: 128 }),
  dueDate: date('due_date'),
  payerName: varchar('payer_name', { length: 200 }),
  remainderTreatment: varchar('remainder_treatment', { length: 24 }).notNull(),
  description: varchar('description', { length: 1000 }),
  accountingDimensions: jsonb('accounting_dimensions').$type<Record<string, string>>(),
  state: varchar('state', { length: 16 }).notNull().default('DRAFT'),
  executedAt: timestamp('executed_at', { withTimezone: true }),
  executedByUserId: uuid('executed_by_user_id'),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.id, table.baseCurrency),
  unique().on(table.organizationId, table.receiptDocumentId, table.lineNumber),
  foreignKey({
    columns: [table.organizationId, table.receiptDocumentId, table.baseCurrency],
    foreignColumns: [
      receiptDocuments.organizationId,
      receiptDocuments.id,
      receiptDocuments.baseCurrency,
    ],
    name: 'receipt_lines_document_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.methodId],
    foreignColumns: [methodDefinitions.organizationId, methodDefinitions.id],
    name: 'receipt_lines_method_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.chequeBankId],
    foreignColumns: [banks.organizationId, banks.id],
    name: 'receipt_lines_cheque_bank_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.chequeBankId, table.chequeBankBranchId],
    foreignColumns: [
      bankBranches.organizationId,
      bankBranches.bankId,
      bankBranches.id,
    ],
    name: 'receipt_lines_cheque_bank_branch_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.chequePayerPartyId],
    foreignColumns: [parties.organizationId, parties.id],
    name: 'receipt_lines_cheque_payer_party_fk',
  }),
  check('receipt_lines_positive_line_number', sql`${table.lineNumber} > 0`),
  check('receipt_lines_positive_amount', sql`${table.amount} > 0`),
  check('receipt_lines_positive_base_amount', sql`${table.baseAmount} > 0`),
  check('receipt_lines_positive_rate', sql`${table.exchangeRate} > 0`),
  check('receipt_lines_cheque_reference_shape', sql`(
    (
      ${table.chequeInput} IS NULL
      AND ${table.chequeBankId} IS NULL
      AND ${table.chequeBankBranchId} IS NULL
      AND ${table.chequePayerPartyId} IS NULL
    )
    OR (
      ${table.chequeInput} IS NOT NULL
      AND ${table.chequeBankId} IS NOT NULL
      AND ${table.chequeInput} ? 'bankId'
      AND jsonb_typeof(${table.chequeInput}->'bankId') IS NOT DISTINCT FROM 'string'
      AND ${table.chequeInput}->>'bankId'
        IS NOT DISTINCT FROM ${table.chequeBankId}::text
      AND (
        (NOT (${table.chequeInput} ? 'bankBranchId')
          AND ${table.chequeBankBranchId} IS NULL)
        OR (
          jsonb_typeof(${table.chequeInput}->'bankBranchId')
            IS NOT DISTINCT FROM 'string'
          AND ${table.chequeInput}->>'bankBranchId'
            IS NOT DISTINCT FROM ${table.chequeBankBranchId}::text
        )
      )
      AND (
        (NOT (${table.chequeInput} ? 'payerPartyId')
          AND ${table.chequePayerPartyId} IS NULL)
        OR (
          jsonb_typeof(${table.chequeInput}->'payerPartyId')
            IS NOT DISTINCT FROM 'string'
          AND ${table.chequeInput}->>'payerPartyId'
            IS NOT DISTINCT FROM ${table.chequePayerPartyId}::text
        )
      )
    )
  )`),
  check(
    'receipt_lines_rate_shape',
    sql`(
      ${table.rateSource} = 'IDENTITY'
      AND ${table.rateRecordId} IS NULL
      AND ${table.currency} = ${table.baseCurrency}
      AND ${table.exchangeRate} = 1
      AND ${table.roundingDifference} = 0
    ) OR (
      ${table.rateSource} = 'TABLE'
      AND ${table.rateRecordId} IS NOT NULL
      AND ${table.currency} <> ${table.baseCurrency}
    )`,
  ),
]);

export const receiptAllocations = pgTable('receipt_allocations', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  receiptLineId: uuid('receipt_line_id').notNull(),
  externalObjectType: varchar('external_object_type', { length: 32 }).notNull(),
  externalObjectId: varchar('external_object_id', { length: 128 }).notNull(),
  baseAmount: numeric('base_amount', { precision: 38, scale: 8 }).notNull(),
  baseCurrency: varchar('base_currency', { length: 8 }).notNull(),
  state: varchar('state', { length: 16 }).notNull().default('ACTIVE'),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(
    table.organizationId,
    table.receiptLineId,
    table.externalObjectType,
    table.externalObjectId,
  ),
  foreignKey({
    columns: [table.organizationId, table.receiptLineId, table.baseCurrency],
    foreignColumns: [
      receiptLines.organizationId,
      receiptLines.id,
      receiptLines.baseCurrency,
    ],
    name: 'receipt_allocations_line_fk',
  }),
  check('receipt_allocations_positive', sql`${table.baseAmount} > 0`),
]);

export const receiptLineAttachmentLinks = pgTable('receipt_line_attachment_links', {
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  receiptLineId: uuid('receipt_line_id').notNull(),
  attachmentId: uuid('attachment_id').notNull(),
  contentDigest: char('content_digest', { length: 64 }).notNull(),
  purpose: varchar('purpose', { length: 64 }).notNull().default(''),
  linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({
    columns: [table.organizationId, table.receiptLineId, table.attachmentId, table.purpose],
  }),
  foreignKey({
    columns: [table.organizationId, table.receiptLineId],
    foreignColumns: [receiptLines.organizationId, receiptLines.id],
    name: 'receipt_line_attachment_links_line_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.attachmentId, table.contentDigest],
    foreignColumns: [
      attachments.organizationId,
      attachments.id,
      attachments.contentDigest,
    ],
    name: 'receipt_line_attachment_links_attachment_fk',
  }),
  check(
    'receipt_line_attachment_links_digest_format',
    sql`${table.contentDigest} ~ '^[a-f0-9]{64}$'`,
  ),
]);

export const cashboxDays = pgTable('cashbox_days', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  cashboxId: uuid('cashbox_id').notNull(),
  businessDate: date('business_date').notNull(),
  closeCycle: integer('close_cycle').notNull().default(1),
  state: varchar('state', { length: 24 }).notNull(),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
}, (table) => [
  unique().on(
    table.organizationId,
    table.cashboxId,
    table.businessDate,
    table.closeCycle,
  ),
]);

export const movementFacts = pgTable('movement_facts', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  owner: varchar('owner', { length: 64 }).notNull(),
  sourceType: varchar('source_type', { length: 32 }).notNull(),
  sourceId: uuid('source_id').notNull(),
  sourceLineId: uuid('source_line_id'),
  effectKey: varchar('effect_key', { length: 128 }).notNull(),
  endpointType: varchar('endpoint_type', { length: 16 }).notNull(),
  endpointId: uuid('endpoint_id').notNull(),
  direction: varchar('direction', { length: 8 }).notNull(),
  amount: numeric('amount', { precision: 38, scale: 8 }).notNull(),
  currency: varchar('currency', { length: 8 }).notNull(),
  businessDate: date('business_date').notNull(),
  executedAt: timestamp('executed_at', { withTimezone: true }).notNull().defaultNow(),
  reversalOfFactId: uuid('reversal_of_fact_id'),
  state: varchar('state', { length: 16 }).notNull(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(
    table.organizationId,
    table.owner,
    table.sourceType,
    table.sourceId,
    table.sourceLineId,
    table.effectKey,
  ),
  unique().on(table.organizationId, table.reversalOfFactId),
]);

export const receivedCheques = pgTable('received_cheques', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  receiptLineId: uuid('receipt_line_id').notNull(),
  issuerBankId: uuid('issuer_bank_id').notNull(),
  issuerBankBranchId: uuid('issuer_bank_branch_id'),
  chequeNumber: varchar('cheque_number', { length: 64 }).notNull(),
  series: varchar('series', { length: 32 }),
  localTrackingId: varchar('local_tracking_id', { length: 64 }),
  issuerAccountRef: varchar('issuer_account_ref', { length: 128 }),
  payerPartyId: uuid('payer_party_id'),
  amount: numeric('amount', { precision: 38, scale: 8 }).notNull(),
  currency: varchar('currency', { length: 8 }).notNull(),
  receiptDate: date('receipt_date').notNull(),
  dueDate: date('due_date').notNull(),
  custodianType: varchar('custodian_type', { length: 16 }).notNull(),
  custodianId: uuid('custodian_id').notNull(),
  sayadId: char('sayad_id', { length: 16 }),
  sayadStatus: varchar('sayad_status', { length: 64 }),
  sayadSource: varchar('sayad_source', { length: 8 }),
  sayadObservedAt: timestamp('sayad_observed_at', { withTimezone: true }),
  sayadSourceDigest: char('sayad_source_digest', { length: 64 }),
  issuerNationalId: varchar('issuer_national_id', { length: 32 }),
  beneficiaryNationalId: varchar('beneficiary_national_id', { length: 32 }),
  state: varchar('state', { length: 24 }).notNull().default('RECEIVED'),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.receiptLineId, table.id),
  unique().on(table.organizationId, table.receiptLineId),
  unique().on(
    table.organizationId,
    table.issuerBankId,
    table.chequeNumber,
    table.amount,
    table.dueDate,
  ),
]);

export const collectionItems = pgTable('collection_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  sourceFactType: varchar('source_fact_type', { length: 32 }).notNull(),
  sourceFactId: uuid('source_fact_id').notNull(),
  channelType: varchar('channel_type', { length: 24 }).notNull(),
  channelId: uuid('channel_id'),
  providerReference: varchar('provider_reference', { length: 128 }),
  grossAmount: numeric('gross_amount', { precision: 38, scale: 8 }).notNull(),
  currency: varchar('currency', { length: 8 }).notNull(),
  allocatedAmount: numeric('allocated_amount', { precision: 38, scale: 8 }).notNull().default('0'),
  remainingAmount: numeric('remaining_amount', { precision: 38, scale: 8 }).notNull(),
  destinationBankAccountId: uuid('destination_bank_account_id').notNull(),
  collectedAt: timestamp('collected_at', { withTimezone: true }).notNull(),
  expectedSettlementDate: date('expected_settlement_date'),
  state: varchar('state', { length: 32 }).notNull().default('OPEN'),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.sourceFactType, table.sourceFactId),
]);

export const receiptExecutionEffects = pgTable('receipt_execution_effects', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  receiptLineId: uuid('receipt_line_id').notNull(),
  effectKey: varchar('effect_key', { length: 128 }).notNull(),
  effectType: varchar('effect_type', { length: 24 }).notNull(),
  direction: varchar('direction', { length: 8 }).notNull(),
  amount: numeric('amount', { precision: 38, scale: 8 }).notNull(),
  currency: varchar('currency', { length: 8 }).notNull(),
  businessDate: date('business_date').notNull(),
  sourceVersion: bigint('source_version', { mode: 'number' }).notNull(),
  movementFactId: uuid('movement_fact_id'),
  receivedChequeId: uuid('received_cheque_id'),
  chequeEventId: uuid('cheque_event_id'),
  collectionItemId: uuid('collection_item_id'),
  collectionItemVersion: bigint('collection_item_version', { mode: 'number' }),
  collectionItemState: varchar('collection_item_state', { length: 32 }),
  reversalOfEffectId: uuid('reversal_of_effect_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.id, table.currency, table.amount),
  unique().on(
    table.organizationId,
    table.receiptLineId,
    table.effectKey,
    table.direction,
  ),
  unique().on(table.organizationId, table.reversalOfEffectId),
  unique().on(table.organizationId, table.movementFactId),
  unique().on(table.organizationId, table.receivedChequeId),
  unique().on(table.organizationId, table.chequeEventId),
]);

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  requestId: varchar('request_id', { length: 128 }).notNull(),
  sequenceNo: bigint('sequence_no', { mode: 'number' }).notNull(),
  actorUserId: uuid('actor_user_id'),
  entityType: varchar('entity_type', { length: 32 }).notNull(),
  entityId: uuid('entity_id').notNull(),
  action: varchar('action', { length: 64 }).notNull(),
  reason: varchar('reason', { length: 500 }),
  outcome: varchar('outcome', { length: 24 }).notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique().on(table.organizationId, table.requestId, table.sequenceNo)]);

export const outboxEvents = pgTable('outbox_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  aggregateType: varchar('aggregate_type', { length: 64 }).notNull(),
  aggregateId: uuid('aggregate_id').notNull(),
  aggregateVersion: bigint('aggregate_version', { mode: 'number' }).notNull(),
  eventType: varchar('event_type', { length: 128 }).notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
}, (table) => [
  unique().on(
    table.organizationId,
    table.aggregateType,
    table.aggregateId,
    table.aggregateVersion,
    table.eventType,
  ),
]);
