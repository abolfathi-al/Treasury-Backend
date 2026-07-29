ALTER TABLE identity_accounts
  ADD CONSTRAINT identity_accounts_id_user_ref_id_key UNIQUE (id, user_ref_id);

CREATE TABLE totp_enrollment_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  identity_account_id uuid NOT NULL,
  user_ref_id uuid NOT NULL,
  enrollment_id_digest char(64) NOT NULL UNIQUE,
  pending_secret_ciphertext text,
  pending_secret_iv text,
  pending_secret_auth_tag text,
  pending_secret_key_version integer,
  account_version integer NOT NULL CHECK (account_version >= 0),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  state varchar(24) NOT NULL DEFAULT 'OPEN'
    CHECK (state IN ('OPEN', 'CONSUMED', 'EXPIRED', 'ATTEMPTS_EXHAUSTED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT totp_enrollment_account_fk
    FOREIGN KEY (identity_account_id, user_ref_id)
    REFERENCES identity_accounts(id, user_ref_id) ON DELETE RESTRICT,
  CONSTRAINT totp_enrollment_organization_user_fk
    FOREIGN KEY (organization_id, user_ref_id)
    REFERENCES user_refs(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT totp_enrollment_secret_state_check CHECK (
    (
      state = 'OPEN'
      AND closed_at IS NULL
      AND pending_secret_ciphertext IS NOT NULL
      AND pending_secret_iv IS NOT NULL
      AND pending_secret_auth_tag IS NOT NULL
      AND pending_secret_key_version IS NOT NULL
    )
    OR
    (
      state <> 'OPEN'
      AND closed_at IS NOT NULL
      AND pending_secret_ciphertext IS NULL
      AND pending_secret_iv IS NULL
      AND pending_secret_auth_tag IS NULL
      AND pending_secret_key_version IS NULL
    )
  ),
  CONSTRAINT totp_enrollment_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT totp_enrollment_updated_check CHECK (updated_at >= created_at),
  CONSTRAINT totp_enrollment_closed_check CHECK (closed_at IS NULL OR closed_at >= created_at)
);

CREATE UNIQUE INDEX uq_totp_enrollment_challenges_open_account
  ON totp_enrollment_challenges (organization_id, identity_account_id)
  WHERE state = 'OPEN';

CREATE INDEX ix_totp_enrollment_challenges_open_expiry
  ON totp_enrollment_challenges (expires_at)
  WHERE state = 'OPEN';
