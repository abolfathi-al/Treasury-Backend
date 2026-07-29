ALTER TABLE identity_accounts
  ADD COLUMN authorization_epoch bigint NOT NULL DEFAULT 0
  CHECK (authorization_epoch >= 0);

ALTER TABLE roles
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE operation_permissions (
  permission varchar(128) PRIMARY KEY
);

INSERT INTO operation_permissions (permission) VALUES
  ('access-control.view'),
  ('access-grant.manage'),
  ('accounting.acknowledge'),
  ('accounting.export'),
  ('accounting.import'),
  ('approval-policy.manage'),
  ('auth.login'),
  ('auth.logout'),
  ('auth.verify-totp'),
  ('bank-account.manage'),
  ('bank-account.view'),
  ('bank-branch.manage'),
  ('bank-branch.view'),
  ('bank-instruction.record-outcome'),
  ('bank-reconciliation.confirm'),
  ('bank-reconciliation.match'),
  ('bank-reconciliation.view'),
  ('bank-statement.import'),
  ('bank-type.manage'),
  ('bank-type.view'),
  ('bank.manage'),
  ('bank.view'),
  ('cashbox.close'),
  ('cashbox.handover'),
  ('cashbox.manage'),
  ('cashbox.reopen'),
  ('cashbox.view'),
  ('cheque-book.manage'),
  ('cheque.transition'),
  ('collection.view'),
  ('delegation.manage'),
  ('identity-account.manage'),
  ('master-data.manage'),
  ('master-data.view'),
  ('notification-endpoint.manage'),
  ('notification-endpoint.view'),
  ('party.manage'),
  ('party.view'),
  ('payment-gateway.manage'),
  ('payment-gateway.view'),
  ('payment-request.create'),
  ('payment.approve'),
  ('payment.create'),
  ('payment.execute'),
  ('payment.reverse'),
  ('payment.submit'),
  ('payment.view'),
  ('petty-cash.create'),
  ('petty-cash.view'),
  ('pos-terminal.manage'),
  ('pos-terminal.view'),
  ('print-template.manage'),
  ('print-template.view'),
  ('receipt.approve'),
  ('receipt.create'),
  ('receipt.edit-draft'),
  ('receipt.execute'),
  ('receipt.reverse'),
  ('receipt.submit'),
  ('receipt.view'),
  ('report.view'),
  ('role.manage'),
  ('settlement.confirm'),
  ('settlement.create'),
  ('settlement.reverse'),
  ('transfer.approve'),
  ('transfer.create'),
  ('transfer.receive'),
  ('transfer.release'),
  ('transfer.submit'),
  ('transfer.view');

ALTER TABLE role_permissions
  ADD CONSTRAINT role_permissions_permission_fk
  FOREIGN KEY (permission) REFERENCES operation_permissions(permission) ON DELETE RESTRICT;

ALTER TABLE access_grants
  DROP CONSTRAINT IF EXISTS access_grants_user_ref_id_role_id_scope_type_scope_id_key,
  DROP CONSTRAINT IF EXISTS access_grants_state_check,
  ADD COLUMN amount_ceiling numeric(38,8),
  ADD COLUMN amount_ceiling_currency varchar(8),
  ADD COLUMN valid_from timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN valid_to timestamptz,
  ADD COLUMN reason varchar(500),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT access_grants_amount_positive CHECK (amount_ceiling IS NULL OR amount_ceiling > 0),
  ADD CONSTRAINT access_grants_amount_pair CHECK (
    (amount_ceiling IS NULL AND amount_ceiling_currency IS NULL)
    OR (amount_ceiling IS NOT NULL AND amount_ceiling_currency IS NOT NULL)
  ),
  ADD CONSTRAINT access_grants_valid_interval CHECK (valid_to IS NULL OR valid_to > valid_from),
  ADD CONSTRAINT access_grants_organization_id_id_key UNIQUE (organization_id, id),
  ADD CONSTRAINT access_grants_amount_currency_fk
    FOREIGN KEY (organization_id, amount_ceiling_currency)
    REFERENCES currencies (organization_id, code) ON DELETE RESTRICT;

UPDATE access_grants SET state = 'REVOKED' WHERE state = 'INACTIVE';
ALTER TABLE access_grants
  ADD CONSTRAINT access_grants_state_check CHECK (state IN ('ACTIVE', 'REVOKED', 'EXPIRED'));

CREATE TABLE access_grant_branch_scopes (
  access_grant_id uuid NOT NULL REFERENCES access_grants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  PRIMARY KEY (access_grant_id, branch_id)
);

CREATE TABLE access_grant_treasury_unit_scopes (
  access_grant_id uuid NOT NULL REFERENCES access_grants(id) ON DELETE RESTRICT,
  treasury_unit_id uuid NOT NULL REFERENCES treasury_units(id) ON DELETE RESTRICT,
  PRIMARY KEY (access_grant_id, treasury_unit_id)
);

-- Cashbox and BankAccount owner tables are not present in INC-1B. Their
-- identifiers remain normalized, and commands fail closed before insertion.
CREATE TABLE access_grant_cashbox_scopes (
  access_grant_id uuid NOT NULL REFERENCES access_grants(id) ON DELETE RESTRICT,
  cashbox_id uuid NOT NULL,
  PRIMARY KEY (access_grant_id, cashbox_id)
);

CREATE TABLE access_grant_bank_account_scopes (
  access_grant_id uuid NOT NULL REFERENCES access_grants(id) ON DELETE RESTRICT,
  bank_account_id uuid NOT NULL,
  PRIMARY KEY (access_grant_id, bank_account_id)
);

CREATE TABLE access_grant_document_type_scopes (
  access_grant_id uuid NOT NULL REFERENCES access_grants(id) ON DELETE RESTRICT,
  document_type varchar(64) NOT NULL,
  PRIMARY KEY (access_grant_id, document_type)
);

CREATE TABLE access_grant_method_category_scopes (
  access_grant_id uuid NOT NULL REFERENCES access_grants(id) ON DELETE RESTRICT,
  method_category varchar(64) NOT NULL,
  PRIMARY KEY (access_grant_id, method_category)
);

CREATE TABLE access_grant_currency_scopes (
  access_grant_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  currency varchar(8) NOT NULL,
  PRIMARY KEY (access_grant_id, currency),
  FOREIGN KEY (organization_id, access_grant_id)
    REFERENCES access_grants (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, currency)
    REFERENCES currencies (organization_id, code) ON DELETE RESTRICT
);

ALTER TABLE auth_sessions
  ADD COLUMN logical_session_id uuid,
  ADD COLUMN authorized_epoch bigint NOT NULL DEFAULT 0 CHECK (authorized_epoch >= 0),
  ADD COLUMN rotation_parent_id uuid,
  ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN rotated_at timestamptz,
  ADD COLUMN predecessor_valid_until timestamptz,
  ADD COLUMN revocation_reason varchar(500),
  ADD COLUMN state varchar(16) NOT NULL DEFAULT 'ACTIVE';

UPDATE auth_sessions s
SET logical_session_id = s.id,
    authorized_epoch = ia.authorization_epoch,
    last_seen_at = s.last_rotated_at,
    state = CASE WHEN s.revoked_at IS NULL THEN 'ACTIVE' ELSE 'REVOKED' END
FROM identity_accounts ia
WHERE ia.id = s.identity_account_id;

ALTER TABLE auth_sessions
  ALTER COLUMN logical_session_id SET NOT NULL,
  ADD CONSTRAINT auth_sessions_logical_session_fk
    FOREIGN KEY (logical_session_id) REFERENCES auth_sessions(id) ON DELETE RESTRICT,
  ADD CONSTRAINT auth_sessions_rotation_parent_fk
    FOREIGN KEY (rotation_parent_id) REFERENCES auth_sessions(id) ON DELETE RESTRICT,
  ADD CONSTRAINT auth_sessions_rotation_parent_key UNIQUE (rotation_parent_id),
  ADD CONSTRAINT auth_sessions_state_check
    CHECK (state IN ('ACTIVE', 'ROTATED', 'REVOKED', 'EXPIRED')),
  ADD CONSTRAINT auth_sessions_rotation_times_check CHECK (
    (state = 'ROTATED' AND rotated_at IS NOT NULL AND predecessor_valid_until IS NOT NULL)
    OR (state <> 'ROTATED' AND rotated_at IS NULL AND predecessor_valid_until IS NULL)
  );

CREATE FUNCTION initialize_auth_session_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.logical_session_id IS NULL THEN
    NEW.logical_session_id := NEW.id;
  END IF;
  IF NEW.authorized_epoch = 0 THEN
    SELECT authorization_epoch INTO NEW.authorized_epoch
    FROM identity_accounts WHERE id = NEW.identity_account_id;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER auth_sessions_initialize_chain
BEFORE INSERT ON auth_sessions
FOR EACH ROW EXECUTE FUNCTION initialize_auth_session_chain();

CREATE INDEX auth_sessions_logical_tail_idx
  ON auth_sessions (identity_account_id, logical_session_id, state);
CREATE INDEX access_grants_active_user_idx
  ON access_grants (organization_id, user_ref_id, state, valid_from, valid_to);
