-- Reference-only Cheque Book persistence required by Print Template scope.
-- INC-1F exposes no Cheque Book operation or lookup.
CREATE TABLE cheque_books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id uuid NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  series varchar(32) NOT NULL CHECK (length(btrim(series)) > 0),
  first_leaf bigint NOT NULL,
  last_leaf bigint NOT NULL,
  received_date date NOT NULL,
  custodian_user_id uuid REFERENCES user_refs(id) ON DELETE RESTRICT,
  state varchar(16) NOT NULL DEFAULT 'DRAFT'
    CHECK (state IN ('DRAFT', 'ACTIVE', 'SUSPENDED', 'EXHAUSTED', 'CLOSED')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bank_account_id, series, first_leaf, last_leaf),
  CHECK (last_leaf >= first_leaf)
);

CREATE TABLE print_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  treasury_unit_id uuid,
  bank_id uuid,
  cheque_book_id uuid REFERENCES cheque_books(id) ON DELETE RESTRICT,
  code varchar(64) NOT NULL,
  document_kind varchar(16) NOT NULL
    CHECK (document_kind IN ('RECEIPT', 'PAYMENT', 'TRANSFER', 'CHEQUE')),
  language varchar(8) NOT NULL CHECK (language IN ('fa-IR', 'en')),
  direction varchar(3) NOT NULL CHECK (direction IN ('RTL', 'LTR')),
  page_profile varchar(32) NOT NULL CHECK (page_profile IN (
    'A4_PORTRAIT', 'A4_LANDSCAPE', 'A5_PORTRAIT', 'A5_LANDSCAPE',
    'CHEQUE_CUSTOM'
  )),
  calibration_x_mm numeric(8, 3) NOT NULL DEFAULT 0
    CHECK (calibration_x_mm BETWEEN -100 AND 100),
  calibration_y_mm numeric(8, 3) NOT NULL DEFAULT 0
    CHECK (calibration_y_mm BETWEEN -100 AND 100),
  template_body jsonb NOT NULL CHECK (jsonb_typeof(template_body) = 'object'),
  template_digest char(64) NOT NULL CHECK (template_digest ~ '^[a-f0-9]{64}$'),
  template_version bigint NOT NULL CHECK (template_version > 0),
  state varchar(16) NOT NULL DEFAULT 'DRAFT'
    CHECK (state IN ('DRAFT', 'ACTIVE', 'RETIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code, template_version),
  FOREIGN KEY (organization_id, treasury_unit_id)
    REFERENCES treasury_units(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, bank_id)
    REFERENCES banks(organization_id, id) ON DELETE RESTRICT,
  CHECK (code ~ '^[A-Z][A-Z0-9_-]{1,63}$'),
  CONSTRAINT print_templates_scope_check CHECK (
    (document_kind = 'CHEQUE' AND (bank_id IS NOT NULL OR cheque_book_id IS NOT NULL))
    OR
    (document_kind <> 'CHEQUE' AND bank_id IS NULL AND cheque_book_id IS NULL)
  )
);

CREATE FUNCTION enforce_print_template_reference_availability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cheque_book_organization_id uuid;
  cheque_book_bank_id uuid;
BEGIN
  IF NEW.treasury_unit_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM treasury_units
    WHERE id = NEW.treasury_unit_id
      AND organization_id = NEW.organization_id
      AND state = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION
      'Print Template Treasury Unit must be ACTIVE in the Template Organization'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.bank_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM banks
    WHERE id = NEW.bank_id
      AND organization_id = NEW.organization_id
      AND state = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION
      'Print Template Bank must be ACTIVE in the Template Organization'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.cheque_book_id IS NOT NULL THEN
    SELECT ba.organization_id, ba.bank_id
      INTO cheque_book_organization_id, cheque_book_bank_id
    FROM cheque_books cb
    JOIN bank_accounts ba ON ba.id = cb.bank_account_id
    WHERE cb.id = NEW.cheque_book_id
      AND cb.state = 'ACTIVE';

    IF cheque_book_organization_id IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION
        'Print Template Cheque Book must be ACTIVE in the Template Organization'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.bank_id IS NOT NULL AND cheque_book_bank_id IS DISTINCT FROM NEW.bank_id THEN
      RAISE EXCEPTION
        'Print Template Cheque Book must belong to the selected Bank'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER print_template_reference_availability
AFTER INSERT OR UPDATE OF
  organization_id, treasury_unit_id, bank_id, cheque_book_id
ON print_templates
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_print_template_reference_availability();

CREATE FUNCTION enforce_print_template_version_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    NEW.organization_id,
    NEW.treasury_unit_id,
    NEW.bank_id,
    NEW.cheque_book_id,
    NEW.code,
    NEW.document_kind,
    NEW.language,
    NEW.direction,
    NEW.page_profile,
    NEW.calibration_x_mm,
    NEW.calibration_y_mm,
    NEW.template_body,
    NEW.template_digest,
    NEW.template_version,
    NEW.created_at
  ) IS DISTINCT FROM (
    OLD.organization_id,
    OLD.treasury_unit_id,
    OLD.bank_id,
    OLD.cheque_book_id,
    OLD.code,
    OLD.document_kind,
    OLD.language,
    OLD.direction,
    OLD.page_profile,
    OLD.calibration_x_mm,
    OLD.calibration_y_mm,
    OLD.template_body,
    OLD.template_digest,
    OLD.template_version,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Print Template versions are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER print_template_version_immutability
BEFORE UPDATE ON print_templates
FOR EACH ROW EXECUTE FUNCTION enforce_print_template_version_immutability();

CREATE INDEX print_templates_list_idx
  ON print_templates(organization_id, code ASC, template_version DESC, id ASC);
CREATE INDEX print_templates_match_idx
  ON print_templates(
    organization_id, document_kind, treasury_unit_id, bank_id, cheque_book_id,
    state
  );
