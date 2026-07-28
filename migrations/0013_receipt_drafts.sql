ALTER TABLE parties
  ADD CONSTRAINT parties_organization_id_id_key UNIQUE (organization_id, id);

ALTER TABLE method_definitions
  ADD CONSTRAINT method_definitions_organization_id_id_key UNIQUE (organization_id, id);

CREATE TABLE exchange_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_currency varchar(8) NOT NULL CHECK (source_currency ~ '^[A-Z0-9]{3,8}$'),
  target_currency varchar(8) NOT NULL CHECK (target_currency ~ '^[A-Z0-9]{3,8}$'),
  rate_type varchar(64) NOT NULL,
  rate numeric(38,18) NOT NULL CHECK (rate > 0),
  valid_at timestamptz NOT NULL,
  source_name varchar(160) NOT NULL,
  recorded_by uuid NOT NULL REFERENCES user_refs(id) ON DELETE RESTRICT,
  approved_by uuid REFERENCES user_refs(id) ON DELETE RESTRICT,
  state varchar(16) NOT NULL CHECK (state IN ('DRAFT', 'APPROVED', 'RETIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_currency, target_currency, rate_type, valid_at, source_name),
  CHECK (source_currency <> target_currency)
);

CREATE INDEX exchange_rates_selection_idx
  ON exchange_rates (source_currency, target_currency, valid_at DESC)
  WHERE state = 'APPROVED';

CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  content_digest char(64) NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  attachment_version integer NOT NULL CHECK (attachment_version > 0),
  file_name varchar(255) NOT NULL,
  media_type varchar(128) NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  storage_ref varchar(500) NOT NULL,
  state varchar(16) NOT NULL CHECK (state IN ('ACTIVE', 'SUPERSEDED', 'REDACTED')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, id, content_digest),
  UNIQUE (organization_id, content_digest, attachment_version),
  FOREIGN KEY (organization_id, created_by)
    REFERENCES user_refs(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE receipt_number_counters (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  business_date date NOT NULL,
  next_value bigint NOT NULL CHECK (next_value > 0),
  PRIMARY KEY (organization_id, business_date)
);

CREATE TABLE receipt_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  business_number varchar(64) NOT NULL,
  business_date date NOT NULL,
  entered_at timestamptz NOT NULL,
  party_id uuid NOT NULL,
  branch_id uuid,
  treasury_unit_id uuid NOT NULL,
  base_currency varchar(8) NOT NULL,
  total_base_amount numeric(38,8) NOT NULL CHECK (total_base_amount > 0),
  description varchar(1000),
  purpose varchar(500),
  contract_ref varchar(128),
  invoice_ref varchar(128),
  order_ref varchar(128),
  project_ref varchar(128),
  cost_center_ref varchar(128),
  origin varchar(32) NOT NULL DEFAULT 'MANUAL' CHECK (origin = 'MANUAL'),
  creator_user_id uuid NOT NULL,
  state varchar(32) NOT NULL DEFAULT 'DRAFT' CHECK (state = 'DRAFT'),
  workflow_state varchar(24) NOT NULL DEFAULT 'DRAFT' CHECK (workflow_state = 'DRAFT'),
  execution_state varchar(24) NOT NULL DEFAULT 'NOT_EXECUTED'
    CHECK (execution_state = 'NOT_EXECUTED'),
  accounting_state varchar(24) NOT NULL DEFAULT 'NOT_READY'
    CHECK (accounting_state = 'NOT_READY'),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, business_number),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, id, base_currency),
  FOREIGN KEY (organization_id, party_id)
    REFERENCES parties(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, branch_id)
    REFERENCES branches(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, treasury_unit_id)
    REFERENCES treasury_units(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, base_currency)
    REFERENCES currencies(organization_id, code) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, creator_user_id)
    REFERENCES user_refs(organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX receipt_documents_list_idx
  ON receipt_documents (organization_id, business_date DESC, id DESC);

CREATE TABLE receipt_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  receipt_document_id uuid NOT NULL,
  line_number integer NOT NULL CHECK (line_number > 0),
  method_id uuid NOT NULL,
  method_name varchar(160) NOT NULL,
  method_category varchar(32) NOT NULL,
  method_required_references jsonb NOT NULL CHECK (jsonb_typeof(method_required_references) = 'array'),
  creates_funds_in_transit boolean NOT NULL,
  requires_approval boolean NOT NULL,
  amount numeric(38,8) NOT NULL CHECK (amount > 0),
  currency varchar(8) NOT NULL,
  base_currency varchar(8) NOT NULL,
  exchange_rate numeric(38,18) NOT NULL CHECK (exchange_rate > 0),
  rate_type varchar(64) NOT NULL,
  rate_source varchar(24) NOT NULL CHECK (rate_source IN ('IDENTITY', 'TABLE')),
  rate_record_id uuid REFERENCES exchange_rates(id) ON DELETE RESTRICT,
  rate_at timestamptz NOT NULL,
  base_amount numeric(38,8) NOT NULL CHECK (base_amount > 0),
  rounding_difference numeric(38,8) NOT NULL DEFAULT 0,
  cashbox_id uuid,
  bank_account_id uuid,
  pos_terminal_id uuid,
  payment_gateway_id uuid,
  cheque_bank_id uuid,
  cheque_bank_branch_id uuid,
  cheque_payer_party_id uuid,
  cheque_input jsonb CHECK (cheque_input IS NULL OR jsonb_typeof(cheque_input) = 'object'),
  tracking_number varchar(128),
  payer_account_reference varchar(128),
  due_date date,
  payer_name varchar(200),
  remainder_treatment varchar(24) NOT NULL
    CHECK (remainder_treatment IN ('UNALLOCATED', 'ADVANCE', 'OVERPAYMENT')),
  description varchar(1000),
  accounting_dimensions jsonb,
  state varchar(16) NOT NULL DEFAULT 'DRAFT' CHECK (state = 'DRAFT'),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, id, base_currency),
  UNIQUE (organization_id, receipt_document_id, line_number),
  FOREIGN KEY (organization_id, receipt_document_id, base_currency)
    REFERENCES receipt_documents(organization_id, id, base_currency) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, method_id)
    REFERENCES method_definitions(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, cashbox_id)
    REFERENCES cashboxes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, bank_account_id)
    REFERENCES bank_accounts(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, pos_terminal_id)
    REFERENCES pos_terminals(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, payment_gateway_id)
    REFERENCES payment_gateways(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, cheque_bank_id)
    REFERENCES banks(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, cheque_bank_id, cheque_bank_branch_id)
    REFERENCES bank_branches(organization_id, bank_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, cheque_payer_party_id)
    REFERENCES parties(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, currency)
    REFERENCES currencies(organization_id, code) ON DELETE RESTRICT,
  CHECK (
    (
      cheque_input IS NULL
      AND cheque_bank_id IS NULL
      AND cheque_bank_branch_id IS NULL
      AND cheque_payer_party_id IS NULL
    )
    OR (
      cheque_input IS NOT NULL
      AND cheque_bank_id IS NOT NULL
      AND cheque_input ? 'bankId'
      AND jsonb_typeof(cheque_input->'bankId') IS NOT DISTINCT FROM 'string'
      AND cheque_input->>'bankId' IS NOT DISTINCT FROM cheque_bank_id::text
      AND (
        (NOT (cheque_input ? 'bankBranchId') AND cheque_bank_branch_id IS NULL)
        OR (
          jsonb_typeof(cheque_input->'bankBranchId') IS NOT DISTINCT FROM 'string'
          AND cheque_input->>'bankBranchId'
            IS NOT DISTINCT FROM cheque_bank_branch_id::text
        )
      )
      AND (
        (NOT (cheque_input ? 'payerPartyId') AND cheque_payer_party_id IS NULL)
        OR (
          jsonb_typeof(cheque_input->'payerPartyId') IS NOT DISTINCT FROM 'string'
          AND cheque_input->>'payerPartyId'
            IS NOT DISTINCT FROM cheque_payer_party_id::text
        )
      )
    )
  ),
  CHECK (
    (rate_source = 'IDENTITY' AND rate_record_id IS NULL
      AND currency = base_currency AND exchange_rate = 1 AND rounding_difference = 0)
    OR (rate_source = 'TABLE' AND rate_record_id IS NOT NULL AND currency <> base_currency)
  )
);

CREATE TABLE receipt_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  receipt_line_id uuid NOT NULL,
  external_object_type varchar(32) NOT NULL CHECK (external_object_type IN (
    'INVOICE', 'DEBT', 'CONTRACT_ITEM', 'ACCOUNTING_REFERENCE'
  )),
  external_object_id varchar(128) NOT NULL,
  base_amount numeric(38,8) NOT NULL CHECK (base_amount > 0),
  base_currency varchar(8) NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'ACTIVE' CHECK (state = 'ACTIVE'),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, receipt_line_id, external_object_type, external_object_id),
  FOREIGN KEY (organization_id, receipt_line_id, base_currency)
    REFERENCES receipt_lines(organization_id, id, base_currency) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, base_currency)
    REFERENCES currencies(organization_id, code) ON DELETE RESTRICT
);

CREATE TABLE receipt_line_attachment_links (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  receipt_line_id uuid NOT NULL,
  attachment_id uuid NOT NULL,
  content_digest char(64) NOT NULL,
  purpose varchar(64) NOT NULL DEFAULT '',
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, receipt_line_id, attachment_id, purpose),
  FOREIGN KEY (organization_id, receipt_line_id)
    REFERENCES receipt_lines(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, attachment_id, content_digest)
    REFERENCES attachments(organization_id, id, content_digest) ON DELETE RESTRICT,
  CHECK (content_digest ~ '^[a-f0-9]{64}$')
);

CREATE FUNCTION prevent_receipt_child_reparenting()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'receipt_lines' THEN
    IF (NEW.organization_id, NEW.receipt_document_id, NEW.base_currency)
      IS DISTINCT FROM (OLD.organization_id, OLD.receipt_document_id, OLD.base_currency)
    THEN
      RAISE EXCEPTION 'Receipt Line parent identity is immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'receipt_allocations' THEN
    IF (NEW.organization_id, NEW.receipt_line_id, NEW.base_currency)
      IS DISTINCT FROM (OLD.organization_id, OLD.receipt_line_id, OLD.base_currency)
    THEN
      RAISE EXCEPTION 'Receipt Allocation parent identity is immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'receipt_line_attachment_links' THEN
    IF (NEW.organization_id, NEW.receipt_line_id, NEW.attachment_id, NEW.content_digest)
      IS DISTINCT FROM (OLD.organization_id, OLD.receipt_line_id, OLD.attachment_id, OLD.content_digest)
    THEN
      RAISE EXCEPTION 'Receipt evidence identity is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER receipt_line_reparent_guard
  BEFORE UPDATE ON receipt_lines
  FOR EACH ROW EXECUTE FUNCTION prevent_receipt_child_reparenting();
CREATE TRIGGER receipt_allocation_reparent_guard
  BEFORE UPDATE ON receipt_allocations
  FOR EACH ROW EXECUTE FUNCTION prevent_receipt_child_reparenting();
CREATE TRIGGER receipt_line_attachment_reparent_guard
  BEFORE UPDATE ON receipt_line_attachment_links
  FOR EACH ROW EXECUTE FUNCTION prevent_receipt_child_reparenting();

CREATE FUNCTION enforce_receipt_line_total()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_organization_id uuid;
  target_receipt_id uuid;
  expected_total numeric(38,8);
  actual_total numeric(38,8);
  line_count bigint;
BEGIN
  IF TG_TABLE_NAME = 'receipt_documents' THEN
    target_organization_id := NEW.organization_id;
    target_receipt_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    target_organization_id := OLD.organization_id;
    target_receipt_id := OLD.receipt_document_id;
  ELSE
    target_organization_id := NEW.organization_id;
    target_receipt_id := NEW.receipt_document_id;
  END IF;
  SELECT total_base_amount INTO expected_total
  FROM receipt_documents
  WHERE organization_id = target_organization_id AND id = target_receipt_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*), coalesce(sum(base_amount), 0)
  INTO line_count, actual_total
  FROM receipt_lines
  WHERE organization_id = target_organization_id AND receipt_document_id = target_receipt_id;
  IF line_count = 0 OR actual_total <> expected_total THEN
    RAISE EXCEPTION 'Receipt line total mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER receipt_document_total_guard
  AFTER INSERT OR UPDATE ON receipt_documents DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_receipt_line_total();
CREATE CONSTRAINT TRIGGER receipt_line_total_guard
  AFTER INSERT OR UPDATE OR DELETE ON receipt_lines DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_receipt_line_total();

CREATE FUNCTION enforce_receipt_allocation_total()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_organization_id uuid;
  target_line_id uuid;
  line_total numeric(38,8);
  allocation_total numeric(38,8);
BEGIN
  IF TG_TABLE_NAME = 'receipt_lines' THEN
    target_organization_id := NEW.organization_id;
    target_line_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    target_organization_id := OLD.organization_id;
    target_line_id := OLD.receipt_line_id;
  ELSE
    target_organization_id := NEW.organization_id;
    target_line_id := NEW.receipt_line_id;
  END IF;
  SELECT base_amount INTO line_total
  FROM receipt_lines
  WHERE organization_id = target_organization_id AND id = target_line_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT coalesce(sum(base_amount), 0) INTO allocation_total
  FROM receipt_allocations
  WHERE organization_id = target_organization_id AND receipt_line_id = target_line_id
    AND state = 'ACTIVE';
  IF allocation_total > line_total THEN
    RAISE EXCEPTION 'Receipt allocation exceeds line' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER receipt_line_allocation_guard
  AFTER INSERT OR UPDATE ON receipt_lines DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_receipt_allocation_total();
CREATE CONSTRAINT TRIGGER receipt_allocation_total_guard
  AFTER INSERT OR UPDATE OR DELETE ON receipt_allocations DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_receipt_allocation_total();
