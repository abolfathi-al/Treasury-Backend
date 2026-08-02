INSERT INTO operation_permissions(permission) VALUES ('transfer.reject') ON CONFLICT DO NOTHING;

CREATE TABLE transfer_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  business_number VARCHAR(64) NOT NULL,
  business_date DATE NOT NULL,
  route VARCHAR(32) NOT NULL,
  source_type VARCHAR(16) NOT NULL CHECK (source_type IN ('CASHBOX', 'BANK_ACCOUNT', 'USER')),
  source_id UUID NOT NULL,
  destination_type VARCHAR(16) NOT NULL CHECK (destination_type IN ('CASHBOX', 'BANK_ACCOUNT', 'USER')),
  destination_id UUID NOT NULL,
  source_amount NUMERIC(38,8) NOT NULL CHECK (source_amount > 0),
  source_currency VARCHAR(8) NOT NULL,
  destination_amount NUMERIC(38,8) NOT NULL CHECK (destination_amount > 0),
  destination_currency VARCHAR(8) NOT NULL,
  exchange_rate NUMERIC(38,18) NOT NULL CHECK (exchange_rate > 0),
  rate_type VARCHAR(64) NOT NULL,
  rate_source VARCHAR(16) NOT NULL CHECK (rate_source IN ('IDENTITY', 'TABLE')),
  rate_record_id UUID REFERENCES exchange_rates(id),
  rated_at TIMESTAMPTZ NOT NULL,
  rounding_difference NUMERIC(38,8) NOT NULL,
  expected_receipt_at TIMESTAMPTZ,
  purpose VARCHAR(1000) NOT NULL,
  accounting_dimensions JSONB,
  creator_user_id UUID NOT NULL,
  current_approval_snapshot_id UUID,
  source_custodian_user_id UUID,
  destination_custodian_user_id UUID,
  state VARCHAR(32) NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT', 'REQUESTED', 'APPROVED', 'REJECTED')),
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, business_number),
  FOREIGN KEY (organization_id, source_currency) REFERENCES currencies(organization_id, code),
  FOREIGN KEY (organization_id, destination_currency) REFERENCES currencies(organization_id, code),
  FOREIGN KEY (organization_id, creator_user_id) REFERENCES user_refs(organization_id, id),
  FOREIGN KEY (organization_id, source_custodian_user_id) REFERENCES user_refs(organization_id, id),
  FOREIGN KEY (organization_id, destination_custodian_user_id) REFERENCES user_refs(organization_id, id),
  CHECK (NOT (source_type = destination_type AND source_id = destination_id)),
  CHECK (
    (route = 'CASHBOX_TO_CASHBOX' AND source_type = 'CASHBOX' AND destination_type = 'CASHBOX') OR
    (route = 'CASHBOX_TO_BANK' AND source_type = 'CASHBOX' AND destination_type = 'BANK_ACCOUNT') OR
    (route = 'BANK_TO_CASHBOX' AND source_type = 'BANK_ACCOUNT' AND destination_type = 'CASHBOX') OR
    (route = 'BANK_TO_BANK' AND source_type = 'BANK_ACCOUNT' AND destination_type = 'BANK_ACCOUNT') OR
    (route = 'CASHBOX_TO_USER' AND source_type = 'CASHBOX' AND destination_type = 'USER') OR
    (route = 'USER_TO_CASHBOX' AND source_type = 'USER' AND destination_type = 'CASHBOX') OR
    (route = 'USER_TO_USER' AND source_type = 'USER' AND destination_type = 'USER') OR
    (route IN ('BRANCH_TRANSFER', 'CURRENCY_EXCHANGE') AND source_type IN ('CASHBOX', 'BANK_ACCOUNT') AND destination_type IN ('CASHBOX', 'BANK_ACCOUNT')) OR
    (route = 'PETTY_CASH' AND ((source_type = 'CASHBOX' AND destination_type = 'USER') OR (source_type = 'USER' AND destination_type = 'CASHBOX')))
  ),
  CHECK (
    (source_currency = destination_currency AND rate_source = 'IDENTITY' AND rate_record_id IS NULL
      AND exchange_rate = 1 AND source_amount = destination_amount AND rounding_difference = 0)
    OR (source_currency <> destination_currency AND rate_source = 'TABLE' AND rate_record_id IS NOT NULL)
  ),
  CHECK ((state = 'DRAFT' AND current_approval_snapshot_id IS NULL) OR (state <> 'DRAFT' AND current_approval_snapshot_id IS NOT NULL)),
  CHECK ((source_custodian_user_id IS NULL) = (destination_custodian_user_id IS NULL)),
  CHECK (source_custodian_user_id IS NULL OR source_custodian_user_id <> destination_custodian_user_id),
  CHECK (state <> 'APPROVED' OR source_custodian_user_id IS NOT NULL)
);

CREATE INDEX transfer_documents_list_idx ON transfer_documents (organization_id, business_date DESC, id DESC);

CREATE TABLE transfer_asset_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  transfer_document_id UUID NOT NULL,
  asset_type VARCHAR(24) NOT NULL CHECK (asset_type IN ('RECEIVED_CHEQUE', 'ISSUED_CHEQUE', 'DOCUMENT', 'OTHER_CONTROLLED')),
  asset_id UUID NOT NULL,
  asset_label VARCHAR(240) NOT NULL,
  quantity NUMERIC(38,8) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  state VARCHAR(16) NOT NULL DEFAULT 'PLANNED' CHECK (state IN ('PLANNED', 'RELEASED', 'RECEIVED', 'RETURNED')),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, transfer_document_id, asset_type, asset_id),
  FOREIGN KEY (organization_id, transfer_document_id) REFERENCES transfer_documents(organization_id, id)
);

CREATE TABLE transfer_attachment_links (
  organization_id UUID NOT NULL,
  transfer_document_id UUID NOT NULL,
  attachment_id UUID NOT NULL,
  content_digest CHAR(64) NOT NULL,
  purpose VARCHAR(64),
  PRIMARY KEY (organization_id, transfer_document_id, attachment_id),
  FOREIGN KEY (organization_id, transfer_document_id) REFERENCES transfer_documents(organization_id, id),
  FOREIGN KEY (organization_id, attachment_id, content_digest) REFERENCES attachments(organization_id, id, content_digest)
);

CREATE TABLE transfer_approval_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  code VARCHAR(64) NOT NULL,
  name VARCHAR(240) NOT NULL,
  branch_id UUID,
  treasury_unit_id UUID,
  currency VARCHAR(8),
  amount_minimum NUMERIC(38,8),
  amount_maximum NUMERIC(38,8),
  version INTEGER NOT NULL CHECK (version > 0),
  state VARCHAR(16) NOT NULL CHECK (state IN ('DRAFT', 'ACTIVE', 'RETIRED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, code, version),
  FOREIGN KEY (organization_id, branch_id) REFERENCES branches(organization_id, id),
  FOREIGN KEY (organization_id, treasury_unit_id) REFERENCES treasury_units(organization_id, id),
  FOREIGN KEY (organization_id, currency) REFERENCES currencies(organization_id, code),
  CHECK (amount_maximum IS NULL OR amount_minimum IS NULL OR amount_maximum >= amount_minimum)
);

CREATE INDEX transfer_approval_policy_selection_idx
  ON transfer_approval_policies (organization_id, state, branch_id, treasury_unit_id, currency, amount_minimum, amount_maximum);

CREATE TABLE transfer_approval_policy_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  policy_id UUID NOT NULL,
  step_order INTEGER NOT NULL CHECK (step_order > 0),
  role_id UUID,
  approver_user_id UUID,
  approvals_required INTEGER NOT NULL DEFAULT 1 CHECK (approvals_required > 0),
  separation_rules VARCHAR(64)[] NOT NULL DEFAULT '{}',
  UNIQUE (organization_id, policy_id, step_order),
  UNIQUE (organization_id, policy_id, id),
  FOREIGN KEY (organization_id, policy_id) REFERENCES transfer_approval_policies(organization_id, id),
  FOREIGN KEY (organization_id, role_id) REFERENCES roles(organization_id, id),
  FOREIGN KEY (organization_id, approver_user_id) REFERENCES user_refs(organization_id, id),
  CHECK ((role_id IS NOT NULL) <> (approver_user_id IS NOT NULL)),
  CHECK (separation_rules <@ ARRAY['CREATOR_NOT_APPROVER','SOURCE_CUSTODIAN_NOT_APPROVER']::VARCHAR(64)[])
);

CREATE TABLE transfer_approval_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  transfer_document_id UUID NOT NULL,
  document_version BIGINT NOT NULL CHECK (document_version > 0),
  amount_basis NUMERIC(38,8) NOT NULL CHECK (amount_basis > 0),
  currency VARCHAR(8) NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL,
  policy_id UUID NOT NULL,
  policy_code VARCHAR(64) NOT NULL,
  policy_name VARCHAR(240) NOT NULL,
  policy_version INTEGER NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, transfer_document_id, id),
  UNIQUE (organization_id, transfer_document_id, document_version),
  FOREIGN KEY (organization_id, transfer_document_id) REFERENCES transfer_documents(organization_id, id),
  FOREIGN KEY (organization_id, policy_id) REFERENCES transfer_approval_policies(organization_id, id)
);

CREATE TABLE transfer_approval_snapshot_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  approval_snapshot_id UUID NOT NULL,
  step_order INTEGER NOT NULL,
  role_id UUID,
  role_name VARCHAR(240),
  approver_user_id UUID,
  approver_name VARCHAR(240),
  approvals_required INTEGER NOT NULL,
  separation_rules VARCHAR(64)[] NOT NULL,
  UNIQUE (organization_id, approval_snapshot_id, id),
  UNIQUE (organization_id, approval_snapshot_id, step_order),
  FOREIGN KEY (organization_id, approval_snapshot_id) REFERENCES transfer_approval_snapshots(organization_id, id),
  FOREIGN KEY (organization_id, role_id) REFERENCES roles(organization_id, id),
  FOREIGN KEY (organization_id, approver_user_id) REFERENCES user_refs(organization_id, id),
  CHECK ((role_id IS NOT NULL) <> (approver_user_id IS NOT NULL)),
  CHECK (step_order > 0),
  CHECK (approvals_required > 0),
  CHECK (separation_rules <@ ARRAY['CREATOR_NOT_APPROVER','SOURCE_CUSTODIAN_NOT_APPROVER']::VARCHAR(64)[])
);

CREATE TABLE transfer_approval_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  approval_snapshot_id UUID NOT NULL,
  approval_snapshot_step_id UUID NOT NULL,
  step_order INTEGER NOT NULL,
  actor_user_id UUID NOT NULL,
  delegated_from_user_id UUID,
  action VARCHAR(16) NOT NULL CHECK (action IN ('APPROVED', 'REJECTED')),
  reason VARCHAR(500),
  acted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, approval_snapshot_id, step_order, actor_user_id),
  FOREIGN KEY (organization_id, approval_snapshot_id) REFERENCES transfer_approval_snapshots(organization_id, id),
  FOREIGN KEY (organization_id, approval_snapshot_id, approval_snapshot_step_id)
    REFERENCES transfer_approval_snapshot_steps(organization_id, approval_snapshot_id, id),
  FOREIGN KEY (organization_id, actor_user_id) REFERENCES user_refs(organization_id, id),
  FOREIGN KEY (organization_id, delegated_from_user_id) REFERENCES user_refs(organization_id, id),
  CHECK (action = 'APPROVED' OR NULLIF(BTRIM(reason), '') IS NOT NULL)
);

ALTER TABLE transfer_documents
  ADD CONSTRAINT transfer_documents_snapshot_fk
  FOREIGN KEY (organization_id, id, current_approval_snapshot_id)
  REFERENCES transfer_approval_snapshots(organization_id, transfer_document_id, id);

CREATE FUNCTION prevent_transfer_approval_fact_updates()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Transfer approval facts are immutable' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER transfer_approval_snapshots_immutable
  BEFORE UPDATE OR DELETE ON transfer_approval_snapshots
  FOR EACH ROW EXECUTE FUNCTION prevent_transfer_approval_fact_updates();

CREATE TRIGGER transfer_approval_snapshot_steps_immutable
  BEFORE UPDATE OR DELETE ON transfer_approval_snapshot_steps
  FOR EACH ROW EXECUTE FUNCTION prevent_transfer_approval_fact_updates();

CREATE TRIGGER transfer_approval_actions_immutable
  BEFORE UPDATE OR DELETE ON transfer_approval_actions
  FOR EACH ROW EXECUTE FUNCTION prevent_transfer_approval_fact_updates();

CREATE FUNCTION enforce_transfer_endpoint_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE source_ok BOOLEAN; destination_ok BOOLEAN;
BEGIN
  IF NEW.source_type = 'CASHBOX' THEN
    SELECT EXISTS (SELECT 1 FROM cashboxes c JOIN cashbox_currency_controls cc ON cc.cashbox_id = c.id
      WHERE c.organization_id = NEW.organization_id AND c.id = NEW.source_id AND c.state = 'ACTIVE' AND c.can_transfer AND cc.currency = NEW.source_currency) INTO source_ok;
  ELSIF NEW.source_type = 'BANK_ACCOUNT' THEN
    SELECT EXISTS (SELECT 1 FROM bank_accounts b WHERE b.organization_id = NEW.organization_id AND b.id = NEW.source_id AND b.state = 'ACTIVE' AND b.can_transfer AND b.currency = NEW.source_currency) INTO source_ok;
  ELSE
    SELECT EXISTS (SELECT 1 FROM user_refs u WHERE u.organization_id = NEW.organization_id AND u.id = NEW.source_id AND u.state = 'ACTIVE') INTO source_ok;
  END IF;
  IF NEW.destination_type = 'CASHBOX' THEN
    SELECT EXISTS (SELECT 1 FROM cashboxes c JOIN cashbox_currency_controls cc ON cc.cashbox_id = c.id
      WHERE c.organization_id = NEW.organization_id AND c.id = NEW.destination_id AND c.state = 'ACTIVE' AND c.can_transfer AND cc.currency = NEW.destination_currency) INTO destination_ok;
  ELSIF NEW.destination_type = 'BANK_ACCOUNT' THEN
    SELECT EXISTS (SELECT 1 FROM bank_accounts b WHERE b.organization_id = NEW.organization_id AND b.id = NEW.destination_id AND b.state = 'ACTIVE' AND b.can_transfer AND b.currency = NEW.destination_currency) INTO destination_ok;
  ELSE
    SELECT EXISTS (SELECT 1 FROM user_refs u WHERE u.organization_id = NEW.organization_id AND u.id = NEW.destination_id AND u.state = 'ACTIVE') INTO destination_ok;
  END IF;
  IF NOT source_ok OR NOT destination_ok THEN RAISE EXCEPTION 'transfer endpoint is inactive, outside the Organization, incapable, or wrong-currency'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER transfer_endpoint_scope_guard
BEFORE INSERT OR UPDATE OF organization_id, source_type, source_id, destination_type, destination_id, source_currency, destination_currency
ON transfer_documents FOR EACH ROW EXECUTE FUNCTION enforce_transfer_endpoint_scope();
