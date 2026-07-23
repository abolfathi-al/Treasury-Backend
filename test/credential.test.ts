import assert from 'node:assert/strict';
import test from 'node:test';

import { CredentialService } from '../src/access-control/credential.service';
import { TreasuryProblem } from '../src/common/problem';

const credentials = new CredentialService();

test('TOTP uses SHA-256, accepts current/previous, and rejects replay counters', () => {
  const secret = Buffer.alloc(32, 7);
  const now = 1_800_000_000_000;
  const current = Math.floor(now / 30_000);
  const currentCode = credentials.totp(secret, current);
  const previousCode = credentials.totp(secret, current - 1);

  assert.equal(credentials.verifyTotp(secret, currentCode, null, now), current);
  assert.equal(credentials.verifyTotp(secret, previousCode, null, now), current - 1);
  assert.equal(credentials.verifyTotp(secret, currentCode, current, now), null);
});

test('TOTP secret encryption is authenticated and key-versioned', () => {
  const secret = Buffer.alloc(32, 9);
  const key = Buffer.alloc(32, 3);
  const encrypted = credentials.encryptTotpSecret(secret, key, 4);
  assert.equal(encrypted.keyVersion, 4);
  assert.deepEqual(credentials.decryptTotpSecret(encrypted, key), secret);
  assert.throws(() => credentials.decryptTotpSecret(encrypted, Buffer.alloc(32, 8)));
});

test('runtime TOTP keyring resolves ciphertext by stored key version', () => {
  const previous = process.env.TOTP_ENCRYPTION_KEYS_JSON;
  process.env.TOTP_ENCRYPTION_KEYS_JSON = JSON.stringify({
    3: Buffer.alloc(32, 3).toString('base64'),
    4: Buffer.alloc(32, 4).toString('base64'),
  });
  try {
    assert.deepEqual(credentials.runtimeTotpKey(3), Buffer.alloc(32, 3));
    assert.throws(() => credentials.runtimeTotpKey(2));
  } finally {
    if (previous === undefined) delete process.env.TOTP_ENCRYPTION_KEYS_JSON;
    else process.env.TOTP_ENCRYPTION_KEYS_JSON = previous;
  }
});

test('recovery hashes are salted and verifiable without storing the code', async () => {
  const code = credentials.generateRecoveryCode();
  const first = await credentials.hashRecoveryCode(code);
  const second = await credentials.hashRecoveryCode(code);
  assert.notEqual(first, second);
  assert.equal(await credentials.verifyRecoveryCode(first, code), true);
  assert.equal(await credentials.verifyRecoveryCode(first, `${code}x`), false);
});

test('password policy normalizes NFC and rejects blocklisted/context passwords', () => {
  assert.equal(
    credentials.validatePassword('long safe passphrase 2026'),
    'long safe passphrase 2026',
  );
  assert.throws(
    () => credentials.validatePassword('treasurytreasury'),
    TreasuryProblem,
  );
  assert.throws(
    () => credentials.validatePassword('Acme finance password', ['Acme']),
    TreasuryProblem,
  );
});
