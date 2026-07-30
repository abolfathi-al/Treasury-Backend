ALTER TABLE receipt_approval_actions
  DROP CONSTRAINT receipt_approval_actions_check1,
  ADD CONSTRAINT receipt_approval_actions_reason_check CHECK (
    (action = 'APPROVED' AND (reason IS NULL OR length(btrim(reason)) > 0))
    OR (action IN ('REJECTED', 'RETURNED') AND length(btrim(reason)) > 0)
  );

ALTER TABLE receipt_documents
  ADD COLUMN executed_at timestamptz,
  ADD COLUMN executed_by_user_id uuid,
  ADD COLUMN reversal_receipt_id uuid,
  ADD COLUMN reverses_receipt_id uuid,
  ADD CONSTRAINT receipt_documents_executor_fk
    FOREIGN KEY (organization_id, executed_by_user_id)
    REFERENCES user_refs(organization_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT receipt_documents_reversal_fk
    FOREIGN KEY (organization_id, reversal_receipt_id)
    REFERENCES receipt_documents(organization_id, id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT receipt_documents_reverses_fk
    FOREIGN KEY (organization_id, reverses_receipt_id)
    REFERENCES receipt_documents(organization_id, id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT receipt_documents_one_reversal UNIQUE (organization_id, reversal_receipt_id),
  ADD CONSTRAINT receipt_documents_one_original UNIQUE (organization_id, reverses_receipt_id);

ALTER TABLE receipt_documents
  DROP CONSTRAINT receipt_documents_snapshot_state_check,
  DROP CONSTRAINT receipt_documents_state_check,
  DROP CONSTRAINT receipt_documents_workflow_state_check,
  DROP CONSTRAINT receipt_documents_workflow_matches_state,
  DROP CONSTRAINT receipt_documents_execution_state_check,
  DROP CONSTRAINT receipt_documents_accounting_state_check,
  ADD CONSTRAINT receipt_documents_state_check CHECK (
    state IN (
      'DRAFT', 'SUBMITTED', 'APPROVAL_PENDING', 'APPROVED', 'REJECTED',
      'EXECUTED', 'ACCOUNTING_READY', 'ACCOUNTING_POSTED', 'REVERSED'
    )
  ),
  ADD CONSTRAINT receipt_documents_workflow_state_check CHECK (
    workflow_state IN ('DRAFT', 'SUBMITTED', 'APPROVAL_PENDING', 'APPROVED', 'REJECTED')
  ),
  ADD CONSTRAINT receipt_documents_execution_state_check CHECK (
    execution_state IN ('NOT_EXECUTED', 'EXECUTED', 'REVERSED')
  ),
  ADD CONSTRAINT receipt_documents_accounting_state_check CHECK (
    accounting_state IN (
      'NOT_READY', 'MAPPING_REQUIRED', 'READY', 'QUEUED', 'SENDING',
      'SENDING_UNKNOWN', 'ACCEPTED', 'FAILED', 'RETURNED', 'CORRECTED'
    )
  ),
  ADD CONSTRAINT receipt_documents_snapshot_state_check CHECK (
    (state = 'DRAFT' AND current_approval_snapshot_id IS NULL)
    OR (
      state <> 'DRAFT'
      AND (
        (reverses_receipt_id IS NULL AND current_approval_snapshot_id IS NOT NULL)
        OR (reverses_receipt_id IS NOT NULL AND current_approval_snapshot_id IS NULL)
      )
    )
  ),
  ADD CONSTRAINT receipt_documents_execution_shape CHECK (
    (
      execution_state = 'NOT_EXECUTED'
      AND executed_at IS NULL
      AND executed_by_user_id IS NULL
      AND reversal_receipt_id IS NULL
      AND reverses_receipt_id IS NULL
    )
    OR (
      execution_state = 'EXECUTED'
      AND state IN ('EXECUTED', 'ACCOUNTING_READY', 'ACCOUNTING_POSTED')
      AND workflow_state = 'APPROVED'
      AND executed_at IS NOT NULL
      AND executed_by_user_id IS NOT NULL
      AND reversal_receipt_id IS NULL
    )
    OR (
      execution_state = 'REVERSED'
      AND state = 'REVERSED'
      AND workflow_state = 'APPROVED'
      AND executed_at IS NOT NULL
      AND executed_by_user_id IS NOT NULL
      AND reversal_receipt_id IS NOT NULL
      AND reverses_receipt_id IS NULL
    )
  ),
  ADD CONSTRAINT receipt_documents_reversal_link_shape CHECK (
    NOT (reversal_receipt_id IS NOT NULL AND reverses_receipt_id IS NOT NULL)
  );

ALTER TABLE receipt_lines
  ADD COLUMN executed_at timestamptz,
  ADD COLUMN executed_by_user_id uuid,
  ADD CONSTRAINT receipt_lines_executor_fk
    FOREIGN KEY (organization_id, executed_by_user_id)
    REFERENCES user_refs(organization_id, id) ON DELETE RESTRICT,
  DROP CONSTRAINT receipt_lines_state_check,
  ADD CONSTRAINT receipt_lines_state_check CHECK (state IN ('DRAFT', 'EXECUTED', 'REVERSED')),
  ADD CONSTRAINT receipt_lines_execution_shape CHECK (
    (state = 'DRAFT' AND executed_at IS NULL AND executed_by_user_id IS NULL)
    OR (state IN ('EXECUTED', 'REVERSED') AND executed_at IS NOT NULL AND executed_by_user_id IS NOT NULL)
  );

ALTER TABLE receipt_allocations
  DROP CONSTRAINT receipt_allocations_state_check,
  ADD CONSTRAINT receipt_allocations_state_check CHECK (state IN ('ACTIVE', 'REVERSED'));

CREATE TABLE cashbox_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  cashbox_id uuid NOT NULL,
  business_date date NOT NULL,
  close_cycle integer NOT NULL DEFAULT 1 CHECK (close_cycle > 0),
  state varchar(24) NOT NULL CHECK (state IN ('OPEN', 'CLOSED', 'REOPENED')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE (organization_id, cashbox_id, business_date, close_cycle),
  FOREIGN KEY (organization_id, cashbox_id)
    REFERENCES cashboxes(organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX cashbox_days_current_idx
  ON cashbox_days (organization_id, cashbox_id, business_date, close_cycle DESC);

CREATE TABLE movement_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  owner varchar(64) NOT NULL,
  source_type varchar(32) NOT NULL,
  source_id uuid NOT NULL,
  source_line_id uuid,
  effect_key varchar(128) NOT NULL,
  endpoint_type varchar(16) NOT NULL CHECK (endpoint_type IN ('CASHBOX', 'BANK_ACCOUNT')),
  endpoint_id uuid NOT NULL,
  direction varchar(8) NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
  amount numeric(38,8) NOT NULL CHECK (amount > 0),
  currency varchar(8) NOT NULL,
  business_date date NOT NULL,
  executed_at timestamptz NOT NULL DEFAULT now(),
  reversal_of_fact_id uuid,
  state varchar(16) NOT NULL CHECK (state IN ('POSTED', 'REVERSED')),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, owner, source_type, source_id, source_line_id, effect_key),
  UNIQUE (organization_id, reversal_of_fact_id),
  FOREIGN KEY (organization_id, currency)
    REFERENCES currencies(organization_id, code) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, reversal_of_fact_id)
    REFERENCES movement_facts(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE received_cheques (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  receipt_line_id uuid NOT NULL,
  issuer_bank_id uuid NOT NULL,
  issuer_bank_branch_id uuid,
  cheque_number varchar(64) NOT NULL,
  series varchar(32),
  local_tracking_id varchar(64),
  issuer_account_ref varchar(128),
  payer_party_id uuid,
  amount numeric(38,8) NOT NULL CHECK (amount > 0),
  currency varchar(8) NOT NULL,
  receipt_date date NOT NULL,
  due_date date NOT NULL,
  custodian_type varchar(16) NOT NULL CHECK (custodian_type IN ('CASHBOX', 'TREASURY_UNIT')),
  custodian_id uuid NOT NULL,
  sayad_id char(16),
  sayad_status varchar(64),
  sayad_source varchar(8) CHECK (sayad_source IS NULL OR sayad_source IN ('MANUAL', 'FILE')),
  sayad_observed_at timestamptz,
  sayad_source_digest char(64),
  issuer_national_id varchar(32),
  beneficiary_national_id varchar(32),
  state varchar(24) NOT NULL DEFAULT 'RECEIVED' CHECK (
    state IN (
      'RECEIVED', 'IN_CUSTODY', 'DEPOSITED', 'IN_COLLECTION', 'CLEARED',
      'RETURNED', 'RETURNED_AFTER_CLEARANCE', 'RETURNED_TO_PARTY',
      'ASSIGNED', 'LOST', 'CANCELLED'
    )
  ),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, receipt_line_id, id),
  UNIQUE (organization_id, receipt_line_id),
  UNIQUE (organization_id, issuer_bank_id, cheque_number, amount, due_date),
  FOREIGN KEY (organization_id, receipt_line_id)
    REFERENCES receipt_lines(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, issuer_bank_id)
    REFERENCES banks(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, issuer_bank_id, issuer_bank_branch_id)
    REFERENCES bank_branches(organization_id, bank_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, payer_party_id)
    REFERENCES parties(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, currency)
    REFERENCES currencies(organization_id, code) ON DELETE RESTRICT
);

CREATE TABLE collection_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  source_fact_type varchar(32) NOT NULL,
  source_fact_id uuid NOT NULL,
  channel_type varchar(24) NOT NULL,
  channel_id uuid,
  provider_reference varchar(128),
  gross_amount numeric(38,8) NOT NULL CHECK (gross_amount > 0),
  currency varchar(8) NOT NULL,
  allocated_amount numeric(38,8) NOT NULL DEFAULT 0 CHECK (allocated_amount >= 0),
  remaining_amount numeric(38,8) NOT NULL CHECK (remaining_amount >= 0),
  destination_bank_account_id uuid NOT NULL,
  collected_at timestamptz NOT NULL,
  expected_settlement_date date,
  state varchar(32) NOT NULL DEFAULT 'OPEN' CHECK (
    state IN (
      'OPEN', 'PARTIALLY_ALLOCATED', 'ALLOCATED', 'SETTLED',
      'REOPENED_AFTER_REVERSAL', 'DELAYED', 'DISPUTED', 'RETURNED', 'CANCELLED'
    )
  ),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, source_fact_type, source_fact_id),
  FOREIGN KEY (organization_id, destination_bank_account_id)
    REFERENCES bank_accounts(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, currency)
    REFERENCES currencies(organization_id, code) ON DELETE RESTRICT,
  CHECK (allocated_amount + remaining_amount = gross_amount)
);

CREATE TABLE receipt_execution_effects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  receipt_line_id uuid NOT NULL,
  effect_key varchar(128) NOT NULL,
  effect_type varchar(24) NOT NULL CHECK (
    effect_type IN ('CASHBOX_MOVEMENT', 'BANK_MOVEMENT', 'RECEIVED_CHEQUE', 'COLLECTION_ITEM')
  ),
  direction varchar(8) NOT NULL CHECK (direction IN ('INCOMING', 'REVERSAL')),
  amount numeric(38,8) NOT NULL CHECK (amount > 0),
  currency varchar(8) NOT NULL,
  business_date date NOT NULL,
  source_version bigint NOT NULL CHECK (source_version > 0),
  movement_fact_id uuid,
  received_cheque_id uuid,
  cheque_event_id uuid REFERENCES cheque_events(id) ON DELETE RESTRICT,
  collection_item_id uuid,
  collection_item_version bigint CHECK (collection_item_version >= 0),
  collection_item_state varchar(32) CHECK (
    collection_item_state IS NULL OR collection_item_state IN ('RETURNED', 'REOPENED_AFTER_REVERSAL')
  ),
  reversal_of_effect_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, id, currency, amount),
  UNIQUE (organization_id, receipt_line_id, effect_key, direction),
  UNIQUE (organization_id, reversal_of_effect_id),
  UNIQUE (organization_id, movement_fact_id),
  UNIQUE (organization_id, received_cheque_id),
  UNIQUE (organization_id, cheque_event_id),
  FOREIGN KEY (organization_id, receipt_line_id)
    REFERENCES receipt_lines(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, movement_fact_id)
    REFERENCES movement_facts(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, receipt_line_id, received_cheque_id)
    REFERENCES received_cheques(organization_id, receipt_line_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, collection_item_id)
    REFERENCES collection_items(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, reversal_of_effect_id, currency, amount)
    REFERENCES receipt_execution_effects(organization_id, id, currency, amount) ON DELETE RESTRICT,
  CHECK (
    (
      direction = 'INCOMING'
      AND reversal_of_effect_id IS NULL
      AND cheque_event_id IS NULL
      AND collection_item_version IS NULL
      AND collection_item_state IS NULL
      AND (
        (effect_type IN ('CASHBOX_MOVEMENT', 'BANK_MOVEMENT')
          AND movement_fact_id IS NOT NULL AND received_cheque_id IS NULL AND collection_item_id IS NULL)
        OR (effect_type = 'RECEIVED_CHEQUE'
          AND movement_fact_id IS NULL AND received_cheque_id IS NOT NULL AND collection_item_id IS NULL)
        OR (effect_type = 'COLLECTION_ITEM'
          AND movement_fact_id IS NULL AND received_cheque_id IS NULL AND collection_item_id IS NOT NULL)
      )
    )
    OR (
      direction = 'REVERSAL'
      AND reversal_of_effect_id IS NOT NULL
      AND received_cheque_id IS NULL
      AND (
        (effect_type IN ('CASHBOX_MOVEMENT', 'BANK_MOVEMENT')
          AND movement_fact_id IS NOT NULL AND cheque_event_id IS NULL
          AND collection_item_id IS NULL AND collection_item_version IS NULL
          AND collection_item_state IS NULL)
        OR (effect_type = 'RECEIVED_CHEQUE'
          AND movement_fact_id IS NULL AND cheque_event_id IS NOT NULL
          AND collection_item_id IS NULL AND collection_item_version IS NULL
          AND collection_item_state IS NULL)
        OR (effect_type = 'COLLECTION_ITEM'
          AND movement_fact_id IS NULL AND cheque_event_id IS NULL
          AND collection_item_id IS NOT NULL AND collection_item_version IS NOT NULL
          AND collection_item_state IS NOT NULL)
      )
    )
  )
);

CREATE UNIQUE INDEX receipt_execution_effect_incoming_collection_key
  ON receipt_execution_effects (organization_id, collection_item_id)
  WHERE direction = 'INCOMING' AND collection_item_id IS NOT NULL;

CREATE FUNCTION enforce_receipt_execution_effect_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  original_effect receipt_execution_effects%ROWTYPE;
  owner_collection collection_items%ROWTYPE;
  owner_cheque_event cheque_events%ROWTYPE;
BEGIN
  IF NEW.direction = 'REVERSAL' THEN
    SELECT *
      INTO original_effect
      FROM receipt_execution_effects
     WHERE organization_id = NEW.organization_id
       AND id = NEW.reversal_of_effect_id
     FOR KEY SHARE;

    IF NOT FOUND
       OR original_effect.direction <> 'INCOMING'
       OR original_effect.effect_type <> NEW.effect_type
       OR original_effect.currency <> NEW.currency
       OR original_effect.amount <> NEW.amount THEN
      RAISE EXCEPTION 'Receipt reversal effect must target one same-Organization INCOMING effect of the same type and Money'
        USING
          ERRCODE = '23514',
          CONSTRAINT = 'receipt_execution_effect_reversal_target_consistency';
    END IF;
  END IF;

  IF NEW.effect_type IN ('CASHBOX_MOVEMENT', 'BANK_MOVEMENT') THEN
    PERFORM 1
      FROM movement_facts
     WHERE organization_id = NEW.organization_id
       AND id = NEW.movement_fact_id
       AND currency = NEW.currency
       AND amount = NEW.amount
       AND (
         NEW.direction = 'INCOMING'
         OR reversal_of_fact_id = original_effect.movement_fact_id
       )
     FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Receipt movement effect must reference its same-Organization matching original or inverse MovementFact'
        USING
          ERRCODE = '23514',
          CONSTRAINT = 'receipt_execution_effect_movement_consistency';
    END IF;
  ELSIF NEW.effect_type = 'RECEIVED_CHEQUE' THEN
    IF NEW.direction = 'INCOMING' THEN
      PERFORM 1
        FROM received_cheques
       WHERE organization_id = NEW.organization_id
         AND receipt_line_id = NEW.receipt_line_id
         AND id = NEW.received_cheque_id
         AND currency = NEW.currency
         AND amount = NEW.amount
       FOR KEY SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Incoming Receipt cheque effect must reference the matching ReceivedCheque owned by its ReceiptLine'
          USING
            ERRCODE = '23514',
            CONSTRAINT = 'receipt_execution_effect_received_cheque_consistency';
      END IF;
    ELSE
      SELECT *
        INTO owner_cheque_event
        FROM cheque_events
       WHERE id = NEW.cheque_event_id
       FOR KEY SHARE;
      IF NOT FOUND
         OR owner_cheque_event.cheque_type <> 'RECEIVED'
         OR owner_cheque_event.cheque_id <> original_effect.received_cheque_id
         OR owner_cheque_event.to_state NOT IN (
           'RETURNED',
           'RETURNED_AFTER_CLEARANCE',
           'RETURNED_TO_PARTY',
           'CANCELLED'
         ) THEN
        RAISE EXCEPTION 'Receipt cheque reversal must reference one correction or return ChequeEvent for the original ReceivedCheque'
          USING
            ERRCODE = '23514',
            CONSTRAINT = 'receipt_execution_effect_cheque_event_consistency';
      END IF;
    END IF;
  ELSIF NEW.effect_type = 'COLLECTION_ITEM' THEN
    SELECT *
      INTO owner_collection
      FROM collection_items
     WHERE organization_id = NEW.organization_id
       AND id = NEW.collection_item_id
     FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Receipt collection effect must reference one CollectionItem in the same Organization'
        USING
          ERRCODE = '23514',
          CONSTRAINT = 'receipt_execution_effect_collection_consistency';
    END IF;

    IF NEW.direction = 'INCOMING' THEN
      IF owner_collection.source_fact_type <> 'RECEIPT_LINE'
         OR owner_collection.source_fact_id <> NEW.receipt_line_id
         OR owner_collection.currency <> NEW.currency
         OR owner_collection.gross_amount <> NEW.amount THEN
        RAISE EXCEPTION 'Incoming Receipt collection effect must reference the matching ReceiptLine CollectionItem'
          USING
            ERRCODE = '23514',
            CONSTRAINT = 'receipt_execution_effect_collection_consistency';
      END IF;
    ELSIF original_effect.collection_item_id <> NEW.collection_item_id
       OR owner_collection.version <> NEW.collection_item_version
       OR owner_collection.state <> NEW.collection_item_state THEN
      RAISE EXCEPTION 'Receipt collection reversal snapshot must match the original owner CollectionItem version and state'
        USING
          ERRCODE = '23514',
          CONSTRAINT = 'receipt_execution_effect_collection_consistency';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER receipt_execution_effect_evidence_guard
AFTER INSERT ON receipt_execution_effects
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION enforce_receipt_execution_effect_evidence();

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  request_id varchar(128) NOT NULL,
  sequence_no bigint NOT NULL CHECK (sequence_no > 0),
  actor_user_id uuid,
  entity_type varchar(32) NOT NULL,
  entity_id uuid NOT NULL,
  action varchar(64) NOT NULL,
  reason varchar(500),
  outcome varchar(24) NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, request_id, sequence_no),
  FOREIGN KEY (organization_id, actor_user_id)
    REFERENCES user_refs(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  aggregate_type varchar(64) NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  event_type varchar(128) NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (organization_id, aggregate_type, aggregate_id, aggregate_version, event_type)
);

CREATE FUNCTION reject_receipt_execution_fact_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Receipt execution facts are append-only' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER movement_facts_append_only
  BEFORE UPDATE OR DELETE ON movement_facts
  FOR EACH ROW EXECUTE FUNCTION reject_receipt_execution_fact_mutation();
CREATE TRIGGER receipt_execution_effects_append_only
  BEFORE UPDATE OR DELETE ON receipt_execution_effects
  FOR EACH ROW EXECUTE FUNCTION reject_receipt_execution_fact_mutation();
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_receipt_execution_fact_mutation();
CREATE TRIGGER outbox_events_append_only
  BEFORE UPDATE OR DELETE ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION reject_receipt_execution_fact_mutation();
