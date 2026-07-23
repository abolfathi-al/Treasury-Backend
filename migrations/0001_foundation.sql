CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton_key boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton_key),
  code varchar(32) NOT NULL UNIQUE,
  legal_name varchar(200) NOT NULL,
  timezone varchar(64) NOT NULL,
  base_currency varchar(8) NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'INACTIVE')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE treasury_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  branch_id uuid,
  code varchar(32) NOT NULL,
  name varchar(160) NOT NULL,
  default_currency varchar(8) NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'INACTIVE')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  code varchar(32) NOT NULL,
  name varchar(160) NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'INACTIVE')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code),
  UNIQUE (organization_id, id)
);

ALTER TABLE treasury_units
  ADD CONSTRAINT treasury_units_branch_fk
  FOREIGN KEY (organization_id, branch_id)
  REFERENCES branches (organization_id, id)
  ON DELETE RESTRICT;

CREATE TABLE currencies (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  code varchar(8) NOT NULL CHECK (code ~ '^[A-Z0-9]{3,8}$'),
  name varchar(100) NOT NULL,
  english_name varchar(100),
  symbol varchar(16),
  decimal_places integer NOT NULL CHECK (decimal_places BETWEEN 0 AND 8),
  base_currency boolean NOT NULL DEFAULT false,
  state varchar(16) NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'INACTIVE')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, code)
);

CREATE UNIQUE INDEX currencies_one_base_per_organization
  ON currencies (organization_id) WHERE base_currency;

ALTER TABLE treasury_units
  ADD CONSTRAINT treasury_units_currency_fk
  FOREIGN KEY (organization_id, default_currency)
  REFERENCES currencies (organization_id, code)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE organizations
  ADD CONSTRAINT organizations_base_currency_fk
  FOREIGN KEY (id, base_currency)
  REFERENCES currencies (organization_id, code)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE user_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  subject_key varchar(128) NOT NULL,
  display_name varchar(200) NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'SUSPENDED', 'INACTIVE')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, subject_key)
);

CREATE TABLE identity_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_ref_id uuid NOT NULL UNIQUE REFERENCES user_refs(id) ON DELETE RESTRICT,
  normalized_login varchar(254) NOT NULL UNIQUE,
  password_hash text NOT NULL,
  password_profile_version integer NOT NULL DEFAULT 1,
  totp_ciphertext text,
  totp_iv text,
  totp_auth_tag text,
  totp_key_version integer,
  totp_last_counter bigint,
  recovery_code_hash text,
  recovery_version integer NOT NULL DEFAULT 1,
  state varchar(16) NOT NULL DEFAULT 'ACTIVE' CHECK (state IN (
    'INVITED', 'ACTIVE', 'LOCKED', 'SUSPENDED', 'CLOSED'
  )),
  privileged boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  code varchar(64) NOT NULL,
  name varchar(160) NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'INACTIVE')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE (organization_id, code)
);

CREATE TABLE role_permissions (
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  permission varchar(128) NOT NULL,
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  user_ref_id uuid NOT NULL REFERENCES user_refs(id) ON DELETE RESTRICT,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  scope_type varchar(32) NOT NULL DEFAULT 'ORGANIZATION' CHECK (scope_type = 'ORGANIZATION'),
  scope_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  state varchar(16) NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'INACTIVE')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE (user_ref_id, role_id, scope_type, scope_id)
);

CREATE TABLE auth_throttle_buckets (
  bucket_digest char(64) PRIMARY KEY,
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  delay_until timestamptz,
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_password_attempt_reservations (
  id uuid PRIMARY KEY,
  bucket_digest char(64) NOT NULL
    REFERENCES auth_throttle_buckets(bucket_digest) ON DELETE CASCADE,
  generation bigint NOT NULL CHECK (generation >= 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auth_password_attempt_reservations_active_idx
  ON auth_password_attempt_reservations (bucket_digest, generation, expires_at);

CREATE TABLE auth_recovery_attempts (
  bucket_digest char(64) PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_account_id uuid NOT NULL REFERENCES identity_accounts(id) ON DELETE RESTRICT,
  token_digest char(64) NOT NULL UNIQUE,
  previous_token_digest char(64) UNIQUE,
  previous_valid_until timestamptz,
  xsrf_digest char(64) NOT NULL,
  previous_xsrf_digest char(64),
  authenticated_at timestamptz NOT NULL,
  last_rotated_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  assurance varchar(32) NOT NULL CHECK (assurance IN ('PASSWORD', 'PASSWORD_TOTP')),
  device_label varchar(160),
  revoked_at timestamptz
);

CREATE INDEX auth_sessions_account_active_idx
  ON auth_sessions (identity_account_id) WHERE revoked_at IS NULL;

CREATE TABLE auth_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_account_id uuid NOT NULL REFERENCES identity_accounts(id) ON DELETE RESTRICT,
  session_id uuid REFERENCES auth_sessions(id) ON DELETE RESTRICT,
  token_digest char(64) NOT NULL UNIQUE,
  kind varchar(24) NOT NULL CHECK (kind IN ('LOGIN', 'STEP_UP')),
  http_method varchar(12),
  http_path text,
  request_body_digest char(64),
  idempotency_key varchar(128),
  device_label varchar(160),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_step_up_proofs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id uuid NOT NULL UNIQUE REFERENCES auth_challenges(id) ON DELETE RESTRICT,
  token_digest char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE TABLE security_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE RESTRICT,
  identity_account_id uuid REFERENCES identity_accounts(id) ON DELETE RESTRICT,
  request_id varchar(128) NOT NULL,
  event_type varchar(96) NOT NULL,
  outcome varchar(32) NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE method_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  code varchar(64) NOT NULL,
  name varchar(160) NOT NULL,
  direction varchar(16) NOT NULL CHECK (direction IN ('RECEIPT', 'PAYMENT', 'BOTH')),
  behavior_category varchar(32) NOT NULL CHECK (behavior_category IN (
    'CASH', 'CHEQUE', 'BANK_TRANSFER', 'DIRECT_DEPOSIT', 'POS', 'GATEWAY',
    'CARD_TRANSFER', 'WALLET', 'OFFSET', 'FOREIGN_REMITTANCE', 'OTHER_CONTROLLED'
  )),
  creates_funds_in_transit boolean NOT NULL,
  requires_approval boolean NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'INACTIVE')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE method_mappings (
  method_id uuid NOT NULL REFERENCES method_definitions(id) ON DELETE RESTRICT,
  mapping_kind varchar(16) NOT NULL CHECK (mapping_kind IN (
    'DEBIT', 'CREDIT', 'FEE', 'DISCREPANCY', 'TEMPLATE'
  )),
  mapping_ref varchar(128) NOT NULL,
  PRIMARY KEY (method_id, mapping_kind)
);

CREATE TABLE method_required_references (
  method_id uuid NOT NULL REFERENCES method_definitions(id) ON DELETE RESTRICT,
  reference varchar(32) NOT NULL CHECK (reference IN (
    'CASHBOX', 'BANK_ACCOUNT', 'CHEQUE', 'POS', 'GATEWAY',
    'TRACKING_NUMBER', 'DUE_DATE', 'PARTY', 'EVIDENCE'
  )),
  PRIMARY KEY (method_id, reference)
);

CREATE TABLE method_allowed_currencies (
  method_id uuid NOT NULL REFERENCES method_definitions(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL,
  currency_code varchar(8) NOT NULL,
  PRIMARY KEY (method_id, currency_code),
  FOREIGN KEY (organization_id, currency_code)
    REFERENCES currencies (organization_id, code) ON DELETE RESTRICT
);

CREATE TABLE method_amount_limits (
  method_id uuid NOT NULL,
  currency_code varchar(8) NOT NULL,
  amount numeric(38, 8) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (method_id, currency_code),
  FOREIGN KEY (method_id, currency_code)
    REFERENCES method_allowed_currencies (method_id, currency_code) ON DELETE RESTRICT
);

CREATE TABLE idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  scope varchar(96) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_digest char(64) NOT NULL,
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, scope, idempotency_key)
);
