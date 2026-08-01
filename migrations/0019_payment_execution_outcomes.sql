INSERT INTO operation_permissions (permission)
VALUES
  ('payment.execute'),
  ('payment.reverse'),
  ('bank-instruction.record-outcome')
ON CONFLICT (permission) DO NOTHING;

-- PostgreSQL resolves fields on polymorphic NEW/OLD records before boolean
-- short-circuiting. Compare through jsonb so this shared 0017 trigger remains
-- valid when ordinary execution updates payment_lines.
CREATE OR REPLACE FUNCTION prevent_payment_child_reparenting()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'payment_lines'
     AND jsonb_build_array(
       to_jsonb(NEW)->>'organization_id',
       to_jsonb(NEW)->>'payment_document_id',
       to_jsonb(NEW)->>'base_currency'
     ) IS DISTINCT FROM jsonb_build_array(
       to_jsonb(OLD)->>'organization_id',
       to_jsonb(OLD)->>'payment_document_id',
       to_jsonb(OLD)->>'base_currency'
     ) THEN
    RAISE EXCEPTION 'Payment Line organization, parent, and base currency are immutable'
      USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'payment_request_attachment_links'
     AND jsonb_build_array(
       to_jsonb(NEW)->>'organization_id',
       to_jsonb(NEW)->>'payment_request_id',
       to_jsonb(NEW)->>'attachment_id',
       to_jsonb(NEW)->>'content_digest'
     ) IS DISTINCT FROM jsonb_build_array(
       to_jsonb(OLD)->>'organization_id',
       to_jsonb(OLD)->>'payment_request_id',
       to_jsonb(OLD)->>'attachment_id',
       to_jsonb(OLD)->>'content_digest'
     ) THEN
    RAISE EXCEPTION 'Payment Request evidence parents and digest are immutable'
      USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'payment_line_attachment_links'
     AND jsonb_build_array(
       to_jsonb(NEW)->>'organization_id',
       to_jsonb(NEW)->>'payment_line_id',
       to_jsonb(NEW)->>'attachment_id',
       to_jsonb(NEW)->>'content_digest'
     ) IS DISTINCT FROM jsonb_build_array(
       to_jsonb(OLD)->>'organization_id',
       to_jsonb(OLD)->>'payment_line_id',
       to_jsonb(OLD)->>'attachment_id',
       to_jsonb(OLD)->>'content_digest'
     ) THEN
    RAISE EXCEPTION 'Payment Line evidence parents and digest are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE payment_documents
  ADD COLUMN reversed_payment_id uuid,
  ADD COLUMN executed_at timestamptz,
  ADD COLUMN executed_by_user_id uuid,
  ADD CONSTRAINT payment_documents_reversal_fk
    FOREIGN KEY (organization_id, reversed_payment_id)
    REFERENCES payment_documents(organization_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT payment_documents_executor_fk
    FOREIGN KEY (organization_id, executed_by_user_id)
    REFERENCES user_refs(organization_id, id) ON DELETE RESTRICT,
  DROP CONSTRAINT payment_documents_state_check,
  DROP CONSTRAINT payment_documents_workflow_state_check,
  DROP CONSTRAINT payment_documents_workflow_matches_state,
  DROP CONSTRAINT payment_documents_snapshot_state_check,
  DROP CONSTRAINT payment_documents_execution_state_check,
  DROP CONSTRAINT payment_documents_accounting_state_check,
  ADD CONSTRAINT payment_documents_state_check CHECK (state IN (
    'DRAFT', 'SUBMITTED', 'APPROVAL_PENDING', 'APPROVED', 'REJECTED',
    'SCHEDULED', 'EXECUTED', 'ACCOUNTING_READY', 'ACCOUNTING_POSTED',
    'CANCELLED', 'REVERSED'
  )),
  ADD CONSTRAINT payment_documents_workflow_state_check CHECK (workflow_state IN (
    'DRAFT', 'SUBMITTED', 'APPROVAL_PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'
  )),
  ADD CONSTRAINT payment_documents_workflow_matches_state CHECK (
    (state IN ('DRAFT', 'SUBMITTED', 'APPROVAL_PENDING', 'APPROVED', 'REJECTED')
      AND workflow_state = state)
    OR (state NOT IN ('DRAFT', 'SUBMITTED', 'APPROVAL_PENDING', 'APPROVED', 'REJECTED')
      AND workflow_state = 'APPROVED')
  ),
  ADD CONSTRAINT payment_documents_snapshot_state_check CHECK (
    (state = 'DRAFT' AND current_approval_snapshot_id IS NULL)
    OR (state IN ('SUBMITTED', 'APPROVAL_PENDING', 'APPROVED', 'REJECTED', 'SCHEDULED')
      AND current_approval_snapshot_id IS NOT NULL)
    OR state IN ('EXECUTED', 'ACCOUNTING_READY', 'ACCOUNTING_POSTED', 'CANCELLED', 'REVERSED')
  ),
  ADD CONSTRAINT payment_documents_execution_state_check CHECK (
    execution_state IN ('NOT_EXECUTED', 'SCHEDULED', 'EXECUTED', 'REVERSED')
  ),
  ADD CONSTRAINT payment_documents_accounting_state_check CHECK (
    accounting_state IN (
      'NOT_READY', 'MAPPING_REQUIRED', 'READY', 'QUEUED', 'SENDING',
      'SENDING_UNKNOWN', 'ACCEPTED', 'FAILED', 'RETURNED', 'CORRECTED'
    )
  ),
  ADD CONSTRAINT payment_documents_execution_evidence_check CHECK (
    (execution_state IN ('EXECUTED', 'REVERSED')
      AND executed_at IS NOT NULL AND executed_by_user_id IS NOT NULL)
    OR (execution_state NOT IN ('EXECUTED', 'REVERSED')
      AND executed_at IS NULL AND executed_by_user_id IS NULL)
  );

ALTER TABLE payment_lines
  ADD COLUMN executed_at timestamptz,
  ADD COLUMN executed_by_user_id uuid,
  ADD CONSTRAINT payment_lines_executor_fk
    FOREIGN KEY (organization_id, executed_by_user_id)
    REFERENCES user_refs(organization_id, id) ON DELETE RESTRICT,
  DROP CONSTRAINT payment_lines_state_check,
  ADD CONSTRAINT payment_lines_state_check
    CHECK (state IN ('DRAFT', 'RESERVED', 'EXECUTED', 'REVERSED')),
  ADD CONSTRAINT payment_lines_execution_evidence_check CHECK (
    (state IN ('EXECUTED', 'REVERSED')
      AND executed_at IS NOT NULL AND executed_by_user_id IS NOT NULL)
    OR (state IN ('DRAFT', 'RESERVED')
      AND executed_at IS NULL AND executed_by_user_id IS NULL)
  );

CREATE TABLE payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  payment_document_id uuid NOT NULL,
  source_namespace varchar(128) NOT NULL,
  external_object_type varchar(32) NOT NULL CHECK (
    external_object_type IN ('INVOICE', 'DEBT', 'CONTRACT_ITEM', 'OTHER_PAYABLE')
  ),
  external_object_id varchar(128) NOT NULL,
  allocated_amount numeric(38,8) NOT NULL CHECK (allocated_amount > 0),
  currency varchar(8) NOT NULL,
  known_obligation_total numeric(38,8) CHECK (
    known_obligation_total IS NULL OR known_obligation_total > 0
  ),
  duplicate_override_reason varchar(500),
  override_approval_action_id uuid,
  state varchar(16) NOT NULL CHECK (state IN ('ACTIVE', 'REVERSED')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE (organization_id, id),
  UNIQUE (
    organization_id, payment_document_id, source_namespace,
    external_object_type, external_object_id
  ),
  FOREIGN KEY (organization_id, payment_document_id)
    REFERENCES payment_documents(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, override_approval_action_id)
    REFERENCES payment_approval_actions(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, currency)
    REFERENCES currencies(organization_id, code) ON DELETE RESTRICT,
  CHECK (known_obligation_total IS NULL OR allocated_amount <= known_obligation_total),
  CHECK ((duplicate_override_reason IS NULL) = (override_approval_action_id IS NULL))
);

CREATE INDEX payment_allocations_obligation_idx ON payment_allocations (
  organization_id, source_namespace, external_object_type,
  external_object_id, currency, state
);

CREATE TABLE payment_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  payment_document_id uuid NOT NULL,
  source_type varchar(16) NOT NULL CHECK (source_type IN ('CASHBOX', 'BANK_ACCOUNT')),
  source_id uuid NOT NULL,
  amount numeric(38,8) NOT NULL CHECK (amount > 0),
  currency varchar(8) NOT NULL,
  review_due_at timestamptz NOT NULL,
  reviewed_at timestamptz,
  release_reason varchar(500),
  state varchar(24) NOT NULL CHECK (
    state IN ('ACTIVE', 'REVIEW_REQUIRED', 'CONSUMED', 'RELEASED')
  ),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, payment_document_id, source_type, source_id, currency),
  FOREIGN KEY (organization_id, payment_document_id)
    REFERENCES payment_documents(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, currency)
    REFERENCES currencies(organization_id, code) ON DELETE RESTRICT
);

CREATE INDEX payment_reservations_source_idx ON payment_reservations (
  organization_id, source_type, source_id, currency, state, review_due_at
);

CREATE TABLE bank_instructions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  payment_line_id uuid NOT NULL,
  bank_account_id uuid NOT NULL,
  amount numeric(38,8) NOT NULL CHECK (amount > 0),
  currency varchar(8) NOT NULL,
  beneficiary_account_reference varchar(128) NOT NULL,
  local_reference varchar(128) NOT NULL,
  statement_line_id uuid,
  correction_payment_id uuid,
  outcome_reason varchar(500),
  outcome_evidence jsonb,
  state varchar(24) NOT NULL DEFAULT 'PENDING_CONFIRMATION' CHECK (
    state IN ('PENDING_CONFIRMATION', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'RETURNED')
  ),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, payment_line_id),
  UNIQUE (organization_id, bank_account_id, local_reference),
  FOREIGN KEY (organization_id, payment_line_id)
    REFERENCES payment_lines(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, bank_account_id)
    REFERENCES bank_accounts(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, currency)
    REFERENCES currencies(organization_id, code) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, correction_payment_id)
    REFERENCES payment_documents(organization_id, id) ON DELETE RESTRICT,
  CHECK (
    (state = 'PENDING_CONFIRMATION'
      AND statement_line_id IS NULL
      AND correction_payment_id IS NULL
      AND outcome_reason IS NULL
      AND outcome_evidence IS NULL)
    OR (state <> 'PENDING_CONFIRMATION'
      AND outcome_evidence IS NOT NULL
      AND jsonb_typeof(outcome_evidence) = 'object')
  )
);

CREATE INDEX bank_instructions_account_idx ON bank_instructions (
  organization_id, bank_account_id, state, created_at
);

CREATE TABLE bank_instruction_outcome_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  bank_instruction_id uuid NOT NULL,
  sequence_no bigint NOT NULL CHECK (sequence_no > 0),
  outcome varchar(24) NOT NULL CHECK (
    outcome IN ('CONFIRMED', 'REJECTED', 'CANCELLED', 'RETURNED')
  ),
  effective_at timestamptz NOT NULL,
  actor_user_id uuid NOT NULL,
  statement_line_id uuid,
  correction_payment_id uuid,
  reason varchar(500),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object' AND evidence <> '{}'::jsonb),
  source_version bigint NOT NULL CHECK (source_version > 0 AND source_version = sequence_no),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, bank_instruction_id, sequence_no),
  FOREIGN KEY (organization_id, bank_instruction_id)
    REFERENCES bank_instructions(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, correction_payment_id)
    REFERENCES payment_documents(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, actor_user_id)
    REFERENCES user_refs(organization_id, id) ON DELETE RESTRICT,
  CHECK (
    (outcome = 'CONFIRMED' AND correction_payment_id IS NULL AND reason IS NULL)
    OR (outcome IN ('REJECTED', 'CANCELLED', 'RETURNED')
      AND correction_payment_id IS NOT NULL
      AND NULLIF(BTRIM(reason), '') IS NOT NULL)
  )
);

CREATE INDEX bank_instruction_outcomes_instruction_idx
  ON bank_instruction_outcome_events (organization_id, bank_instruction_id, sequence_no);

CREATE FUNCTION reject_bank_instruction_outcome_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Bank Instruction Outcome Events are append-only'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER bank_instruction_outcome_events_append_only
BEFORE UPDATE OR DELETE ON bank_instruction_outcome_events
FOR EACH ROW EXECUTE FUNCTION reject_bank_instruction_outcome_event_mutation();

CREATE FUNCTION enforce_bank_instruction_outcome_event_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM bank_instructions instruction
    WHERE instruction.organization_id = NEW.organization_id
      AND instruction.id = NEW.bank_instruction_id
      AND instruction.state = NEW.outcome
      AND instruction.version = NEW.source_version
      AND instruction.statement_line_id IS NOT DISTINCT FROM NEW.statement_line_id
      AND instruction.correction_payment_id IS NOT DISTINCT FROM NEW.correction_payment_id
      AND instruction.outcome_reason IS NOT DISTINCT FROM NEW.reason
      AND instruction.outcome_evidence = NEW.evidence
  ) THEN
    RAISE EXCEPTION 'Bank Instruction outcome event must equal its current projection'
      USING ERRCODE = '23514', CONSTRAINT = 'bank_instruction_outcome_event_consistency';
  END IF;

  IF (NEW.outcome = 'RETURNED' AND (
      NEW.sequence_no <> 2 OR NOT EXISTS (
        SELECT 1 FROM bank_instruction_outcome_events prior
        WHERE prior.organization_id = NEW.organization_id
          AND prior.bank_instruction_id = NEW.bank_instruction_id
          AND prior.sequence_no = 1 AND prior.outcome = 'CONFIRMED'
      ))) OR (NEW.outcome <> 'RETURNED' AND NEW.sequence_no <> 1) THEN
    RAISE EXCEPTION 'Invalid Bank Instruction outcome history'
      USING ERRCODE = '23514', CONSTRAINT = 'bank_instruction_outcome_transition_history';
  END IF;

  IF NEW.statement_line_id IS NOT NULL OR NEW.evidence ? 'statementLineId' THEN
    RAISE EXCEPTION 'Statement evidence is unavailable until reconciliation is authorized'
      USING ERRCODE = '23514', CONSTRAINT = 'bank_instruction_outcome_statement_consistency';
  END IF;

  IF NOT (NEW.evidence ? 'attachments')
     OR jsonb_typeof(NEW.evidence->'attachments') <> 'array'
     OR jsonb_array_length(NEW.evidence->'attachments') = 0
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(NEW.evidence->'attachments') item
       WHERE NOT EXISTS (
         SELECT 1 FROM attachments attachment
         WHERE attachment.organization_id = NEW.organization_id
           AND attachment.id = (item->>'id')::uuid
           AND attachment.content_digest = item->>'contentDigest'
           AND attachment.state = 'ACTIVE'
       )
     ) THEN
    RAISE EXCEPTION 'Outcome attachments must be active digest-matched evidence'
      USING ERRCODE = '23514', CONSTRAINT = 'bank_instruction_outcome_attachment_consistency';
  END IF;

  IF NEW.correction_payment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM bank_instructions instruction
    JOIN payment_lines original_line
      ON original_line.organization_id = instruction.organization_id
     AND original_line.id = instruction.payment_line_id
    JOIN payment_documents original_payment
      ON original_payment.organization_id = original_line.organization_id
     AND original_payment.id = original_line.payment_document_id
    JOIN payment_documents correction
      ON correction.organization_id = original_payment.organization_id
     AND correction.id = NEW.correction_payment_id
    WHERE instruction.organization_id = NEW.organization_id
      AND instruction.id = NEW.bank_instruction_id
      AND original_payment.reversed_payment_id = correction.id
      AND correction.execution_state = 'EXECUTED'
      AND NEW.evidence->>'correctionPaymentId' = NEW.correction_payment_id::text
  ) THEN
    RAISE EXCEPTION 'Negative outcome requires its linked executed correction Payment'
      USING ERRCODE = '23514', CONSTRAINT = 'bank_instruction_outcome_correction_consistency';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER bank_instruction_outcome_event_evidence_guard
AFTER INSERT ON bank_instruction_outcome_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_bank_instruction_outcome_event_evidence();

CREATE TABLE payment_execution_effects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  payment_line_id uuid NOT NULL,
  effect_key varchar(128) NOT NULL,
  effect_type varchar(24) NOT NULL CHECK (
    effect_type IN ('CASHBOX_MOVEMENT', 'BANK_MOVEMENT', 'BANK_INSTRUCTION', 'ISSUED_CHEQUE')
  ),
  direction varchar(8) NOT NULL CHECK (direction IN ('OUTGOING', 'REVERSAL')),
  amount numeric(38,8) NOT NULL CHECK (amount > 0),
  currency varchar(8) NOT NULL,
  business_date date NOT NULL,
  source_version bigint NOT NULL CHECK (source_version > 0),
  movement_fact_id uuid,
  bank_instruction_id uuid,
  issued_cheque_id uuid,
  reversal_of_effect_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, id, currency, amount),
  UNIQUE (organization_id, payment_line_id, effect_key, direction),
  UNIQUE (organization_id, reversal_of_effect_id),
  UNIQUE (organization_id, movement_fact_id),
  UNIQUE (organization_id, bank_instruction_id),
  UNIQUE (organization_id, issued_cheque_id),
  FOREIGN KEY (organization_id, payment_line_id)
    REFERENCES payment_lines(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, movement_fact_id)
    REFERENCES movement_facts(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, bank_instruction_id)
    REFERENCES bank_instructions(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, reversal_of_effect_id, currency, amount)
    REFERENCES payment_execution_effects(organization_id, id, currency, amount)
    ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, currency)
    REFERENCES currencies(organization_id, code) ON DELETE RESTRICT,
  CHECK (
    (direction = 'OUTGOING' AND reversal_of_effect_id IS NULL AND (
      (effect_type IN ('CASHBOX_MOVEMENT', 'BANK_MOVEMENT')
        AND movement_fact_id IS NOT NULL AND bank_instruction_id IS NULL AND issued_cheque_id IS NULL)
      OR (effect_type = 'BANK_INSTRUCTION'
        AND movement_fact_id IS NULL AND bank_instruction_id IS NOT NULL AND issued_cheque_id IS NULL)
      OR (effect_type = 'ISSUED_CHEQUE'
        AND movement_fact_id IS NULL AND bank_instruction_id IS NULL AND issued_cheque_id IS NOT NULL)
    ))
    OR (direction = 'REVERSAL'
      AND effect_type IN ('CASHBOX_MOVEMENT', 'BANK_MOVEMENT')
      AND reversal_of_effect_id IS NOT NULL
      AND movement_fact_id IS NOT NULL
      AND bank_instruction_id IS NULL
      AND issued_cheque_id IS NULL)
  )
);

CREATE INDEX payment_execution_effects_line_idx
  ON payment_execution_effects (organization_id, payment_line_id, direction);

CREATE FUNCTION reject_payment_execution_effect_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Payment Execution Effects are append-only'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER payment_execution_effects_append_only
BEFORE UPDATE OR DELETE ON payment_execution_effects
FOR EACH ROW EXECUTE FUNCTION reject_payment_execution_effect_mutation();

CREATE FUNCTION enforce_payment_execution_effect_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original payment_execution_effects%ROWTYPE;
BEGIN
  IF NEW.direction = 'REVERSAL' THEN
    SELECT * INTO original FROM payment_execution_effects
    WHERE organization_id = NEW.organization_id AND id = NEW.reversal_of_effect_id
    FOR KEY SHARE;
    IF NOT FOUND OR original.direction <> 'OUTGOING'
       OR original.effect_type <> NEW.effect_type
       OR original.currency <> NEW.currency OR original.amount <> NEW.amount THEN
      RAISE EXCEPTION 'Payment reversal effect target is inconsistent'
        USING ERRCODE = '23514', CONSTRAINT = 'payment_execution_effect_reversal_target_consistency';
    END IF;
  END IF;

  IF NEW.effect_type IN ('CASHBOX_MOVEMENT', 'BANK_MOVEMENT') AND NOT EXISTS (
    SELECT 1
    FROM movement_facts fact
    JOIN payment_lines line
      ON line.organization_id = NEW.organization_id AND line.id = NEW.payment_line_id
    JOIN payment_documents payment
      ON payment.organization_id = line.organization_id
     AND payment.id = line.payment_document_id
    WHERE fact.organization_id = NEW.organization_id
      AND fact.id = NEW.movement_fact_id
      AND fact.owner = 'domain.payments'
      AND fact.source_type = 'Payment'
      AND fact.source_id = payment.id
      AND fact.source_line_id = line.id
      AND fact.effect_key = NEW.effect_key
      AND fact.currency = NEW.currency AND fact.amount = NEW.amount
      AND fact.business_date = NEW.business_date
      AND fact.direction = CASE WHEN NEW.direction = 'OUTGOING' THEN 'DEBIT' ELSE 'CREDIT' END
      AND fact.state = 'POSTED'
      AND payment.business_date = NEW.business_date
      AND payment.version = NEW.source_version
      AND ((NEW.effect_type = 'CASHBOX_MOVEMENT'
          AND fact.endpoint_type = 'CASHBOX' AND fact.endpoint_id = line.cashbox_id)
        OR (NEW.effect_type = 'BANK_MOVEMENT'
          AND fact.endpoint_type = 'BANK_ACCOUNT' AND fact.endpoint_id = line.bank_account_id))
      AND ((NEW.direction = 'OUTGOING' AND fact.reversal_of_fact_id IS NULL)
        OR (NEW.direction = 'REVERSAL' AND fact.reversal_of_fact_id = original.movement_fact_id))
  ) THEN
    RAISE EXCEPTION 'Payment movement effect must reference its matching MovementFact'
      USING ERRCODE = '23514', CONSTRAINT = 'payment_execution_effect_movement_consistency';
  END IF;

  IF NEW.effect_type = 'BANK_INSTRUCTION' AND NOT EXISTS (
    SELECT 1
    FROM bank_instructions instruction
    JOIN payment_lines line
      ON line.organization_id = instruction.organization_id
     AND line.id = instruction.payment_line_id
    JOIN payment_documents payment
      ON payment.organization_id = line.organization_id
     AND payment.id = line.payment_document_id
    WHERE instruction.organization_id = NEW.organization_id
      AND instruction.id = NEW.bank_instruction_id
      AND instruction.payment_line_id = NEW.payment_line_id
      AND instruction.bank_account_id = line.bank_account_id
      AND instruction.currency = NEW.currency AND instruction.amount = NEW.amount
      AND payment.business_date = NEW.business_date
      AND payment.version = NEW.source_version
  ) THEN
    RAISE EXCEPTION 'Payment Bank Instruction effect is inconsistent'
      USING ERRCODE = '23514', CONSTRAINT = 'payment_execution_effect_bank_instruction_consistency';
  END IF;

  IF NEW.effect_type = 'ISSUED_CHEQUE' THEN
    RAISE EXCEPTION 'Cheque execution is unavailable until selector authorization'
      USING ERRCODE = '23514', CONSTRAINT = 'payment_execution_effect_issued_cheque_consistency';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER payment_execution_effect_evidence_guard
AFTER INSERT ON payment_execution_effects
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_payment_execution_effect_evidence();
