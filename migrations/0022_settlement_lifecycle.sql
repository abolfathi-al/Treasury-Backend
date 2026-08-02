CREATE TABLE settlement_batches (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  business_number varchar(64) NOT NULL,
  destination_bank_account_id uuid NOT NULL,
  bank_statement_line_id uuid,
  provider_reference varchar(128),
  settlement_date date NOT NULL,
  match_kind varchar(16),
  match_rule_id varchar(128),
  match_rule_version varchar(64),
  manual_match_reason varchar(500),
  currency varchar(8) NOT NULL,
  gross_amount numeric(38,8) NOT NULL,
  fee_amount numeric(38,8) NOT NULL DEFAULT 0,
  deduction_amount numeric(38,8) NOT NULL DEFAULT 0,
  expected_net_amount numeric(38,8) NOT NULL,
  actual_net_amount numeric(38,8) NOT NULL,
  discrepancy_amount numeric(38,8) NOT NULL,
  discrepancy_disposition varchar(32) NOT NULL,
  discrepancy_reason varchar(500),
  creator_user_id uuid NOT NULL,
  confirmed_by uuid,
  confirmed_at timestamptz,
  reversed_by uuid,
  reversed_at timestamptz,
  reversal_of_batch_id uuid,
  replacement_for_batch_id uuid,
  reversal_reason varchar(500),
  state varchar(32) NOT NULL,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, business_number),
  UNIQUE (organization_id, reversal_of_batch_id),
  UNIQUE (organization_id, replacement_for_batch_id),
  FOREIGN KEY (organization_id, destination_bank_account_id)
    REFERENCES bank_accounts(organization_id, id),
  FOREIGN KEY (organization_id, currency)
    REFERENCES currencies(organization_id, code),
  FOREIGN KEY (organization_id, creator_user_id)
    REFERENCES user_refs(organization_id, id),
  FOREIGN KEY (organization_id, confirmed_by)
    REFERENCES user_refs(organization_id, id),
  FOREIGN KEY (organization_id, reversed_by)
    REFERENCES user_refs(organization_id, id),
  FOREIGN KEY (organization_id, reversal_of_batch_id)
    REFERENCES settlement_batches(organization_id, id),
  FOREIGN KEY (organization_id, replacement_for_batch_id)
    REFERENCES settlement_batches(organization_id, id),
  CHECK (match_kind IN ('DETERMINISTIC', 'MANUAL') OR match_kind IS NULL),
  CHECK (gross_amount > 0 AND fee_amount >= 0 AND deduction_amount >= 0),
  CHECK (expected_net_amount > 0 AND actual_net_amount > 0),
  CHECK (expected_net_amount = gross_amount - fee_amount - deduction_amount),
  CHECK (discrepancy_amount = actual_net_amount - expected_net_amount),
  CHECK (discrepancy_disposition IN (
    'NONE', 'OPEN', 'APPROVED_DIFFERENCE', 'CORRECTION_REQUIRED', 'RETURNED'
  )),
  CHECK (
    (discrepancy_amount = 0 AND discrepancy_disposition = 'NONE' AND discrepancy_reason IS NULL)
    OR (discrepancy_amount <> 0 AND discrepancy_disposition <> 'NONE'
      AND NULLIF(BTRIM(discrepancy_reason), '') IS NOT NULL)
  ),
  CHECK (confirmed_by IS NULL OR confirmed_by <> creator_user_id),
  CHECK (reversed_by IS NULL OR (reversed_by <> creator_user_id AND reversed_by <> confirmed_by)),
  CHECK (state IN ('MATCHED', 'DISCREPANCY', 'CONFIRMED', 'REVERSED', 'REVERSAL')),
  CHECK (
    (state = 'REVERSAL' AND reversal_of_batch_id IS NOT NULL
      AND NULLIF(BTRIM(reversal_reason), '') IS NOT NULL)
    OR (state <> 'REVERSAL' AND reversal_of_batch_id IS NULL AND reversal_reason IS NULL)
  ),
  CHECK (
    (state = 'REVERSAL' AND match_kind IS NULL AND match_rule_id IS NULL
      AND match_rule_version IS NULL AND manual_match_reason IS NULL)
    OR (state <> 'REVERSAL' AND match_kind = 'DETERMINISTIC'
      AND NULLIF(BTRIM(match_rule_id), '') IS NOT NULL
      AND NULLIF(BTRIM(match_rule_version), '') IS NOT NULL
      AND manual_match_reason IS NULL)
    OR (state <> 'REVERSAL' AND match_kind = 'MANUAL'
      AND match_rule_id IS NULL AND match_rule_version IS NULL
      AND NULLIF(BTRIM(manual_match_reason), '') IS NOT NULL)
  ),
  CHECK (
    (state = 'MATCHED' AND discrepancy_amount = 0 AND confirmed_by IS NULL
      AND confirmed_at IS NULL AND reversed_by IS NULL AND reversed_at IS NULL)
    OR (state = 'DISCREPANCY' AND discrepancy_amount <> 0 AND confirmed_by IS NULL
      AND confirmed_at IS NULL AND reversed_by IS NULL AND reversed_at IS NULL)
    OR (state = 'CONFIRMED' AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL
      AND reversed_by IS NULL AND reversed_at IS NULL
      AND (discrepancy_amount = 0 OR discrepancy_disposition = 'APPROVED_DIFFERENCE'))
    OR (state = 'REVERSED' AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL
      AND reversed_by IS NOT NULL AND reversed_at IS NOT NULL
      AND (discrepancy_amount = 0 OR discrepancy_disposition = 'APPROVED_DIFFERENCE'))
    OR (state = 'REVERSAL' AND confirmed_by IS NULL AND confirmed_at IS NULL
      AND reversed_by IS NULL AND reversed_at IS NULL)
  )
);

CREATE TABLE settlement_allocations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  settlement_batch_id uuid NOT NULL,
  collection_item_id uuid NOT NULL,
  collection_item_version bigint NOT NULL CHECK (collection_item_version >= 0),
  allocated_amount numeric(38,8) NOT NULL CHECK (allocated_amount > 0),
  currency varchar(8) NOT NULL,
  state varchar(16) NOT NULL CHECK (state IN ('PROPOSED', 'CONFIRMED', 'REVERSED')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, settlement_batch_id, collection_item_id),
  FOREIGN KEY (organization_id, settlement_batch_id)
    REFERENCES settlement_batches(organization_id, id),
  FOREIGN KEY (organization_id, collection_item_id)
    REFERENCES collection_items(organization_id, id),
  FOREIGN KEY (organization_id, currency)
    REFERENCES currencies(organization_id, code)
);

CREATE TABLE settlement_attachment_links (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  settlement_batch_id uuid NOT NULL,
  attachment_id uuid NOT NULL,
  content_digest char(64) NOT NULL,
  purpose varchar(64) NOT NULL CHECK (purpose = 'BANK_CREDIT_EVIDENCE'),
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, settlement_batch_id, attachment_id),
  FOREIGN KEY (organization_id, settlement_batch_id)
    REFERENCES settlement_batches(organization_id, id),
  FOREIGN KEY (organization_id, attachment_id, content_digest)
    REFERENCES attachments(organization_id, id, content_digest),
  CHECK (content_digest ~ '^[a-f0-9]{64}$')
);

CREATE TABLE settlement_effects (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  settlement_batch_id uuid NOT NULL,
  effect_key varchar(64) NOT NULL,
  effect_type varchar(40) NOT NULL CHECK (effect_type IN (
    'BANK_CREDIT', 'ALLOCATION_CONSUMPTION', 'FEE_EVIDENCE',
    'DEDUCTION_EVIDENCE', 'APPROVED_DISCREPANCY_EVIDENCE'
  )),
  direction varchar(16) NOT NULL CHECK (direction IN ('SETTLEMENT', 'REVERSAL')),
  amount numeric(38,8) NOT NULL,
  currency varchar(8) NOT NULL,
  business_date date NOT NULL,
  source_version bigint NOT NULL CHECK (source_version >= 0),
  movement_fact_id uuid,
  collection_item_id uuid,
  reversal_of_effect_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, id, effect_type, currency, amount),
  UNIQUE (organization_id, settlement_batch_id, effect_key, direction),
  UNIQUE (organization_id, reversal_of_effect_id),
  UNIQUE (organization_id, movement_fact_id),
  FOREIGN KEY (organization_id, settlement_batch_id)
    REFERENCES settlement_batches(organization_id, id),
  FOREIGN KEY (organization_id, collection_item_id)
    REFERENCES collection_items(organization_id, id),
  FOREIGN KEY (organization_id, currency)
    REFERENCES currencies(organization_id, code),
  FOREIGN KEY (organization_id, movement_fact_id)
    REFERENCES movement_facts(organization_id, id),
  FOREIGN KEY (organization_id, reversal_of_effect_id, effect_type, currency, amount)
    REFERENCES settlement_effects(organization_id, id, effect_type, currency, amount),
  CHECK (
    (effect_type = 'BANK_CREDIT' AND movement_fact_id IS NOT NULL AND collection_item_id IS NULL)
    OR (effect_type = 'ALLOCATION_CONSUMPTION' AND movement_fact_id IS NULL AND collection_item_id IS NOT NULL)
    OR (effect_type IN ('FEE_EVIDENCE', 'DEDUCTION_EVIDENCE', 'APPROVED_DISCREPANCY_EVIDENCE')
      AND movement_fact_id IS NULL AND collection_item_id IS NULL)
  ),
  CHECK (
    (direction = 'SETTLEMENT' AND reversal_of_effect_id IS NULL)
    OR (direction = 'REVERSAL' AND reversal_of_effect_id IS NOT NULL)
  ),
  CHECK (
    (direction = 'SETTLEMENT' AND source_version > 0)
    OR (direction = 'REVERSAL' AND source_version = 0)
  )
);

CREATE FUNCTION enforce_settlement_allocation_consistency()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  batch settlement_batches%ROWTYPE;
  item collection_items%ROWTYPE;
  proposed_total numeric(38,8);
BEGIN
  SELECT * INTO batch FROM settlement_batches
  WHERE organization_id = NEW.organization_id AND id = NEW.settlement_batch_id;
  SELECT * INTO item FROM collection_items
  WHERE organization_id = NEW.organization_id AND id = NEW.collection_item_id;
  SELECT SUM(allocated_amount) INTO proposed_total FROM settlement_allocations
  WHERE organization_id = NEW.organization_id AND settlement_batch_id = NEW.settlement_batch_id;
  IF batch.state NOT IN ('MATCHED', 'DISCREPANCY')
    OR batch.currency <> NEW.currency
    OR item.currency <> NEW.currency
    OR item.destination_bank_account_id <> batch.destination_bank_account_id
    OR item.version <> NEW.collection_item_version
    OR NEW.allocated_amount > item.remaining_amount
    OR proposed_total <> batch.gross_amount THEN
    RAISE EXCEPTION 'Settlement allocation mismatch'
      USING ERRCODE = '23514', CONSTRAINT = 'settlement_allocation_consistency';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER settlement_allocation_consistency
AFTER INSERT ON settlement_allocations DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_settlement_allocation_consistency();

CREATE FUNCTION enforce_settlement_batch_creation_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original settlement_batches%ROWTYPE;
BEGIN
  IF NEW.state IN ('MATCHED', 'DISCREPANCY') AND (
    NOT EXISTS (
      SELECT 1 FROM bank_accounts account
      WHERE account.organization_id = NEW.organization_id
        AND account.id = NEW.destination_bank_account_id
        AND account.currency = NEW.currency
        AND account.state = 'ACTIVE' AND account.can_receive
    ) OR NOT EXISTS (
      SELECT 1 FROM settlement_attachment_links link
      JOIN attachments attachment
        ON attachment.organization_id = link.organization_id
       AND attachment.id = link.attachment_id
       AND attachment.content_digest = link.content_digest
      WHERE link.organization_id = NEW.organization_id
        AND link.settlement_batch_id = NEW.id
        AND link.purpose = 'BANK_CREDIT_EVIDENCE'
        AND attachment.state = 'ACTIVE'
    ) OR EXISTS (
      SELECT 1 FROM settlement_attachment_links link
      LEFT JOIN attachments attachment
        ON attachment.organization_id = link.organization_id
       AND attachment.id = link.attachment_id
       AND attachment.content_digest = link.content_digest
      WHERE link.organization_id = NEW.organization_id
        AND link.settlement_batch_id = NEW.id
        AND (
          link.purpose <> 'BANK_CREDIT_EVIDENCE'
          OR attachment.id IS NULL
          OR attachment.state <> 'ACTIVE'
        )
    )
  ) THEN
    RAISE EXCEPTION 'Settlement destination or evidence mismatch'
      USING ERRCODE = '23514', CONSTRAINT = 'settlement_batch_creation_evidence';
  END IF;
  IF NEW.bank_statement_line_id IS NOT NULL THEN
    RAISE EXCEPTION 'Bank statement lines are not active in this runtime slice'
      USING ERRCODE = '23514', CONSTRAINT = 'settlement_bank_statement_line_unavailable';
  END IF;
  IF NEW.state = 'REVERSAL' THEN
    SELECT * INTO original FROM settlement_batches
    WHERE organization_id = NEW.organization_id
      AND id = NEW.reversal_of_batch_id AND id <> NEW.id
      AND state = 'REVERSED'
      AND destination_bank_account_id = NEW.destination_bank_account_id
      AND currency = NEW.currency
      AND gross_amount = NEW.gross_amount
      AND fee_amount = NEW.fee_amount
      AND deduction_amount = NEW.deduction_amount
      AND expected_net_amount = NEW.expected_net_amount
      AND actual_net_amount = NEW.actual_net_amount
      AND discrepancy_amount = NEW.discrepancy_amount
      AND reversed_by = NEW.creator_user_id
      AND reversed_at = NEW.created_at;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Settlement reversal lineage mismatch'
        USING ERRCODE = '23514', CONSTRAINT = 'settlement_reversal_batch_lineage';
    END IF;
  END IF;
  IF NEW.replacement_for_batch_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM settlement_batches original_batch
    WHERE original_batch.organization_id = NEW.organization_id
      AND original_batch.id = NEW.replacement_for_batch_id
      AND original_batch.id <> NEW.id
      AND original_batch.state = 'REVERSED'
      AND original_batch.destination_bank_account_id = NEW.destination_bank_account_id
      AND original_batch.currency = NEW.currency
  ) THEN
    RAISE EXCEPTION 'Settlement replacement lineage mismatch'
      USING ERRCODE = '23514', CONSTRAINT = 'settlement_replacement_batch_lineage';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER settlement_batch_creation_evidence
AFTER INSERT ON settlement_batches DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_settlement_batch_creation_evidence();

CREATE FUNCTION protect_settlement_batch_history()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Settlement batches are append-only'
      USING ERRCODE = '55000', CONSTRAINT = 'settlement_batch_history_immutable';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.business_number IS DISTINCT FROM OLD.business_number
    OR NEW.destination_bank_account_id IS DISTINCT FROM OLD.destination_bank_account_id
    OR NEW.bank_statement_line_id IS DISTINCT FROM OLD.bank_statement_line_id
    OR NEW.provider_reference IS DISTINCT FROM OLD.provider_reference
    OR NEW.settlement_date IS DISTINCT FROM OLD.settlement_date
    OR NEW.match_kind IS DISTINCT FROM OLD.match_kind
    OR NEW.match_rule_id IS DISTINCT FROM OLD.match_rule_id
    OR NEW.match_rule_version IS DISTINCT FROM OLD.match_rule_version
    OR NEW.manual_match_reason IS DISTINCT FROM OLD.manual_match_reason
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.gross_amount IS DISTINCT FROM OLD.gross_amount
    OR NEW.fee_amount IS DISTINCT FROM OLD.fee_amount
    OR NEW.deduction_amount IS DISTINCT FROM OLD.deduction_amount
    OR NEW.expected_net_amount IS DISTINCT FROM OLD.expected_net_amount
    OR NEW.actual_net_amount IS DISTINCT FROM OLD.actual_net_amount
    OR NEW.discrepancy_amount IS DISTINCT FROM OLD.discrepancy_amount
    OR NEW.discrepancy_disposition IS DISTINCT FROM OLD.discrepancy_disposition
    OR NEW.discrepancy_reason IS DISTINCT FROM OLD.discrepancy_reason
    OR NEW.creator_user_id IS DISTINCT FROM OLD.creator_user_id
    OR NEW.reversal_of_batch_id IS DISTINCT FROM OLD.reversal_of_batch_id
    OR NEW.replacement_for_batch_id IS DISTINCT FROM OLD.replacement_for_batch_id
    OR NEW.reversal_reason IS DISTINCT FROM OLD.reversal_reason
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.version <> OLD.version + 1
    OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'Settlement proposal facts are immutable'
      USING ERRCODE = '55000', CONSTRAINT = 'settlement_batch_history_immutable';
  END IF;
  IF NOT (
    (OLD.state IN ('MATCHED', 'DISCREPANCY') AND NEW.state = 'CONFIRMED'
      AND OLD.confirmed_by IS NULL AND NEW.confirmed_by IS NOT NULL
      AND OLD.confirmed_at IS NULL AND NEW.confirmed_at IS NOT NULL
      AND NEW.reversed_by IS NULL AND NEW.reversed_at IS NULL)
    OR (OLD.state = 'CONFIRMED' AND NEW.state = 'REVERSED'
      AND NEW.confirmed_by = OLD.confirmed_by AND NEW.confirmed_at = OLD.confirmed_at
      AND OLD.reversed_by IS NULL AND NEW.reversed_by IS NOT NULL
      AND OLD.reversed_at IS NULL AND NEW.reversed_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Illegal Settlement lifecycle mutation'
      USING ERRCODE = '55000', CONSTRAINT = 'settlement_batch_lifecycle_transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER settlement_batch_history_immutable
BEFORE UPDATE OR DELETE ON settlement_batches
FOR EACH ROW EXECUTE FUNCTION protect_settlement_batch_history();

CREATE FUNCTION protect_settlement_allocation_history()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.settlement_batch_id IS DISTINCT FROM OLD.settlement_batch_id
    OR NEW.collection_item_id IS DISTINCT FROM OLD.collection_item_id
    OR NEW.collection_item_version IS DISTINCT FROM OLD.collection_item_version
    OR NEW.allocated_amount IS DISTINCT FROM OLD.allocated_amount
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.version <> OLD.version + 1
    OR NOT ((OLD.state = 'PROPOSED' AND NEW.state = 'CONFIRMED')
      OR (OLD.state = 'CONFIRMED' AND NEW.state = 'REVERSED')) THEN
    RAISE EXCEPTION 'Settlement allocations are immutable'
      USING ERRCODE = '55000', CONSTRAINT = 'settlement_allocation_history_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER settlement_allocation_history_immutable
BEFORE UPDATE OR DELETE ON settlement_allocations
FOR EACH ROW EXECUTE FUNCTION protect_settlement_allocation_history();

CREATE FUNCTION reject_settlement_append_only_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Settlement evidence is append-only'
    USING ERRCODE = '55000', CONSTRAINT = 'settlement_evidence_append_only';
END;
$$;

CREATE TRIGGER settlement_effects_append_only
BEFORE UPDATE OR DELETE ON settlement_effects
FOR EACH ROW EXECUTE FUNCTION reject_settlement_append_only_mutation();

CREATE TRIGGER settlement_attachment_links_immutable
BEFORE UPDATE OR DELETE ON settlement_attachment_links
FOR EACH ROW EXECUTE FUNCTION reject_settlement_append_only_mutation();

CREATE INDEX settlement_batches_destination_idx
  ON settlement_batches (organization_id, destination_bank_account_id, settlement_date, id);
CREATE INDEX settlement_allocations_item_idx
  ON settlement_allocations (organization_id, collection_item_id, state);
CREATE INDEX settlement_effects_batch_idx
  ON settlement_effects (organization_id, settlement_batch_id, created_at, id);
