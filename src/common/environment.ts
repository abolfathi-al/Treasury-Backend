export function assertRuntimeEnvironment(): void {
  const required = [
    'DATABASE_URL',
    'APP_ORIGIN',
    'COMMAND_DIGEST_HMAC_KEY_BASE64',
    'LOGIN_THROTTLE_HMAC_KEY_BASE64',
  ];
  if (!process.env.TOTP_ENCRYPTION_KEYS_JSON && !process.env.TOTP_ENCRYPTION_KEY_BASE64) {
    required.push('TOTP_ENCRYPTION_KEYS_JSON or TOTP_ENCRYPTION_KEY_BASE64');
  }
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing required environment: ${missing.join(', ')}`);

  const throttleKey = Buffer.from(process.env.LOGIN_THROTTLE_HMAC_KEY_BASE64!, 'base64');
  const commandDigestKey = Buffer.from(process.env.COMMAND_DIGEST_HMAC_KEY_BASE64!, 'base64');
  const totpKeys = process.env.TOTP_ENCRYPTION_KEYS_JSON
    ? Object.values(JSON.parse(process.env.TOTP_ENCRYPTION_KEYS_JSON) as Record<string, string>)
    : [process.env.TOTP_ENCRYPTION_KEY_BASE64!];
  if (!totpKeys.length || totpKeys.some((value) => Buffer.from(value, 'base64').length !== 32)) {
    throw new Error('Every TOTP encryption key must decode to exactly 32 bytes');
  }
  if (throttleKey.length < 32) throw new Error('LOGIN_THROTTLE_HMAC_KEY_BASE64 must decode to at least 32 bytes');
  if (commandDigestKey.length < 32) {
    throw new Error('COMMAND_DIGEST_HMAC_KEY_BASE64 must decode to at least 32 bytes');
  }
  new URL(process.env.APP_ORIGIN!);
}
