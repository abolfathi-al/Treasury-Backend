CREATE TABLE bank_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  code varchar(32) NOT NULL,
  display_name varchar(160) NOT NULL,
  description varchar(500),
  state varchar(16) NOT NULL DEFAULT 'ACTIVE'
    CHECK (state IN ('ACTIVE', 'INACTIVE')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code),
  UNIQUE (organization_id, id),
  CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$')
);

CREATE TABLE banks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  bank_type_id uuid NOT NULL,
  code varchar(32) NOT NULL,
  display_name varchar(200) NOT NULL,
  english_name varchar(200),
  country_code char(2) NOT NULL,
  national_bank_code varchar(32),
  swift_code varchar(11),
  logo_ref varchar(256),
  state varchar(16) NOT NULL DEFAULT 'ACTIVE'
    CHECK (state IN ('ACTIVE', 'INACTIVE')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, bank_type_id)
    REFERENCES bank_types(organization_id, id) ON DELETE RESTRICT,
  CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  CHECK (country_code ~ '^[A-Z]{2}$'),
  CHECK (
    national_bank_code IS NULL
    OR national_bank_code ~ '^[A-Z0-9][A-Z0-9._-]{0,31}$'
  ),
  CHECK (swift_code IS NULL OR swift_code ~ '^[A-Z0-9]{8}([A-Z0-9]{3})?$')
);

CREATE TABLE bank_branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  bank_id uuid NOT NULL,
  code varchar(32) NOT NULL,
  name varchar(200) NOT NULL,
  city varchar(100),
  address varchar(500),
  contact_reference varchar(256),
  state varchar(16) NOT NULL DEFAULT 'ACTIVE'
    CHECK (state IN ('ACTIVE', 'INACTIVE')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bank_id, code),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, bank_id, id),
  FOREIGN KEY (organization_id, bank_id)
    REFERENCES banks(organization_id, id) ON DELETE RESTRICT,
  CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$')
);

CREATE TABLE bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  bank_id uuid NOT NULL,
  bank_branch_id uuid,
  organization_branch_id uuid,
  treasury_unit_id uuid,
  account_type varchar(32) NOT NULL CHECK (account_type IN (
    'CURRENT', 'SAVINGS', 'SHORT_TERM', 'LONG_TERM', 'FOREIGN_CURRENCY',
    'DEPOSIT', 'INTERMEDIARY', 'FUNDS_IN_TRANSIT', 'FACILITY_REFERENCE',
    'GUARANTEE_REFERENCE'
  )),
  account_number varchar(64) NOT NULL,
  iban varchar(64),
  masked_card_number varchar(32),
  currency varchar(8) NOT NULL,
  legal_owner_name varchar(200) NOT NULL,
  opening_date date NOT NULL,
  closing_date date,
  cheque_enabled boolean NOT NULL DEFAULT false,
  can_receive boolean NOT NULL,
  can_pay boolean NOT NULL,
  can_transfer boolean NOT NULL,
  withdrawal_ceiling numeric(38, 8),
  withdrawal_ceiling_currency varchar(8),
  accounting_dimensions jsonb,
  state varchar(16) NOT NULL DEFAULT 'DRAFT'
    CHECK (state IN ('DRAFT', 'ACTIVE', 'SUSPENDED', 'CLOSED')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, bank_id, account_number),
  UNIQUE (organization_id, iban),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, bank_id)
    REFERENCES banks(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, bank_id, bank_branch_id)
    REFERENCES bank_branches(organization_id, bank_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, organization_branch_id)
    REFERENCES branches(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, treasury_unit_id)
    REFERENCES treasury_units(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, currency)
    REFERENCES currencies(organization_id, code) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, withdrawal_ceiling_currency)
    REFERENCES currencies(organization_id, code) ON DELETE RESTRICT,
  CHECK ((state = 'CLOSED') = (closing_date IS NOT NULL)),
  CHECK (closing_date IS NULL OR closing_date >= opening_date),
  CHECK (
    masked_card_number IS NULL
    OR masked_card_number ~ '^[*Xx][*Xx -]*[0-9]{4}$'
  ),
  CONSTRAINT bank_accounts_cheque_eligibility
    CHECK (NOT cheque_enabled OR account_type = 'CURRENT'),
  CONSTRAINT bank_accounts_withdrawal_ceiling CHECK (
    (withdrawal_ceiling IS NULL AND withdrawal_ceiling_currency IS NULL)
    OR (
      withdrawal_ceiling IS NOT NULL
      AND withdrawal_ceiling_currency IS NOT NULL
      AND withdrawal_ceiling >= 0
      AND withdrawal_ceiling_currency = currency
    )
  )
);

CREATE TABLE pos_terminals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  bank_account_id uuid NOT NULL,
  treasury_unit_id uuid NOT NULL,
  terminal_number varchar(64) NOT NULL,
  merchant_number varchar(64) NOT NULL,
  provider_label varchar(160),
  currency varchar(8) NOT NULL,
  settlement_cycle varchar(64) NOT NULL,
  fee_rule_ref varchar(128),
  state varchar(16) NOT NULL DEFAULT 'ACTIVE'
    CHECK (state IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, terminal_number),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, bank_account_id)
    REFERENCES bank_accounts(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, treasury_unit_id)
    REFERENCES treasury_units(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, currency)
    REFERENCES currencies(organization_id, code) ON DELETE RESTRICT
);

CREATE TABLE payment_gateways (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  bank_account_id uuid NOT NULL,
  treasury_unit_id uuid NOT NULL,
  provider_code varchar(64) NOT NULL,
  merchant_id varchar(128) NOT NULL,
  terminal_id varchar(128) NOT NULL,
  currency varchar(8) NOT NULL,
  settlement_cycle varchar(64) NOT NULL,
  fee_rule_ref varchar(128),
  funds_in_transit_mapping_ref varchar(128),
  fee_mapping_ref varchar(128),
  state varchar(16) NOT NULL DEFAULT 'ACTIVE'
    CHECK (state IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider_code, merchant_id, terminal_id),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, bank_account_id)
    REFERENCES bank_accounts(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, treasury_unit_id)
    REFERENCES treasury_units(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, currency)
    REFERENCES currencies(organization_id, code) ON DELETE RESTRICT,
  CHECK (provider_code ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$')
);

ALTER TABLE access_grant_bank_account_scopes
  ADD CONSTRAINT access_grant_bank_account_scopes_account_fk
  FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id) ON DELETE RESTRICT;

CREATE FUNCTION enforce_banking_institution_availability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'banks' AND NOT EXISTS (
    SELECT 1 FROM bank_types
    WHERE organization_id = NEW.organization_id
      AND id = (to_jsonb(NEW)->>'bank_type_id')::uuid
      AND state = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Bank Type must be ACTIVE in the Bank Organization'
      USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'bank_branches' AND NOT EXISTS (
    SELECT 1 FROM banks
    WHERE organization_id = NEW.organization_id
      AND id = (to_jsonb(NEW)->>'bank_id')::uuid
      AND state = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Bank must be ACTIVE in the Bank Branch Organization'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER bank_type_availability
AFTER INSERT OR UPDATE OF organization_id, bank_type_id ON banks
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION enforce_banking_institution_availability();

CREATE CONSTRAINT TRIGGER bank_availability_for_branch
AFTER INSERT OR UPDATE OF organization_id, bank_id ON bank_branches
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION enforce_banking_institution_availability();

CREATE FUNCTION enforce_bank_account_references()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  unit_branch_id uuid;
  currency_scale integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM banks
    WHERE organization_id = NEW.organization_id
      AND id = NEW.bank_id
      AND state = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Bank Account Bank must be ACTIVE in its Organization'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.bank_branch_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM bank_branches
    WHERE organization_id = NEW.organization_id
      AND bank_id = NEW.bank_id
      AND id = NEW.bank_branch_id
      AND state = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Bank Branch must be ACTIVE and belong to the selected Bank'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.organization_branch_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM branches
    WHERE organization_id = NEW.organization_id
      AND id = NEW.organization_branch_id
      AND state = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Organization Branch must be ACTIVE in the Account Organization'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.treasury_unit_id IS NOT NULL THEN
    SELECT branch_id INTO STRICT unit_branch_id
    FROM treasury_units
    WHERE organization_id = NEW.organization_id
      AND id = NEW.treasury_unit_id
      AND state = 'ACTIVE';
    IF unit_branch_id IS NOT NULL
      AND NEW.organization_branch_id IS NOT NULL
      AND unit_branch_id IS DISTINCT FROM NEW.organization_branch_id
    THEN
      RAISE EXCEPTION 'Treasury Unit Branch conflicts with Organization Branch'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT decimal_places INTO STRICT currency_scale
  FROM currencies
  WHERE organization_id = NEW.organization_id
    AND code = NEW.currency
    AND state = 'ACTIVE';
  IF NEW.withdrawal_ceiling IS NOT NULL
    AND NEW.withdrawal_ceiling <> round(NEW.withdrawal_ceiling, currency_scale)
  THEN
    RAISE EXCEPTION 'Withdrawal ceiling exceeds Currency precision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    RAISE EXCEPTION 'Bank Account reference must be ACTIVE in its Organization'
      USING ERRCODE = '23514';
END;
$$;

CREATE CONSTRAINT TRIGGER bank_account_reference_availability
AFTER INSERT OR UPDATE OF
  organization_id, bank_id, bank_branch_id, organization_branch_id,
  treasury_unit_id, currency, withdrawal_ceiling
ON bank_accounts
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION enforce_bank_account_references();

CREATE FUNCTION enforce_collection_endpoint_references()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM treasury_units
    WHERE organization_id = NEW.organization_id
      AND id = NEW.treasury_unit_id
      AND state = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Collection endpoint Treasury Unit must be ACTIVE'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM bank_accounts
    WHERE organization_id = NEW.organization_id
      AND id = NEW.bank_account_id
      AND state = 'ACTIVE'
      AND can_receive
      AND currency = NEW.currency
  ) THEN
    RAISE EXCEPTION 'Collection endpoint destination Account is unavailable'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM currencies
    WHERE organization_id = NEW.organization_id
      AND code = NEW.currency
      AND state = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Collection endpoint Currency must be ACTIVE'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER pos_terminal_reference_availability
AFTER INSERT OR UPDATE OF
  organization_id, bank_account_id, treasury_unit_id, currency
ON pos_terminals
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION enforce_collection_endpoint_references();

CREATE CONSTRAINT TRIGGER payment_gateway_reference_availability
AFTER INSERT OR UPDATE OF
  organization_id, bank_account_id, treasury_unit_id, currency
ON payment_gateways
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION enforce_collection_endpoint_references();

CREATE INDEX bank_types_list_idx
  ON bank_types(organization_id, code, id);
CREATE INDEX banks_list_idx
  ON banks(organization_id, code, id);
CREATE INDEX bank_branches_list_idx
  ON bank_branches(organization_id, bank_id, code, id);
CREATE INDEX bank_accounts_list_idx
  ON bank_accounts(organization_id, bank_id, account_number, id);
CREATE INDEX bank_accounts_scope_idx
  ON bank_accounts(organization_id, organization_branch_id, treasury_unit_id, currency, state);
CREATE INDEX pos_terminals_list_idx
  ON pos_terminals(organization_id, terminal_number, id);
CREATE INDEX payment_gateways_list_idx
  ON payment_gateways(organization_id, provider_code, merchant_id, terminal_id, id);
