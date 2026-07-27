import assert from 'node:assert/strict';
import test from 'node:test';

import { AuthRepository } from '../src/access-control/auth.repository';
import { AuthService } from '../src/access-control/auth.service';
import { CredentialService } from '../src/access-control/credential.service';
import { digest } from '../src/common/http';
import { TreasuryProblem } from '../src/common/problem';
import { DatabaseService } from '../src/database/database.service';

const connectionString = process.env.TEST_DATABASE_URL;

test('PostgreSQL ACTIVE TOTP enrollment preserves password and revokes prior auth material', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = connectionString;
  process.env.LOGIN_THROTTLE_HMAC_KEY_BASE64 = Buffer.alloc(32, 61).toString('base64');
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 62).toString('base64');
  process.env.TOTP_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 63).toString('base64');
  process.env.TOTP_KEY_VERSION = '1';

  const database = new DatabaseService();
  const credentials = new CredentialService();
  const service = new AuthService(new AuthRepository(database), credentials);
  const currentPassword = 'safe active enrollment password 2026';

  try {
    const accountId = await seedNonEnrolledAccount(database, credentials, currentPassword);
    const accountBefore = await database.pool.query<{
      password_hash: string;
      password_profile_version: number;
      version: number;
    }>(`
      SELECT password_hash, password_profile_version, version
      FROM identity_accounts
      WHERE id = $1
    `, [accountId]);
    const existingSession = await service.login({
      login: 'enrollment.admin',
      password: currentPassword,
    }, 'pre-enrollment-session');
    assert.equal(existingSession.status, 201);
    if (existingSession.status !== 201) throw new Error('Expected password session');

    const challenge = await database.pool.query<{ id: string }>(`
      INSERT INTO auth_challenges (
        identity_account_id, session_id, token_digest, kind, http_method,
        http_path, request_body_digest, idempotency_key, expires_at
      ) VALUES ($1,$2,$3,'STEP_UP','POST','/v1/test',$4,'test-key',now() + interval '5 minutes')
      RETURNING id
    `, [
      accountId,
      existingSession.body.session.sessionId,
      digest('pre-enrollment-challenge'),
      digest('{}'),
    ]);
    await database.pool.query(`
      INSERT INTO auth_step_up_proofs (challenge_id, token_digest, expires_at)
      VALUES ($1,$2,now() + interval '5 minutes')
    `, [challenge.rows[0]!.id, digest('pre-enrollment-proof')]);

    const started = await service.startTotpEnrollment({
      login: ' Enrollment.Admin ',
      currentOrTemporaryPassword: currentPassword,
    }, 'enrollment-start');

    const pending = await database.pool.query<{
      enrollment_id_digest: string;
      account_version: number;
      pending_secret_ciphertext: string;
      pending_secret_iv: string;
      pending_secret_auth_tag: string;
      pending_secret_key_version: number;
      pending_password_hash: string | null;
    }>(`
      SELECT enrollment_id_digest, account_version, pending_secret_ciphertext,
             pending_secret_iv, pending_secret_auth_tag, pending_secret_key_version,
             pending_password_hash
      FROM totp_enrollment_challenges
      WHERE identity_account_id = $1 AND state = 'OPEN'
    `, [accountId]);
    assert.equal(pending.rowCount, 1);
    assert.equal(
      pending.rows[0]!.enrollment_id_digest,
      credentials.enrollmentIdDigest(started.enrollmentId),
    );
    assert.equal(pending.rows[0]!.account_version, 0);
    assert.equal(pending.rows[0]!.pending_password_hash, null);
    const accountAfterStart = await database.pool.query<{
      password_hash: string;
      password_profile_version: number;
      version: number;
    }>(`
      SELECT password_hash, password_profile_version, version
      FROM identity_accounts
      WHERE id = $1
    `, [accountId]);
    assert.deepEqual(accountAfterStart.rows[0], accountBefore.rows[0]);
    const secret = credentials.decryptTotpSecret({
      ciphertext: pending.rows[0]!.pending_secret_ciphertext,
      iv: pending.rows[0]!.pending_secret_iv,
      authTag: pending.rows[0]!.pending_secret_auth_tag,
      keyVersion: pending.rows[0]!.pending_secret_key_version,
    }, credentials.runtimeTotpKey(pending.rows[0]!.pending_secret_key_version));
    assert.equal(credentials.base32(secret), started.secret);

    const counter = Math.floor(Date.now() / 30_000);
    const completed = await service.completeTotpEnrollment({
      enrollmentId: started.enrollmentId,
      firstCode: credentials.totp(secret, counter - 1),
      secondCode: credentials.totp(secret, counter),
    }, 'enrollment-complete');

    const state = await database.pool.query<{
      state: string;
      version: number;
      password_hash: string;
      password_profile_version: number;
      recovery_version: number;
      authorization_epoch: string;
      totp_ciphertext: string | null;
      recovery_code_hash: string | null;
      active_sessions: string;
      open_challenges: string;
      open_proofs: string;
      enrollment_state: string;
      pending_secret_ciphertext: string | null;
      pending_password_hash: string | null;
    }>(`
      SELECT ia.state, ia.version, ia.password_hash, ia.password_profile_version,
             ia.recovery_version, ia.authorization_epoch,
             ia.totp_ciphertext, ia.recovery_code_hash,
             (SELECT count(*) FROM auth_sessions s
              WHERE s.identity_account_id = ia.id AND s.revoked_at IS NULL
                AND (s.state = 'ACTIVE' OR (
                  s.state = 'ROTATED' AND s.predecessor_valid_until > now()
                )))::text AS active_sessions,
             (SELECT count(*) FROM auth_challenges c
              WHERE c.identity_account_id = ia.id AND c.consumed_at IS NULL)::text AS open_challenges,
             (SELECT count(*) FROM auth_step_up_proofs p
              JOIN auth_challenges c ON c.id = p.challenge_id
             WHERE c.identity_account_id = ia.id AND p.consumed_at IS NULL)::text AS open_proofs,
             e.state AS enrollment_state,
             e.pending_secret_ciphertext,
             e.pending_password_hash
      FROM identity_accounts ia
      JOIN totp_enrollment_challenges e ON e.identity_account_id = ia.id
      WHERE ia.id = $1
    `, [accountId]);
    assert.equal(state.rows[0]!.state, 'ACTIVE');
    assert.equal(state.rows[0]!.version, 1);
    assert.equal(state.rows[0]!.password_hash, accountBefore.rows[0]!.password_hash);
    assert.equal(state.rows[0]!.password_profile_version, 1);
    assert.equal(state.rows[0]!.recovery_version, 2);
    assert.equal(state.rows[0]!.authorization_epoch, '1');
    assert.ok(state.rows[0]!.totp_ciphertext);
    assert.ok(state.rows[0]!.recovery_code_hash);
    assert.equal(
      await credentials.verifyRecoveryCode(
        state.rows[0]!.recovery_code_hash!,
        completed.recoveryCode,
      ),
      true,
    );
    assert.equal(state.rows[0]!.active_sessions, '0');
    assert.equal(state.rows[0]!.open_challenges, '0');
    assert.equal(state.rows[0]!.open_proofs, '0');
    assert.equal(state.rows[0]!.enrollment_state, 'CONSUMED');
    assert.equal(state.rows[0]!.pending_secret_ciphertext, null);
    assert.equal(state.rows[0]!.pending_password_hash, null);

    const relogin = await service.login({
      login: 'enrollment.admin',
      password: currentPassword,
    }, 'post-enrollment-login');
    assert.equal(relogin.status, 202);

    await assert.rejects(
      service.completeTotpEnrollment({
        enrollmentId: started.enrollmentId,
        firstCode: credentials.totp(secret, counter - 1),
        secondCode: credentials.totp(secret, counter),
      }, 'enrollment-replay'),
      (error) => error instanceof TreasuryProblem
        && (error.getResponse() as { code?: string }).code === 'TRS-AUT-005',
    );
  } finally {
    await database.onModuleDestroy();
  }
});

test('PostgreSQL INVITED TOTP enrollment defers password activation until completion', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = connectionString;
  process.env.LOGIN_THROTTLE_HMAC_KEY_BASE64 = Buffer.alloc(32, 64).toString('base64');
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 65).toString('base64');
  process.env.TOTP_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 66).toString('base64');
  process.env.TOTP_KEY_VERSION = '1';

  const database = new DatabaseService();
  const credentials = new CredentialService();
  const service = new AuthService(new AuthRepository(database), credentials);
  const temporaryPassword = 'safe invited temporary password 2026';
  const newPassword = 'D9!Cobalt-River-Mango-Quartz-742';

  try {
    const accountId = await seedNonEnrolledAccount(
      database,
      credentials,
      temporaryPassword,
      'INVITED',
    );
    const before = await database.pool.query<{
      password_hash: string;
      password_profile_version: number;
      version: number;
      state: string;
    }>(`
      SELECT password_hash, password_profile_version, version, state
      FROM identity_accounts
      WHERE id = $1
    `, [accountId]);

    const started = await service.startTotpEnrollment({
      login: 'enrollment.admin',
      currentOrTemporaryPassword: temporaryPassword,
      newPassword,
    }, 'invited-enrollment-start');
    const pending = await database.pool.query<{
      account_version: number;
      pending_secret_ciphertext: string;
      pending_secret_iv: string;
      pending_secret_auth_tag: string;
      pending_secret_key_version: number;
      pending_password_hash: string;
    }>(`
      SELECT account_version, pending_secret_ciphertext, pending_secret_iv,
             pending_secret_auth_tag, pending_secret_key_version, pending_password_hash
      FROM totp_enrollment_challenges
      WHERE identity_account_id = $1 AND state = 'OPEN'
    `, [accountId]);
    assert.equal(pending.rowCount, 1);
    assert.equal(pending.rows[0]!.account_version, 0);
    assert.equal(await credentials.verifyPassword(
      pending.rows[0]!.pending_password_hash,
      newPassword,
    ), true);

    const afterStart = await database.pool.query<{
      password_hash: string;
      password_profile_version: number;
      version: number;
      state: string;
    }>(`
      SELECT password_hash, password_profile_version, version, state
      FROM identity_accounts
      WHERE id = $1
    `, [accountId]);
    assert.deepEqual(afterStart.rows[0], before.rows[0]);

    const secret = credentials.decryptTotpSecret({
      ciphertext: pending.rows[0]!.pending_secret_ciphertext,
      iv: pending.rows[0]!.pending_secret_iv,
      authTag: pending.rows[0]!.pending_secret_auth_tag,
      keyVersion: pending.rows[0]!.pending_secret_key_version,
    }, credentials.runtimeTotpKey(pending.rows[0]!.pending_secret_key_version));
    const counter = Math.floor(Date.now() / 30_000);
    await service.completeTotpEnrollment({
      enrollmentId: started.enrollmentId,
      firstCode: credentials.totp(secret, counter - 1),
      secondCode: credentials.totp(secret, counter),
    }, 'invited-enrollment-complete');

    const completed = await database.pool.query<{
      password_hash: string;
      password_profile_version: number;
      version: number;
      state: string;
      pending_password_hash: string | null;
      enrollment_state: string;
    }>(`
      SELECT ia.password_hash, ia.password_profile_version, ia.version, ia.state,
             e.pending_password_hash, e.state AS enrollment_state
      FROM identity_accounts ia
      JOIN totp_enrollment_challenges e ON e.identity_account_id = ia.id
      WHERE ia.id = $1
    `, [accountId]);
    assert.equal(completed.rows[0]!.state, 'ACTIVE');
    assert.equal(completed.rows[0]!.version, 1);
    assert.equal(completed.rows[0]!.password_profile_version, 2);
    assert.equal(
      await credentials.verifyPassword(completed.rows[0]!.password_hash, newPassword),
      true,
    );
    assert.equal(
      await credentials.verifyPassword(completed.rows[0]!.password_hash, temporaryPassword),
      false,
    );
    assert.equal(completed.rows[0]!.pending_password_hash, null);
    assert.equal(completed.rows[0]!.enrollment_state, 'CONSUMED');
  } finally {
    await database.onModuleDestroy();
  }
});

async function seedNonEnrolledAccount(
  database: DatabaseService,
  credentials: CredentialService,
  password: string,
  state: 'INVITED' | 'ACTIVE' = 'ACTIVE',
): Promise<string> {
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE organizations CASCADE');
    const organization = await client.query<{ id: string }>(`
      INSERT INTO organizations (code, legal_name, timezone, base_currency)
      VALUES ('TEST', 'Test Treasury', 'UTC', 'USD') RETURNING id
    `);
    const organizationId = organization.rows[0]!.id;
    await client.query(`
      INSERT INTO currencies (organization_id, code, name, decimal_places, base_currency)
      VALUES ($1, 'USD', 'US Dollar', 2, true)
    `, [organizationId]);
    const user = await client.query<{ id: string }>(`
      INSERT INTO user_refs (organization_id, subject_key, display_name)
      VALUES ($1, 'enrollment-administrator', 'Enrollment Administrator') RETURNING id
    `, [organizationId]);
    const account = await client.query<{ id: string }>(`
      INSERT INTO identity_accounts (
        user_ref_id, normalized_login, password_hash, state, privileged
      ) VALUES ($1, 'enrollment.admin', $2, $3, false)
      RETURNING id
    `, [user.rows[0]!.id, await credentials.hashPassword(password), state]);
    await client.query('COMMIT');
    return account.rows[0]!.id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
