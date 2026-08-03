ALTER TABLE movement_facts
  DROP CONSTRAINT movement_facts_endpoint_type_check,
  ADD CONSTRAINT movement_facts_endpoint_type_check
    CHECK (endpoint_type IN ('CASHBOX', 'BANK_ACCOUNT', 'USER'));

ALTER TABLE transfer_documents
  DROP CONSTRAINT transfer_documents_state_check,
  ADD COLUMN released_by_user_id UUID,
  ADD COLUMN released_at TIMESTAMPTZ,
  ADD COLUMN received_by_user_id UUID,
  ADD COLUMN received_at TIMESTAMPTZ,
  ADD COLUMN receipt_recorded_at TIMESTAMPTZ,
  ADD COLUMN discrepancy_amount NUMERIC(38,8) NOT NULL DEFAULT 0,
  ADD COLUMN discrepancy_reason VARCHAR(500),
  ADD CONSTRAINT transfer_documents_state_check
    CHECK (state IN ('DRAFT', 'REQUESTED', 'APPROVED', 'IN_TRANSIT', 'DISCREPANCY', 'COMPLETED', 'REJECTED')),
  ADD CONSTRAINT transfer_documents_released_by_fk
    FOREIGN KEY (organization_id, released_by_user_id) REFERENCES user_refs(organization_id, id),
  ADD CONSTRAINT transfer_documents_received_by_fk
    FOREIGN KEY (organization_id, received_by_user_id) REFERENCES user_refs(organization_id, id),
  ADD CONSTRAINT transfer_documents_later_custodian_check
    CHECK (state NOT IN ('IN_TRANSIT', 'DISCREPANCY', 'COMPLETED') OR source_custodian_user_id IS NOT NULL),
  ADD CONSTRAINT transfer_documents_release_actor_check
    CHECK (released_by_user_id IS NULL OR released_by_user_id = source_custodian_user_id),
  ADD CONSTRAINT transfer_documents_release_pair_check
    CHECK ((released_by_user_id IS NULL) = (released_at IS NULL)),
  ADD CONSTRAINT transfer_documents_receipt_actor_check
    CHECK (received_by_user_id IS NULL OR (
      released_by_user_id IS NOT NULL
      AND received_by_user_id = destination_custodian_user_id
      AND received_by_user_id <> released_by_user_id
    )),
  ADD CONSTRAINT transfer_documents_receipt_time_pair_check
    CHECK ((received_by_user_id IS NULL) = (received_at IS NULL)
      AND (received_by_user_id IS NULL) = (receipt_recorded_at IS NULL)),
  ADD CONSTRAINT transfer_documents_receipt_time_bounds_check
    CHECK (received_at IS NULL OR (received_at >= released_at AND received_at <= receipt_recorded_at)),
  ADD CONSTRAINT transfer_documents_release_state_check
    CHECK (released_by_user_id IS NULL OR state IN ('IN_TRANSIT', 'DISCREPANCY', 'COMPLETED')),
  ADD CONSTRAINT transfer_documents_receipt_state_check
    CHECK (received_by_user_id IS NULL OR state IN ('DISCREPANCY', 'COMPLETED')),
  ADD CONSTRAINT transfer_documents_later_release_check
    CHECK (state NOT IN ('IN_TRANSIT', 'DISCREPANCY', 'COMPLETED') OR released_by_user_id IS NOT NULL),
  ADD CONSTRAINT transfer_documents_later_receipt_check
    CHECK (state NOT IN ('DISCREPANCY', 'COMPLETED') OR received_by_user_id IS NOT NULL),
  ADD CONSTRAINT transfer_documents_discrepancy_reason_check
    CHECK (state <> 'DISCREPANCY' OR NULLIF(BTRIM(discrepancy_reason), '') IS NOT NULL),
  ADD CONSTRAINT transfer_documents_discrepancy_nonnegative
    CHECK (discrepancy_amount >= 0);

CREATE TABLE transfer_transit_obligations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  transfer_document_id UUID NOT NULL,
  source_amount NUMERIC(38,8) NOT NULL CHECK (source_amount > 0),
  source_currency VARCHAR(8) NOT NULL,
  destination_amount NUMERIC(38,8) NOT NULL CHECK (destination_amount > 0),
  destination_currency VARCHAR(8) NOT NULL,
  source_movement_fact_id UUID NOT NULL,
  destination_movement_fact_id UUID,
  received_amount NUMERIC(38,8),
  received_currency VARCHAR(8),
  state VARCHAR(16) NOT NULL CHECK (state IN ('OPEN', 'DISCREPANCY', 'CLOSED', 'RETURNED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, transfer_document_id),
  UNIQUE (organization_id, source_movement_fact_id),
  UNIQUE (organization_id, destination_movement_fact_id),
  FOREIGN KEY (organization_id, transfer_document_id) REFERENCES transfer_documents(organization_id, id),
  FOREIGN KEY (organization_id, source_movement_fact_id) REFERENCES movement_facts(organization_id, id),
  FOREIGN KEY (organization_id, destination_movement_fact_id) REFERENCES movement_facts(organization_id, id),
  CHECK (
    (state = 'OPEN' AND destination_movement_fact_id IS NULL AND received_amount IS NULL AND received_currency IS NULL)
    OR (state = 'DISCREPANCY' AND destination_movement_fact_id IS NULL AND received_amount IS NOT NULL
      AND received_amount >= 0 AND received_currency = destination_currency)
    OR (state = 'CLOSED' AND destination_movement_fact_id IS NOT NULL
      AND received_amount = destination_amount AND received_currency = destination_currency)
    OR (state = 'RETURNED' AND destination_movement_fact_id IS NULL)
  )
);

CREATE FUNCTION enforce_transfer_transit_obligation_consistency()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1
    FROM transfer_documents transfer
    JOIN movement_facts source_fact
      ON source_fact.organization_id = NEW.organization_id
     AND source_fact.id = NEW.source_movement_fact_id
   WHERE transfer.organization_id = NEW.organization_id
     AND transfer.id = NEW.transfer_document_id
     AND transfer.source_amount = NEW.source_amount
     AND transfer.source_currency = NEW.source_currency
     AND transfer.destination_amount = NEW.destination_amount
     AND transfer.destination_currency = NEW.destination_currency
     AND source_fact.owner = 'domain.transfers'
     AND source_fact.source_type = 'Transfer'
     AND source_fact.source_id = NEW.transfer_document_id
     AND source_fact.source_line_id IS NULL
     AND source_fact.effect_key = 'SOURCE_RELEASE'
     AND source_fact.endpoint_type = transfer.source_type
     AND source_fact.endpoint_id = transfer.source_id
     AND source_fact.direction = 'DEBIT'
     AND source_fact.amount = NEW.source_amount
     AND source_fact.currency = NEW.source_currency
     AND source_fact.business_date = transfer.business_date
     AND source_fact.reversal_of_fact_id IS NULL
     AND source_fact.state = 'POSTED'
   FOR KEY SHARE OF transfer, source_fact;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transfer transit obligation must match its immutable Transfer and source MovementFact'
      USING ERRCODE = '23514', CONSTRAINT = 'transfer_transit_obligation_source_consistency';
  END IF;

  IF NEW.destination_movement_fact_id IS NOT NULL THEN
    PERFORM 1
      FROM transfer_documents transfer
      JOIN movement_facts destination_fact
        ON destination_fact.organization_id = NEW.organization_id
       AND destination_fact.id = NEW.destination_movement_fact_id
     WHERE transfer.organization_id = NEW.organization_id
       AND transfer.id = NEW.transfer_document_id
       AND destination_fact.owner = 'domain.transfers'
       AND destination_fact.source_type = 'Transfer'
       AND destination_fact.source_id = NEW.transfer_document_id
       AND destination_fact.source_line_id IS NULL
       AND destination_fact.effect_key = 'DESTINATION_RECEIPT'
       AND destination_fact.endpoint_type = transfer.destination_type
       AND destination_fact.endpoint_id = transfer.destination_id
       AND destination_fact.direction = 'CREDIT'
       AND destination_fact.amount = NEW.destination_amount
       AND destination_fact.currency = NEW.destination_currency
       AND destination_fact.business_date = transfer.business_date
       AND destination_fact.reversal_of_fact_id IS NULL
       AND destination_fact.state = 'POSTED'
     FOR KEY SHARE OF transfer, destination_fact;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Closed Transfer transit obligation must reference its exact destination MovementFact'
        USING ERRCODE = '23514', CONSTRAINT = 'transfer_transit_obligation_destination_consistency';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER transfer_transit_obligation_consistency_guard
  BEFORE INSERT OR UPDATE ON transfer_transit_obligations
  FOR EACH ROW EXECUTE FUNCTION enforce_transfer_transit_obligation_consistency();

CREATE FUNCTION reject_transfer_transit_obligation_delete()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Transfer transit obligations cannot be deleted'
    USING ERRCODE = '23514', CONSTRAINT = 'transfer_transit_obligations_no_delete';
END;
$$;

CREATE TRIGGER transfer_transit_obligations_no_delete
  BEFORE DELETE ON transfer_transit_obligations
  FOR EACH ROW EXECUTE FUNCTION reject_transfer_transit_obligation_delete();
