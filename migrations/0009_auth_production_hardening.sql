ALTER TABLE identity_accounts
  ADD CONSTRAINT identity_accounts_totp_secret_tuple_check CHECK (
    (
      totp_ciphertext IS NULL
      AND totp_iv IS NULL
      AND totp_auth_tag IS NULL
      AND totp_key_version IS NULL
    )
    OR
    (
      totp_ciphertext IS NOT NULL
      AND totp_iv IS NOT NULL
      AND totp_auth_tag IS NOT NULL
      AND totp_key_version IS NOT NULL
    )
  );
