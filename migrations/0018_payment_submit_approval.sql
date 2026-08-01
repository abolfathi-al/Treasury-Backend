INSERT INTO operation_permissions (permission)
VALUES ('payment.reject')
ON CONFLICT (permission) DO NOTHING;

CREATE TABLE delegations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  access_grant_id uuid NOT NULL,
  grantor_user_id uuid NOT NULL,
  delegate_user_id uuid NOT NULL,
  reason varchar(500) NOT NULL CHECK (length(btrim(reason)) > 0),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, access_grant_id)
    REFERENCES access_grants(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, grantor_user_id)
    REFERENCES user_refs(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, delegate_user_id)
    REFERENCES user_refs(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, revoked_by_user_id)
    REFERENCES user_refs(organization_id, id) ON DELETE RESTRICT,
  CHECK (grantor_user_id <> delegate_user_id),
  CHECK (valid_to > valid_from),
  CHECK ((revoked_at IS NULL) = (revoked_by_user_id IS NULL))
);

CREATE INDEX delegations_delegate_active_idx
  ON delegations (organization_id, delegate_user_id, valid_from, valid_to)
  WHERE revoked_at IS NULL;

CREATE FUNCTION enforce_delegation_grantor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM access_grants
    WHERE organization_id = NEW.organization_id
      AND id = NEW.access_grant_id
      AND user_ref_id = NEW.grantor_user_id
  ) THEN
    RAISE EXCEPTION 'Delegation grantor must own the delegated Access Grant'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER delegation_grantor_guard
AFTER INSERT OR UPDATE OF organization_id, access_grant_id, grantor_user_id ON delegations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_delegation_grantor();

CREATE FUNCTION prevent_delegation_rewrite()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Delegation history is retained; revoke instead of deleting'
      USING ERRCODE = '23514';
  END IF;
  IF (NEW.organization_id, NEW.access_grant_id, NEW.grantor_user_id,
      NEW.delegate_user_id, NEW.reason, NEW.valid_from, NEW.valid_to, NEW.created_at)
     IS DISTINCT FROM
     (OLD.organization_id, OLD.access_grant_id, OLD.grantor_user_id,
      OLD.delegate_user_id, OLD.reason, OLD.valid_from, OLD.valid_to, OLD.created_at) THEN
    RAISE EXCEPTION 'Delegation authority and validity are immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL
     AND (NEW.revoked_at, NEW.revoked_by_user_id)
         IS DISTINCT FROM (OLD.revoked_at, OLD.revoked_by_user_id) THEN
    RAISE EXCEPTION 'Delegation revocation is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER delegation_rewrite_guard
BEFORE UPDATE OR DELETE ON delegations
FOR EACH ROW EXECUTE FUNCTION prevent_delegation_rewrite();

ALTER TABLE payment_documents
  DROP CONSTRAINT payment_documents_state_check,
  DROP CONSTRAINT payment_documents_workflow_state_check,
  ADD CONSTRAINT payment_documents_state_check
    CHECK (state IN ('DRAFT', 'SUBMITTED', 'APPROVAL_PENDING', 'APPROVED', 'REJECTED')),
  ADD CONSTRAINT payment_documents_workflow_state_check
    CHECK (workflow_state IN ('DRAFT', 'SUBMITTED', 'APPROVAL_PENDING', 'APPROVED', 'REJECTED')),
  ADD CONSTRAINT payment_documents_workflow_matches_state
    CHECK (workflow_state = state);

CREATE TABLE payment_approval_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  code varchar(64) NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_-]{1,63}$'),
  name varchar(240) NOT NULL,
  document_type varchar(64) NOT NULL CHECK (document_type = 'PAYMENT'),
  branch_id uuid,
  treasury_unit_id uuid,
  currency varchar(8),
  method_category varchar(64),
  amount_minimum numeric(38,8),
  amount_maximum numeric(38,8),
  aggregation_window_kind varchar(16),
  aggregation_keys varchar(64)[] NOT NULL DEFAULT '{}',
  version integer NOT NULL CHECK (version > 0),
  state varchar(16) NOT NULL CHECK (state IN ('ACTIVE', 'RETIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, code, version),
  FOREIGN KEY (organization_id, branch_id)
    REFERENCES branches(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, treasury_unit_id)
    REFERENCES treasury_units(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, currency)
    REFERENCES currencies(organization_id, code) ON DELETE RESTRICT,
  CHECK (amount_minimum IS NULL OR amount_minimum >= 0),
  CHECK (amount_maximum IS NULL OR amount_maximum > 0),
  CHECK (
    amount_minimum IS NULL OR amount_maximum IS NULL
    OR amount_minimum <= amount_maximum
  ),
  CHECK (
    (aggregation_window_kind IS NULL AND cardinality(aggregation_keys) = 0)
    OR (
      aggregation_window_kind = 'BUSINESS_DATE'
      AND cardinality(aggregation_keys) > 0
      AND aggregation_keys <@ ARRAY['BENEFICIARY', 'EXTERNAL_OBLIGATION']::varchar[]
    )
  )
);

CREATE INDEX payment_approval_policy_selection_idx
  ON payment_approval_policies (
    organization_id, document_type, state, branch_id, treasury_unit_id,
    currency, method_category, amount_minimum, amount_maximum
  );

CREATE TABLE payment_approval_policy_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  step_order integer NOT NULL CHECK (step_order > 0),
  role_id uuid,
  approver_user_id uuid,
  approvals_required integer NOT NULL CHECK (approvals_required > 0),
  separation_rules varchar(64)[] NOT NULL DEFAULT '{}',
  UNIQUE (organization_id, policy_id, step_order),
  UNIQUE (organization_id, policy_id, id),
  FOREIGN KEY (organization_id, policy_id)
    REFERENCES payment_approval_policies(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, role_id)
    REFERENCES roles(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, approver_user_id)
    REFERENCES user_refs(organization_id, id) ON DELETE RESTRICT,
  CHECK ((role_id IS NULL) <> (approver_user_id IS NULL)),
  CHECK (separation_rules <@ ARRAY[
    'REQUESTER_NOT_APPROVER', 'CREATOR_NOT_APPROVER', 'CREATOR_NOT_EXECUTOR',
    'APPROVER_NOT_EXECUTOR', 'CUSTODIAN_NOT_RECONCILER',
    'EXECUTOR_NOT_ACCOUNTING_EXPORTER'
  ]::varchar[])
);

CREATE TABLE payment_approval_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  payment_document_id uuid NOT NULL,
  document_version bigint NOT NULL CHECK (document_version > 0),
  amount_basis numeric(38,8) NOT NULL CHECK (amount_basis > 0),
  base_currency varchar(8) NOT NULL,
  evaluated_at timestamptz NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, payment_document_id, id),
  FOREIGN KEY (organization_id, payment_document_id, base_currency)
    REFERENCES payment_documents(organization_id, id, base_currency) ON DELETE RESTRICT
);

ALTER TABLE payment_documents
  ADD COLUMN current_approval_snapshot_id uuid,
  ADD CONSTRAINT payment_documents_current_snapshot_fk
    FOREIGN KEY (organization_id, id, current_approval_snapshot_id)
    REFERENCES payment_approval_snapshots(organization_id, payment_document_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT payment_documents_snapshot_state_check CHECK (
    (state = 'DRAFT' AND current_approval_snapshot_id IS NULL)
    OR (state <> 'DRAFT' AND current_approval_snapshot_id IS NOT NULL)
  );

CREATE TABLE payment_approval_snapshot_contexts (
  organization_id uuid NOT NULL,
  approval_snapshot_id uuid NOT NULL,
  context_order integer NOT NULL CHECK (context_order > 0),
  first_line_number integer NOT NULL CHECK (first_line_number > 0),
  currency varchar(8) NOT NULL,
  method_category varchar(64) NOT NULL,
  policy_id uuid NOT NULL,
  policy_code varchar(64) NOT NULL,
  policy_name varchar(240) NOT NULL,
  policy_version integer NOT NULL CHECK (policy_version > 0),
  PRIMARY KEY (organization_id, approval_snapshot_id, context_order),
  FOREIGN KEY (organization_id, approval_snapshot_id)
    REFERENCES payment_approval_snapshots(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, policy_id)
    REFERENCES payment_approval_policies(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE payment_approval_snapshot_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  approval_snapshot_id uuid NOT NULL,
  step_order integer NOT NULL CHECK (step_order > 0),
  role_id uuid,
  role_name varchar(240),
  approver_user_id uuid,
  approver_name varchar(240),
  approvals_required integer NOT NULL CHECK (approvals_required > 0),
  separation_rules varchar(64)[] NOT NULL,
  source_context_orders integer[] NOT NULL,
  obligation_key text NOT NULL,
  UNIQUE (organization_id, approval_snapshot_id, id),
  UNIQUE (organization_id, approval_snapshot_id, step_order),
  UNIQUE (organization_id, approval_snapshot_id, obligation_key),
  FOREIGN KEY (organization_id, approval_snapshot_id)
    REFERENCES payment_approval_snapshots(organization_id, id) ON DELETE RESTRICT,
  CHECK ((role_id IS NULL) <> (approver_user_id IS NULL)),
  CHECK ((role_name IS NULL) <> (approver_name IS NULL)),
  CHECK (cardinality(source_context_orders) > 0)
);

CREATE TABLE payment_approval_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  approval_snapshot_id uuid NOT NULL,
  approval_snapshot_step_id uuid,
  step_order integer,
  actor_user_id uuid NOT NULL,
  delegated_from_user_id uuid,
  action varchar(16) NOT NULL CHECK (action IN ('APPROVED', 'REJECTED', 'RETURNED')),
  reason varchar(500),
  acted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, approval_snapshot_id)
    REFERENCES payment_approval_snapshots(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, approval_snapshot_id, approval_snapshot_step_id)
    REFERENCES payment_approval_snapshot_steps(
      organization_id, approval_snapshot_id, id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, actor_user_id)
    REFERENCES user_refs(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, delegated_from_user_id)
    REFERENCES user_refs(organization_id, id) ON DELETE RESTRICT,
  CHECK (
    (approval_snapshot_step_id IS NULL AND step_order IS NULL AND action = 'RETURNED')
    OR (approval_snapshot_step_id IS NOT NULL AND step_order IS NOT NULL AND step_order > 0)
  ),
  CHECK (
    (action = 'APPROVED' AND (reason IS NULL OR length(btrim(reason)) > 0))
    OR (action IN ('REJECTED', 'RETURNED') AND length(btrim(reason)) > 0)
  )
);

CREATE UNIQUE INDEX payment_approval_actions_actor_step_key
  ON payment_approval_actions (
    organization_id, approval_snapshot_id, approval_snapshot_step_id, actor_user_id
  )
  WHERE approval_snapshot_step_id IS NOT NULL;

CREATE UNIQUE INDEX payment_approval_actions_actor_snapshot_key
  ON payment_approval_actions (
    organization_id, approval_snapshot_id, actor_user_id
  )
  WHERE approval_snapshot_step_id IS NULL;

CREATE TABLE payment_approval_aggregations (
  organization_id uuid NOT NULL,
  approval_snapshot_id uuid NOT NULL,
  business_date date NOT NULL,
  aggregation_keys varchar(64)[] NOT NULL,
  beneficiary_party_id uuid,
  external_obligation_key text,
  PRIMARY KEY (organization_id, approval_snapshot_id),
  FOREIGN KEY (organization_id, approval_snapshot_id)
    REFERENCES payment_approval_snapshots(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, beneficiary_party_id)
    REFERENCES parties(organization_id, id) ON DELETE RESTRICT,
  CHECK (cardinality(aggregation_keys) > 0),
  CHECK (aggregation_keys <@ ARRAY['BENEFICIARY', 'EXTERNAL_OBLIGATION']::varchar[]),
  CHECK (
    ('BENEFICIARY' <> ALL(aggregation_keys) OR beneficiary_party_id IS NOT NULL)
    AND ('EXTERNAL_OBLIGATION' <> ALL(aggregation_keys) OR external_obligation_key IS NOT NULL)
  )
);

CREATE TABLE payment_approval_aggregation_participants (
  organization_id uuid NOT NULL,
  approval_snapshot_id uuid NOT NULL,
  payment_document_id uuid NOT NULL,
  payment_number varchar(64) NOT NULL,
  version_basis varchar(24) NOT NULL
    CHECK (version_basis IN ('SUBMITTED_CONTENT', 'LIVE_AGGREGATE')),
  payment_version bigint NOT NULL CHECK (payment_version > 0),
  base_amount numeric(38,8) NOT NULL CHECK (base_amount > 0),
  base_currency varchar(8) NOT NULL,
  PRIMARY KEY (organization_id, approval_snapshot_id, payment_document_id),
  FOREIGN KEY (organization_id, approval_snapshot_id)
    REFERENCES payment_approval_aggregations(organization_id, approval_snapshot_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, payment_document_id, base_currency)
    REFERENCES payment_documents(organization_id, id, base_currency) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX payment_approval_one_submitted_content
  ON payment_approval_aggregation_participants (organization_id, approval_snapshot_id)
  WHERE version_basis = 'SUBMITTED_CONTENT';

CREATE FUNCTION prevent_payment_approval_fact_updates()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Payment approval facts are immutable' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER payment_approval_snapshots_immutable
  BEFORE UPDATE OR DELETE ON payment_approval_snapshots
  FOR EACH ROW EXECUTE FUNCTION prevent_payment_approval_fact_updates();

CREATE TRIGGER payment_approval_snapshot_contexts_immutable
  BEFORE UPDATE OR DELETE ON payment_approval_snapshot_contexts
  FOR EACH ROW EXECUTE FUNCTION prevent_payment_approval_fact_updates();

CREATE TRIGGER payment_approval_snapshot_steps_immutable
  BEFORE UPDATE OR DELETE ON payment_approval_snapshot_steps
  FOR EACH ROW EXECUTE FUNCTION prevent_payment_approval_fact_updates();

CREATE TRIGGER payment_approval_actions_immutable
  BEFORE UPDATE OR DELETE ON payment_approval_actions
  FOR EACH ROW EXECUTE FUNCTION prevent_payment_approval_fact_updates();

CREATE TRIGGER payment_approval_aggregations_immutable
  BEFORE UPDATE OR DELETE ON payment_approval_aggregations
  FOR EACH ROW EXECUTE FUNCTION prevent_payment_approval_fact_updates();

CREATE TRIGGER payment_approval_aggregation_participants_immutable
  BEFORE UPDATE OR DELETE ON payment_approval_aggregation_participants
  FOR EACH ROW EXECUTE FUNCTION prevent_payment_approval_fact_updates();
