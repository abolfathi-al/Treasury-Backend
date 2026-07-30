ALTER TABLE collection_items
  ADD COLUMN branch_id UUID,
  ADD COLUMN treasury_unit_id UUID,
  ADD COLUMN collected_party_id UUID,
  ADD COLUMN created_at TIMESTAMPTZ,
  ADD COLUMN updated_at TIMESTAMPTZ;

UPDATE collection_items AS item
   SET treasury_unit_id = account.treasury_unit_id,
       branch_id = unit.branch_id,
       created_at = item.collected_at,
       updated_at = item.collected_at
  FROM bank_accounts AS account
  JOIN treasury_units AS unit
    ON unit.organization_id = account.organization_id
   AND unit.id = account.treasury_unit_id
 WHERE account.organization_id = item.organization_id
   AND account.id = item.destination_bank_account_id;

UPDATE collection_items AS item
   SET collected_party_id = document.party_id
  FROM receipt_lines AS line
  JOIN receipt_documents AS document
    ON document.organization_id = line.organization_id
   AND document.id = line.receipt_document_id
 WHERE item.source_fact_type = 'RECEIPT_LINE'
   AND line.organization_id = item.organization_id
   AND line.id = item.source_fact_id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM collection_items
     WHERE treasury_unit_id IS NULL
        OR expected_settlement_date IS NULL
        OR created_at IS NULL
        OR updated_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'Cannot upgrade collection_items: destination chain, expected settlement date, or timestamps are incomplete';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM collection_items AS item
      JOIN bank_accounts AS account
        ON account.organization_id = item.organization_id
       AND account.id = item.destination_bank_account_id
      JOIN treasury_units AS unit
        ON unit.organization_id = account.organization_id
       AND unit.id = account.treasury_unit_id
     WHERE item.treasury_unit_id IS DISTINCT FROM account.treasury_unit_id
        OR item.branch_id IS DISTINCT FROM unit.branch_id
  ) THEN
    RAISE EXCEPTION
      'Cannot upgrade collection_items: destination Bank Account scope chain is inconsistent';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM collection_items AS item
      LEFT JOIN receipt_lines AS line
        ON item.source_fact_type = 'RECEIPT_LINE'
       AND line.organization_id = item.organization_id
       AND line.id = item.source_fact_id
     WHERE item.source_fact_type = 'RECEIPT_LINE'
       AND line.id IS NULL
  ) THEN
    RAISE EXCEPTION
      'Cannot upgrade collection_items: Receipt Line source is missing or cross-Organization';
  END IF;
END;
$$;

ALTER TABLE collection_items
  DROP CONSTRAINT collection_items_state_check;

ALTER TABLE collection_items
  ALTER COLUMN treasury_unit_id SET NOT NULL,
  ALTER COLUMN expected_settlement_date SET NOT NULL,
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL,
  ALTER COLUMN updated_at SET DEFAULT now(),
  ADD CONSTRAINT collection_items_source_type_check
    CHECK (source_fact_type IN ('RECEIPT_LINE', 'CHEQUE_EVENT')),
  ADD CONSTRAINT collection_items_channel_type_check
    CHECK (
      channel_type IN (
        'BANK_TRANSFER', 'DIRECT_DEPOSIT', 'POS', 'GATEWAY',
        'CARD_TRANSFER', 'WALLET', 'FOREIGN_REMITTANCE', 'DEPOSITED_CHEQUE'
      )
    ),
  ADD CONSTRAINT collection_items_state_check
    CHECK (
      state IN (
        'OPEN', 'PARTIALLY_ALLOCATED', 'ALLOCATED', 'SETTLED',
        'REOPENED_AFTER_REVERSAL', 'DELAYED', 'DISPUTED',
        'RETURNED', 'CANCELLED'
      )
    ),
  ADD CONSTRAINT collection_items_gross_positive CHECK (gross_amount > 0),
  ADD CONSTRAINT collection_items_allocated_nonnegative CHECK (allocated_amount >= 0),
  ADD CONSTRAINT collection_items_remaining_nonnegative CHECK (remaining_amount >= 0),
  ADD CONSTRAINT collection_items_money_balance
    CHECK (allocated_amount + remaining_amount = gross_amount),
  ADD CONSTRAINT collection_items_state_money_shape
    CHECK (
      (
        state IN ('OPEN', 'REOPENED_AFTER_REVERSAL')
        AND allocated_amount = 0
        AND remaining_amount = gross_amount
      )
      OR (
        state = 'PARTIALLY_ALLOCATED'
        AND allocated_amount > 0
        AND remaining_amount > 0
      )
      OR (
        state IN ('ALLOCATED', 'SETTLED')
        AND allocated_amount = gross_amount
        AND remaining_amount = 0
      )
      OR state IN ('DELAYED', 'DISPUTED', 'RETURNED', 'CANCELLED')
    ),
  ADD CONSTRAINT collection_items_version_nonnegative CHECK (version >= 0),
  ADD CONSTRAINT collection_items_branch_fk
    FOREIGN KEY (organization_id, branch_id)
    REFERENCES branches(organization_id, id),
  ADD CONSTRAINT collection_items_treasury_unit_fk
    FOREIGN KEY (organization_id, treasury_unit_id)
    REFERENCES treasury_units(organization_id, id),
  ADD CONSTRAINT collection_items_collected_party_fk
    FOREIGN KEY (organization_id, collected_party_id)
    REFERENCES parties(organization_id, id);

CREATE UNIQUE INDEX uq_collection_item_provider_reference
  ON collection_items (
    organization_id,
    channel_type,
    (
      CASE
        WHEN channel_id IS NOT NULL THEN 'CHANNEL:' || channel_id::text
        ELSE 'BANK_ACCOUNT:' || destination_bank_account_id::text
      END
    ),
    provider_reference
  )
  WHERE provider_reference IS NOT NULL;

CREATE INDEX collection_items_queue_idx
  ON collection_items (organization_id, collected_at DESC, id DESC);

CREATE OR REPLACE FUNCTION enforce_collection_item_destination_scope_chain()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  destination_treasury_unit_id UUID;
  derived_branch_id UUID;
BEGIN
  SELECT account.treasury_unit_id, unit.branch_id
    INTO STRICT destination_treasury_unit_id, derived_branch_id
    FROM bank_accounts AS account
    JOIN treasury_units AS unit
      ON unit.organization_id = account.organization_id
     AND unit.id = account.treasury_unit_id
   WHERE account.organization_id = NEW.organization_id
     AND account.id = NEW.destination_bank_account_id;

  IF NEW.treasury_unit_id IS DISTINCT FROM destination_treasury_unit_id THEN
    RAISE EXCEPTION
      'Collection Item Treasury Unit must equal the destination Bank Account Treasury Unit';
  END IF;
  IF NEW.branch_id IS DISTINCT FROM derived_branch_id THEN
    RAISE EXCEPTION
      'Collection Item Branch must be null-safe equal to the destination Treasury Unit Branch';
  END IF;
  RETURN NEW;
EXCEPTION
  WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
    RAISE EXCEPTION
      'Collection Item destination scope must resolve to exactly one same-Organization Bank Account and Treasury Unit chain';
END;
$$;

CREATE CONSTRAINT TRIGGER collection_item_destination_scope_chain_consistency
AFTER INSERT OR UPDATE OF
  organization_id,
  destination_bank_account_id,
  treasury_unit_id,
  branch_id
ON collection_items
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION enforce_collection_item_destination_scope_chain();

CREATE OR REPLACE FUNCTION enforce_collection_item_source_fact()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  source_party_id UUID;
BEGIN
  IF NEW.source_fact_type = 'RECEIPT_LINE' THEN
    SELECT document.party_id
      INTO STRICT source_party_id
      FROM receipt_lines AS line
      JOIN receipt_documents AS document
        ON document.organization_id = line.organization_id
       AND document.id = line.receipt_document_id
     WHERE line.organization_id = NEW.organization_id
       AND line.id = NEW.source_fact_id;

    IF NEW.collected_party_id IS DISTINCT FROM source_party_id THEN
      RAISE EXCEPTION
        'Collection Item collected Party must equal its Receipt source Party';
    END IF;
  ELSIF NEW.source_fact_type = 'CHEQUE_EVENT' THEN
    SELECT cheque.payer_party_id
      INTO STRICT source_party_id
      FROM cheque_events AS event
      JOIN received_cheques AS cheque
        ON event.cheque_type = 'RECEIVED'
       AND cheque.id = event.cheque_id
     WHERE cheque.organization_id = NEW.organization_id
       AND event.id = NEW.source_fact_id;
    IF (
      NEW.channel_type <> 'DEPOSITED_CHEQUE'
      OR NEW.collected_party_id IS DISTINCT FROM source_party_id
    ) THEN
      RAISE EXCEPTION
        'Collection Item Cheque Event source must be a same-Organization deposited cheque with its source Party';
    END IF;
  END IF;
  RETURN NEW;
EXCEPTION
  WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
    RAISE EXCEPTION
      'Collection Item source must resolve to exactly one same-Organization source fact';
END;
$$;

CREATE CONSTRAINT TRIGGER collection_item_source_fact_consistency
AFTER INSERT OR UPDATE OF
  organization_id,
  source_fact_type,
  source_fact_id,
  collected_party_id,
  channel_type
ON collection_items
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION enforce_collection_item_source_fact();
