CREATE TABLE accounting_systems (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  code varchar(64) NOT NULL,
  name varchar(160) NOT NULL,
  transport_profile varchar(24) NOT NULL CHECK (transport_profile IN ('CSV_ZIP_MANIFEST', 'XLSX')),
  contract_version varchar(32) NOT NULL,
  supported_source_types varchar(32)[] NOT NULL DEFAULT ARRAY['PAYMENT']::varchar[],
  forbid_source_executor_export boolean NOT NULL DEFAULT true,
  state varchar(16) NOT NULL CHECK (state IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  CHECK (cardinality(supported_source_types) > 0
    AND supported_source_types <@ ARRAY['PAYMENT']::varchar[]),
  UNIQUE (organization_id, code),
  UNIQUE (organization_id, id)
);

CREATE TABLE accounting_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  accounting_system_id uuid NOT NULL,
  source_digest char(64) NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  contract_version varchar(32) NOT NULL,
  representation varchar(24) NOT NULL CHECK (representation IN ('CSV_ZIP_MANIFEST', 'XLSX')),
  snapshot_kind varchar(16) NOT NULL CHECK (snapshot_kind IN ('FULL', 'INCREMENTAL')),
  source_version varchar(64) NOT NULL,
  base_source_version varchar(64),
  fiscal_context varchar(128),
  received_at timestamptz NOT NULL,
  applied_count integer NOT NULL DEFAULT 0 CHECK (applied_count >= 0),
  error_count integer NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  state varchar(24) NOT NULL,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE (organization_id, id),
  UNIQUE (accounting_system_id, source_digest, contract_version),
  FOREIGN KEY (organization_id, accounting_system_id)
    REFERENCES accounting_systems(organization_id, id) ON DELETE RESTRICT,
  CHECK (snapshot_kind <> 'INCREMENTAL' OR base_source_version IS NOT NULL)
);

CREATE TABLE fiscal_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  accounting_system_id uuid NOT NULL,
  accounting_import_id uuid NOT NULL,
  external_key varchar(128) NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  source_version varchar(64) NOT NULL,
  source_digest char(64) NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  effective_at timestamptz NOT NULL,
  external_authorization_ref varchar(128),
  change_reason varchar(500),
  state varchar(16) NOT NULL CHECK (state IN ('OPEN', 'CLOSED')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE (organization_id, id),
  UNIQUE (accounting_system_id, external_key),
  FOREIGN KEY (organization_id, accounting_system_id)
    REFERENCES accounting_systems(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, accounting_import_id)
    REFERENCES accounting_imports(organization_id, id) ON DELETE RESTRICT,
  CHECK (period_end >= period_start)
);

CREATE TABLE accounting_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  accounting_system_id uuid NOT NULL,
  local_type varchar(32) NOT NULL,
  local_id uuid NOT NULL,
  mapping_type varchar(32) NOT NULL,
  external_key varchar(128) NOT NULL,
  external_parent_key varchar(128),
  source_version varchar(64),
  payload_digest char(64) CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  state varchar(16) NOT NULL CHECK (state IN ('ACTIVE', 'INACTIVE', 'CONFLICT')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE (organization_id, id),
  UNIQUE (accounting_system_id, local_type, local_id, mapping_type),
  FOREIGN KEY (organization_id, accounting_system_id)
    REFERENCES accounting_systems(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE accounting_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  accounting_system_id uuid NOT NULL,
  branch_id uuid,
  treasury_unit_id uuid,
  source_type varchar(32) NOT NULL CHECK (source_type = 'PAYMENT'),
  source_id uuid NOT NULL,
  source_version bigint NOT NULL CHECK (source_version >= 0),
  document_type varchar(64) NOT NULL,
  base_currency varchar(8) NOT NULL,
  aggregate_base_amount numeric(38,8) NOT NULL CHECK (aggregate_base_amount >= 0),
  export_kind varchar(64) NOT NULL,
  contract_version varchar(32) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  payload_digest char(64) NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  mapping_snapshot_digest char(64) NOT NULL CHECK (mapping_snapshot_digest ~ '^[a-f0-9]{64}$'),
  fiscal_snapshot_digest char(64) NOT NULL CHECK (fiscal_snapshot_digest ~ '^[a-f0-9]{64}$'),
  exported_by uuid NOT NULL,
  external_document_id varchar(128),
  external_document_number varchar(128),
  accepted_at timestamptz,
  state varchar(32) NOT NULL CHECK (state IN (
    'NOT_READY', 'MAPPING_REQUIRED', 'READY', 'QUEUED', 'SENDING',
    'SENDING_UNKNOWN', 'ACCEPTED', 'FAILED', 'RETURNED', 'CORRECTED'
  )),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, accounting_system_id, idempotency_key),
  UNIQUE (organization_id, accounting_system_id, source_type, source_id, source_version, export_kind),
  FOREIGN KEY (organization_id, accounting_system_id)
    REFERENCES accounting_systems(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, branch_id)
    REFERENCES branches(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, treasury_unit_id)
    REFERENCES treasury_units(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, exported_by)
    REFERENCES user_refs(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE accounting_export_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  accounting_export_id uuid NOT NULL,
  representation varchar(24) NOT NULL CHECK (representation IN ('CSV_ZIP_MANIFEST', 'XLSX')),
  contract_version varchar(32) NOT NULL,
  manifest_version varchar(32) NOT NULL,
  media_type varchar(96) NOT NULL CHECK (media_type IN (
    'application/zip',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  )),
  file_name varchar(255) NOT NULL,
  content_address varchar(192) NOT NULL,
  content bytea NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  payload_digest char(64) NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  row_count integer NOT NULL CHECK (row_count > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, accounting_export_id, representation),
  UNIQUE (organization_id, content_address),
  FOREIGN KEY (organization_id, accounting_export_id)
    REFERENCES accounting_exports(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE accounting_export_row_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  accounting_export_artifact_id uuid NOT NULL,
  row_number integer NOT NULL CHECK (row_number > 0),
  source_type varchar(64) NOT NULL,
  source_id uuid NOT NULL,
  source_version bigint NOT NULL CHECK (source_version >= 0),
  payload_digest char(64) NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  outcome varchar(16) NOT NULL CHECK (outcome IN ('ACCEPTED', 'ERROR')),
  error_code varchar(64),
  error_detail varchar(2000),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, accounting_export_artifact_id, row_number),
  FOREIGN KEY (organization_id, accounting_export_artifact_id)
    REFERENCES accounting_export_artifacts(organization_id, id) ON DELETE RESTRICT,
  CHECK ((outcome = 'ACCEPTED' AND error_code IS NULL AND error_detail IS NULL)
    OR (outcome = 'ERROR' AND error_code IS NOT NULL))
);

CREATE TABLE accounting_export_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  accounting_export_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  request_snapshot jsonb NOT NULL,
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  response_snapshot jsonb,
  response_digest char(64) CHECK (response_digest ~ '^[a-f0-9]{64}$'),
  outcome varchar(24) NOT NULL CHECK (outcome IN ('QUEUED', 'SENDING', 'SENDING_UNKNOWN', 'ACCEPTED', 'FAILED')),
  error_code varchar(64),
  actor_id uuid,
  worker_key varchar(128),
  external_document_id varchar(128),
  external_document_number varchar(128),
  attempted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, accounting_export_id, attempt_number),
  FOREIGN KEY (organization_id, accounting_export_id)
    REFERENCES accounting_exports(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, actor_id)
    REFERENCES user_refs(organization_id, id) ON DELETE RESTRICT,
  CHECK ((actor_id IS NOT NULL) <> (worker_key IS NOT NULL))
);

CREATE TABLE accounting_acknowledgements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  accounting_export_id uuid NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  outcome varchar(24) NOT NULL CHECK (outcome IN ('ACCEPTED', 'REJECTED', 'OUTCOME_UNKNOWN', 'RETURNED')),
  response_digest char(64) NOT NULL CHECK (response_digest ~ '^[a-f0-9]{64}$'),
  external_document_id varchar(128),
  external_document_number varchar(128),
  external_return_id varchar(128),
  error_code varchar(64),
  error_detail varchar(2000),
  acknowledged_by uuid NOT NULL,
  acknowledged_at timestamptz NOT NULL,
  export_version bigint NOT NULL CHECK (export_version >= 0),
  response_body jsonb NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, accounting_export_id, idempotency_key),
  FOREIGN KEY (organization_id, accounting_export_id)
    REFERENCES accounting_exports(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, acknowledged_by)
    REFERENCES user_refs(organization_id, id) ON DELETE RESTRICT,
  CHECK (outcome <> 'ACCEPTED' OR external_document_id IS NOT NULL),
  CHECK (outcome <> 'REJECTED' OR error_code IS NOT NULL),
  CHECK (outcome <> 'RETURNED'
    OR (external_document_id IS NOT NULL AND external_return_id IS NOT NULL AND error_code IS NOT NULL))
);

CREATE TABLE posting_locks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  accounting_export_id uuid NOT NULL,
  accounting_system_id uuid NOT NULL,
  source_type varchar(32) NOT NULL CHECK (source_type = 'PAYMENT'),
  source_id uuid NOT NULL,
  source_version bigint NOT NULL CHECK (source_version >= 0),
  locked_digest char(64) NOT NULL CHECK (locked_digest ~ '^[a-f0-9]{64}$'),
  locked_at timestamptz NOT NULL,
  state varchar(16) NOT NULL CHECK (state IN ('ACTIVE', 'RETURNED', 'CORRECTED')),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, accounting_export_id),
  CONSTRAINT posting_locks_one_accepted_source
    UNIQUE (organization_id, source_type, source_id, source_version),
  FOREIGN KEY (organization_id, accounting_export_id)
    REFERENCES accounting_exports(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, accounting_system_id)
    REFERENCES accounting_systems(organization_id, id) ON DELETE RESTRICT
);

CREATE FUNCTION prevent_accounting_fact_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Accounting evidence is append-only' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER accounting_export_artifacts_append_only
BEFORE UPDATE OR DELETE ON accounting_export_artifacts
FOR EACH ROW EXECUTE FUNCTION prevent_accounting_fact_mutation();
CREATE TRIGGER accounting_export_row_results_append_only
BEFORE UPDATE OR DELETE ON accounting_export_row_results
FOR EACH ROW EXECUTE FUNCTION prevent_accounting_fact_mutation();
CREATE TRIGGER accounting_export_attempts_append_only
BEFORE UPDATE OR DELETE ON accounting_export_attempts
FOR EACH ROW EXECUTE FUNCTION prevent_accounting_fact_mutation();
CREATE TRIGGER accounting_acknowledgements_append_only
BEFORE UPDATE OR DELETE ON accounting_acknowledgements
FOR EACH ROW EXECUTE FUNCTION prevent_accounting_fact_mutation();

CREATE FUNCTION protect_posting_lock_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     OR (to_jsonb(NEW) - 'state') IS DISTINCT FROM (to_jsonb(OLD) - 'state') THEN
    RAISE EXCEPTION 'PostingLock identity and digest are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER posting_locks_identity_guard
BEFORE UPDATE OR DELETE ON posting_locks
FOR EACH ROW EXECUTE FUNCTION protect_posting_lock_identity();

CREATE FUNCTION enforce_payment_posting_lock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  locked_source_id uuid;
BEGIN
  locked_source_id := CASE
    WHEN TG_TABLE_NAME = 'payment_documents' THEN
      COALESCE(to_jsonb(NEW)->>'id', to_jsonb(OLD)->>'id')::uuid
    WHEN TG_TABLE_NAME = 'payment_lines' THEN
      COALESCE(to_jsonb(NEW)->>'payment_document_id', to_jsonb(OLD)->>'payment_document_id')::uuid
    ELSE (
      SELECT payment_document_id FROM payment_lines
      WHERE id = COALESCE(
        to_jsonb(NEW)->>'payment_line_id',
        to_jsonb(OLD)->>'payment_line_id'
      )::uuid
    )
  END;
  IF NOT EXISTS (
    SELECT 1 FROM posting_locks
    WHERE organization_id = COALESCE(
        to_jsonb(NEW)->>'organization_id',
        to_jsonb(OLD)->>'organization_id'
      )::uuid
      AND source_type = 'PAYMENT'
      AND posting_locks.source_id = locked_source_id
  ) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Accepted accounting source and evidence are locked'
      USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'payment_documents' AND
    (to_jsonb(NEW) - ARRAY['accounting_state', 'version', 'updated_at'])
      IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['accounting_state', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'Accepted Payment header is locked' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME <> 'payment_documents' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'Accepted Payment line or evidence is locked' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_documents_posting_lock
BEFORE UPDATE OR DELETE ON payment_documents
FOR EACH ROW EXECUTE FUNCTION enforce_payment_posting_lock();
CREATE TRIGGER payment_lines_posting_lock
BEFORE INSERT OR UPDATE OR DELETE ON payment_lines
FOR EACH ROW EXECUTE FUNCTION enforce_payment_posting_lock();
CREATE TRIGGER payment_line_evidence_posting_lock
BEFORE INSERT OR UPDATE OR DELETE ON payment_line_attachment_links
FOR EACH ROW EXECUTE FUNCTION enforce_payment_posting_lock();

CREATE INDEX accounting_systems_active_idx
  ON accounting_systems (organization_id, code, id) WHERE state = 'ACTIVE';
CREATE INDEX fiscal_periods_selection_idx
  ON fiscal_periods (organization_id, accounting_system_id, period_start, period_end, state);
CREATE INDEX accounting_mappings_lookup_idx
  ON accounting_mappings (organization_id, accounting_system_id, local_type, local_id, state);
CREATE INDEX accounting_exports_source_idx
  ON accounting_exports (organization_id, source_type, source_id, source_version);
