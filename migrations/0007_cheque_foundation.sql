ALTER TABLE cheque_books
  ADD COLUMN organization_id uuid,
  ADD COLUMN notes varchar(1000),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

UPDATE cheque_books cb
SET organization_id = ba.organization_id
FROM bank_accounts ba
WHERE ba.id = cb.bank_account_id;

ALTER TABLE cheque_books
  ALTER COLUMN organization_id SET NOT NULL,
  ADD CONSTRAINT cheque_books_organization_fk
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  ADD CONSTRAINT cheque_books_organization_identity
    UNIQUE (organization_id, id),
  ADD CONSTRAINT cheque_books_leaf_identity
    UNIQUE (organization_id, id, bank_account_id, series),
  ADD CONSTRAINT cheque_books_bank_account_fk
    FOREIGN KEY (organization_id, bank_account_id)
    REFERENCES bank_accounts(organization_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT cheque_books_custodian_fk
    FOREIGN KEY (organization_id, custodian_user_id)
    REFERENCES user_refs(organization_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT cheque_books_positive_first_leaf CHECK (first_leaf >= 1),
  ADD CONSTRAINT cheque_books_leaf_count CHECK (last_leaf - first_leaf BETWEEN 0 AND 499);

CREATE FUNCTION enforce_cheque_book_contract()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.bank_account_id IS DISTINCT FROM OLD.bank_account_id
    OR NEW.series IS DISTINCT FROM OLD.series
    OR NEW.first_leaf IS DISTINCT FROM OLD.first_leaf
    OR NEW.last_leaf IS DISTINCT FROM OLD.last_leaf
  ) THEN
    RAISE EXCEPTION
      'Active Cheque Book Organization, account, series, and range are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM bank_accounts
    WHERE organization_id = NEW.organization_id
      AND id = NEW.bank_account_id
      AND state = 'ACTIVE'
      AND account_type = 'CURRENT'
      AND cheque_enabled
  ) THEN
    RAISE EXCEPTION
      'Cheque Book Bank Account must be ACTIVE CURRENT and cheque-enabled'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.custodian_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM user_refs
    WHERE organization_id = NEW.organization_id
      AND id = NEW.custodian_user_id
      AND state = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION
      'Cheque Book Custodian must be ACTIVE in the same Organization'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.organization_id::text || ':' || NEW.bank_account_id::text || ':' || NEW.series,
    0
  ));
  IF EXISTS (
    SELECT 1
    FROM cheque_books existing
    WHERE existing.id <> NEW.id
      AND existing.organization_id = NEW.organization_id
      AND existing.bank_account_id = NEW.bank_account_id
      AND existing.series = NEW.series
      AND int8range(existing.first_leaf, existing.last_leaf, '[]')
          && int8range(NEW.first_leaf, NEW.last_leaf, '[]')
  ) THEN
    RAISE EXCEPTION 'Cheque Book inclusive leaf range overlaps an existing range'
      USING ERRCODE = '23P01', CONSTRAINT = 'cheque_books_range_overlap';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER cheque_book_contract
AFTER INSERT OR UPDATE OF
  organization_id, bank_account_id, series, first_leaf, last_leaf, custodian_user_id
ON cheque_books
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION enforce_cheque_book_contract();

-- Re-run the new dynamic checks for reference-only books created under 0006.
-- Invalid references or overlapping ranges abort this migration atomically.
UPDATE cheque_books SET series = series;

CREATE TABLE cheque_leaves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  cheque_book_id uuid NOT NULL,
  bank_account_id uuid NOT NULL,
  series varchar(32) NOT NULL,
  leaf_number bigint NOT NULL CHECK (leaf_number >= 1),
  reserved_for_payment_line_id uuid,
  reservation_review_due_at timestamptz,
  state varchar(24) NOT NULL DEFAULT 'AVAILABLE'
    CHECK (state IN ('AVAILABLE', 'RESERVED', 'CONSUMED', 'VOID', 'LOST', 'STOPPED')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (bank_account_id, series, leaf_number),
  CONSTRAINT cheque_leaves_book_fk
    FOREIGN KEY (organization_id, cheque_book_id, bank_account_id, series)
    REFERENCES cheque_books(organization_id, id, bank_account_id, series)
    ON DELETE RESTRICT
);

CREATE INDEX cheque_leaves_available_idx
  ON cheque_leaves(cheque_book_id, state, leaf_number);

INSERT INTO cheque_leaves (
  organization_id, cheque_book_id, bank_account_id, series, leaf_number,
  created_at, updated_at
)
SELECT cb.organization_id, cb.id, cb.bank_account_id, cb.series, leaf_number,
       cb.created_at, cb.updated_at
FROM cheque_books cb
CROSS JOIN LATERAL generate_series(
  cb.first_leaf,
  cb.last_leaf
) AS leaf_number;

CREATE TABLE cheque_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cheque_type varchar(16) NOT NULL
    CHECK (cheque_type IN ('RECEIVED', 'ISSUED', 'LEAF')),
  cheque_id uuid NOT NULL,
  sequence_no bigint NOT NULL CHECK (sequence_no > 0),
  from_state varchar(24),
  to_state varchar(24) NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES user_refs(id) ON DELETE RESTRICT,
  reason varchar(500),
  evidence_digest varchar(128),
  custodian_before_type varchar(16),
  custodian_before_id uuid,
  custodian_after_type varchar(16),
  custodian_after_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key varchar(128) NOT NULL,
  UNIQUE (cheque_type, cheque_id, sequence_no),
  UNIQUE (cheque_type, cheque_id, idempotency_key),
  CONSTRAINT cheque_events_foundation_reason CHECK (
    cheque_type <> 'LEAF'
    OR from_state <> 'AVAILABLE'
    OR to_state NOT IN ('VOID', 'LOST')
    OR NULLIF(btrim(reason), '') IS NOT NULL
  )
);

CREATE FUNCTION reject_cheque_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Cheque Events are append-only'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER cheque_events_append_only
BEFORE UPDATE OR DELETE ON cheque_events
FOR EACH ROW EXECUTE FUNCTION reject_cheque_event_mutation();
