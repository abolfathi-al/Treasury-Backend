import {
  bigint,
  boolean,
  char,
  check,
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
}, (table) => [unique().on(table.organizationId, table.subjectKey)]);

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
});

export const roles = pgTable('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  code: varchar('code', { length: 64 }).notNull(),
  name: varchar('name', { length: 160 }).notNull(),
  state: varchar('state', { length: 16 }).notNull().default('ACTIVE'),
  version: integer('version').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique().on(table.organizationId, table.code)]);

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

export const accessGrantCashboxScopes = pgTable('access_grant_cashbox_scopes', {
  accessGrantId: uuid('access_grant_id').notNull().references(() => accessGrants.id),
  cashboxId: uuid('cashbox_id').notNull(),
}, (table) => [primaryKey({ columns: [table.accessGrantId, table.cashboxId] })]);

export const accessGrantBankAccountScopes = pgTable('access_grant_bank_account_scopes', {
  accessGrantId: uuid('access_grant_id').notNull().references(() => accessGrants.id),
  bankAccountId: uuid('bank_account_id').notNull(),
}, (table) => [primaryKey({ columns: [table.accessGrantId, table.bankAccountId] })]);

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
