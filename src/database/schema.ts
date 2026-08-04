import {
  bigint,
  boolean,
  char,
  check,
  customType,
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

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

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

export const delegations = pgTable('delegations', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  accessGrantId: uuid('access_grant_id').notNull(),
  sourceGrantVersion: integer('source_grant_version').notNull(),
  sourceScopeDigest: char('source_scope_digest', { length: 64 }).notNull(),
  grantorUserId: uuid('grantor_user_id').notNull(),
  delegateUserId: uuid('delegate_user_id').notNull(),
  branchId: uuid('branch_id'),
  treasuryUnitId: uuid('treasury_unit_id'),
  currency: varchar('currency', { length: 8 }),
  documentType: varchar('document_type', { length: 64 }),
  methodCategory: varchar('method_category', { length: 32 }),
  amountCeiling: numeric('amount_ceiling', { precision: 38, scale: 8 }),
  amountCeilingCurrency: varchar('amount_ceiling_currency', { length: 8 }),
  reason: varchar('reason', { length: 500 }).notNull(),
  validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
  validTo: timestamp('valid_to', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedByUserId: uuid('revoked_by_user_id'),
  revocationReason: varchar('revocation_reason', { length: 500 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  foreignKey({
    columns: [table.organizationId, table.accessGrantId],
    foreignColumns: [accessGrants.organizationId, accessGrants.id],
    name: 'delegations_access_grant_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.grantorUserId],
    foreignColumns: [userRefs.organizationId, userRefs.id],
    name: 'delegations_grantor_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.delegateUserId],
    foreignColumns: [userRefs.organizationId, userRefs.id],
    name: 'delegations_delegate_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.revokedByUserId],
    foreignColumns: [userRefs.organizationId, userRefs.id],
    name: 'delegations_revoked_by_fk',
  }),
  foreignKey({ columns: [table.organizationId, table.branchId], foreignColumns: [branches.organizationId, branches.id], name: 'delegations_branch_fk' }),
  foreignKey({ columns: [table.organizationId, table.treasuryUnitId], foreignColumns: [treasuryUnits.organizationId, treasuryUnits.id], name: 'delegations_treasury_unit_fk' }),
  foreignKey({ columns: [table.organizationId, table.currency], foreignColumns: [currencies.organizationId, currencies.code], name: 'delegations_currency_fk' }),
  foreignKey({ columns: [table.organizationId, table.amountCeilingCurrency], foreignColumns: [currencies.organizationId, currencies.code], name: 'delegations_amount_currency_fk' }),
  check('delegations_distinct_users', sql`${table.grantorUserId} <> ${table.delegateUserId}`),
  check('delegations_source_version_check', sql`${table.sourceGrantVersion} >= 0`),
  check('delegations_source_digest_check', sql`${table.sourceScopeDigest} ~ '^[0-9a-f]{64}$'`),
  check('delegations_valid_interval', sql`${table.validTo} > ${table.validFrom}`),
  check('delegations_scope_check', sql`${table.branchId} IS NOT NULL OR ${table.treasuryUnitId} IS NOT NULL OR ${table.currency} IS NOT NULL OR ${table.documentType} IS NOT NULL OR ${table.methodCategory} IS NOT NULL OR ${table.amountCeiling} IS NOT NULL`),
  check('delegations_amount_check', sql`(${table.amountCeiling} IS NULL AND ${table.amountCeilingCurrency} IS NULL) OR (${table.amountCeiling} > 0 AND ${table.amountCeilingCurrency} IS NOT NULL)`),
  check('delegations_currency_amount_check', sql`${table.currency} IS NULL OR ${table.amountCeilingCurrency} IS NULL OR ${table.currency} = ${table.amountCeilingCurrency}`),
  check(
    'delegations_revocation_pair',
    sql`(${table.revokedAt} IS NULL AND ${table.revokedByUserId} IS NULL AND ${table.revocationReason} IS NULL) OR (${table.revokedAt} IS NOT NULL AND ${table.revokedByUserId} IS NOT NULL AND ${table.revocationReason} IS NOT NULL)`,
  ),
  index('delegations_delegate_active_idx').on(
    table.organizationId,
    table.delegateUserId,
    table.validFrom,
    table.validTo,
  ),
]);

export const approvalPolicies = pgTable('approval_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  code: varchar('code', { length: 64 }).notNull(),
  name: varchar('name', { length: 240 }).notNull(),
  documentType: varchar('document_type', { length: 64 }).notNull(),
  organizationWide: boolean('organization_wide').notNull(),
  branchId: uuid('branch_id'),
  treasuryUnitId: uuid('treasury_unit_id'),
  currency: varchar('currency', { length: 8 }),
  methodCategory: varchar('method_category', { length: 32 }),
  minimumBaseAmount: numeric('minimum_base_amount', { precision: 38, scale: 8 }),
  maximumBaseAmount: numeric('maximum_base_amount', { precision: 38, scale: 8 }),
  separationRules: jsonb('separation_rules').$type<string[]>().notNull().default([]),
  aggregationWindowKind: varchar('aggregation_window_kind', { length: 16 }),
  aggregationKeys: jsonb('aggregation_keys').$type<string[]>(),
  aggregationOverrideSecondApproval: boolean('aggregation_override_second_approval'),
  state: varchar('state', { length: 16 }).notNull().default('ACTIVE'),
  policyVersion: integer('policy_version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.documentType, table.code, table.policyVersion),
  foreignKey({ columns: [table.organizationId, table.branchId], foreignColumns: [branches.organizationId, branches.id], name: 'approval_policies_branch_fk' }),
  foreignKey({ columns: [table.organizationId, table.treasuryUnitId], foreignColumns: [treasuryUnits.organizationId, treasuryUnits.id], name: 'approval_policies_treasury_unit_fk' }),
  foreignKey({ columns: [table.organizationId, table.currency], foreignColumns: [currencies.organizationId, currencies.code], name: 'approval_policies_currency_fk' }),
  check('approval_policies_scope_check', sql`${table.organizationWide} <> (${table.branchId} IS NOT NULL OR ${table.treasuryUnitId} IS NOT NULL OR ${table.currency} IS NOT NULL OR ${table.methodCategory} IS NOT NULL OR ${table.minimumBaseAmount} IS NOT NULL OR ${table.maximumBaseAmount} IS NOT NULL)`),
  check('approval_policies_amount_check', sql`(${table.minimumBaseAmount} IS NULL OR ${table.minimumBaseAmount} >= 0) AND (${table.maximumBaseAmount} IS NULL OR ${table.maximumBaseAmount} >= 0) AND (${table.maximumBaseAmount} IS NULL OR ${table.minimumBaseAmount} IS NULL OR ${table.maximumBaseAmount} >= ${table.minimumBaseAmount})`),
  check('approval_policies_state_check', sql`${table.state} IN ('DRAFT', 'ACTIVE', 'RETIRED')`),
  check('approval_policies_version_check', sql`${table.policyVersion} > 0`),
]);

export const approvalSteps = pgTable('approval_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  approvalPolicyId: uuid('approval_policy_id').notNull(),
  stepOrder: integer('step_order').notNull(),
  requiredRoleId: uuid('required_role_id'),
  namedApproverId: uuid('named_approver_id'),
  approvalsRequired: integer('approvals_required').notNull(),
  separationRules: jsonb('separation_rules').$type<string[]>().notNull().default([]),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.approvalPolicyId, table.stepOrder),
  foreignKey({ columns: [table.organizationId, table.approvalPolicyId], foreignColumns: [approvalPolicies.organizationId, approvalPolicies.id], name: 'approval_steps_policy_fk' }),
  foreignKey({ columns: [table.organizationId, table.requiredRoleId], foreignColumns: [roles.organizationId, roles.id], name: 'approval_steps_role_fk' }),
  foreignKey({ columns: [table.organizationId, table.namedApproverId], foreignColumns: [userRefs.organizationId, userRefs.id], name: 'approval_steps_approver_fk' }),
  check('approval_steps_order_check', sql`${table.stepOrder} > 0`),
  check('approval_steps_required_check', sql`${table.approvalsRequired} > 0`),
  check('approval_steps_subject_check', sql`(${table.requiredRoleId} IS NOT NULL) <> (${table.namedApproverId} IS NOT NULL)`),
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
      'EXECUTED', 'ACCOUNTING_READY', 'ACCOUNTING_POSTED', 'CANCELLED', 'REVERSED'
    )`,
  ),
  check(
    'receipt_documents_workflow_state_check',
    sql`${table.workflowState} IN (
      'DRAFT', 'SUBMITTED', 'APPROVAL_PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'
    )`,
  ),
  check(
    'receipt_documents_snapshot_state_check',
    sql`(${table.state} = 'DRAFT' AND ${table.currentApprovalSnapshotId} IS NULL)
      OR (${table.state} = 'CANCELLED' AND ${table.reversesReceiptId} IS NULL)
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
  check('movement_facts_endpoint_type_check', sql`${table.endpointType} IN ('CASHBOX', 'BANK_ACCOUNT', 'USER')`),
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
  branchId: uuid('branch_id'),
  treasuryUnitId: uuid('treasury_unit_id').notNull(),
  channelType: varchar('channel_type', { length: 24 }).notNull(),
  channelId: uuid('channel_id'),
  providerReference: varchar('provider_reference', { length: 128 }),
  collectedPartyId: uuid('collected_party_id'),
  grossAmount: numeric('gross_amount', { precision: 38, scale: 8 }).notNull(),
  currency: varchar('currency', { length: 8 }).notNull(),
  allocatedAmount: numeric('allocated_amount', { precision: 38, scale: 8 }).notNull().default('0'),
  remainingAmount: numeric('remaining_amount', { precision: 38, scale: 8 }).notNull(),
  destinationBankAccountId: uuid('destination_bank_account_id').notNull(),
  collectedAt: timestamp('collected_at', { withTimezone: true }).notNull(),
  expectedSettlementDate: date('expected_settlement_date').notNull(),
  state: varchar('state', { length: 32 }).notNull().default('OPEN'),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.sourceFactType, table.sourceFactId),
  foreignKey({
    columns: [table.organizationId, table.branchId],
    foreignColumns: [branches.organizationId, branches.id],
    name: 'collection_items_branch_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.treasuryUnitId],
    foreignColumns: [treasuryUnits.organizationId, treasuryUnits.id],
    name: 'collection_items_treasury_unit_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.collectedPartyId],
    foreignColumns: [parties.organizationId, parties.id],
    name: 'collection_items_collected_party_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.destinationBankAccountId],
    foreignColumns: [bankAccounts.organizationId, bankAccounts.id],
    name: 'collection_items_destination_account_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.currency],
    foreignColumns: [currencies.organizationId, currencies.code],
    name: 'collection_items_currency_fk',
  }),
  check(
    'collection_items_source_type_check',
    sql`${table.sourceFactType} IN ('RECEIPT_LINE', 'CHEQUE_EVENT')`,
  ),
  check(
    'collection_items_channel_type_check',
    sql`${table.channelType} IN (
      'BANK_TRANSFER', 'DIRECT_DEPOSIT', 'POS', 'GATEWAY',
      'CARD_TRANSFER', 'WALLET', 'FOREIGN_REMITTANCE', 'DEPOSITED_CHEQUE'
    )`,
  ),
  check(
    'collection_items_state_check',
    sql`${table.state} IN (
      'OPEN', 'PARTIALLY_ALLOCATED', 'ALLOCATED', 'SETTLED',
      'REOPENED_AFTER_REVERSAL', 'DELAYED', 'DISPUTED',
      'RETURNED', 'CANCELLED'
    )`,
  ),
  check('collection_items_gross_positive', sql`${table.grossAmount} > 0`),
  check('collection_items_allocated_nonnegative', sql`${table.allocatedAmount} >= 0`),
  check('collection_items_remaining_nonnegative', sql`${table.remainingAmount} >= 0`),
  check(
    'collection_items_money_balance',
    sql`${table.allocatedAmount} + ${table.remainingAmount} = ${table.grossAmount}`,
  ),
  check(
    'collection_items_state_money_shape',
    sql`(
      ${table.state} IN ('OPEN', 'REOPENED_AFTER_REVERSAL')
      AND ${table.allocatedAmount} = 0
      AND ${table.remainingAmount} = ${table.grossAmount}
    ) OR (
      ${table.state} = 'PARTIALLY_ALLOCATED'
      AND ${table.allocatedAmount} > 0
      AND ${table.remainingAmount} > 0
    ) OR (
      ${table.state} IN ('ALLOCATED', 'SETTLED')
      AND ${table.allocatedAmount} = ${table.grossAmount}
      AND ${table.remainingAmount} = 0
    ) OR ${table.state} IN ('DELAYED', 'DISPUTED', 'RETURNED', 'CANCELLED')`,
  ),
  check('collection_items_version_nonnegative', sql`${table.version} >= 0`),
  uniqueIndex('uq_collection_item_provider_reference')
    .on(
      table.organizationId,
      table.channelType,
      sql`(
        CASE
          WHEN ${table.channelId} IS NOT NULL
            THEN 'CHANNEL:' || ${table.channelId}::text
          ELSE 'BANK_ACCOUNT:' || ${table.destinationBankAccountId}::text
        END
      )`,
      table.providerReference,
    )
    .where(sql`${table.providerReference} IS NOT NULL`),
  index('collection_items_queue_idx').on(
    table.organizationId,
    table.collectedAt.desc(),
    table.id.desc(),
  ),
]);

export const settlementBatches = pgTable('settlement_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  businessNumber: varchar('business_number', { length: 64 }).notNull(),
  destinationBankAccountId: uuid('destination_bank_account_id').notNull(),
  bankStatementLineId: uuid('bank_statement_line_id'),
  providerReference: varchar('provider_reference', { length: 128 }),
  settlementDate: date('settlement_date').notNull(),
  matchKind: varchar('match_kind', { length: 16 }),
  matchRuleId: varchar('match_rule_id', { length: 128 }),
  matchRuleVersion: varchar('match_rule_version', { length: 64 }),
  manualMatchReason: varchar('manual_match_reason', { length: 500 }),
  currency: varchar('currency', { length: 8 }).notNull(),
  grossAmount: numeric('gross_amount', { precision: 38, scale: 8 }).notNull(),
  feeAmount: numeric('fee_amount', { precision: 38, scale: 8 }).notNull().default('0'),
  deductionAmount: numeric('deduction_amount', { precision: 38, scale: 8 }).notNull().default('0'),
  expectedNetAmount: numeric('expected_net_amount', { precision: 38, scale: 8 }).notNull(),
  actualNetAmount: numeric('actual_net_amount', { precision: 38, scale: 8 }).notNull(),
  discrepancyAmount: numeric('discrepancy_amount', { precision: 38, scale: 8 }).notNull(),
  discrepancyDisposition: varchar('discrepancy_disposition', { length: 32 }).notNull(),
  discrepancyReason: varchar('discrepancy_reason', { length: 500 }),
  creatorUserId: uuid('creator_user_id').notNull(),
  confirmedBy: uuid('confirmed_by'),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  reversedBy: uuid('reversed_by'),
  reversedAt: timestamp('reversed_at', { withTimezone: true }),
  reversalOfBatchId: uuid('reversal_of_batch_id'),
  replacementForBatchId: uuid('replacement_for_batch_id'),
  reversalReason: varchar('reversal_reason', { length: 500 }),
  state: varchar('state', { length: 32 }).notNull(),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.businessNumber),
  unique().on(table.organizationId, table.reversalOfBatchId),
  unique().on(table.organizationId, table.replacementForBatchId),
  foreignKey({
    columns: [table.organizationId, table.destinationBankAccountId],
    foreignColumns: [bankAccounts.organizationId, bankAccounts.id],
    name: 'settlement_batches_destination_account_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.currency],
    foreignColumns: [currencies.organizationId, currencies.code],
    name: 'settlement_batches_currency_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.creatorUserId],
    foreignColumns: [userRefs.organizationId, userRefs.id],
    name: 'settlement_batches_creator_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.confirmedBy],
    foreignColumns: [userRefs.organizationId, userRefs.id],
    name: 'settlement_batches_confirmer_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.reversedBy],
    foreignColumns: [userRefs.organizationId, userRefs.id],
    name: 'settlement_batches_reverser_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.reversalOfBatchId],
    foreignColumns: [table.organizationId, table.id],
    name: 'settlement_batches_reversal_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.replacementForBatchId],
    foreignColumns: [table.organizationId, table.id],
    name: 'settlement_batches_replacement_fk',
  }),
  check('settlement_batches_gross_positive', sql`${table.grossAmount} > 0`),
  check('settlement_batches_fee_nonnegative', sql`${table.feeAmount} >= 0`),
  check('settlement_batches_deduction_nonnegative', sql`${table.deductionAmount} >= 0`),
  check('settlement_batches_net_positive', sql`${table.expectedNetAmount} > 0 AND ${table.actualNetAmount} > 0`),
  check('settlement_batches_expected_net', sql`${table.expectedNetAmount} = ${table.grossAmount} - ${table.feeAmount} - ${table.deductionAmount}`),
  check('settlement_batches_discrepancy', sql`${table.discrepancyAmount} = ${table.actualNetAmount} - ${table.expectedNetAmount}`),
  check('settlement_batches_version_nonnegative', sql`${table.version} >= 0`),
  check(
    'settlement_batches_discrepancy_shape',
    sql`(${table.discrepancyAmount} = 0
      AND ${table.discrepancyDisposition} = 'NONE'
      AND ${table.discrepancyReason} IS NULL)
      OR (${table.discrepancyAmount} <> 0
        AND ${table.discrepancyDisposition} IN ('OPEN', 'APPROVED_DIFFERENCE', 'CORRECTION_REQUIRED', 'RETURNED')
        AND NULLIF(BTRIM(${table.discrepancyReason}), '') IS NOT NULL)`,
  ),
  check(
    'settlement_batches_match_shape',
    sql`(${table.state} = 'REVERSAL'
      AND ${table.matchKind} IS NULL
      AND ${table.matchRuleId} IS NULL
      AND ${table.matchRuleVersion} IS NULL
      AND ${table.manualMatchReason} IS NULL)
      OR (${table.state} <> 'REVERSAL'
        AND ${table.matchKind} = 'DETERMINISTIC'
        AND NULLIF(BTRIM(${table.matchRuleId}), '') IS NOT NULL
        AND NULLIF(BTRIM(${table.matchRuleVersion}), '') IS NOT NULL
        AND ${table.manualMatchReason} IS NULL)
      OR (${table.state} <> 'REVERSAL'
        AND ${table.matchKind} = 'MANUAL'
        AND ${table.matchRuleId} IS NULL
        AND ${table.matchRuleVersion} IS NULL
        AND NULLIF(BTRIM(${table.manualMatchReason}), '') IS NOT NULL)`,
  ),
  check(
    'settlement_batches_custody_separation',
    sql`(${table.confirmedBy} IS NULL OR ${table.confirmedBy} <> ${table.creatorUserId})
      AND (${table.reversedBy} IS NULL
        OR (${table.reversedBy} <> ${table.creatorUserId}
          AND ${table.reversedBy} <> ${table.confirmedBy}))`,
  ),
  check(
    'settlement_batches_state_shape',
    sql`(${table.state} = 'MATCHED'
      AND ${table.discrepancyAmount} = 0
      AND ${table.confirmedBy} IS NULL AND ${table.confirmedAt} IS NULL
      AND ${table.reversedBy} IS NULL AND ${table.reversedAt} IS NULL)
      OR (${table.state} = 'DISCREPANCY'
        AND ${table.discrepancyAmount} <> 0
        AND ${table.confirmedBy} IS NULL AND ${table.confirmedAt} IS NULL
        AND ${table.reversedBy} IS NULL AND ${table.reversedAt} IS NULL)
      OR (${table.state} = 'CONFIRMED'
        AND ${table.confirmedBy} IS NOT NULL AND ${table.confirmedAt} IS NOT NULL
        AND ${table.reversedBy} IS NULL AND ${table.reversedAt} IS NULL
        AND (${table.discrepancyAmount} = 0 OR ${table.discrepancyDisposition} = 'APPROVED_DIFFERENCE'))
      OR (${table.state} = 'REVERSED'
        AND ${table.confirmedBy} IS NOT NULL AND ${table.confirmedAt} IS NOT NULL
        AND ${table.reversedBy} IS NOT NULL AND ${table.reversedAt} IS NOT NULL
        AND (${table.discrepancyAmount} = 0 OR ${table.discrepancyDisposition} = 'APPROVED_DIFFERENCE'))
      OR (${table.state} = 'REVERSAL'
        AND ${table.reversalOfBatchId} IS NOT NULL
        AND NULLIF(BTRIM(${table.reversalReason}), '') IS NOT NULL
        AND ${table.confirmedBy} IS NULL AND ${table.confirmedAt} IS NULL
        AND ${table.reversedBy} IS NULL AND ${table.reversedAt} IS NULL)`,
  ),
]);

export const settlementAllocations = pgTable('settlement_allocations', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  settlementBatchId: uuid('settlement_batch_id').notNull(),
  collectionItemId: uuid('collection_item_id').notNull(),
  collectionItemVersion: bigint('collection_item_version', { mode: 'number' }).notNull(),
  allocatedAmount: numeric('allocated_amount', { precision: 38, scale: 8 }).notNull(),
  currency: varchar('currency', { length: 8 }).notNull(),
  state: varchar('state', { length: 16 }).notNull(),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.settlementBatchId, table.collectionItemId),
  foreignKey({
    columns: [table.organizationId, table.settlementBatchId],
    foreignColumns: [settlementBatches.organizationId, settlementBatches.id],
    name: 'settlement_allocations_batch_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.collectionItemId],
    foreignColumns: [collectionItems.organizationId, collectionItems.id],
    name: 'settlement_allocations_item_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.currency],
    foreignColumns: [currencies.organizationId, currencies.code],
    name: 'settlement_allocations_currency_fk',
  }),
  check('settlement_allocations_version_nonnegative', sql`${table.collectionItemVersion} >= 0 AND ${table.version} >= 0`),
  check('settlement_allocations_amount_positive', sql`${table.allocatedAmount} > 0`),
]);

export const settlementAttachmentLinks = pgTable('settlement_attachment_links', {
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  settlementBatchId: uuid('settlement_batch_id').notNull(),
  attachmentId: uuid('attachment_id').notNull(),
  contentDigest: char('content_digest', { length: 64 }).notNull(),
  purpose: varchar('purpose', { length: 64 }).notNull(),
  linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.settlementBatchId, table.attachmentId] }),
  foreignKey({
    columns: [table.organizationId, table.settlementBatchId],
    foreignColumns: [settlementBatches.organizationId, settlementBatches.id],
    name: 'settlement_attachment_links_batch_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.attachmentId, table.contentDigest],
    foreignColumns: [attachments.organizationId, attachments.id, attachments.contentDigest],
    name: 'settlement_attachment_links_attachment_fk',
  }),
  check('settlement_attachment_links_purpose', sql`${table.purpose} = 'BANK_CREDIT_EVIDENCE'`),
  check('settlement_attachment_links_digest', sql`${table.contentDigest} ~ '^[a-f0-9]{64}$'`),
]);

export const settlementEffects = pgTable('settlement_effects', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  settlementBatchId: uuid('settlement_batch_id').notNull(),
  effectKey: varchar('effect_key', { length: 64 }).notNull(),
  effectType: varchar('effect_type', { length: 40 }).notNull(),
  direction: varchar('direction', { length: 16 }).notNull(),
  amount: numeric('amount', { precision: 38, scale: 8 }).notNull(),
  currency: varchar('currency', { length: 8 }).notNull(),
  businessDate: date('business_date').notNull(),
  sourceVersion: bigint('source_version', { mode: 'number' }).notNull(),
  movementFactId: uuid('movement_fact_id'),
  collectionItemId: uuid('collection_item_id'),
  reversalOfEffectId: uuid('reversal_of_effect_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(
    table.organizationId,
    table.id,
    table.effectType,
    table.currency,
    table.amount,
  ),
  unique().on(table.organizationId, table.settlementBatchId, table.effectKey, table.direction),
  unique().on(table.organizationId, table.reversalOfEffectId),
  unique().on(table.organizationId, table.movementFactId),
  foreignKey({
    columns: [table.organizationId, table.settlementBatchId],
    foreignColumns: [settlementBatches.organizationId, settlementBatches.id],
    name: 'settlement_effects_batch_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.collectionItemId],
    foreignColumns: [collectionItems.organizationId, collectionItems.id],
    name: 'settlement_effects_collection_item_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.currency],
    foreignColumns: [currencies.organizationId, currencies.code],
    name: 'settlement_effects_currency_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.movementFactId],
    foreignColumns: [movementFacts.organizationId, movementFacts.id],
    name: 'settlement_effects_movement_fk',
  }),
  foreignKey({
    columns: [
      table.organizationId,
      table.reversalOfEffectId,
      table.effectType,
      table.currency,
      table.amount,
    ],
    foreignColumns: [
      table.organizationId,
      table.id,
      table.effectType,
      table.currency,
      table.amount,
    ],
    name: 'settlement_effects_reversal_fk',
  }),
  check(
    'settlement_effects_source_version',
    sql`(${table.direction} = 'SETTLEMENT' AND ${table.sourceVersion} > 0)
      OR (${table.direction} = 'REVERSAL' AND ${table.sourceVersion} = 0)`,
  ),
  check(
    'settlement_effects_shape',
    sql`(${table.effectType} = 'BANK_CREDIT'
      AND ${table.movementFactId} IS NOT NULL
      AND ${table.collectionItemId} IS NULL)
      OR (${table.effectType} = 'ALLOCATION_CONSUMPTION'
        AND ${table.movementFactId} IS NULL
        AND ${table.collectionItemId} IS NOT NULL)
      OR (${table.effectType} IN ('FEE_EVIDENCE', 'DEDUCTION_EVIDENCE', 'APPROVED_DISCREPANCY_EVIDENCE')
        AND ${table.movementFactId} IS NULL
        AND ${table.collectionItemId} IS NULL)`,
  ),
  check(
    'settlement_effects_direction',
    sql`(${table.direction} = 'SETTLEMENT' AND ${table.reversalOfEffectId} IS NULL)
      OR (${table.direction} = 'REVERSAL' AND ${table.reversalOfEffectId} IS NOT NULL)`,
  ),
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

export const paymentRequestNumberCounters = pgTable('payment_request_number_counters', {
  organizationId: uuid('organization_id').primaryKey().references(() => organizations.id),
  nextValue: bigint('next_value', { mode: 'number' }).notNull().default(1),
}, (table) => [check('payment_request_number_counters_positive', sql`${table.nextValue} > 0`)]);

export const paymentNumberCounters = pgTable('payment_number_counters', {
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  businessDate: date('business_date').notNull(),
  nextValue: bigint('next_value', { mode: 'number' }).notNull().default(1),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.businessDate] }),
  check('payment_number_counters_positive', sql`${table.nextValue} > 0`),
]);

export const paymentRequests = pgTable('payment_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  businessNumber: varchar('business_number', { length: 64 }).notNull(),
  requesterUserId: uuid('requester_user_id').notNull(),
  beneficiaryPartyId: uuid('beneficiary_party_id').notNull(),
  requestedAmount: numeric('requested_amount', { precision: 38, scale: 8 }).notNull(),
  currency: varchar('currency', { length: 8 }).notNull(),
  branchId: uuid('branch_id'),
  treasuryUnitId: uuid('treasury_unit_id'),
  dueDate: date('due_date'),
  purpose: varchar('purpose', { length: 1000 }).notNull(),
  contractRef: varchar('contract_ref', { length: 128 }),
  invoiceRef: varchar('invoice_ref', { length: 128 }),
  accountingDimensions: jsonb('accounting_dimensions').$type<Record<string, string>>(),
  approvalProgress: jsonb('approval_progress')
    .$type<{ state: 'NOT_STARTED'; completedSteps: 0; requiredSteps: 0 }>()
    .notNull()
    .default({ state: 'NOT_STARTED', completedSteps: 0, requiredSteps: 0 }),
  state: varchar('state', { length: 32 }).notNull().default('DRAFT'),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.businessNumber),
  unique().on(table.organizationId, table.id),
  foreignKey({
    columns: [table.organizationId, table.requesterUserId],
    foreignColumns: [userRefs.organizationId, userRefs.id],
    name: 'payment_requests_requester_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.beneficiaryPartyId],
    foreignColumns: [parties.organizationId, parties.id],
    name: 'payment_requests_beneficiary_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.branchId],
    foreignColumns: [branches.organizationId, branches.id],
    name: 'payment_requests_branch_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.treasuryUnitId],
    foreignColumns: [treasuryUnits.organizationId, treasuryUnits.id],
    name: 'payment_requests_treasury_unit_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.currency],
    foreignColumns: [currencies.organizationId, currencies.code],
    name: 'payment_requests_currency_fk',
  }),
  check('payment_requests_amount_positive', sql`${table.requestedAmount} > 0`),
  check('payment_requests_approval_progress_initial', sql`${table.approvalProgress} = '{"state":"NOT_STARTED","completedSteps":0,"requiredSteps":0}'::jsonb`),
  check('payment_requests_state_check', sql`${table.state} = 'DRAFT'`),
  check('payment_requests_version_nonnegative', sql`${table.version} >= 0`),
]);

export const paymentDocuments = pgTable('payment_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  businessNumber: varchar('business_number', { length: 64 }).notNull(),
  businessDate: date('business_date').notNull(),
  beneficiaryPartyId: uuid('beneficiary_party_id').notNull(),
  paymentRequestId: uuid('payment_request_id'),
  branchId: uuid('branch_id'),
  treasuryUnitId: uuid('treasury_unit_id').notNull(),
  baseCurrency: varchar('base_currency', { length: 8 }).notNull(),
  totalBaseAmount: numeric('total_base_amount', { precision: 38, scale: 8 }).notNull(),
  dueDate: date('due_date'),
  purpose: varchar('purpose', { length: 1000 }).notNull(),
  creatorUserId: uuid('creator_user_id').notNull(),
  currentApprovalSnapshotId: uuid('current_approval_snapshot_id'),
  reversedPaymentId: uuid('reversed_payment_id'),
  executedAt: timestamp('executed_at', { withTimezone: true }),
  executedByUserId: uuid('executed_by_user_id'),
  state: varchar('state', { length: 32 }).notNull().default('DRAFT'),
  workflowState: varchar('workflow_state', { length: 24 }).notNull().default('DRAFT'),
  executionState: varchar('execution_state', { length: 24 }).notNull().default('NOT_EXECUTED'),
  accountingState: varchar('accounting_state', { length: 24 }).notNull().default('NOT_READY'),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.businessNumber),
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.id, table.baseCurrency),
  foreignKey({
    columns: [table.organizationId, table.beneficiaryPartyId],
    foreignColumns: [parties.organizationId, parties.id],
    name: 'payment_documents_beneficiary_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.paymentRequestId],
    foreignColumns: [paymentRequests.organizationId, paymentRequests.id],
    name: 'payment_documents_request_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.branchId],
    foreignColumns: [branches.organizationId, branches.id],
    name: 'payment_documents_branch_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.treasuryUnitId],
    foreignColumns: [treasuryUnits.organizationId, treasuryUnits.id],
    name: 'payment_documents_treasury_unit_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.baseCurrency],
    foreignColumns: [currencies.organizationId, currencies.code],
    name: 'payment_documents_currency_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.creatorUserId],
    foreignColumns: [userRefs.organizationId, userRefs.id],
    name: 'payment_documents_creator_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.reversedPaymentId],
    foreignColumns: [table.organizationId, table.id],
    name: 'payment_documents_reversal_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.executedByUserId],
    foreignColumns: [userRefs.organizationId, userRefs.id],
    name: 'payment_documents_executor_fk',
  }),
  check('payment_documents_total_positive', sql`${table.totalBaseAmount} > 0`),
  check(
    'payment_documents_state_check',
    sql`${table.state} IN ('DRAFT', 'SUBMITTED', 'APPROVAL_PENDING', 'APPROVED', 'REJECTED', 'SCHEDULED', 'EXECUTED', 'ACCOUNTING_READY', 'ACCOUNTING_POSTED', 'CANCELLED', 'REVERSED')`,
  ),
  check(
    'payment_documents_workflow_state_check',
    sql`${table.workflowState} IN ('DRAFT', 'SUBMITTED', 'APPROVAL_PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')`,
  ),
  check(
    'payment_documents_workflow_matches_state',
    sql`(${table.state} IN ('DRAFT', 'SUBMITTED', 'APPROVAL_PENDING', 'APPROVED', 'REJECTED') AND ${table.workflowState} = ${table.state})
      OR (${table.state} NOT IN ('DRAFT', 'SUBMITTED', 'APPROVAL_PENDING', 'APPROVED', 'REJECTED') AND ${table.workflowState} = 'APPROVED')`,
  ),
  check(
    'payment_documents_snapshot_state_check',
    sql`(${table.state} = 'DRAFT' AND ${table.currentApprovalSnapshotId} IS NULL)
      OR (${table.state} IN ('SUBMITTED', 'APPROVAL_PENDING', 'APPROVED', 'REJECTED', 'SCHEDULED') AND ${table.currentApprovalSnapshotId} IS NOT NULL)
      OR (${table.state} IN ('EXECUTED', 'ACCOUNTING_READY', 'ACCOUNTING_POSTED', 'CANCELLED', 'REVERSED'))`,
  ),
  check('payment_documents_execution_state_check', sql`${table.executionState} IN ('NOT_EXECUTED', 'SCHEDULED', 'EXECUTED', 'REVERSED')`),
  check('payment_documents_accounting_state_check', sql`${table.accountingState} IN ('NOT_READY', 'MAPPING_REQUIRED', 'READY', 'QUEUED', 'SENDING', 'SENDING_UNKNOWN', 'ACCEPTED', 'FAILED', 'RETURNED', 'CORRECTED')`),
  check(
    'payment_documents_execution_evidence_check',
    sql`(${table.executionState} IN ('EXECUTED', 'REVERSED') AND ${table.executedAt} IS NOT NULL AND ${table.executedByUserId} IS NOT NULL)
      OR (${table.executionState} NOT IN ('EXECUTED', 'REVERSED') AND ${table.executedAt} IS NULL AND ${table.executedByUserId} IS NULL)`,
  ),
  check('payment_documents_version_nonnegative', sql`${table.version} >= 0`),
  index('payment_documents_list_idx').on(
    table.organizationId,
    table.businessDate.desc(),
    table.id.desc(),
  ),
]);

export const paymentApprovalPolicies = pgTable('payment_approval_policies', {
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
  aggregationWindowKind: varchar('aggregation_window_kind', { length: 16 }),
  aggregationKeys: varchar('aggregation_keys', { length: 64 }).array().notNull().default([]),
  version: integer('version').notNull(),
  state: varchar('state', { length: 16 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.code, table.version),
  foreignKey({
    columns: [table.organizationId, table.branchId],
    foreignColumns: [branches.organizationId, branches.id],
    name: 'payment_approval_policies_branch_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.treasuryUnitId],
    foreignColumns: [treasuryUnits.organizationId, treasuryUnits.id],
    name: 'payment_approval_policies_treasury_unit_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.currency],
    foreignColumns: [currencies.organizationId, currencies.code],
    name: 'payment_approval_policies_currency_fk',
  }),
  index('payment_approval_policy_selection_idx').on(
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

export const paymentApprovalPolicySteps = pgTable('payment_approval_policy_steps', {
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
    foreignColumns: [paymentApprovalPolicies.organizationId, paymentApprovalPolicies.id],
    name: 'payment_approval_policy_steps_policy_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.roleId],
    foreignColumns: [roles.organizationId, roles.id],
    name: 'payment_approval_policy_steps_role_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.approverUserId],
    foreignColumns: [userRefs.organizationId, userRefs.id],
    name: 'payment_approval_policy_steps_approver_fk',
  }),
]);

export const paymentApprovalSnapshots = pgTable('payment_approval_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  paymentDocumentId: uuid('payment_document_id').notNull(),
  documentVersion: bigint('document_version', { mode: 'number' }).notNull(),
  amountBasis: numeric('amount_basis', { precision: 38, scale: 8 }).notNull(),
  baseCurrency: varchar('base_currency', { length: 8 }).notNull(),
  evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.paymentDocumentId, table.id),
  foreignKey({
    columns: [table.organizationId, table.paymentDocumentId, table.baseCurrency],
    foreignColumns: [paymentDocuments.organizationId, paymentDocuments.id, paymentDocuments.baseCurrency],
    name: 'payment_approval_snapshots_document_fk',
  }),
]);

export const paymentApprovalSnapshotContexts = pgTable('payment_approval_snapshot_contexts', {
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
    foreignColumns: [paymentApprovalSnapshots.organizationId, paymentApprovalSnapshots.id],
    name: 'payment_approval_snapshot_contexts_snapshot_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.policyId],
    foreignColumns: [paymentApprovalPolicies.organizationId, paymentApprovalPolicies.id],
    name: 'payment_approval_snapshot_contexts_policy_fk',
  }),
]);

export const paymentApprovalSnapshotSteps = pgTable('payment_approval_snapshot_steps', {
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
    foreignColumns: [paymentApprovalSnapshots.organizationId, paymentApprovalSnapshots.id],
    name: 'payment_approval_snapshot_steps_snapshot_fk',
  }),
]);

export const paymentApprovalActions = pgTable('payment_approval_actions', {
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
    foreignColumns: [paymentApprovalSnapshots.organizationId, paymentApprovalSnapshots.id],
    name: 'payment_approval_actions_snapshot_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.approvalSnapshotId, table.approvalSnapshotStepId],
    foreignColumns: [
      paymentApprovalSnapshotSteps.organizationId,
      paymentApprovalSnapshotSteps.approvalSnapshotId,
      paymentApprovalSnapshotSteps.id,
    ],
    name: 'payment_approval_actions_step_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.actorUserId],
    foreignColumns: [userRefs.organizationId, userRefs.id],
    name: 'payment_approval_actions_actor_fk',
  }),
]);

export const paymentApprovalAggregations = pgTable('payment_approval_aggregations', {
  organizationId: uuid('organization_id').notNull(),
  approvalSnapshotId: uuid('approval_snapshot_id').notNull(),
  businessDate: date('business_date').notNull(),
  aggregationKeys: varchar('aggregation_keys', { length: 64 }).array().notNull(),
  beneficiaryPartyId: uuid('beneficiary_party_id'),
  externalObligationKey: text('external_obligation_key'),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.approvalSnapshotId] }),
  foreignKey({
    columns: [table.organizationId, table.approvalSnapshotId],
    foreignColumns: [paymentApprovalSnapshots.organizationId, paymentApprovalSnapshots.id],
    name: 'payment_approval_aggregations_snapshot_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.beneficiaryPartyId],
    foreignColumns: [parties.organizationId, parties.id],
    name: 'payment_approval_aggregations_beneficiary_fk',
  }),
]);

export const paymentApprovalAggregationParticipants = pgTable(
  'payment_approval_aggregation_participants',
  {
    organizationId: uuid('organization_id').notNull(),
    approvalSnapshotId: uuid('approval_snapshot_id').notNull(),
    paymentDocumentId: uuid('payment_document_id').notNull(),
    paymentNumber: varchar('payment_number', { length: 64 }).notNull(),
    versionBasis: varchar('version_basis', { length: 24 }).notNull(),
    paymentVersion: bigint('payment_version', { mode: 'number' }).notNull(),
    baseAmount: numeric('base_amount', { precision: 38, scale: 8 }).notNull(),
    baseCurrency: varchar('base_currency', { length: 8 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.approvalSnapshotId, table.paymentDocumentId] }),
    foreignKey({
      columns: [table.organizationId, table.approvalSnapshotId],
      foreignColumns: [paymentApprovalAggregations.organizationId, paymentApprovalAggregations.approvalSnapshotId],
      name: 'payment_approval_aggregation_participants_aggregation_fk',
    }),
    foreignKey({
      columns: [table.organizationId, table.paymentDocumentId, table.baseCurrency],
      foreignColumns: [paymentDocuments.organizationId, paymentDocuments.id, paymentDocuments.baseCurrency],
      name: 'payment_approval_aggregation_participants_payment_fk',
    }),
  ],
);

export const paymentLines = pgTable('payment_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  paymentDocumentId: uuid('payment_document_id').notNull(),
  lineNumber: integer('line_number').notNull(),
  methodId: uuid('method_id').notNull(),
  methodName: varchar('method_name', { length: 160 }).notNull(),
  methodCategory: varchar('method_category', { length: 32 }).notNull(),
  methodRequiredReferences: jsonb('method_required_references').$type<string[]>().notNull(),
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
  roundingDifference: numeric('rounding_difference', { precision: 38, scale: 8 }).notNull().default('0'),
  cashboxId: uuid('cashbox_id'),
  bankAccountId: uuid('bank_account_id'),
  beneficiaryPartyId: uuid('beneficiary_party_id').notNull(),
  beneficiaryAccountReference: varchar('beneficiary_account_reference', { length: 128 }),
  trackingNumber: varchar('tracking_number', { length: 128 }),
  dueDate: date('due_date'),
  description: varchar('description', { length: 1000 }),
  accountingDimensions: jsonb('accounting_dimensions').$type<Record<string, string>>(),
  executedAt: timestamp('executed_at', { withTimezone: true }),
  executedByUserId: uuid('executed_by_user_id'),
  state: varchar('state', { length: 16 }).notNull().default('DRAFT'),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.paymentDocumentId, table.lineNumber),
  foreignKey({
    columns: [table.organizationId, table.paymentDocumentId, table.baseCurrency],
    foreignColumns: [paymentDocuments.organizationId, paymentDocuments.id, paymentDocuments.baseCurrency],
    name: 'payment_lines_document_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.methodId],
    foreignColumns: [methodDefinitions.organizationId, methodDefinitions.id],
    name: 'payment_lines_method_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.cashboxId],
    foreignColumns: [cashboxes.organizationId, cashboxes.id],
    name: 'payment_lines_cashbox_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.bankAccountId],
    foreignColumns: [bankAccounts.organizationId, bankAccounts.id],
    name: 'payment_lines_bank_account_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.beneficiaryPartyId],
    foreignColumns: [parties.organizationId, parties.id],
    name: 'payment_lines_beneficiary_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.currency],
    foreignColumns: [currencies.organizationId, currencies.code],
    name: 'payment_lines_currency_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.executedByUserId],
    foreignColumns: [userRefs.organizationId, userRefs.id],
    name: 'payment_lines_executor_fk',
  }),
  check('payment_lines_line_number_positive', sql`${table.lineNumber} > 0`),
  check('payment_lines_required_references_array', sql`jsonb_typeof(${table.methodRequiredReferences}) = 'array'`),
  check('payment_lines_amount_positive', sql`${table.amount} > 0`),
  check('payment_lines_exchange_rate_positive', sql`${table.exchangeRate} > 0`),
  check('payment_lines_base_amount_positive', sql`${table.baseAmount} > 0`),
  check('payment_lines_state_check', sql`${table.state} IN ('DRAFT', 'RESERVED', 'EXECUTED', 'REVERSED')`),
  check(
    'payment_lines_execution_evidence_check',
    sql`(${table.state} IN ('EXECUTED', 'REVERSED') AND ${table.executedAt} IS NOT NULL AND ${table.executedByUserId} IS NOT NULL)
      OR (${table.state} IN ('DRAFT', 'RESERVED') AND ${table.executedAt} IS NULL AND ${table.executedByUserId} IS NULL)`,
  ),
  check('payment_lines_version_nonnegative', sql`${table.version} >= 0`),
  check('payment_lines_rate_shape', sql`(
    ${table.rateSource} = 'IDENTITY'
    AND ${table.currency} = ${table.baseCurrency}
    AND ${table.exchangeRate} = 1
    AND ${table.rateRecordId} IS NULL
    AND ${table.roundingDifference} = 0
  ) OR (
    ${table.rateSource} = 'TABLE'
    AND ${table.currency} <> ${table.baseCurrency}
    AND ${table.rateRecordId} IS NOT NULL
  )`),
]);

export const paymentAllocations = pgTable('payment_allocations', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  paymentDocumentId: uuid('payment_document_id').notNull(),
  sourceNamespace: varchar('source_namespace', { length: 128 }).notNull(),
  externalObjectType: varchar('external_object_type', { length: 32 }).notNull(),
  externalObjectId: varchar('external_object_id', { length: 128 }).notNull(),
  allocatedAmount: numeric('allocated_amount', { precision: 38, scale: 8 }).notNull(),
  currency: varchar('currency', { length: 8 }).notNull(),
  knownObligationTotal: numeric('known_obligation_total', { precision: 38, scale: 8 }),
  duplicateOverrideReason: varchar('duplicate_override_reason', { length: 500 }),
  overrideApprovalActionId: uuid('override_approval_action_id'),
  state: varchar('state', { length: 16 }).notNull(),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(
    table.organizationId,
    table.paymentDocumentId,
    table.sourceNamespace,
    table.externalObjectType,
    table.externalObjectId,
  ),
  foreignKey({
    columns: [table.organizationId, table.paymentDocumentId],
    foreignColumns: [paymentDocuments.organizationId, paymentDocuments.id],
    name: 'payment_allocations_document_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.overrideApprovalActionId],
    foreignColumns: [paymentApprovalActions.organizationId, paymentApprovalActions.id],
    name: 'payment_allocations_override_action_fk',
  }),
  check('payment_allocations_external_type_check', sql`${table.externalObjectType} IN ('INVOICE', 'DEBT', 'CONTRACT_ITEM', 'OTHER_PAYABLE')`),
  check('payment_allocations_amount_positive', sql`${table.allocatedAmount} > 0`),
  check('payment_allocations_known_total_positive', sql`${table.knownObligationTotal} IS NULL OR ${table.knownObligationTotal} > 0`),
  check('payment_allocations_not_over_known_total', sql`${table.knownObligationTotal} IS NULL OR ${table.allocatedAmount} <= ${table.knownObligationTotal}`),
  check('payment_allocations_override_pair', sql`(${table.duplicateOverrideReason} IS NULL) = (${table.overrideApprovalActionId} IS NULL)`),
  check('payment_allocations_state_check', sql`${table.state} IN ('ACTIVE', 'REVERSED')`),
  check('payment_allocations_version_nonnegative', sql`${table.version} >= 0`),
  index('payment_allocations_obligation_idx').on(
    table.organizationId,
    table.sourceNamespace,
    table.externalObjectType,
    table.externalObjectId,
    table.currency,
    table.state,
  ),
]);

export const paymentReservations = pgTable('payment_reservations', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  paymentDocumentId: uuid('payment_document_id').notNull(),
  sourceType: varchar('source_type', { length: 16 }).notNull(),
  sourceId: uuid('source_id').notNull(),
  amount: numeric('amount', { precision: 38, scale: 8 }).notNull(),
  currency: varchar('currency', { length: 8 }).notNull(),
  reviewDueAt: timestamp('review_due_at', { withTimezone: true }).notNull(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  releaseReason: varchar('release_reason', { length: 500 }),
  state: varchar('state', { length: 24 }).notNull(),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(
    table.organizationId,
    table.paymentDocumentId,
    table.sourceType,
    table.sourceId,
    table.currency,
  ),
  foreignKey({
    columns: [table.organizationId, table.paymentDocumentId],
    foreignColumns: [paymentDocuments.organizationId, paymentDocuments.id],
    name: 'payment_reservations_document_fk',
  }),
  check('payment_reservations_source_type_check', sql`${table.sourceType} IN ('CASHBOX', 'BANK_ACCOUNT')`),
  check('payment_reservations_amount_positive', sql`${table.amount} > 0`),
  check('payment_reservations_state_check', sql`${table.state} IN ('ACTIVE', 'REVIEW_REQUIRED', 'CONSUMED', 'RELEASED')`),
  check('payment_reservations_version_nonnegative', sql`${table.version} >= 0`),
  index('payment_reservations_source_idx').on(
    table.organizationId,
    table.sourceType,
    table.sourceId,
    table.currency,
    table.state,
    table.reviewDueAt,
  ),
]);

export const bankInstructions = pgTable('bank_instructions', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  paymentLineId: uuid('payment_line_id').notNull(),
  bankAccountId: uuid('bank_account_id').notNull(),
  amount: numeric('amount', { precision: 38, scale: 8 }).notNull(),
  currency: varchar('currency', { length: 8 }).notNull(),
  beneficiaryAccountReference: varchar('beneficiary_account_reference', { length: 128 }).notNull(),
  localReference: varchar('local_reference', { length: 128 }).notNull(),
  statementLineId: uuid('statement_line_id'),
  correctionPaymentId: uuid('correction_payment_id'),
  outcomeReason: varchar('outcome_reason', { length: 500 }),
  outcomeEvidence: jsonb('outcome_evidence').$type<Record<string, unknown>>(),
  state: varchar('state', { length: 24 }).notNull().default('PENDING_CONFIRMATION'),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.paymentLineId),
  unique().on(table.organizationId, table.bankAccountId, table.localReference),
  foreignKey({
    columns: [table.organizationId, table.paymentLineId],
    foreignColumns: [paymentLines.organizationId, paymentLines.id],
    name: 'bank_instructions_payment_line_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.bankAccountId],
    foreignColumns: [bankAccounts.organizationId, bankAccounts.id],
    name: 'bank_instructions_bank_account_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.correctionPaymentId],
    foreignColumns: [paymentDocuments.organizationId, paymentDocuments.id],
    name: 'bank_instructions_correction_payment_fk',
  }),
  check('bank_instructions_amount_positive', sql`${table.amount} > 0`),
  check('bank_instructions_state_check', sql`${table.state} IN ('PENDING_CONFIRMATION', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'RETURNED')`),
  check('bank_instructions_version_nonnegative', sql`${table.version} >= 0`),
  check(
    'bank_instructions_outcome_shape',
    sql`(${table.state} = 'PENDING_CONFIRMATION'
      AND ${table.statementLineId} IS NULL
      AND ${table.correctionPaymentId} IS NULL
      AND ${table.outcomeReason} IS NULL
      AND ${table.outcomeEvidence} IS NULL)
      OR (${table.state} <> 'PENDING_CONFIRMATION'
        AND ${table.outcomeEvidence} IS NOT NULL
        AND jsonb_typeof(${table.outcomeEvidence}) = 'object')`,
  ),
  index('bank_instructions_account_idx').on(
    table.organizationId,
    table.bankAccountId,
    table.state,
    table.createdAt,
  ),
]);

export const bankInstructionOutcomeEvents = pgTable('bank_instruction_outcome_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  bankInstructionId: uuid('bank_instruction_id').notNull(),
  sequenceNo: bigint('sequence_no', { mode: 'number' }).notNull(),
  outcome: varchar('outcome', { length: 24 }).notNull(),
  effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
  actorUserId: uuid('actor_user_id').notNull(),
  statementLineId: uuid('statement_line_id'),
  correctionPaymentId: uuid('correction_payment_id'),
  reason: varchar('reason', { length: 500 }),
  evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull(),
  sourceVersion: bigint('source_version', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.bankInstructionId, table.sequenceNo),
  foreignKey({
    columns: [table.organizationId, table.bankInstructionId],
    foreignColumns: [bankInstructions.organizationId, bankInstructions.id],
    name: 'bank_instruction_outcomes_instruction_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.correctionPaymentId],
    foreignColumns: [paymentDocuments.organizationId, paymentDocuments.id],
    name: 'bank_instruction_outcomes_correction_payment_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.actorUserId],
    foreignColumns: [userRefs.organizationId, userRefs.id],
    name: 'bank_instruction_outcomes_actor_fk',
  }),
  check('bank_instruction_outcomes_sequence_positive', sql`${table.sequenceNo} > 0`),
  check('bank_instruction_outcomes_outcome_check', sql`${table.outcome} IN ('CONFIRMED', 'REJECTED', 'CANCELLED', 'RETURNED')`),
  check('bank_instruction_outcomes_source_version', sql`${table.sourceVersion} > 0 AND ${table.sourceVersion} = ${table.sequenceNo}`),
  check('bank_instruction_outcomes_evidence', sql`jsonb_typeof(${table.evidence}) = 'object' AND ${table.evidence} <> '{}'::jsonb`),
  check(
    'bank_instruction_outcomes_shape',
    sql`(${table.outcome} = 'CONFIRMED' AND ${table.correctionPaymentId} IS NULL AND ${table.reason} IS NULL)
      OR (${table.outcome} IN ('REJECTED', 'CANCELLED', 'RETURNED')
        AND ${table.correctionPaymentId} IS NOT NULL
        AND NULLIF(BTRIM(${table.reason}), '') IS NOT NULL)`,
  ),
  index('bank_instruction_outcomes_instruction_idx').on(
    table.organizationId,
    table.bankInstructionId,
    table.sequenceNo,
  ),
]);

export const paymentExecutionEffects = pgTable('payment_execution_effects', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  paymentLineId: uuid('payment_line_id').notNull(),
  effectKey: varchar('effect_key', { length: 128 }).notNull(),
  effectType: varchar('effect_type', { length: 24 }).notNull(),
  direction: varchar('direction', { length: 8 }).notNull(),
  amount: numeric('amount', { precision: 38, scale: 8 }).notNull(),
  currency: varchar('currency', { length: 8 }).notNull(),
  businessDate: date('business_date').notNull(),
  sourceVersion: bigint('source_version', { mode: 'number' }).notNull(),
  movementFactId: uuid('movement_fact_id'),
  bankInstructionId: uuid('bank_instruction_id'),
  issuedChequeId: uuid('issued_cheque_id'),
  reversalOfEffectId: uuid('reversal_of_effect_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.id, table.currency, table.amount),
  unique().on(table.organizationId, table.paymentLineId, table.effectKey, table.direction),
  unique().on(table.organizationId, table.reversalOfEffectId),
  unique().on(table.organizationId, table.movementFactId),
  unique().on(table.organizationId, table.bankInstructionId),
  unique().on(table.organizationId, table.issuedChequeId),
  foreignKey({
    columns: [table.organizationId, table.paymentLineId],
    foreignColumns: [paymentLines.organizationId, paymentLines.id],
    name: 'payment_execution_effects_payment_line_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.movementFactId],
    foreignColumns: [movementFacts.organizationId, movementFacts.id],
    name: 'payment_execution_effects_movement_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.bankInstructionId],
    foreignColumns: [bankInstructions.organizationId, bankInstructions.id],
    name: 'payment_execution_effects_bank_instruction_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.reversalOfEffectId, table.currency, table.amount],
    foreignColumns: [table.organizationId, table.id, table.currency, table.amount],
    name: 'payment_execution_effects_reversal_fk',
  }),
  check('payment_execution_effects_type_check', sql`${table.effectType} IN ('CASHBOX_MOVEMENT', 'BANK_MOVEMENT', 'BANK_INSTRUCTION', 'ISSUED_CHEQUE')`),
  check('payment_execution_effects_direction_check', sql`${table.direction} IN ('OUTGOING', 'REVERSAL')`),
  check('payment_execution_effects_amount_positive', sql`${table.amount} > 0`),
  check('payment_execution_effects_source_version_positive', sql`${table.sourceVersion} > 0`),
  check(
    'payment_execution_effects_shape',
    sql`(${table.direction} = 'OUTGOING'
      AND ${table.reversalOfEffectId} IS NULL
      AND ((${table.effectType} IN ('CASHBOX_MOVEMENT', 'BANK_MOVEMENT')
          AND ${table.movementFactId} IS NOT NULL
          AND ${table.bankInstructionId} IS NULL
          AND ${table.issuedChequeId} IS NULL)
        OR (${table.effectType} = 'BANK_INSTRUCTION'
          AND ${table.movementFactId} IS NULL
          AND ${table.bankInstructionId} IS NOT NULL
          AND ${table.issuedChequeId} IS NULL)
        OR (${table.effectType} = 'ISSUED_CHEQUE'
          AND ${table.movementFactId} IS NULL
          AND ${table.bankInstructionId} IS NULL
          AND ${table.issuedChequeId} IS NOT NULL)))
      OR (${table.direction} = 'REVERSAL'
        AND ${table.effectType} IN ('CASHBOX_MOVEMENT', 'BANK_MOVEMENT')
        AND ${table.reversalOfEffectId} IS NOT NULL
        AND ${table.movementFactId} IS NOT NULL
        AND ${table.bankInstructionId} IS NULL
        AND ${table.issuedChequeId} IS NULL)`,
  ),
  index('payment_execution_effects_line_idx').on(
    table.organizationId,
    table.paymentLineId,
    table.direction,
  ),
]);

export const paymentRequestAttachmentLinks = pgTable('payment_request_attachment_links', {
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  paymentRequestId: uuid('payment_request_id').notNull(),
  attachmentId: uuid('attachment_id').notNull(),
  contentDigest: char('content_digest', { length: 64 }).notNull(),
  purpose: varchar('purpose', { length: 64 }).notNull().default(''),
  linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.paymentRequestId, table.attachmentId, table.purpose] }),
  foreignKey({
    columns: [table.organizationId, table.paymentRequestId],
    foreignColumns: [paymentRequests.organizationId, paymentRequests.id],
    name: 'payment_request_attachment_links_request_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.attachmentId, table.contentDigest],
    foreignColumns: [attachments.organizationId, attachments.id, attachments.contentDigest],
    name: 'payment_request_attachment_links_attachment_fk',
  }),
  check('payment_request_attachment_links_digest_format', sql`${table.contentDigest} ~ '^[a-f0-9]{64}$'`),
]);

export const paymentLineAttachmentLinks = pgTable('payment_line_attachment_links', {
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  paymentLineId: uuid('payment_line_id').notNull(),
  attachmentId: uuid('attachment_id').notNull(),
  contentDigest: char('content_digest', { length: 64 }).notNull(),
  purpose: varchar('purpose', { length: 64 }).notNull().default(''),
  linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.paymentLineId, table.attachmentId, table.purpose] }),
  foreignKey({
    columns: [table.organizationId, table.paymentLineId],
    foreignColumns: [paymentLines.organizationId, paymentLines.id],
    name: 'payment_line_attachment_links_line_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.attachmentId, table.contentDigest],
    foreignColumns: [attachments.organizationId, attachments.id, attachments.contentDigest],
    name: 'payment_line_attachment_links_attachment_fk',
  }),
  check('payment_line_attachment_links_digest_format', sql`${table.contentDigest} ~ '^[a-f0-9]{64}$'`),
]);

export const accountingSystems = pgTable('accounting_systems', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  code: varchar('code', { length: 64 }).notNull(),
  name: varchar('name', { length: 160 }).notNull(),
  transportProfile: varchar('transport_profile', { length: 24 }).notNull(),
  contractVersion: varchar('contract_version', { length: 32 }).notNull(),
  supportedSourceTypes: varchar('supported_source_types', { length: 32 }).array().notNull().default(['PAYMENT']),
  forbidSourceExecutorExport: boolean('forbid_source_executor_export').notNull().default(true),
  state: varchar('state', { length: 16 }).notNull(),
}, (table) => [
  unique().on(table.organizationId, table.code),
  unique().on(table.organizationId, table.id),
  check('accounting_systems_transport_check', sql`${table.transportProfile} IN ('CSV_ZIP_MANIFEST', 'XLSX')`),
  check('accounting_systems_source_types_check', sql`cardinality(${table.supportedSourceTypes}) > 0 AND ${table.supportedSourceTypes} <@ ARRAY['PAYMENT']::varchar[]`),
  check('accounting_systems_state_check', sql`${table.state} IN ('ACTIVE', 'SUSPENDED', 'CLOSED')`),
]);

export const accountingImports = pgTable('accounting_imports', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  accountingSystemId: uuid('accounting_system_id').notNull(),
  sourceDigest: char('source_digest', { length: 64 }).notNull(),
  contractVersion: varchar('contract_version', { length: 32 }).notNull(),
  representation: varchar('representation', { length: 24 }).notNull(),
  snapshotKind: varchar('snapshot_kind', { length: 16 }).notNull(),
  sourceVersion: varchar('source_version', { length: 64 }).notNull(),
  baseSourceVersion: varchar('base_source_version', { length: 64 }),
  fiscalContext: varchar('fiscal_context', { length: 128 }),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  appliedCount: integer('applied_count').notNull().default(0),
  errorCount: integer('error_count').notNull().default(0),
  state: varchar('state', { length: 24 }).notNull(),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.accountingSystemId, table.sourceDigest, table.contractVersion),
  foreignKey({
    columns: [table.organizationId, table.accountingSystemId],
    foreignColumns: [accountingSystems.organizationId, accountingSystems.id],
    name: 'accounting_imports_system_fk',
  }),
  check('accounting_imports_representation_check', sql`${table.representation} IN ('CSV_ZIP_MANIFEST', 'XLSX')`),
  check('accounting_imports_snapshot_check', sql`${table.snapshotKind} IN ('FULL', 'INCREMENTAL')`),
  check('accounting_imports_incremental_base_check', sql`${table.snapshotKind} <> 'INCREMENTAL' OR ${table.baseSourceVersion} IS NOT NULL`),
]);

export const fiscalPeriods = pgTable('fiscal_periods', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  accountingSystemId: uuid('accounting_system_id').notNull(),
  accountingImportId: uuid('accounting_import_id').notNull(),
  externalKey: varchar('external_key', { length: 128 }).notNull(),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  sourceVersion: varchar('source_version', { length: 64 }).notNull(),
  sourceDigest: char('source_digest', { length: 64 }).notNull(),
  effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
  externalAuthorizationRef: varchar('external_authorization_ref', { length: 128 }),
  changeReason: varchar('change_reason', { length: 500 }),
  state: varchar('state', { length: 16 }).notNull(),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.accountingSystemId, table.externalKey),
  foreignKey({
    columns: [table.organizationId, table.accountingSystemId],
    foreignColumns: [accountingSystems.organizationId, accountingSystems.id],
    name: 'fiscal_periods_system_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.accountingImportId],
    foreignColumns: [accountingImports.organizationId, accountingImports.id],
    name: 'fiscal_periods_import_fk',
  }),
  check('fiscal_periods_date_check', sql`${table.periodEnd} >= ${table.periodStart}`),
  check('fiscal_periods_state_check', sql`${table.state} IN ('OPEN', 'CLOSED')`),
]);

export const accountingMappings = pgTable('accounting_mappings', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  accountingSystemId: uuid('accounting_system_id').notNull(),
  localType: varchar('local_type', { length: 32 }).notNull(),
  localId: uuid('local_id').notNull(),
  mappingType: varchar('mapping_type', { length: 32 }).notNull(),
  externalKey: varchar('external_key', { length: 128 }).notNull(),
  externalParentKey: varchar('external_parent_key', { length: 128 }),
  sourceVersion: varchar('source_version', { length: 64 }),
  payloadDigest: char('payload_digest', { length: 64 }),
  state: varchar('state', { length: 16 }).notNull(),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.accountingSystemId, table.localType, table.localId, table.mappingType),
  foreignKey({
    columns: [table.organizationId, table.accountingSystemId],
    foreignColumns: [accountingSystems.organizationId, accountingSystems.id],
    name: 'accounting_mappings_system_fk',
  }),
  check('accounting_mappings_state_check', sql`${table.state} IN ('ACTIVE', 'INACTIVE', 'CONFLICT')`),
]);

export const accountingExports = pgTable('accounting_exports', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  accountingSystemId: uuid('accounting_system_id').notNull(),
  branchId: uuid('branch_id'),
  treasuryUnitId: uuid('treasury_unit_id'),
  sourceType: varchar('source_type', { length: 32 }).notNull(),
  sourceId: uuid('source_id').notNull(),
  sourceVersion: bigint('source_version', { mode: 'number' }).notNull(),
  documentType: varchar('document_type', { length: 64 }).notNull(),
  baseCurrency: varchar('base_currency', { length: 8 }).notNull(),
  aggregateBaseAmount: numeric('aggregate_base_amount', { precision: 38, scale: 8 }).notNull(),
  exportKind: varchar('export_kind', { length: 64 }).notNull(),
  contractVersion: varchar('contract_version', { length: 32 }).notNull(),
  idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
  payloadDigest: char('payload_digest', { length: 64 }).notNull(),
  mappingSnapshotDigest: char('mapping_snapshot_digest', { length: 64 }).notNull(),
  fiscalSnapshotDigest: char('fiscal_snapshot_digest', { length: 64 }).notNull(),
  exportedBy: uuid('exported_by').notNull(),
  externalDocumentId: varchar('external_document_id', { length: 128 }),
  externalDocumentNumber: varchar('external_document_number', { length: 128 }),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  state: varchar('state', { length: 32 }).notNull(),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.accountingSystemId, table.idempotencyKey),
  unique().on(table.organizationId, table.accountingSystemId, table.sourceType, table.sourceId, table.sourceVersion, table.exportKind),
  foreignKey({
    columns: [table.organizationId, table.accountingSystemId],
    foreignColumns: [accountingSystems.organizationId, accountingSystems.id],
    name: 'accounting_exports_system_fk',
  }),
  foreignKey({ columns: [table.organizationId, table.branchId], foreignColumns: [branches.organizationId, branches.id], name: 'accounting_exports_branch_fk' }),
  foreignKey({ columns: [table.organizationId, table.treasuryUnitId], foreignColumns: [treasuryUnits.organizationId, treasuryUnits.id], name: 'accounting_exports_unit_fk' }),
  foreignKey({ columns: [table.organizationId, table.exportedBy], foreignColumns: [userRefs.organizationId, userRefs.id], name: 'accounting_exports_exporter_fk' }),
  check('accounting_exports_amount_check', sql`${table.aggregateBaseAmount} >= 0`),
  check('accounting_exports_source_check', sql`${table.sourceType} = 'PAYMENT'`),
  check('accounting_exports_state_check', sql`${table.state} IN ('NOT_READY', 'MAPPING_REQUIRED', 'READY', 'QUEUED', 'SENDING', 'SENDING_UNKNOWN', 'ACCEPTED', 'FAILED', 'RETURNED', 'CORRECTED')`),
]);

export const accountingExportArtifacts = pgTable('accounting_export_artifacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  accountingExportId: uuid('accounting_export_id').notNull(),
  representation: varchar('representation', { length: 24 }).notNull(),
  contractVersion: varchar('contract_version', { length: 32 }).notNull(),
  manifestVersion: varchar('manifest_version', { length: 32 }).notNull(),
  mediaType: varchar('media_type', { length: 96 }).notNull(),
  fileName: varchar('file_name', { length: 255 }).notNull(),
  contentAddress: varchar('content_address', { length: 192 }).notNull(),
  content: bytea('content').notNull(),
  byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
  payloadDigest: char('payload_digest', { length: 64 }).notNull(),
  rowCount: integer('row_count').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.accountingExportId, table.representation),
  unique().on(table.organizationId, table.contentAddress),
  foreignKey({ columns: [table.organizationId, table.accountingExportId], foreignColumns: [accountingExports.organizationId, accountingExports.id], name: 'accounting_export_artifacts_export_fk' }),
  check('accounting_export_artifacts_representation_check', sql`${table.representation} IN ('CSV_ZIP_MANIFEST', 'XLSX')`),
  check('accounting_export_artifacts_size_check', sql`${table.byteSize} > 0 AND ${table.rowCount} > 0`),
]);

export const accountingExportRowResults = pgTable('accounting_export_row_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  accountingExportArtifactId: uuid('accounting_export_artifact_id').notNull(),
  rowNumber: integer('row_number').notNull(),
  sourceType: varchar('source_type', { length: 64 }).notNull(),
  sourceId: uuid('source_id').notNull(),
  sourceVersion: bigint('source_version', { mode: 'number' }).notNull(),
  payloadDigest: char('payload_digest', { length: 64 }).notNull(),
  outcome: varchar('outcome', { length: 16 }).notNull(),
  errorCode: varchar('error_code', { length: 64 }),
  errorDetail: varchar('error_detail', { length: 2000 }),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.accountingExportArtifactId, table.rowNumber),
  foreignKey({ columns: [table.organizationId, table.accountingExportArtifactId], foreignColumns: [accountingExportArtifacts.organizationId, accountingExportArtifacts.id], name: 'accounting_export_rows_artifact_fk' }),
  check('accounting_export_rows_number_check', sql`${table.rowNumber} > 0`),
  check('accounting_export_rows_outcome_check', sql`${table.outcome} IN ('ACCEPTED', 'ERROR')`),
  check('accounting_export_rows_error_check', sql`(${table.outcome} = 'ACCEPTED' AND ${table.errorCode} IS NULL AND ${table.errorDetail} IS NULL) OR (${table.outcome} = 'ERROR' AND ${table.errorCode} IS NOT NULL)`),
]);

export const accountingExportAttempts = pgTable('accounting_export_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  accountingExportId: uuid('accounting_export_id').notNull(),
  attemptNumber: integer('attempt_number').notNull(),
  requestSnapshot: jsonb('request_snapshot').$type<Record<string, unknown>>().notNull(),
  requestDigest: char('request_digest', { length: 64 }).notNull(),
  responseSnapshot: jsonb('response_snapshot').$type<Record<string, unknown>>(),
  responseDigest: char('response_digest', { length: 64 }),
  outcome: varchar('outcome', { length: 24 }).notNull(),
  errorCode: varchar('error_code', { length: 64 }),
  actorId: uuid('actor_id'),
  workerKey: varchar('worker_key', { length: 128 }),
  externalDocumentId: varchar('external_document_id', { length: 128 }),
  externalDocumentNumber: varchar('external_document_number', { length: 128 }),
  attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.accountingExportId, table.attemptNumber),
  foreignKey({ columns: [table.organizationId, table.accountingExportId], foreignColumns: [accountingExports.organizationId, accountingExports.id], name: 'accounting_export_attempts_export_fk' }),
  foreignKey({ columns: [table.organizationId, table.actorId], foreignColumns: [userRefs.organizationId, userRefs.id], name: 'accounting_export_attempts_actor_fk' }),
  check('accounting_export_attempts_number_check', sql`${table.attemptNumber} > 0`),
  check('accounting_export_attempts_outcome_check', sql`${table.outcome} IN ('QUEUED', 'SENDING', 'SENDING_UNKNOWN', 'ACCEPTED', 'FAILED')`),
  check('accounting_export_attempts_actor_check', sql`(${table.actorId} IS NOT NULL) <> (${table.workerKey} IS NOT NULL)`),
]);

export const accountingAcknowledgements = pgTable('accounting_acknowledgements', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  accountingExportId: uuid('accounting_export_id').notNull(),
  idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
  requestDigest: char('request_digest', { length: 64 }).notNull(),
  outcome: varchar('outcome', { length: 24 }).notNull(),
  responseDigest: char('response_digest', { length: 64 }).notNull(),
  externalDocumentId: varchar('external_document_id', { length: 128 }),
  externalDocumentNumber: varchar('external_document_number', { length: 128 }),
  externalReturnId: varchar('external_return_id', { length: 128 }),
  errorCode: varchar('error_code', { length: 64 }),
  errorDetail: varchar('error_detail', { length: 2000 }),
  acknowledgedBy: uuid('acknowledged_by').notNull(),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }).notNull(),
  exportVersion: bigint('export_version', { mode: 'number' }).notNull(),
  responseBody: jsonb('response_body').$type<Record<string, unknown>>().notNull(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.accountingExportId, table.idempotencyKey),
  foreignKey({ columns: [table.organizationId, table.accountingExportId], foreignColumns: [accountingExports.organizationId, accountingExports.id], name: 'accounting_acknowledgements_export_fk' }),
  foreignKey({ columns: [table.organizationId, table.acknowledgedBy], foreignColumns: [userRefs.organizationId, userRefs.id], name: 'accounting_acknowledgements_actor_fk' }),
  check('accounting_acknowledgements_outcome_check', sql`${table.outcome} IN ('ACCEPTED', 'REJECTED', 'OUTCOME_UNKNOWN', 'RETURNED')`),
  check('accounting_acknowledgements_accepted_check', sql`${table.outcome} <> 'ACCEPTED' OR ${table.externalDocumentId} IS NOT NULL`),
  check('accounting_acknowledgements_rejected_check', sql`${table.outcome} <> 'REJECTED' OR ${table.errorCode} IS NOT NULL`),
  check('accounting_acknowledgements_returned_check', sql`${table.outcome} <> 'RETURNED' OR (${table.externalDocumentId} IS NOT NULL AND ${table.externalReturnId} IS NOT NULL AND ${table.errorCode} IS NOT NULL)`),
]);

export const postingLocks = pgTable('posting_locks', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  accountingExportId: uuid('accounting_export_id').notNull(),
  accountingSystemId: uuid('accounting_system_id').notNull(),
  sourceType: varchar('source_type', { length: 32 }).notNull(),
  sourceId: uuid('source_id').notNull(),
  sourceVersion: bigint('source_version', { mode: 'number' }).notNull(),
  lockedDigest: char('locked_digest', { length: 64 }).notNull(),
  lockedAt: timestamp('locked_at', { withTimezone: true }).notNull(),
  state: varchar('state', { length: 16 }).notNull(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.accountingExportId),
  unique('posting_locks_one_accepted_source').on(
    table.organizationId,
    table.sourceType,
    table.sourceId,
    table.sourceVersion,
  ),
  foreignKey({ columns: [table.organizationId, table.accountingExportId], foreignColumns: [accountingExports.organizationId, accountingExports.id], name: 'posting_locks_export_fk' }),
  foreignKey({ columns: [table.organizationId, table.accountingSystemId], foreignColumns: [accountingSystems.organizationId, accountingSystems.id], name: 'posting_locks_system_fk' }),
  check('posting_locks_state_check', sql`${table.state} IN ('ACTIVE', 'RETURNED', 'CORRECTED')`),
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

export const transferDocuments = pgTable('transfer_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  businessNumber: varchar('business_number', { length: 64 }).notNull(),
  businessDate: date('business_date').notNull(),
  route: varchar('route', { length: 32 }).notNull(),
  sourceType: varchar('source_type', { length: 16 }).notNull(),
  sourceId: uuid('source_id').notNull(),
  destinationType: varchar('destination_type', { length: 16 }).notNull(),
  destinationId: uuid('destination_id').notNull(),
  sourceAmount: numeric('source_amount', { precision: 38, scale: 8 }).notNull(),
  sourceCurrency: varchar('source_currency', { length: 8 }).notNull(),
  destinationAmount: numeric('destination_amount', { precision: 38, scale: 8 }).notNull(),
  destinationCurrency: varchar('destination_currency', { length: 8 }).notNull(),
  exchangeRate: numeric('exchange_rate', { precision: 38, scale: 18 }).notNull(),
  rateType: varchar('rate_type', { length: 64 }).notNull(),
  rateSource: varchar('rate_source', { length: 16 }).notNull(),
  rateRecordId: uuid('rate_record_id').references(() => exchangeRates.id),
  ratedAt: timestamp('rated_at', { withTimezone: true }).notNull(),
  roundingDifference: numeric('rounding_difference', { precision: 38, scale: 8 }).notNull(),
  expectedReceiptAt: timestamp('expected_receipt_at', { withTimezone: true }),
  purpose: varchar('purpose', { length: 1000 }).notNull(),
  accountingDimensions: jsonb('accounting_dimensions').$type<Record<string, never>>(),
  creatorUserId: uuid('creator_user_id').notNull(),
  currentApprovalSnapshotId: uuid('current_approval_snapshot_id'),
  sourceCustodianUserId: uuid('source_custodian_user_id'),
  destinationCustodianUserId: uuid('destination_custodian_user_id'),
  releasedByUserId: uuid('released_by_user_id'),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  receivedByUserId: uuid('received_by_user_id'),
  receivedAt: timestamp('received_at', { withTimezone: true }),
  receiptRecordedAt: timestamp('receipt_recorded_at', { withTimezone: true }),
  discrepancyAmount: numeric('discrepancy_amount', { precision: 38, scale: 8 }).notNull().default('0'),
  discrepancyReason: varchar('discrepancy_reason', { length: 500 }),
  state: varchar('state', { length: 32 }).notNull().default('DRAFT'),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.businessNumber),
  foreignKey({
    columns: [table.organizationId, table.sourceCurrency],
    foreignColumns: [currencies.organizationId, currencies.code],
    name: 'transfer_documents_source_currency_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.destinationCurrency],
    foreignColumns: [currencies.organizationId, currencies.code],
    name: 'transfer_documents_destination_currency_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.creatorUserId],
    foreignColumns: [userRefs.organizationId, userRefs.id],
    name: 'transfer_documents_creator_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.sourceCustodianUserId],
    foreignColumns: [userRefs.organizationId, userRefs.id],
    name: 'transfer_documents_source_custodian_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.destinationCustodianUserId],
    foreignColumns: [userRefs.organizationId, userRefs.id],
    name: 'transfer_documents_destination_custodian_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.releasedByUserId],
    foreignColumns: [userRefs.organizationId, userRefs.id],
    name: 'transfer_documents_released_by_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.receivedByUserId],
    foreignColumns: [userRefs.organizationId, userRefs.id],
    name: 'transfer_documents_received_by_fk',
  }),
  check('transfer_documents_source_positive', sql`${table.sourceAmount} > 0`),
  check('transfer_documents_destination_positive', sql`${table.destinationAmount} > 0`),
  check('transfer_documents_rate_positive', sql`${table.exchangeRate} > 0`),
  check('transfer_documents_endpoint_type_check', sql`${table.sourceType} IN ('CASHBOX', 'BANK_ACCOUNT', 'USER') AND ${table.destinationType} IN ('CASHBOX', 'BANK_ACCOUNT', 'USER')`),
  check('transfer_documents_distinct_endpoints', sql`NOT (${table.sourceType} = ${table.destinationType} AND ${table.sourceId} = ${table.destinationId})`),
  check('transfer_documents_route_check', sql`
    (${table.route} = 'CASHBOX_TO_CASHBOX' AND ${table.sourceType} = 'CASHBOX' AND ${table.destinationType} = 'CASHBOX')
    OR (${table.route} = 'CASHBOX_TO_BANK' AND ${table.sourceType} = 'CASHBOX' AND ${table.destinationType} = 'BANK_ACCOUNT')
    OR (${table.route} = 'BANK_TO_CASHBOX' AND ${table.sourceType} = 'BANK_ACCOUNT' AND ${table.destinationType} = 'CASHBOX')
    OR (${table.route} = 'BANK_TO_BANK' AND ${table.sourceType} = 'BANK_ACCOUNT' AND ${table.destinationType} = 'BANK_ACCOUNT')
    OR (${table.route} = 'CASHBOX_TO_USER' AND ${table.sourceType} = 'CASHBOX' AND ${table.destinationType} = 'USER')
    OR (${table.route} = 'USER_TO_CASHBOX' AND ${table.sourceType} = 'USER' AND ${table.destinationType} = 'CASHBOX')
    OR (${table.route} = 'USER_TO_USER' AND ${table.sourceType} = 'USER' AND ${table.destinationType} = 'USER')
    OR (${table.route} IN ('BRANCH_TRANSFER', 'CURRENCY_EXCHANGE') AND ${table.sourceType} IN ('CASHBOX', 'BANK_ACCOUNT') AND ${table.destinationType} IN ('CASHBOX', 'BANK_ACCOUNT'))
    OR (${table.route} = 'PETTY_CASH' AND ((${table.sourceType} = 'CASHBOX' AND ${table.destinationType} = 'USER') OR (${table.sourceType} = 'USER' AND ${table.destinationType} = 'CASHBOX')))
  `),
  check('transfer_documents_rate_check', sql`
    (${table.sourceCurrency} = ${table.destinationCurrency} AND ${table.rateSource} = 'IDENTITY' AND ${table.rateRecordId} IS NULL AND ${table.exchangeRate} = 1 AND ${table.sourceAmount} = ${table.destinationAmount} AND ${table.roundingDifference} = 0)
    OR (${table.sourceCurrency} <> ${table.destinationCurrency} AND ${table.rateSource} = 'TABLE' AND ${table.rateRecordId} IS NOT NULL)
  `),
  check('transfer_documents_state_check', sql`${table.state} IN ('DRAFT', 'REQUESTED', 'APPROVED', 'IN_TRANSIT', 'DISCREPANCY', 'COMPLETED', 'REJECTED')`),
  check('transfer_documents_snapshot_check', sql`(${table.state} = 'DRAFT' AND ${table.currentApprovalSnapshotId} IS NULL) OR (${table.state} <> 'DRAFT' AND ${table.currentApprovalSnapshotId} IS NOT NULL)`),
  check('transfer_documents_custodian_pair_check', sql`(${table.sourceCustodianUserId} IS NULL) = (${table.destinationCustodianUserId} IS NULL)`),
  check('transfer_documents_custodian_distinct_check', sql`${table.sourceCustodianUserId} IS NULL OR ${table.sourceCustodianUserId} <> ${table.destinationCustodianUserId}`),
  check('transfer_documents_approved_custodian_check', sql`${table.state} NOT IN ('APPROVED', 'IN_TRANSIT', 'DISCREPANCY', 'COMPLETED') OR ${table.sourceCustodianUserId} IS NOT NULL`),
  check('transfer_documents_release_actor_check', sql`${table.releasedByUserId} IS NULL OR ${table.releasedByUserId} = ${table.sourceCustodianUserId}`),
  check('transfer_documents_release_pair_check', sql`(${table.releasedByUserId} IS NULL) = (${table.releasedAt} IS NULL)`),
  check('transfer_documents_receipt_actor_check', sql`${table.receivedByUserId} IS NULL OR (${table.releasedByUserId} IS NOT NULL AND ${table.receivedByUserId} = ${table.destinationCustodianUserId} AND ${table.receivedByUserId} <> ${table.releasedByUserId})`),
  check('transfer_documents_receipt_time_pair_check', sql`(${table.receivedByUserId} IS NULL) = (${table.receivedAt} IS NULL) AND (${table.receivedByUserId} IS NULL) = (${table.receiptRecordedAt} IS NULL)`),
  check('transfer_documents_receipt_time_bounds_check', sql`${table.receivedAt} IS NULL OR (${table.receivedAt} >= ${table.releasedAt} AND ${table.receivedAt} <= ${table.receiptRecordedAt})`),
  check('transfer_documents_release_state_check', sql`${table.releasedByUserId} IS NULL OR ${table.state} IN ('IN_TRANSIT', 'DISCREPANCY', 'COMPLETED')`),
  check('transfer_documents_receipt_state_check', sql`${table.receivedByUserId} IS NULL OR ${table.state} IN ('DISCREPANCY', 'COMPLETED')`),
  check('transfer_documents_later_release_check', sql`${table.state} NOT IN ('IN_TRANSIT', 'DISCREPANCY', 'COMPLETED') OR ${table.releasedByUserId} IS NOT NULL`),
  check('transfer_documents_later_receipt_check', sql`${table.state} NOT IN ('DISCREPANCY', 'COMPLETED') OR ${table.receivedByUserId} IS NOT NULL`),
  check('transfer_documents_discrepancy_reason_check', sql`${table.state} <> 'DISCREPANCY' OR NULLIF(BTRIM(${table.discrepancyReason}), '') IS NOT NULL`),
  check('transfer_documents_discrepancy_nonnegative', sql`${table.discrepancyAmount} >= 0`),
  check('transfer_documents_version_nonnegative', sql`${table.version} >= 0`),
  index('transfer_documents_list_idx').on(table.organizationId, table.businessDate.desc(), table.id.desc()),
]);

export const transferAssetItems = pgTable('transfer_asset_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  transferDocumentId: uuid('transfer_document_id').notNull(),
  assetType: varchar('asset_type', { length: 24 }).notNull(),
  assetId: uuid('asset_id').notNull(),
  assetLabel: varchar('asset_label', { length: 240 }).notNull(),
  quantity: numeric('quantity', { precision: 38, scale: 8 }).notNull().default('1'),
  state: varchar('state', { length: 16 }).notNull().default('PLANNED'),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.transferDocumentId, table.assetType, table.assetId),
  foreignKey({
    columns: [table.organizationId, table.transferDocumentId],
    foreignColumns: [transferDocuments.organizationId, transferDocuments.id],
    name: 'transfer_asset_items_document_fk',
  }),
  check('transfer_asset_items_type_check', sql`${table.assetType} IN ('RECEIVED_CHEQUE', 'ISSUED_CHEQUE', 'DOCUMENT', 'OTHER_CONTROLLED')`),
  check('transfer_asset_items_quantity_positive', sql`${table.quantity} > 0`),
  check('transfer_asset_items_state_check', sql`${table.state} IN ('PLANNED', 'RELEASED', 'RECEIVED', 'RETURNED')`),
]);

export const transferTransitObligations = pgTable('transfer_transit_obligations', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  transferDocumentId: uuid('transfer_document_id').notNull(),
  sourceAmount: numeric('source_amount', { precision: 38, scale: 8 }).notNull(),
  sourceCurrency: varchar('source_currency', { length: 8 }).notNull(),
  destinationAmount: numeric('destination_amount', { precision: 38, scale: 8 }).notNull(),
  destinationCurrency: varchar('destination_currency', { length: 8 }).notNull(),
  sourceMovementFactId: uuid('source_movement_fact_id').notNull(),
  destinationMovementFactId: uuid('destination_movement_fact_id'),
  receivedAmount: numeric('received_amount', { precision: 38, scale: 8 }),
  receivedCurrency: varchar('received_currency', { length: 8 }),
  state: varchar('state', { length: 16 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.transferDocumentId),
  unique().on(table.organizationId, table.sourceMovementFactId),
  unique().on(table.organizationId, table.destinationMovementFactId),
  foreignKey({ columns: [table.organizationId, table.transferDocumentId], foreignColumns: [transferDocuments.organizationId, transferDocuments.id], name: 'transfer_transit_obligations_document_fk' }),
  foreignKey({ columns: [table.organizationId, table.sourceMovementFactId], foreignColumns: [movementFacts.organizationId, movementFacts.id], name: 'transfer_transit_obligations_source_movement_fk' }),
  foreignKey({ columns: [table.organizationId, table.destinationMovementFactId], foreignColumns: [movementFacts.organizationId, movementFacts.id], name: 'transfer_transit_obligations_destination_movement_fk' }),
  check('transfer_transit_obligations_source_positive', sql`${table.sourceAmount} > 0`),
  check('transfer_transit_obligations_destination_positive', sql`${table.destinationAmount} > 0`),
  check('transfer_transit_obligations_state_check', sql`${table.state} IN ('OPEN', 'DISCREPANCY', 'CLOSED', 'RETURNED')`),
  check('transfer_transit_obligations_receipt_check', sql`
    (${table.state} = 'OPEN' AND ${table.destinationMovementFactId} IS NULL AND ${table.receivedAmount} IS NULL AND ${table.receivedCurrency} IS NULL)
    OR (${table.state} = 'DISCREPANCY' AND ${table.destinationMovementFactId} IS NULL AND ${table.receivedAmount} IS NOT NULL AND ${table.receivedAmount} >= 0 AND ${table.receivedCurrency} = ${table.destinationCurrency})
    OR (${table.state} = 'CLOSED' AND ${table.destinationMovementFactId} IS NOT NULL AND ${table.receivedAmount} = ${table.destinationAmount} AND ${table.receivedCurrency} = ${table.destinationCurrency})
    OR (${table.state} = 'RETURNED' AND ${table.destinationMovementFactId} IS NULL)
  `),
]);

export const transferAttachmentLinks = pgTable('transfer_attachment_links', {
  organizationId: uuid('organization_id').notNull(),
  transferDocumentId: uuid('transfer_document_id').notNull(),
  attachmentId: uuid('attachment_id').notNull(),
  contentDigest: char('content_digest', { length: 64 }).notNull(),
  purpose: varchar('purpose', { length: 64 }),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.transferDocumentId, table.attachmentId] }),
  foreignKey({
    columns: [table.organizationId, table.transferDocumentId],
    foreignColumns: [transferDocuments.organizationId, transferDocuments.id],
    name: 'transfer_attachment_links_document_fk',
  }),
  foreignKey({
    columns: [table.organizationId, table.attachmentId, table.contentDigest],
    foreignColumns: [attachments.organizationId, attachments.id, attachments.contentDigest],
    name: 'transfer_attachment_links_attachment_fk',
  }),
]);

export const transferApprovalPolicies = pgTable('transfer_approval_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  code: varchar('code', { length: 64 }).notNull(),
  name: varchar('name', { length: 240 }).notNull(),
  branchId: uuid('branch_id'),
  treasuryUnitId: uuid('treasury_unit_id'),
  currency: varchar('currency', { length: 8 }),
  amountMinimum: numeric('amount_minimum', { precision: 38, scale: 8 }),
  amountMaximum: numeric('amount_maximum', { precision: 38, scale: 8 }),
  version: integer('version').notNull(),
  state: varchar('state', { length: 16 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.code, table.version),
  foreignKey({ columns: [table.organizationId, table.branchId], foreignColumns: [branches.organizationId, branches.id], name: 'transfer_approval_policies_branch_fk' }),
  foreignKey({ columns: [table.organizationId, table.treasuryUnitId], foreignColumns: [treasuryUnits.organizationId, treasuryUnits.id], name: 'transfer_approval_policies_treasury_unit_fk' }),
  foreignKey({
    columns: [table.organizationId, table.currency],
    foreignColumns: [currencies.organizationId, currencies.code],
    name: 'transfer_approval_policies_currency_fk',
  }),
  check('transfer_approval_policies_range_check', sql`${table.amountMaximum} IS NULL OR ${table.amountMinimum} IS NULL OR ${table.amountMaximum} >= ${table.amountMinimum}`),
  check('transfer_approval_policies_state_check', sql`${table.state} IN ('DRAFT', 'ACTIVE', 'RETIRED')`),
  index('transfer_approval_policy_selection_idx').on(table.organizationId, table.state, table.branchId, table.treasuryUnitId, table.currency, table.amountMinimum, table.amountMaximum),
]);

export const transferApprovalPolicySteps = pgTable('transfer_approval_policy_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  policyId: uuid('policy_id').notNull(),
  stepOrder: integer('step_order').notNull(),
  roleId: uuid('role_id'),
  approverUserId: uuid('approver_user_id'),
  approvalsRequired: integer('approvals_required').notNull().default(1),
  separationRules: varchar('separation_rules', { length: 64 }).array().notNull().default([]),
}, (table) => [
  unique().on(table.organizationId, table.policyId, table.stepOrder),
  unique().on(table.organizationId, table.policyId, table.id),
  foreignKey({ columns: [table.organizationId, table.policyId], foreignColumns: [transferApprovalPolicies.organizationId, transferApprovalPolicies.id], name: 'transfer_approval_policy_steps_policy_fk' }),
  foreignKey({ columns: [table.organizationId, table.roleId], foreignColumns: [roles.organizationId, roles.id], name: 'transfer_approval_policy_steps_role_fk' }),
  foreignKey({ columns: [table.organizationId, table.approverUserId], foreignColumns: [userRefs.organizationId, userRefs.id], name: 'transfer_approval_policy_steps_approver_fk' }),
  check('transfer_approval_policy_steps_subject_check', sql`(${table.roleId} IS NOT NULL) <> (${table.approverUserId} IS NOT NULL)`),
  check('transfer_approval_policy_steps_order_check', sql`${table.stepOrder} > 0`),
  check('transfer_approval_policy_steps_required_check', sql`${table.approvalsRequired} > 0`),
  check('transfer_approval_policy_steps_separation_check', sql`${table.separationRules} <@ ARRAY['CREATOR_NOT_APPROVER','SOURCE_CUSTODIAN_NOT_APPROVER']::VARCHAR(64)[]`),
]);

export const transferApprovalSnapshots = pgTable('transfer_approval_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  transferDocumentId: uuid('transfer_document_id').notNull(),
  documentVersion: bigint('document_version', { mode: 'number' }).notNull(),
  amountBasis: numeric('amount_basis', { precision: 38, scale: 8 }).notNull(),
  currency: varchar('currency', { length: 8 }).notNull(),
  evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull(),
  policyId: uuid('policy_id').notNull(),
  policyCode: varchar('policy_code', { length: 64 }).notNull(),
  policyName: varchar('policy_name', { length: 240 }).notNull(),
  policyVersion: integer('policy_version').notNull(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.transferDocumentId, table.id),
  unique().on(table.organizationId, table.transferDocumentId, table.documentVersion),
  foreignKey({ columns: [table.organizationId, table.transferDocumentId], foreignColumns: [transferDocuments.organizationId, transferDocuments.id], name: 'transfer_approval_snapshots_document_fk' }),
  foreignKey({ columns: [table.organizationId, table.policyId], foreignColumns: [transferApprovalPolicies.organizationId, transferApprovalPolicies.id], name: 'transfer_approval_snapshots_policy_fk' }),
  check('transfer_approval_snapshots_amount_positive', sql`${table.amountBasis} > 0`),
]);

export const transferApprovalSnapshotSteps = pgTable('transfer_approval_snapshot_steps', {
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
}, (table) => [
  unique().on(table.organizationId, table.approvalSnapshotId, table.id),
  unique().on(table.organizationId, table.approvalSnapshotId, table.stepOrder),
  foreignKey({ columns: [table.organizationId, table.approvalSnapshotId], foreignColumns: [transferApprovalSnapshots.organizationId, transferApprovalSnapshots.id], name: 'transfer_approval_snapshot_steps_snapshot_fk' }),
  foreignKey({ columns: [table.organizationId, table.roleId], foreignColumns: [roles.organizationId, roles.id], name: 'transfer_approval_snapshot_steps_role_fk' }),
  foreignKey({ columns: [table.organizationId, table.approverUserId], foreignColumns: [userRefs.organizationId, userRefs.id], name: 'transfer_approval_snapshot_steps_approver_fk' }),
  check('transfer_approval_snapshot_steps_subject_check', sql`(${table.roleId} IS NOT NULL) <> (${table.approverUserId} IS NOT NULL)`),
  check('transfer_approval_snapshot_steps_order_check', sql`${table.stepOrder} > 0`),
  check('transfer_approval_snapshot_steps_required_check', sql`${table.approvalsRequired} > 0`),
  check('transfer_approval_snapshot_steps_separation_check', sql`${table.separationRules} <@ ARRAY['CREATOR_NOT_APPROVER','SOURCE_CUSTODIAN_NOT_APPROVER']::VARCHAR(64)[]`),
]);

export const transferApprovalActions = pgTable('transfer_approval_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  approvalSnapshotId: uuid('approval_snapshot_id').notNull(),
  approvalSnapshotStepId: uuid('approval_snapshot_step_id').notNull(),
  stepOrder: integer('step_order').notNull(),
  actorUserId: uuid('actor_user_id').notNull(),
  delegatedFromUserId: uuid('delegated_from_user_id'),
  action: varchar('action', { length: 16 }).notNull(),
  reason: varchar('reason', { length: 500 }),
  actedAt: timestamp('acted_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique().on(table.organizationId, table.id),
  unique().on(table.organizationId, table.approvalSnapshotId, table.stepOrder, table.actorUserId),
  foreignKey({ columns: [table.organizationId, table.approvalSnapshotId], foreignColumns: [transferApprovalSnapshots.organizationId, transferApprovalSnapshots.id], name: 'transfer_approval_actions_snapshot_fk' }),
  foreignKey({ columns: [table.organizationId, table.approvalSnapshotId, table.approvalSnapshotStepId], foreignColumns: [transferApprovalSnapshotSteps.organizationId, transferApprovalSnapshotSteps.approvalSnapshotId, transferApprovalSnapshotSteps.id], name: 'transfer_approval_actions_step_fk' }),
  foreignKey({ columns: [table.organizationId, table.actorUserId], foreignColumns: [userRefs.organizationId, userRefs.id], name: 'transfer_approval_actions_actor_fk' }),
  foreignKey({ columns: [table.organizationId, table.delegatedFromUserId], foreignColumns: [userRefs.organizationId, userRefs.id], name: 'transfer_approval_actions_delegated_from_fk' }),
  check('transfer_approval_actions_action_check', sql`${table.action} IN ('APPROVED', 'REJECTED')`),
  check('transfer_approval_actions_reason_check', sql`${table.action} = 'APPROVED' OR NULLIF(BTRIM(${table.reason}), '') IS NOT NULL`),
]);
