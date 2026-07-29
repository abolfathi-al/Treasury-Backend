ALTER TABLE treasury_units
  ADD CONSTRAINT treasury_units_organization_id_id_key UNIQUE (organization_id, id);

ALTER TABLE user_refs
  ADD CONSTRAINT user_refs_organization_id_id_key UNIQUE (organization_id, id);

CREATE TABLE cashboxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  branch_id uuid,
  treasury_unit_id uuid NOT NULL,
  code varchar(64) NOT NULL,
  name varchar(160) NOT NULL,
  cashbox_type varchar(32) NOT NULL CHECK (cashbox_type IN (
    'CASH', 'FOREIGN_CURRENCY', 'SALES', 'BRANCH', 'TEMPORARY', 'VIRTUAL',
    'INSTRUMENT', 'CHEQUE', 'COLLECTION', 'CUSTODIAL', 'PETTY_CASH'
  )),
  main_currency varchar(8) NOT NULL,
  can_receive boolean NOT NULL,
  can_pay boolean NOT NULL,
  can_transfer boolean NOT NULL,
  requires_approval boolean NOT NULL,
  accounting_dimensions jsonb,
  active_from timestamptz NOT NULL,
  active_to timestamptz,
  state varchar(16) NOT NULL DEFAULT 'ACTIVE'
    CHECK (state IN ('DRAFT', 'ACTIVE', 'SUSPENDED', 'CLOSED')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, branch_id)
    REFERENCES branches(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, treasury_unit_id)
    REFERENCES treasury_units(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, main_currency)
    REFERENCES currencies(organization_id, code) ON DELETE RESTRICT,
  CHECK (active_to IS NULL OR active_to > active_from)
);

CREATE TABLE cashbox_currency_controls (
  cashbox_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  currency varchar(8) NOT NULL,
  transaction_ceiling numeric(38, 8)
    CHECK (transaction_ceiling IS NULL OR transaction_ceiling >= 0),
  minimum_position numeric(38, 8),
  maximum_holding numeric(38, 8)
    CHECK (maximum_holding IS NULL OR maximum_holding >= 0),
  allow_negative boolean NOT NULL DEFAULT false,
  PRIMARY KEY (cashbox_id, currency),
  FOREIGN KEY (organization_id, cashbox_id)
    REFERENCES cashboxes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, currency)
    REFERENCES currencies(organization_id, code) ON DELETE RESTRICT,
  CHECK (
    minimum_position IS NULL OR maximum_holding IS NULL
    OR minimum_position <= maximum_holding
  ),
  CHECK (minimum_position IS NULL OR minimum_position >= 0 OR allow_negative)
);

ALTER TABLE cashboxes
  ADD CONSTRAINT cashboxes_main_currency_control_fk
  FOREIGN KEY (id, main_currency)
  REFERENCES cashbox_currency_controls(cashbox_id, currency)
  DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION enforce_cashbox_treasury_unit_branch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  unit_branch_id uuid;
BEGIN
  SELECT branch_id INTO STRICT unit_branch_id
  FROM treasury_units
  WHERE organization_id = NEW.organization_id AND id = NEW.treasury_unit_id;
  IF NEW.branch_id IS DISTINCT FROM unit_branch_id THEN
    RAISE EXCEPTION 'Cashbox Branch must equal its Treasury Unit Branch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER cashbox_treasury_unit_branch_consistency
AFTER INSERT OR UPDATE OF organization_id, treasury_unit_id, branch_id ON cashboxes
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION enforce_cashbox_treasury_unit_branch();

CREATE FUNCTION enforce_treasury_unit_cashbox_branches()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM cashboxes
    WHERE organization_id = NEW.organization_id
      AND treasury_unit_id = NEW.id
      AND branch_id IS DISTINCT FROM NEW.branch_id
  ) THEN
    RAISE EXCEPTION 'Treasury Unit Branch conflicts with an existing Cashbox'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER treasury_unit_cashbox_branch_consistency
AFTER UPDATE OF organization_id, id, branch_id ON treasury_units
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION enforce_treasury_unit_cashbox_branches();

CREATE TABLE cashbox_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  cashbox_id uuid NOT NULL,
  user_id uuid NOT NULL,
  assignment_type varchar(16) NOT NULL
    CHECK (assignment_type IN ('PRIMARY', 'SUBSTITUTE')),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  state varchar(16) NOT NULL
    CHECK (state IN ('SCHEDULED', 'ACTIVE', 'ENDED', 'CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, cashbox_id, id),
  FOREIGN KEY (organization_id, cashbox_id)
    REFERENCES cashboxes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, user_id)
    REFERENCES user_refs(organization_id, id) ON DELETE RESTRICT,
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE UNIQUE INDEX cashbox_current_primary_assignment_unique
  ON cashbox_assignments(cashbox_id)
  WHERE assignment_type = 'PRIMARY' AND state = 'ACTIVE';

CREATE TABLE cashbox_handovers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  cashbox_id uuid NOT NULL,
  current_assignment_id uuid NOT NULL,
  handover_number varchar(64) NOT NULL,
  outgoing_user_id uuid NOT NULL,
  incoming_user_id uuid NOT NULL,
  book_snapshot_digest varchar(128) NOT NULL,
  has_discrepancy boolean NOT NULL,
  reason varchar(500),
  state varchar(24) NOT NULL CHECK (state IN (
    'DRAFT', 'COUNTED', 'OFFERED', 'ACCEPTED', 'APPROVED', 'COMPLETED',
    'REJECTED', 'CANCELLED'
  )),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_by_user_id uuid NOT NULL,
  request_id varchar(128) NOT NULL,
  counted_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (cashbox_id, handover_number),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, cashbox_id)
    REFERENCES cashboxes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, cashbox_id, current_assignment_id)
    REFERENCES cashbox_assignments(organization_id, cashbox_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, outgoing_user_id)
    REFERENCES user_refs(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, incoming_user_id)
    REFERENCES user_refs(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, created_by_user_id)
    REFERENCES user_refs(organization_id, id) ON DELETE RESTRICT,
  CHECK (outgoing_user_id <> incoming_user_id),
  CHECK (created_by_user_id = outgoing_user_id),
  CHECK (
    NOT has_discrepancy
    OR (reason IS NOT NULL AND char_length(btrim(reason)) > 0)
  ),
  CHECK (
    (state = 'COMPLETED' AND completed_at IS NOT NULL)
    OR (state <> 'COMPLETED' AND completed_at IS NULL)
  )
);

CREATE UNIQUE INDEX cashbox_nonterminal_handover_unique
  ON cashbox_handovers(cashbox_id)
  WHERE state NOT IN ('COMPLETED', 'REJECTED', 'CANCELLED');

CREATE TABLE cashbox_handover_money (
  handover_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  currency varchar(8) NOT NULL,
  book_amount numeric(38, 8) NOT NULL,
  counted_amount numeric(38, 8) NOT NULL,
  variance_amount numeric(38, 8) NOT NULL,
  PRIMARY KEY (handover_id, currency),
  FOREIGN KEY (organization_id, handover_id)
    REFERENCES cashbox_handovers(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, currency)
    REFERENCES currencies(organization_id, code) ON DELETE RESTRICT,
  CHECK (variance_amount = counted_amount - book_amount)
);

CREATE TABLE cashbox_handover_instruments (
  handover_id uuid NOT NULL REFERENCES cashbox_handovers(id) ON DELETE RESTRICT,
  instrument_id varchar(128) NOT NULL,
  instrument_type varchar(16) NOT NULL
    CHECK (instrument_type IN ('CHEQUE', 'DOCUMENT', 'OTHER')),
  reference varchar(200) NOT NULL CHECK (char_length(btrim(reference)) > 0),
  observed boolean NOT NULL,
  PRIMARY KEY (handover_id, instrument_id)
);

ALTER TABLE access_grant_cashbox_scopes
  ADD CONSTRAINT access_grant_cashbox_scopes_cashbox_fk
  FOREIGN KEY (cashbox_id) REFERENCES cashboxes(id) ON DELETE RESTRICT;

CREATE INDEX cashboxes_list_idx ON cashboxes(organization_id, code, id);
CREATE INDEX cashbox_assignments_current_idx
  ON cashbox_assignments(cashbox_id, state, effective_from, effective_to);
