ALTER TABLE totp_enrollment_challenges
  ADD COLUMN pending_password_hash text;

UPDATE totp_enrollment_challenges
SET state = 'EXPIRED',
    closed_at = now(),
    updated_at = now(),
    pending_secret_ciphertext = NULL,
    pending_secret_iv = NULL,
    pending_secret_auth_tag = NULL,
    pending_secret_key_version = NULL,
    pending_password_hash = NULL
WHERE state = 'OPEN';

ALTER TABLE totp_enrollment_challenges
  DROP CONSTRAINT totp_enrollment_secret_state_check,
  ADD CONSTRAINT totp_enrollment_secret_state_check CHECK (
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
      AND pending_password_hash IS NULL
    )
  );
