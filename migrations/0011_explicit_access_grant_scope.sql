ALTER TABLE access_grants
  ADD COLUMN organization_wide boolean;

UPDATE access_grants ag
SET organization_wide = NOT (
  ag.amount_ceiling IS NOT NULL
  OR EXISTS (
    SELECT 1 FROM access_grant_branch_scopes s
    WHERE s.access_grant_id = ag.id
  )
  OR EXISTS (
    SELECT 1 FROM access_grant_treasury_unit_scopes s
    WHERE s.access_grant_id = ag.id
  )
  OR EXISTS (
    SELECT 1 FROM access_grant_cashbox_scopes s
    WHERE s.access_grant_id = ag.id
  )
  OR EXISTS (
    SELECT 1 FROM access_grant_bank_account_scopes s
    WHERE s.access_grant_id = ag.id
  )
  OR EXISTS (
    SELECT 1 FROM access_grant_document_type_scopes s
    WHERE s.access_grant_id = ag.id
  )
  OR EXISTS (
    SELECT 1 FROM access_grant_method_category_scopes s
    WHERE s.access_grant_id = ag.id
  )
  OR EXISTS (
    SELECT 1 FROM access_grant_currency_scopes s
    WHERE s.access_grant_id = ag.id
  )
);

ALTER TABLE access_grants
  ALTER COLUMN organization_wide SET NOT NULL,
  ADD CONSTRAINT access_grants_wide_without_amount
    CHECK (NOT organization_wide OR amount_ceiling IS NULL);

CREATE FUNCTION enforce_access_grant_scope_mode()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_grant_ids uuid[];
  target_grant_id uuid;
  target_organization_wide boolean;
  target_has_amount boolean;
  target_has_scope boolean;
BEGIN
  IF TG_TABLE_NAME = 'access_grants' THEN
    target_grant_ids := ARRAY[NEW.id];
  ELSIF TG_OP = 'DELETE' THEN
    target_grant_ids := ARRAY[OLD.access_grant_id];
  ELSIF TG_OP = 'INSERT' OR OLD.access_grant_id = NEW.access_grant_id THEN
    target_grant_ids := ARRAY[NEW.access_grant_id];
  ELSIF OLD.access_grant_id < NEW.access_grant_id THEN
    target_grant_ids := ARRAY[OLD.access_grant_id, NEW.access_grant_id];
  ELSE
    target_grant_ids := ARRAY[NEW.access_grant_id, OLD.access_grant_id];
  END IF;

  FOREACH target_grant_id IN ARRAY target_grant_ids LOOP
    -- Serialize validation without conflicting with FK key-share locks from child inserts.
    SELECT organization_wide, amount_ceiling IS NOT NULL
    INTO target_organization_wide, target_has_amount
    FROM access_grants
    WHERE id = target_grant_id
    FOR NO KEY UPDATE;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM access_grant_branch_scopes s
      WHERE s.access_grant_id = target_grant_id
      UNION ALL
      SELECT 1 FROM access_grant_treasury_unit_scopes s
      WHERE s.access_grant_id = target_grant_id
      UNION ALL
      SELECT 1 FROM access_grant_cashbox_scopes s
      WHERE s.access_grant_id = target_grant_id
      UNION ALL
      SELECT 1 FROM access_grant_bank_account_scopes s
      WHERE s.access_grant_id = target_grant_id
      UNION ALL
      SELECT 1 FROM access_grant_document_type_scopes s
      WHERE s.access_grant_id = target_grant_id
      UNION ALL
      SELECT 1 FROM access_grant_method_category_scopes s
      WHERE s.access_grant_id = target_grant_id
      UNION ALL
      SELECT 1 FROM access_grant_currency_scopes s
      WHERE s.access_grant_id = target_grant_id
    ) INTO target_has_scope;

    IF target_organization_wide AND (target_has_amount OR target_has_scope) THEN
      RAISE EXCEPTION 'Organization-wide Access Grant cannot carry scope restrictions'
        USING
          ERRCODE = '23514',
          CONSTRAINT = 'access_grants_scope_mode_consistency';
    END IF;

    IF NOT target_organization_wide AND NOT target_has_amount AND NOT target_has_scope THEN
      RAISE EXCEPTION 'Restricted Access Grant requires at least one scope restriction'
        USING
          ERRCODE = '23514',
          CONSTRAINT = 'access_grants_scope_mode_consistency';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER access_grants_scope_mode_guard
AFTER INSERT OR UPDATE ON access_grants
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_access_grant_scope_mode();

CREATE CONSTRAINT TRIGGER access_grant_branch_scopes_mode_guard
AFTER INSERT OR UPDATE OR DELETE ON access_grant_branch_scopes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_access_grant_scope_mode();

CREATE CONSTRAINT TRIGGER access_grant_treasury_unit_scopes_mode_guard
AFTER INSERT OR UPDATE OR DELETE ON access_grant_treasury_unit_scopes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_access_grant_scope_mode();

CREATE CONSTRAINT TRIGGER access_grant_cashbox_scopes_mode_guard
AFTER INSERT OR UPDATE OR DELETE ON access_grant_cashbox_scopes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_access_grant_scope_mode();

CREATE CONSTRAINT TRIGGER access_grant_bank_account_scopes_mode_guard
AFTER INSERT OR UPDATE OR DELETE ON access_grant_bank_account_scopes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_access_grant_scope_mode();

CREATE CONSTRAINT TRIGGER access_grant_document_type_scopes_mode_guard
AFTER INSERT OR UPDATE OR DELETE ON access_grant_document_type_scopes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_access_grant_scope_mode();

CREATE CONSTRAINT TRIGGER access_grant_method_category_scopes_mode_guard
AFTER INSERT OR UPDATE OR DELETE ON access_grant_method_category_scopes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_access_grant_scope_mode();

CREATE CONSTRAINT TRIGGER access_grant_currency_scopes_mode_guard
AFTER INSERT OR UPDATE OR DELETE ON access_grant_currency_scopes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_access_grant_scope_mode();
