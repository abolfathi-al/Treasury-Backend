INSERT INTO operation_permissions (permission)
VALUES ('cashbox.approve'), ('cashbox.reject')
ON CONFLICT DO NOTHING;

CREATE TABLE numbering_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  operation varchar(32) NOT NULL CHECK (operation = 'CASHBOX_DAY_CLOSE'),
  branch_id uuid,
  treasury_unit_id uuid NOT NULL,
  fiscal_year varchar(16) NOT NULL,
  fiscal_year_starts_on date NOT NULL,
  fiscal_year_ends_on date NOT NULL,
  prefix varchar(32) NOT NULL,
  number_width integer NOT NULL CHECK (number_width BETWEEN 1 AND 32),
  next_value bigint NOT NULL DEFAULT 1 CHECK (next_value > 0),
  state varchar(16) NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'CLOSED')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  CONSTRAINT numbering_rules_cashbox_day_scope_unique UNIQUE NULLS NOT DISTINCT (
    organization_id, operation, branch_id, treasury_unit_id, fiscal_year
  ),
  FOREIGN KEY (organization_id, branch_id)
    REFERENCES branches(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, treasury_unit_id)
    REFERENCES treasury_units(organization_id, id) ON DELETE RESTRICT,
  CHECK (fiscal_year_ends_on >= fiscal_year_starts_on)
);

CREATE UNIQUE INDEX numbering_rules_cashbox_day_namespace_unique
  ON numbering_rules (organization_id, (prefix || fiscal_year))
  WHERE operation = 'CASHBOX_DAY_CLOSE';

CREATE TABLE petty_cash_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  cashbox_id uuid NOT NULL,
  ceiling numeric(38,8) NOT NULL CHECK (ceiling > 0),
  expense_category_codes text[] NOT NULL CHECK (cardinality(expense_category_codes) > 0),
  evidence_threshold numeric(38,8),
  settlement_days integer NOT NULL CHECK (settlement_days BETWEEN 1 AND 3650),
  replenishment_source_type varchar(16) NOT NULL
    CHECK (replenishment_source_type IN ('CASHBOX', 'BANK_ACCOUNT')),
  replenishment_source_id uuid NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'ACTIVE'
    CHECK (state IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, cashbox_id),
  FOREIGN KEY (organization_id, cashbox_id)
    REFERENCES cashboxes(organization_id, id) ON DELETE RESTRICT,
  CHECK (evidence_threshold IS NULL OR evidence_threshold >= 0),
  CHECK (evidence_threshold IS NULL OR evidence_threshold <= ceiling),
  CHECK (replenishment_source_type <> 'CASHBOX' OR replenishment_source_id <> cashbox_id)
);

CREATE INDEX petty_cash_profiles_list_idx
  ON petty_cash_profiles (organization_id, cashbox_id, id);

CREATE TABLE cashbox_day_approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  cashbox_id uuid NOT NULL,
  business_date date NOT NULL,
  command_kind varchar(16) NOT NULL CHECK (command_kind IN ('CLOSE', 'REOPEN')),
  command_body jsonb NOT NULL,
  command_digest char(64) NOT NULL CHECK (command_digest ~ '^[a-f0-9]{64}$'),
  source_day_id uuid,
  source_day_version bigint NOT NULL DEFAULT 0 CHECK (source_day_version >= 0),
  requested_by_user_id uuid NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING', 'APPROVED', 'REJECTED')),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (
    organization_id,
    cashbox_id,
    business_date,
    command_kind,
    command_digest,
    source_day_version
  ),
  FOREIGN KEY (organization_id, cashbox_id)
    REFERENCES cashboxes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, requested_by_user_id)
    REFERENCES user_refs(organization_id, id) ON DELETE RESTRICT,
  CHECK (
    (source_day_id IS NULL AND source_day_version = 0)
    OR (source_day_id IS NOT NULL AND source_day_version > 0)
  ),
  CHECK (
    command_kind = 'CLOSE'
    OR (source_day_id IS NOT NULL AND source_day_version > 0)
  )
);

CREATE INDEX cashbox_day_approval_requests_queue_idx
  ON cashbox_day_approval_requests (organization_id, state, created_at DESC, id DESC);

CREATE TABLE cashbox_day_approval_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  approval_request_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  action varchar(16) NOT NULL CHECK (action IN ('APPROVED', 'REJECTED')),
  reason varchar(500),
  acted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, approval_request_id),
  FOREIGN KEY (organization_id, approval_request_id)
    REFERENCES cashbox_day_approval_requests(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, actor_user_id)
    REFERENCES user_refs(organization_id, id) ON DELETE RESTRICT,
  CHECK (action = 'APPROVED' OR NULLIF(BTRIM(reason), '') IS NOT NULL)
);

ALTER TABLE cashbox_days
  ADD COLUMN business_number varchar(128),
  ADD COLUMN prior_close_id uuid,
  ADD COLUMN book_snapshot_digest char(64),
  ADD COLUMN held_instrument_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN observed_instrument_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN approval_action_id uuid,
  ADD COLUMN closed_by_user_id uuid,
  ADD COLUMN closed_at timestamptz,
  ADD COLUMN reopen_reason varchar(500),
  ADD COLUMN reopened_by_user_id uuid,
  ADD COLUMN reopened_at timestamptz,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT cashbox_days_organization_id_id_unique UNIQUE (organization_id, id),
  ADD CONSTRAINT cashbox_days_organization_cashbox_id_unique
    UNIQUE (organization_id, cashbox_id, id),
  ADD CONSTRAINT cashbox_days_business_number_unique UNIQUE (organization_id, business_number),
  ADD CONSTRAINT cashbox_days_prior_close_fk
    FOREIGN KEY (organization_id, cashbox_id, prior_close_id)
    REFERENCES cashbox_days(organization_id, cashbox_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT cashbox_days_approval_action_fk
    FOREIGN KEY (organization_id, approval_action_id)
    REFERENCES cashbox_day_approval_actions(organization_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT cashbox_days_closed_by_fk
    FOREIGN KEY (organization_id, closed_by_user_id)
    REFERENCES user_refs(organization_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT cashbox_days_reopened_by_fk
    FOREIGN KEY (organization_id, reopened_by_user_id)
    REFERENCES user_refs(organization_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT cashbox_days_snapshot_digest_check
    CHECK (book_snapshot_digest IS NULL OR book_snapshot_digest ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT cashbox_days_closed_shape CHECK (
    state <> 'CLOSED'
    OR (business_number IS NOT NULL AND closed_by_user_id IS NOT NULL AND closed_at IS NOT NULL)
  ),
  ADD CONSTRAINT cashbox_days_reopened_shape CHECK (
    state <> 'REOPENED'
    OR (
      business_number IS NULL
      AND prior_close_id IS NOT NULL
      AND approval_action_id IS NOT NULL
      AND NULLIF(BTRIM(reopen_reason), '') IS NOT NULL
      AND reopened_by_user_id IS NOT NULL
      AND reopened_at IS NOT NULL
      AND held_instrument_snapshot = '[]'::jsonb
      AND cardinality(observed_instrument_ids) = 0
    )
  );

ALTER TABLE cashbox_day_approval_requests
  ADD CONSTRAINT cashbox_day_approval_requests_source_day_fk
  FOREIGN KEY (organization_id, cashbox_id, source_day_id)
  REFERENCES cashbox_days(organization_id, cashbox_id, id) ON DELETE RESTRICT;

CREATE TABLE cashbox_day_counts (
  cashbox_day_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  currency varchar(8) NOT NULL,
  book_amount numeric(38,8) NOT NULL,
  counted_amount numeric(38,8) NOT NULL CHECK (counted_amount >= 0),
  variance_amount numeric(38,8) NOT NULL,
  variance_reason varchar(500),
  PRIMARY KEY (cashbox_day_id, currency),
  FOREIGN KEY (organization_id, cashbox_day_id)
    REFERENCES cashbox_days(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, currency)
    REFERENCES currencies(organization_id, code) ON DELETE RESTRICT,
  CHECK (variance_amount = counted_amount - book_amount),
  CHECK (
    (variance_amount = 0 AND variance_reason IS NULL)
    OR (variance_amount <> 0 AND NULLIF(BTRIM(variance_reason), '') IS NOT NULL)
  )
);

CREATE TABLE cashbox_day_number_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  numbering_rule_id uuid NOT NULL,
  numbering_rule_version bigint NOT NULL CHECK (numbering_rule_version > 0),
  operation varchar(32) NOT NULL CHECK (operation = 'CASHBOX_DAY_CLOSE'),
  branch_id uuid,
  treasury_unit_id uuid NOT NULL,
  fiscal_year varchar(16) NOT NULL,
  fiscal_year_starts_on date NOT NULL,
  fiscal_year_ends_on date NOT NULL,
  prefix varchar(32) NOT NULL,
  number_width integer NOT NULL CHECK (number_width BETWEEN 1 AND 32),
  sequence_value bigint NOT NULL CHECK (sequence_value > 0),
  business_number varchar(128) NOT NULL,
  cashbox_id uuid NOT NULL,
  business_date date NOT NULL,
  close_cycle integer NOT NULL CHECK (close_cycle > 0),
  reserved_by_user_id uuid NOT NULL,
  command_digest char(64) NOT NULL CHECK (command_digest ~ '^[a-f0-9]{64}$'),
  reservation_scope varchar(160) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'RESERVED',
  cashbox_day_id uuid,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  abandoned_at timestamptz,
  abandoned_reason varchar(500),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, numbering_rule_id, sequence_value),
  UNIQUE (organization_id, business_number),
  UNIQUE (organization_id, reservation_scope, idempotency_key),
  FOREIGN KEY (organization_id, numbering_rule_id)
    REFERENCES numbering_rules(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, cashbox_id)
    REFERENCES cashboxes(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, cashbox_id, cashbox_day_id)
    REFERENCES cashbox_days(organization_id, cashbox_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, reserved_by_user_id)
    REFERENCES user_refs(organization_id, id) ON DELETE RESTRICT,
  CHECK (fiscal_year_ends_on >= fiscal_year_starts_on),
  CHECK (
    length(sequence_value::text) <= number_width
    AND business_number = prefix || fiscal_year || '-' || lpad(sequence_value::text, number_width, '0')
  ),
  CHECK (
    (state = 'RESERVED' AND cashbox_day_id IS NULL AND consumed_at IS NULL
      AND abandoned_at IS NULL AND abandoned_reason IS NULL)
    OR (state = 'CONSUMED' AND cashbox_day_id IS NOT NULL AND consumed_at IS NOT NULL
      AND abandoned_at IS NULL AND abandoned_reason IS NULL)
    OR (state = 'ABANDONED' AND cashbox_day_id IS NULL AND consumed_at IS NULL
      AND abandoned_at IS NOT NULL AND NULLIF(BTRIM(abandoned_reason), '') IS NOT NULL)
  )
);

CREATE UNIQUE INDEX cashbox_day_number_reservations_consumed_day_unique
  ON cashbox_day_number_reservations (organization_id, cashbox_id, business_date, close_cycle)
  WHERE state = 'CONSUMED';

CREATE FUNCTION enforce_cashbox_day_number_reservation_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'RESERVED' THEN
      RAISE EXCEPTION 'Cashbox Day number reservations begin RESERVED';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Cashbox Day number reservations are immutable';
  END IF;
  IF OLD.state <> 'RESERVED'
     OR NEW.state NOT IN ('CONSUMED', 'ABANDONED')
     OR (to_jsonb(NEW) - ARRAY['state', 'cashbox_day_id', 'consumed_at', 'abandoned_at', 'abandoned_reason'])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['state', 'cashbox_day_id', 'consumed_at', 'abandoned_at', 'abandoned_reason']) THEN
    RAISE EXCEPTION 'invalid Cashbox Day number reservation transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cashbox_day_number_reservations_terminal_transition
BEFORE INSERT OR UPDATE OR DELETE ON cashbox_day_number_reservations
FOR EACH ROW EXECUTE FUNCTION enforce_cashbox_day_number_reservation_transition();

CREATE FUNCTION enforce_cashbox_day_number_parity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_organization_id uuid;
  target_day_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'cashbox_days' THEN
    target_organization_id := COALESCE(NEW.organization_id, OLD.organization_id);
    target_day_id := COALESCE(NEW.id, OLD.id);
  ELSE
    target_organization_id := COALESCE(NEW.organization_id, OLD.organization_id);
    target_day_id := COALESCE(NEW.cashbox_day_id, OLD.cashbox_day_id);
  END IF;
  IF target_day_id IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  IF EXISTS (
    SELECT 1 FROM cashbox_days d
    WHERE d.organization_id = target_organization_id
      AND d.id = target_day_id
      AND d.state = 'CLOSED'
  ) AND NOT EXISTS (
    SELECT 1
    FROM cashbox_days d
    JOIN cashbox_day_number_reservations r
      ON r.organization_id = d.organization_id
     AND r.cashbox_day_id = d.id
     AND r.cashbox_id = d.cashbox_id
     AND r.business_date = d.business_date
     AND r.close_cycle = d.close_cycle
     AND r.business_number = d.business_number
     AND r.state = 'CONSUMED'
    WHERE d.organization_id = target_organization_id
      AND d.id = target_day_id
      AND d.state = 'CLOSED'
  ) THEN
    RAISE EXCEPTION 'closed Cashbox Day requires one matching consumed number reservation';
  END IF;
  IF TG_TABLE_NAME = 'cashbox_day_number_reservations'
     AND COALESCE(NEW.state, OLD.state) = 'CONSUMED'
     AND NOT EXISTS (
       SELECT 1
       FROM cashbox_day_number_reservations r
       JOIN cashbox_days d
         ON d.organization_id = r.organization_id
        AND d.id = r.cashbox_day_id
        AND d.cashbox_id = r.cashbox_id
        AND d.business_date = r.business_date
        AND d.close_cycle = r.close_cycle
        AND d.business_number = r.business_number
        AND d.state = 'CLOSED'
       WHERE r.organization_id = target_organization_id
         AND r.cashbox_day_id = target_day_id
         AND r.state = 'CONSUMED'
     ) THEN
    RAISE EXCEPTION 'consumed number reservation requires one matching closed Cashbox Day';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE CONSTRAINT TRIGGER cashbox_days_number_parity
AFTER INSERT OR UPDATE ON cashbox_days
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_cashbox_day_number_parity();

CREATE CONSTRAINT TRIGGER cashbox_day_number_reservations_parity
AFTER INSERT OR UPDATE OR DELETE ON cashbox_day_number_reservations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_cashbox_day_number_parity();

CREATE FUNCTION prevent_cashbox_day_history_rewrite()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.state = 'CLOSED' THEN
    RAISE EXCEPTION 'closed Cashbox Day history is immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.state = 'CLOSED' THEN
    RAISE EXCEPTION 'closed Cashbox Day history is immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER cashbox_days_history_immutable
BEFORE UPDATE OR DELETE ON cashbox_days
FOR EACH ROW EXECUTE FUNCTION prevent_cashbox_day_history_rewrite();

CREATE FUNCTION prevent_cashbox_day_count_rewrite()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_parent_state varchar(24);
  new_parent_xmin bigint;
  new_parent_state varchar(24);
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT state INTO old_parent_state
    FROM cashbox_days
    WHERE organization_id = OLD.organization_id
      AND id = OLD.cashbox_day_id;

    IF old_parent_state = 'CLOSED' THEN
      RAISE EXCEPTION 'closed Cashbox Day count evidence is immutable';
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT xmin::text::bigint, state
    INTO new_parent_xmin, new_parent_state
    FROM cashbox_days
    WHERE organization_id = NEW.organization_id
      AND id = NEW.cashbox_day_id;

    IF new_parent_state = 'CLOSED'
       AND (TG_OP <> 'INSERT' OR new_parent_xmin <> txid_current()) THEN
      RAISE EXCEPTION 'closed Cashbox Day count evidence is immutable';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER cashbox_day_counts_history_immutable
BEFORE INSERT OR UPDATE OR DELETE ON cashbox_day_counts
FOR EACH ROW EXECUTE FUNCTION prevent_cashbox_day_count_rewrite();

CREATE FUNCTION prevent_cashbox_day_approval_rewrite()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Cashbox Day approval actions are immutable';
END;
$$;

CREATE TRIGGER cashbox_day_approval_actions_immutable
BEFORE UPDATE OR DELETE ON cashbox_day_approval_actions
FOR EACH ROW EXECUTE FUNCTION prevent_cashbox_day_approval_rewrite();

CREATE FUNCTION enforce_cashbox_day_approval_request_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state <> 'PENDING' THEN
    RAISE EXCEPTION 'terminal Cashbox Day approval requests are immutable';
  END IF;
  IF NEW.state NOT IN ('APPROVED', 'REJECTED')
     OR NEW.version <> OLD.version + 1
     OR NEW.updated_at <= OLD.updated_at
     OR NEW.command_body IS DISTINCT FROM OLD.command_body
     OR NEW.command_digest IS DISTINCT FROM OLD.command_digest
     OR NEW.source_day_id IS DISTINCT FROM OLD.source_day_id
     OR NEW.source_day_version IS DISTINCT FROM OLD.source_day_version
     OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id THEN
    RAISE EXCEPTION 'invalid Cashbox Day approval request transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cashbox_day_approval_requests_terminal_transition
BEFORE UPDATE ON cashbox_day_approval_requests
FOR EACH ROW EXECUTE FUNCTION enforce_cashbox_day_approval_request_transition();
