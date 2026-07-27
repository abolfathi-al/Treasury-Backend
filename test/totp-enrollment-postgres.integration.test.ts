import assert from 'node:assert/strict';
import test from 'node:test';

import { AuthRepository } from '../src/access-control/auth.repository';
import { AuthService } from '../src/access-control/auth.service';
import { CredentialService } from '../src/access-control/credential.service';
import { digest } from '../src/common/http';
import { TreasuryProblem } from '../src/common/problem';
import { DatabaseService } from '../src/database/database.service';

const connectionString = process.env.TEST_DATABASE_URL;

test('PostgreSQL TOTP enrollment is atomic and closes a concurrent stale login', {
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
  const newPassword = 'D9!Cobalt-River-Mango-Quartz-742';

  try {
    const accountId = await seedNonEnrolledAccount(database, credentials, currentPassword);
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
      newPassword,
    }, 'enrollment-start');

    const pending = await database.pool.query<{
      enrollment_id_digest: string;
      account_version: number;
      pending_secret_ciphertext: string;
      pending_secret_iv: string;
      pending_secret_auth_tag: string;
      pending_secret_key_version: number;
    }>(`
      SELECT enrollment_id_digest, account_version, pending_secret_ciphertext,
             pending_secret_iv, pending_secret_auth_tag, pending_secret_key_version
      FROM totp_enrollment_challenges
      WHERE identity_account_id = $1 AND state = 'OPEN'
    `, [accountId]);
    assert.equal(pending.rowCount, 1);
    assert.equal(
      pending.rows[0]!.enrollment_id_digest,
      credentials.enrollmentIdDigest(started.enrollmentId),
    );
    assert.equal(pending.rows[0]!.account_version, 1);
    const secret = credentials.decryptTotpSecret({
      ciphertext: pending.rows[0]!.pending_secret_ciphertext,
      iv: pending.rows[0]!.pending_secret_iv,
      authTag: pending.rows[0]!.pending_secret_auth_tag,
      keyVersion: pending.rows[0]!.pending_secret_key_version,
    }, credentials.runtimeTotpKey(pending.rows[0]!.pending_secret_key_version));
    assert.equal(credentials.base32(secret), started.secret);

    const originalVerifyPassword = credentials.verifyPassword.bind(credentials);
    let releaseLogin!: () => void;
    let loginVerified!: () => void;
    const loginMayContinue = new Promise<void>((resolve) => {
      releaseLogin = resolve;
    });
    const passwordVerified = new Promise<void>((resolve) => {
      loginVerified = resolve;
    });
    credentials.verifyPassword = async (hash, password) => {
      const valid = await originalVerifyPassword(hash, password);
      if (password === newPassword) {
        loginVerified();
        await loginMayContinue;
      }
      return valid;
    };
    const staleLogin = service.login({
      login: 'enrollment.admin',
      password: newPassword,
    }, 'concurrent-login');
    await passwordVerified;

    const counter = Math.floor(Date.now() / 30_000);
    const completed = await service.completeTotpEnrollment({
      enrollmentId: started.enrollmentId,
      firstCode: credentials.totp(secret, counter - 1),
      secondCode: credentials.totp(secret, counter),
    }, 'enrollment-complete');
    releaseLogin();
    await assert.rejects(
      staleLogin,
      (error) => error instanceof TreasuryProblem
        && (error.getResponse() as { code?: string }).code === 'TRS-AUT-001',
    );

    const state = await database.pool.query<{
      state: string;
      version: number;
      recovery_version: number;
      authorization_epoch: string;
      totp_ciphertext: string | null;
      recovery_code_hash: string | null;
      active_sessions: string;
      open_challenges: string;
      open_proofs: string;
      enrollment_state: string;
      pending_secret_ciphertext: string | null;
    }>(`
      SELECT ia.state, ia.version, ia.recovery_version, ia.authorization_epoch,
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
             e.pending_secret_ciphertext
      FROM identity_accounts ia
      JOIN totp_enrollment_challenges e ON e.identity_account_id = ia.id
      WHERE ia.id = $1
    `, [accountId]);
    assert.equal(state.rows[0]!.state, 'ACTIVE');
    assert.equal(state.rows[0]!.version, 2);
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

async function seedNonEnrolledAccount(
  database: DatabaseService,
  credentials: CredentialService,
  password: string,
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
      ) VALUES ($1, 'enrollment.admin', $2, 'ACTIVE', false)
      RETURNING id
    `, [user.rows[0]!.id, await credentials.hashPassword(password)]);
    await client.query('COMMIT');
    return account.rows[0]!.id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
