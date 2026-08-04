INSERT INTO operation_permissions (permission)
VALUES ('approval-policy.manage'), ('delegation.manage')
ON CONFLICT (permission) DO NOTHING;

CREATE FUNCTION access_grant_scope_digest(grant_id uuid)
RETURNS char(64)
LANGUAGE sql
STABLE
STRICT
AS $$
  SELECT encode(digest(convert_to(concat_ws(E'\x1f',
    COALESCE((SELECT string_agg(s.branch_id::text, ',' ORDER BY s.branch_id)
      FROM access_grant_branch_scopes s WHERE s.access_grant_id = ag.id), ''),
    COALESCE((SELECT string_agg(s.treasury_unit_id::text, ',' ORDER BY s.treasury_unit_id)
      FROM access_grant_treasury_unit_scopes s WHERE s.access_grant_id = ag.id), ''),
    COALESCE((SELECT string_agg(s.cashbox_id::text, ',' ORDER BY s.cashbox_id)
      FROM access_grant_cashbox_scopes s WHERE s.access_grant_id = ag.id), ''),
    COALESCE((SELECT string_agg(s.bank_account_id::text, ',' ORDER BY s.bank_account_id)
      FROM access_grant_bank_account_scopes s WHERE s.access_grant_id = ag.id), ''),
    COALESCE((SELECT string_agg(s.document_type, ',' ORDER BY s.document_type)
      FROM access_grant_document_type_scopes s WHERE s.access_grant_id = ag.id), ''),
    COALESCE((SELECT string_agg(s.method_category, ',' ORDER BY s.method_category)
      FROM access_grant_method_category_scopes s WHERE s.access_grant_id = ag.id), ''),
    COALESCE((SELECT string_agg(s.currency, ',' ORDER BY s.currency)
      FROM access_grant_currency_scopes s WHERE s.access_grant_id = ag.id), ''),
    COALESCE(ag.amount_ceiling::text, ''),
    COALESCE(ag.amount_ceiling_currency, '')
  ), 'UTF8'), 'sha256'), 'hex')::char(64)
  FROM access_grants ag
  WHERE ag.id = grant_id
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM delegations) THEN
    RAISE EXCEPTION 'INC-5A migration requires the previously non-routable delegations table to be empty';
  END IF;
END;
$$;

ALTER TABLE delegations
  ADD COLUMN source_grant_version integer NOT NULL CHECK (source_grant_version >= 0),
  ADD COLUMN source_scope_digest char(64) NOT NULL CHECK (source_scope_digest ~ '^[0-9a-f]{64}$'),
  ADD COLUMN branch_id uuid,
  ADD COLUMN treasury_unit_id uuid,
  ADD COLUMN currency varchar(8),
  ADD COLUMN document_type varchar(64),
  ADD COLUMN method_category varchar(32),
  ADD COLUMN amount_ceiling numeric(38,8),
  ADD COLUMN amount_ceiling_currency varchar(8),
  ADD COLUMN revocation_reason varchar(500),
  ADD CONSTRAINT delegations_branch_fk FOREIGN KEY (organization_id, branch_id)
    REFERENCES branches(organization_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT delegations_treasury_unit_fk FOREIGN KEY (organization_id, treasury_unit_id)
    REFERENCES treasury_units(organization_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT delegations_currency_fk FOREIGN KEY (organization_id, currency)
    REFERENCES currencies(organization_id, code) ON DELETE RESTRICT,
  ADD CONSTRAINT delegations_amount_currency_fk FOREIGN KEY (organization_id, amount_ceiling_currency)
    REFERENCES currencies(organization_id, code) ON DELETE RESTRICT,
  ADD CONSTRAINT delegations_scope_check CHECK (
    branch_id IS NOT NULL OR treasury_unit_id IS NOT NULL OR currency IS NOT NULL
    OR document_type IS NOT NULL OR method_category IS NOT NULL OR amount_ceiling IS NOT NULL
  ),
  ADD CONSTRAINT delegations_amount_check CHECK (
    (amount_ceiling IS NULL AND amount_ceiling_currency IS NULL)
    OR (amount_ceiling > 0 AND amount_ceiling_currency IS NOT NULL)
  ),
  ADD CONSTRAINT delegations_currency_amount_check CHECK (
    currency IS NULL OR amount_ceiling_currency IS NULL OR currency = amount_ceiling_currency
  );

CREATE FUNCTION delegation_is_current(delegation_id uuid, grant_id uuid, actor_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
STRICT
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM delegations d
    JOIN access_grants ag ON ag.id = d.access_grant_id
      AND ag.organization_id = d.organization_id
    JOIN roles r ON r.id = ag.role_id
      AND r.organization_id = ag.organization_id
      AND r.state = 'ACTIVE'
    JOIN user_refs grantor ON grantor.id = d.grantor_user_id
      AND grantor.organization_id = d.organization_id
      AND grantor.state = 'ACTIVE'
    JOIN user_refs delegate ON delegate.id = d.delegate_user_id
      AND delegate.organization_id = d.organization_id
      AND delegate.state = 'ACTIVE'
    WHERE d.id = delegation_id
      AND ag.id = grant_id
      AND d.grantor_user_id = ag.user_ref_id
      AND d.delegate_user_id = actor_id
      AND d.revoked_at IS NULL
      AND d.valid_from <= now() AND d.valid_to > now()
      AND ag.state = 'ACTIVE'
      AND ag.valid_from <= now() AND (ag.valid_to IS NULL OR ag.valid_to > now())
      AND d.source_grant_version = ag.version
      AND d.source_scope_digest = access_grant_scope_digest(ag.id)
      AND (d.branch_id IS NULL
        OR NOT EXISTS (SELECT 1 FROM access_grant_branch_scopes s WHERE s.access_grant_id = ag.id)
        OR EXISTS (SELECT 1 FROM access_grant_branch_scopes s
          WHERE s.access_grant_id = ag.id AND s.branch_id = d.branch_id))
      AND (d.treasury_unit_id IS NULL
        OR NOT EXISTS (SELECT 1 FROM access_grant_treasury_unit_scopes s WHERE s.access_grant_id = ag.id)
        OR EXISTS (SELECT 1 FROM access_grant_treasury_unit_scopes s
          WHERE s.access_grant_id = ag.id AND s.treasury_unit_id = d.treasury_unit_id))
      AND (d.document_type IS NULL
        OR NOT EXISTS (SELECT 1 FROM access_grant_document_type_scopes s WHERE s.access_grant_id = ag.id)
        OR EXISTS (SELECT 1 FROM access_grant_document_type_scopes s
          WHERE s.access_grant_id = ag.id AND s.document_type = d.document_type))
      AND (d.method_category IS NULL
        OR NOT EXISTS (SELECT 1 FROM access_grant_method_category_scopes s WHERE s.access_grant_id = ag.id)
        OR EXISTS (SELECT 1 FROM access_grant_method_category_scopes s
          WHERE s.access_grant_id = ag.id AND s.method_category = d.method_category))
      AND (d.currency IS NULL
        OR NOT EXISTS (SELECT 1 FROM access_grant_currency_scopes s WHERE s.access_grant_id = ag.id)
        OR EXISTS (SELECT 1 FROM access_grant_currency_scopes s
          WHERE s.access_grant_id = ag.id AND s.currency = d.currency))
      AND (d.amount_ceiling IS NULL OR (
        (ag.amount_ceiling IS NULL OR (
          ag.amount_ceiling_currency = d.amount_ceiling_currency
          AND d.amount_ceiling <= ag.amount_ceiling
        ))
        AND (
          NOT EXISTS (SELECT 1 FROM access_grant_currency_scopes s WHERE s.access_grant_id = ag.id)
          OR EXISTS (SELECT 1 FROM access_grant_currency_scopes s
            WHERE s.access_grant_id = ag.id AND s.currency = d.amount_ceiling_currency)
        )
      ))
      AND (
        (d.branch_id IS NOT NULL AND (SELECT count(*) FROM access_grant_branch_scopes s
          WHERE s.access_grant_id = ag.id) <> 1)
        OR (d.treasury_unit_id IS NOT NULL AND (SELECT count(*) FROM access_grant_treasury_unit_scopes s
          WHERE s.access_grant_id = ag.id) <> 1)
        OR (d.document_type IS NOT NULL AND (SELECT count(*) FROM access_grant_document_type_scopes s
          WHERE s.access_grant_id = ag.id) <> 1)
        OR (d.method_category IS NOT NULL AND (SELECT count(*) FROM access_grant_method_category_scopes s
          WHERE s.access_grant_id = ag.id) <> 1)
        OR (d.currency IS NOT NULL AND (SELECT count(*) FROM access_grant_currency_scopes s
          WHERE s.access_grant_id = ag.id) <> 1)
        OR (d.amount_ceiling IS NOT NULL AND (
          ag.amount_ceiling IS NULL OR d.amount_ceiling < ag.amount_ceiling
        ))
      )
      AND EXISTS (
        SELECT 1 FROM identity_accounts ia
        WHERE ia.user_ref_id = grantor.id AND ia.state = 'ACTIVE'
      )
      AND EXISTS (
        SELECT 1 FROM identity_accounts ia
        WHERE ia.user_ref_id = delegate.id AND ia.state = 'ACTIVE'
      )
  )
$$;

DO $$
DECLARE revocation_constraint text;
BEGIN
  SELECT conname INTO revocation_constraint
  FROM pg_constraint
  WHERE conrelid = 'delegations'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%revoked_at IS NULL%revoked_by_user_id IS NULL%';
  IF revocation_constraint IS NULL THEN
    RAISE EXCEPTION 'Existing delegation revocation constraint was not found';
  END IF;
  EXECUTE format('ALTER TABLE delegations DROP CONSTRAINT %I', revocation_constraint);
END;
$$;
ALTER TABLE delegations ADD CONSTRAINT delegations_revocation_pair CHECK (
  (revoked_at IS NULL AND revoked_by_user_id IS NULL AND revocation_reason IS NULL)
  OR (revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL AND revocation_reason IS NOT NULL)
);

CREATE OR REPLACE FUNCTION prevent_delegation_rewrite()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Delegation history is retained; revoke instead of deleting' USING ERRCODE = '23514';
  END IF;
  IF (NEW.organization_id, NEW.access_grant_id, NEW.source_grant_version,
      NEW.source_scope_digest, NEW.grantor_user_id, NEW.delegate_user_id,
      NEW.branch_id, NEW.treasury_unit_id, NEW.currency, NEW.document_type,
      NEW.method_category, NEW.amount_ceiling, NEW.amount_ceiling_currency,
      NEW.reason, NEW.valid_from, NEW.valid_to, NEW.created_at)
     IS DISTINCT FROM
     (OLD.organization_id, OLD.access_grant_id, OLD.source_grant_version,
      OLD.source_scope_digest, OLD.grantor_user_id, OLD.delegate_user_id,
      OLD.branch_id, OLD.treasury_unit_id, OLD.currency, OLD.document_type,
      OLD.method_category, OLD.amount_ceiling, OLD.amount_ceiling_currency,
      OLD.reason, OLD.valid_from, OLD.valid_to, OLD.created_at) THEN
    RAISE EXCEPTION 'Delegation authority and validity are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND
     (NEW.revoked_at, NEW.revoked_by_user_id, NEW.revocation_reason)
       IS DISTINCT FROM (OLD.revoked_at, OLD.revoked_by_user_id, OLD.revocation_reason) THEN
    RAISE EXCEPTION 'Delegation revocation is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE approval_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  code varchar(64) NOT NULL,
  name varchar(240) NOT NULL,
  document_type varchar(64) NOT NULL,
  organization_wide boolean NOT NULL,
  branch_id uuid,
  treasury_unit_id uuid,
  currency varchar(8),
  method_category varchar(32),
  minimum_base_amount numeric(38,8),
  maximum_base_amount numeric(38,8),
  separation_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  aggregation_window_kind varchar(16),
  aggregation_keys jsonb,
  aggregation_override_second_approval boolean,
  state varchar(16) NOT NULL DEFAULT 'ACTIVE',
  policy_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, document_type, code, policy_version),
  FOREIGN KEY (organization_id, branch_id) REFERENCES branches(organization_id, id),
  FOREIGN KEY (organization_id, treasury_unit_id) REFERENCES treasury_units(organization_id, id),
  FOREIGN KEY (organization_id, currency) REFERENCES currencies(organization_id, code),
  CHECK (organization_wide <> (
    branch_id IS NOT NULL OR treasury_unit_id IS NOT NULL OR currency IS NOT NULL
    OR method_category IS NOT NULL OR minimum_base_amount IS NOT NULL OR maximum_base_amount IS NOT NULL
  )),
  CHECK ((minimum_base_amount IS NULL OR minimum_base_amount >= 0)
    AND (maximum_base_amount IS NULL OR maximum_base_amount >= 0)
    AND (maximum_base_amount IS NULL OR minimum_base_amount IS NULL OR maximum_base_amount >= minimum_base_amount)),
  CHECK (state IN ('DRAFT', 'ACTIVE', 'RETIRED')),
  CHECK (policy_version > 0),
  CHECK (jsonb_typeof(separation_rules) = 'array'),
  CHECK ((aggregation_window_kind IS NULL AND aggregation_keys IS NULL AND aggregation_override_second_approval IS NULL)
    OR (document_type = 'PAYMENT' AND aggregation_window_kind = 'BUSINESS_DATE'
      AND jsonb_typeof(aggregation_keys) = 'array' AND jsonb_array_length(aggregation_keys) > 0
      AND aggregation_override_second_approval IS TRUE))
);

CREATE TABLE approval_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  approval_policy_id uuid NOT NULL,
  step_order integer NOT NULL CHECK (step_order > 0),
  required_role_id uuid,
  named_approver_id uuid,
  approvals_required integer NOT NULL CHECK (approvals_required > 0),
  separation_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, approval_policy_id, step_order),
  FOREIGN KEY (organization_id, approval_policy_id) REFERENCES approval_policies(organization_id, id),
  FOREIGN KEY (organization_id, required_role_id) REFERENCES roles(organization_id, id),
  FOREIGN KEY (organization_id, named_approver_id) REFERENCES user_refs(organization_id, id),
  CHECK ((required_role_id IS NOT NULL) <> (named_approver_id IS NOT NULL)),
  CHECK (jsonb_typeof(separation_rules) = 'array')
);

INSERT INTO approval_policies (
  id, organization_id, code, name, document_type, organization_wide,
  branch_id, treasury_unit_id, currency, method_category,
  minimum_base_amount, maximum_base_amount, separation_rules,
  aggregation_window_kind, aggregation_keys,
  aggregation_override_second_approval, state, policy_version,
  created_at, updated_at
)
SELECT p.id, p.organization_id, p.code, p.name, p.document_type,
       NOT (p.branch_id IS NOT NULL OR p.treasury_unit_id IS NOT NULL
         OR p.currency IS NOT NULL OR p.method_category IS NOT NULL
         OR p.amount_minimum IS NOT NULL OR p.amount_maximum IS NOT NULL),
       p.branch_id, p.treasury_unit_id, p.currency, p.method_category,
       p.amount_minimum, p.amount_maximum,
       COALESCE((
         SELECT to_jsonb(array_agg(DISTINCT rule ORDER BY rule))
         FROM payment_approval_policy_steps s
         CROSS JOIN LATERAL unnest(s.separation_rules) AS rule
         WHERE s.organization_id = p.organization_id AND s.policy_id = p.id
       ), '[]'::jsonb),
       p.aggregation_window_kind,
       CASE WHEN p.aggregation_window_kind IS NULL THEN NULL
         ELSE to_jsonb(p.aggregation_keys) END,
       CASE WHEN p.aggregation_window_kind IS NULL THEN NULL ELSE true END,
       p.state, p.version, p.created_at, p.created_at
FROM payment_approval_policies p;

INSERT INTO approval_policies (
  id, organization_id, code, name, document_type, organization_wide,
  branch_id, treasury_unit_id, currency, method_category,
  minimum_base_amount, maximum_base_amount, separation_rules,
  state, policy_version, created_at, updated_at
)
SELECT p.id, p.organization_id, p.code, p.name, p.document_type,
       NOT (p.branch_id IS NOT NULL OR p.treasury_unit_id IS NOT NULL
         OR p.currency IS NOT NULL OR p.method_category IS NOT NULL
         OR p.amount_minimum IS NOT NULL OR p.amount_maximum IS NOT NULL),
       p.branch_id, p.treasury_unit_id, p.currency, p.method_category,
       p.amount_minimum, p.amount_maximum,
       COALESCE((
         SELECT to_jsonb(array_agg(DISTINCT rule ORDER BY rule))
         FROM receipt_approval_policy_steps s
         CROSS JOIN LATERAL unnest(s.separation_rules) AS rule
         WHERE s.organization_id = p.organization_id AND s.policy_id = p.id
       ), '[]'::jsonb),
       p.state, p.version, p.created_at, p.created_at
FROM receipt_approval_policies p;

INSERT INTO approval_policies (
  id, organization_id, code, name, document_type, organization_wide,
  branch_id, treasury_unit_id, currency, minimum_base_amount,
  maximum_base_amount, separation_rules, state, policy_version,
  created_at, updated_at
)
SELECT p.id, p.organization_id, p.code, p.name, 'TRANSFER',
       NOT (p.branch_id IS NOT NULL OR p.treasury_unit_id IS NOT NULL
         OR p.currency IS NOT NULL OR p.amount_minimum IS NOT NULL
         OR p.amount_maximum IS NOT NULL),
       p.branch_id, p.treasury_unit_id, p.currency, p.amount_minimum,
       p.amount_maximum,
       COALESCE((
         SELECT to_jsonb(array_agg(DISTINCT rule ORDER BY rule))
         FROM transfer_approval_policy_steps s
         CROSS JOIN LATERAL unnest(s.separation_rules) AS rule
         WHERE s.organization_id = p.organization_id AND s.policy_id = p.id
       ), '[]'::jsonb),
       p.state, p.version, p.created_at, p.created_at
FROM transfer_approval_policies p;

INSERT INTO approval_steps (
  id, organization_id, approval_policy_id, step_order,
  required_role_id, named_approver_id, approvals_required, separation_rules
)
SELECT s.id, s.organization_id, s.policy_id, s.step_order,
       s.role_id, s.approver_user_id, s.approvals_required,
       to_jsonb(s.separation_rules)
FROM payment_approval_policy_steps s;

INSERT INTO approval_steps (
  id, organization_id, approval_policy_id, step_order,
  required_role_id, named_approver_id, approvals_required, separation_rules
)
SELECT s.id, s.organization_id, s.policy_id, s.step_order,
       s.role_id, s.approver_user_id, s.approvals_required,
       to_jsonb(s.separation_rules)
FROM receipt_approval_policy_steps s;

INSERT INTO approval_steps (
  id, organization_id, approval_policy_id, step_order,
  required_role_id, named_approver_id, approvals_required, separation_rules
)
SELECT s.id, s.organization_id, s.policy_id, s.step_order,
       s.role_id, s.approver_user_id, s.approvals_required,
       to_jsonb(s.separation_rules)
FROM transfer_approval_policy_steps s;

ALTER TABLE receipt_approval_snapshot_contexts
  DROP CONSTRAINT receipt_approval_snapshot_contex_organization_id_policy_id_fkey,
  ADD CONSTRAINT receipt_approval_snapshot_contexts_policy_fk
    FOREIGN KEY (organization_id, policy_id)
    REFERENCES approval_policies(organization_id, id) ON DELETE RESTRICT;
ALTER TABLE payment_approval_snapshot_contexts
  DROP CONSTRAINT payment_approval_snapshot_contex_organization_id_policy_id_fkey,
  ADD CONSTRAINT payment_approval_snapshot_contexts_policy_fk
    FOREIGN KEY (organization_id, policy_id)
    REFERENCES approval_policies(organization_id, id) ON DELETE RESTRICT;
ALTER TABLE transfer_approval_snapshots
  DROP CONSTRAINT transfer_approval_snapshots_organization_id_policy_id_fkey,
  ADD CONSTRAINT transfer_approval_snapshots_policy_fk
    FOREIGN KEY (organization_id, policy_id)
    REFERENCES approval_policies(organization_id, id) ON DELETE RESTRICT;

CREATE INDEX approval_policies_page_idx
  ON approval_policies (organization_id, created_at DESC, id DESC);
CREATE INDEX delegations_page_idx
  ON delegations (organization_id, created_at DESC, id DESC);

CREATE FUNCTION prevent_approval_policy_rewrite()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Approval Policy versions and steps are immutable' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER approval_policy_rewrite_guard
BEFORE UPDATE OR DELETE ON approval_policies
FOR EACH ROW EXECUTE FUNCTION prevent_approval_policy_rewrite();

CREATE TRIGGER approval_step_rewrite_guard
BEFORE UPDATE OR DELETE ON approval_steps
FOR EACH ROW EXECUTE FUNCTION prevent_approval_policy_rewrite();
