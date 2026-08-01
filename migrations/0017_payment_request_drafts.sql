CREATE TABLE payment_request_number_counters (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE RESTRICT,
  next_value bigint NOT NULL DEFAULT 1 CHECK (next_value > 0)
);

CREATE TABLE payment_number_counters (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  business_date date NOT NULL,
  next_value bigint NOT NULL DEFAULT 1 CHECK (next_value > 0),
  PRIMARY KEY (organization_id, business_date)
);

CREATE TABLE payment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  business_number varchar(64) NOT NULL,
  requester_user_id uuid NOT NULL,
  beneficiary_party_id uuid NOT NULL,
  requested_amount numeric(38,8) NOT NULL CHECK (requested_amount > 0),
  currency varchar(8) NOT NULL,
  branch_id uuid,
  treasury_unit_id uuid,
  due_date date,
  purpose varchar(1000) NOT NULL,
  contract_ref varchar(128),
  invoice_ref varchar(128),
  accounting_dimensions jsonb,
  approval_progress jsonb NOT NULL
    DEFAULT '{"state":"NOT_STARTED","completedSteps":0,"requiredSteps":0}'::jsonb
    CHECK (approval_progress = '{"state":"NOT_STARTED","completedSteps":0,"requiredSteps":0}'::jsonb),
  state varchar(32) NOT NULL DEFAULT 'DRAFT' CHECK (state = 'DRAFT'),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, business_number),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, requester_user_id)
    REFERENCES user_refs(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, beneficiary_party_id)
    REFERENCES parties(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, branch_id)
    REFERENCES branches(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, treasury_unit_id)
    REFERENCES treasury_units(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, currency)
    REFERENCES currencies(organization_id, code) ON DELETE RESTRICT
);

CREATE TABLE payment_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  business_number varchar(64) NOT NULL,
  business_date date NOT NULL,
  beneficiary_party_id uuid NOT NULL,
  payment_request_id uuid,
  branch_id uuid,
  treasury_unit_id uuid NOT NULL,
  base_currency varchar(8) NOT NULL,
  total_base_amount numeric(38,8) NOT NULL CHECK (total_base_amount > 0),
  due_date date,
  purpose varchar(1000) NOT NULL,
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
  FOREIGN KEY (organization_id, beneficiary_party_id)
    REFERENCES parties(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, payment_request_id)
    REFERENCES payment_requests(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, branch_id)
    REFERENCES branches(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, treasury_unit_id)
    REFERENCES treasury_units(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, base_currency)
    REFERENCES currencies(organization_id, code) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, creator_user_id)
    REFERENCES user_refs(organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX payment_documents_list_idx
  ON payment_documents (organization_id, business_date DESC, id DESC);

CREATE TABLE payment_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  payment_document_id uuid NOT NULL,
  line_number integer NOT NULL CHECK (line_number > 0),
  method_id uuid NOT NULL,
  method_name varchar(160) NOT NULL,
  method_category varchar(32) NOT NULL,
  method_required_references jsonb NOT NULL
    CHECK (jsonb_typeof(method_required_references) = 'array'),
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
  beneficiary_party_id uuid NOT NULL,
  beneficiary_account_reference varchar(128),
  tracking_number varchar(128),
  due_date date,
  description varchar(1000),
  accounting_dimensions jsonb,
  state varchar(16) NOT NULL DEFAULT 'DRAFT' CHECK (state = 'DRAFT'),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, payment_document_id, line_number),
  FOREIGN KEY (organization_id, payment_document_id, base_currency)
    REFERENCES payment_documents(organization_id, id, base_currency) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, method_id)
    REFERENCES method_definitions(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, cashbox_id)
    REFERENCES cashboxes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, bank_account_id)
    REFERENCES bank_accounts(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, beneficiary_party_id)
    REFERENCES parties(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, currency)
    REFERENCES currencies(organization_id, code) ON DELETE RESTRICT,
  CHECK (
    (rate_source = 'IDENTITY' AND currency = base_currency AND exchange_rate = 1
      AND rate_record_id IS NULL AND rounding_difference = 0)
    OR
    (rate_source = 'TABLE' AND currency <> base_currency AND rate_record_id IS NOT NULL)
  )
);

CREATE TABLE payment_request_attachment_links (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  payment_request_id uuid NOT NULL,
  attachment_id uuid NOT NULL,
  content_digest char(64) NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  purpose varchar(64) NOT NULL DEFAULT '',
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, payment_request_id, attachment_id, purpose),
  FOREIGN KEY (organization_id, payment_request_id)
    REFERENCES payment_requests(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, attachment_id, content_digest)
    REFERENCES attachments(organization_id, id, content_digest) ON DELETE RESTRICT
);

CREATE TABLE payment_line_attachment_links (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  payment_line_id uuid NOT NULL,
  attachment_id uuid NOT NULL,
  content_digest char(64) NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  purpose varchar(64) NOT NULL DEFAULT '',
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, payment_line_id, attachment_id, purpose),
  FOREIGN KEY (organization_id, payment_line_id)
    REFERENCES payment_lines(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, attachment_id, content_digest)
    REFERENCES attachments(organization_id, id, content_digest) ON DELETE RESTRICT
);

CREATE FUNCTION enforce_payment_treasury_unit_branch_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.branch_id IS NOT NULL
     AND NEW.treasury_unit_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM treasury_units
       WHERE organization_id = NEW.organization_id
         AND id = NEW.treasury_unit_id
         AND branch_id = NEW.branch_id
     ) THEN
    RAISE EXCEPTION 'Payment Branch must match the selected Treasury Unit Branch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER payment_request_treasury_unit_branch_guard
AFTER INSERT OR UPDATE OF organization_id, branch_id, treasury_unit_id ON payment_requests
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_payment_treasury_unit_branch_consistency();

CREATE CONSTRAINT TRIGGER payment_document_treasury_unit_branch_guard
AFTER INSERT OR UPDATE OF organization_id, branch_id, treasury_unit_id ON payment_documents
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_payment_treasury_unit_branch_consistency();

CREATE FUNCTION prevent_payment_child_reparenting()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'payment_lines'
     AND (NEW.organization_id, NEW.payment_document_id, NEW.base_currency)
         IS DISTINCT FROM
         (OLD.organization_id, OLD.payment_document_id, OLD.base_currency) THEN
    RAISE EXCEPTION 'Payment Line organization, parent, and base currency are immutable'
      USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'payment_request_attachment_links'
     AND (NEW.organization_id, NEW.payment_request_id, NEW.attachment_id, NEW.content_digest)
         IS DISTINCT FROM
         (OLD.organization_id, OLD.payment_request_id, OLD.attachment_id, OLD.content_digest) THEN
    RAISE EXCEPTION 'Payment Request evidence parents and digest are immutable'
      USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'payment_line_attachment_links'
     AND (NEW.organization_id, NEW.payment_line_id, NEW.attachment_id, NEW.content_digest)
         IS DISTINCT FROM
         (OLD.organization_id, OLD.payment_line_id, OLD.attachment_id, OLD.content_digest) THEN
    RAISE EXCEPTION 'Payment Line evidence parents and digest are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_line_reparent_guard
BEFORE UPDATE ON payment_lines
FOR EACH ROW EXECUTE FUNCTION prevent_payment_child_reparenting();

CREATE TRIGGER payment_request_attachment_reparent_guard
BEFORE UPDATE ON payment_request_attachment_links
FOR EACH ROW EXECUTE FUNCTION prevent_payment_child_reparenting();

CREATE TRIGGER payment_line_attachment_reparent_guard
BEFORE UPDATE ON payment_line_attachment_links
FOR EACH ROW EXECUTE FUNCTION prevent_payment_child_reparenting();

CREATE FUNCTION enforce_payment_line_total()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_organization_id uuid;
  target_payment_id uuid;
  expected_total numeric(38,8);
  actual_total numeric(38,8);
  line_count bigint;
BEGIN
  IF TG_TABLE_NAME = 'payment_documents' THEN
    target_organization_id := NEW.organization_id;
    target_payment_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    target_organization_id := OLD.organization_id;
    target_payment_id := OLD.payment_document_id;
  ELSE
    target_organization_id := NEW.organization_id;
    target_payment_id := NEW.payment_document_id;
  END IF;

  SELECT total_base_amount
  INTO expected_total
  FROM payment_documents
  WHERE organization_id = target_organization_id AND id = target_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(*), COALESCE(SUM(base_amount), 0)
  INTO line_count, actual_total
  FROM payment_lines
  WHERE organization_id = target_organization_id
    AND payment_document_id = target_payment_id;

  IF line_count = 0 OR actual_total <> expected_total THEN
    RAISE EXCEPTION 'Payment requires at least one line and exact derived header total'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER payment_document_total_guard
AFTER INSERT OR UPDATE ON payment_documents
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_payment_line_total();

CREATE CONSTRAINT TRIGGER payment_line_total_guard
AFTER INSERT OR UPDATE OR DELETE ON payment_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_payment_line_total();
