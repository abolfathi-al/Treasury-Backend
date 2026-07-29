INSERT INTO operation_permissions (permission)
VALUES ('receipt.reject')
ON CONFLICT (permission) DO NOTHING;

ALTER TABLE roles
  ADD CONSTRAINT roles_organization_id_id_key UNIQUE (organization_id, id);

ALTER TABLE receipt_documents
  DROP CONSTRAINT receipt_documents_state_check,
  DROP CONSTRAINT receipt_documents_workflow_state_check,
  ADD CONSTRAINT receipt_documents_state_check
    CHECK (state IN ('DRAFT', 'SUBMITTED', 'APPROVAL_PENDING', 'APPROVED', 'REJECTED')),
  ADD CONSTRAINT receipt_documents_workflow_state_check
    CHECK (workflow_state IN ('DRAFT', 'SUBMITTED', 'APPROVAL_PENDING', 'APPROVED', 'REJECTED')),
  ADD CONSTRAINT receipt_documents_workflow_matches_state
    CHECK (workflow_state = state);

CREATE TABLE receipt_approval_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  code varchar(64) NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_-]{1,63}$'),
  name varchar(240) NOT NULL,
  document_type varchar(64) NOT NULL CHECK (document_type = 'RECEIPT'),
  branch_id uuid,
  treasury_unit_id uuid,
  currency varchar(8),
  method_category varchar(64),
  amount_minimum numeric(38,8),
  amount_maximum numeric(38,8),
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
  )
);

CREATE INDEX receipt_approval_policy_selection_idx
  ON receipt_approval_policies (
    organization_id, document_type, state, branch_id, treasury_unit_id,
    currency, method_category, amount_minimum, amount_maximum
  );

CREATE TABLE receipt_approval_policy_steps (
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
    REFERENCES receipt_approval_policies(organization_id, id) ON DELETE RESTRICT,
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

CREATE TABLE receipt_approval_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  receipt_document_id uuid NOT NULL,
  document_version bigint NOT NULL CHECK (document_version > 0),
  amount_basis numeric(38,8) NOT NULL CHECK (amount_basis > 0),
  base_currency varchar(8) NOT NULL,
  evaluated_at timestamptz NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, receipt_document_id, id),
  FOREIGN KEY (organization_id, receipt_document_id, base_currency)
    REFERENCES receipt_documents(organization_id, id, base_currency) ON DELETE RESTRICT
);

ALTER TABLE receipt_documents
  ADD COLUMN current_approval_snapshot_id uuid,
  ADD CONSTRAINT receipt_documents_current_snapshot_fk
    FOREIGN KEY (organization_id, id, current_approval_snapshot_id)
    REFERENCES receipt_approval_snapshots(organization_id, receipt_document_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT receipt_documents_snapshot_state_check CHECK (
    (state = 'DRAFT' AND current_approval_snapshot_id IS NULL)
    OR (state <> 'DRAFT' AND current_approval_snapshot_id IS NOT NULL)
  );

CREATE TABLE receipt_approval_snapshot_contexts (
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
    REFERENCES receipt_approval_snapshots(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, policy_id)
    REFERENCES receipt_approval_policies(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE receipt_approval_snapshot_steps (
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
    REFERENCES receipt_approval_snapshots(organization_id, id) ON DELETE RESTRICT,
  CHECK ((role_id IS NULL) <> (approver_user_id IS NULL)),
  CHECK ((role_name IS NULL) <> (approver_name IS NULL)),
  CHECK (cardinality(source_context_orders) > 0)
);

CREATE TABLE receipt_approval_actions (
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
    REFERENCES receipt_approval_snapshots(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, approval_snapshot_id, approval_snapshot_step_id)
    REFERENCES receipt_approval_snapshot_steps(
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
    (action = 'APPROVED' AND reason IS NULL)
    OR (action IN ('REJECTED', 'RETURNED') AND length(btrim(reason)) > 0)
  )
);

CREATE UNIQUE INDEX receipt_approval_actions_actor_step_key
  ON receipt_approval_actions (
    organization_id, approval_snapshot_id, approval_snapshot_step_id, actor_user_id
  )
  WHERE approval_snapshot_step_id IS NOT NULL;

CREATE UNIQUE INDEX receipt_approval_actions_actor_snapshot_key
  ON receipt_approval_actions (
    organization_id, approval_snapshot_id, actor_user_id
  )
  WHERE approval_snapshot_step_id IS NULL;

CREATE INDEX receipt_approval_actions_progress_idx
  ON receipt_approval_actions (
    organization_id, approval_snapshot_id, approval_snapshot_step_id, action, acted_at
  );

CREATE FUNCTION prevent_receipt_approval_fact_updates()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Receipt approval facts are immutable' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER receipt_approval_snapshots_immutable
  BEFORE UPDATE OR DELETE ON receipt_approval_snapshots
  FOR EACH ROW EXECUTE FUNCTION prevent_receipt_approval_fact_updates();

CREATE TRIGGER receipt_approval_snapshot_contexts_immutable
  BEFORE UPDATE OR DELETE ON receipt_approval_snapshot_contexts
  FOR EACH ROW EXECUTE FUNCTION prevent_receipt_approval_fact_updates();

CREATE TRIGGER receipt_approval_snapshot_steps_immutable
  BEFORE UPDATE OR DELETE ON receipt_approval_snapshot_steps
  FOR EACH ROW EXECUTE FUNCTION prevent_receipt_approval_fact_updates();

CREATE TRIGGER receipt_approval_actions_immutable
  BEFORE UPDATE OR DELETE ON receipt_approval_actions
  FOR EACH ROW EXECUTE FUNCTION prevent_receipt_approval_fact_updates();
