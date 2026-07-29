import assert from 'node:assert/strict';
import test from 'node:test';

import { AuthRepository } from '../src/access-control/auth.repository';
import { AuthService } from '../src/access-control/auth.service';
import { CredentialService } from '../src/access-control/credential.service';
import { TreasuryProblem } from '../src/common/problem';
import { DatabaseService } from '../src/database/database.service';
import { digest } from '../src/common/http';

const connectionString = process.env.TEST_DATABASE_URL;

test('PostgreSQL rejects partial persisted TOTP secret tuples', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = connectionString;
  process.env.LOGIN_THROTTLE_HMAC_KEY_BASE64 = Buffer.alloc(32, 1).toString('base64');
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 3).toString('base64');
  process.env.TOTP_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 2).toString('base64');
  const database = new DatabaseService();
  const credentials = new CredentialService();
  try {
    const fixture = await seedAccount(database, credentials);
    await assert.rejects(
      database.pool.query(
        'UPDATE identity_accounts SET totp_iv = NULL WHERE id = $1',
        [fixture.accountId],
      ),
      (error) => (
        (error as { code?: string }).code === '23514'
        && (error as { constraint?: string }).constraint
          === 'identity_accounts_totp_secret_tuple_check'
      ),
    );
  } finally {
    await database.onModuleDestroy();
  }
});

test('PostgreSQL session touch atomically rejects stale proof and invalid auth state', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = connectionString;
  process.env.LOGIN_THROTTLE_HMAC_KEY_BASE64 = Buffer.alloc(32, 1).toString('base64');
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 3).toString('base64');
  process.env.TOTP_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 2).toString('base64');
  const database = new DatabaseService();
  const credentials = new CredentialService();
  const repository = new AuthRepository(database);
  try {
    const fixture = await seedAccount(database, credentials);
    const tokenDigest = digest('atomic-touch-proof');
    const sessionId = await repository.transaction((client) => repository.createSession(client, {
      accountId: fixture.accountId,
      tokenDigest,
      xsrfDigest: digest('atomic-touch-xsrf'),
      assurance: 'PASSWORD_TOTP',
      now: new Date(),
    }));

    assert.equal(
      await repository.touchSession(sessionId, sessionId, tokenDigest, new Date()),
      true,
      'valid current proof must touch the active session',
    );
    assert.equal(
      await repository.touchSession(
        sessionId,
        '00000000-0000-4000-8000-000000000999',
        tokenDigest,
        new Date(),
      ),
      false,
      'a stale presented session id must fail',
    );
    assert.equal(
      await repository.touchSession(sessionId, sessionId, digest('wrong-proof'), new Date()),
      false,
      'a stale presented token digest must fail',
    );

    await database.pool.query(`
      UPDATE auth_sessions
      SET idle_expires_at = now() - interval '1 second'
      WHERE id = $1
    `, [sessionId]);
    assert.equal(
      await repository.touchSession(sessionId, sessionId, tokenDigest, new Date()),
      false,
      'an expired session must fail',
    );
    await database.pool.query(`
      UPDATE auth_sessions
      SET idle_expires_at = now() + interval '15 minutes',
          absolute_expires_at = now() + interval '8 hours'
      WHERE id = $1
    `, [sessionId]);

    await database.pool.query(
      `UPDATE identity_accounts SET state = 'SUSPENDED' WHERE id = $1`,
      [fixture.accountId],
    );
    assert.equal(
      await repository.touchSession(sessionId, sessionId, tokenDigest, new Date()),
      false,
      'a non-ACTIVE identity account must fail',
    );
    await database.pool.query(
      `UPDATE identity_accounts SET state = 'ACTIVE' WHERE id = $1`,
      [fixture.accountId],
    );

    await database.pool.query(`
      UPDATE user_refs ur
      SET state = 'SUSPENDED'
      FROM identity_accounts ia
      WHERE ia.user_ref_id = ur.id AND ia.id = $1
    `, [fixture.accountId]);
    assert.equal(
      await repository.touchSession(sessionId, sessionId, tokenDigest, new Date()),
      false,
      'a non-ACTIVE UserRef must fail',
    );
    await database.pool.query(`
      UPDATE user_refs ur
      SET state = 'ACTIVE'
      FROM identity_accounts ia
      WHERE ia.user_ref_id = ur.id AND ia.id = $1
    `, [fixture.accountId]);

    await database.pool.query(`
      UPDATE auth_sessions
      SET state = 'REVOKED', revoked_at = now()
      WHERE id = $1
    `, [sessionId]);
    assert.equal(
      await repository.touchSession(sessionId, sessionId, tokenDigest, new Date()),
      false,
      'a revoked session must fail',
    );
  } finally {
    await database.onModuleDestroy();
  }
});

test('PostgreSQL pre-session proofs reject a SUSPENDED UserRef consistently', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = connectionString;
  process.env.LOGIN_THROTTLE_HMAC_KEY_BASE64 = Buffer.alloc(32, 1).toString('base64');
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 3).toString('base64');
  process.env.TOTP_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 2).toString('base64');
  const database = new DatabaseService();
  const credentials = new CredentialService();
  const service = new AuthService(new AuthRepository(database), credentials);
  try {
    const fixture = await seedAccount(database, credentials);
    const login = await service.login({
      login: 'admin',
      password: fixture.password,
    }, 'active-login-before-suspension');
    assert.equal(login.status, 202);
    if (login.status !== 202) throw new Error('Expected TOTP challenge');
    await database.pool.query(`
      UPDATE user_refs ur
      SET state = 'SUSPENDED'
      FROM identity_accounts ia
      WHERE ia.user_ref_id = ur.id AND ia.id = $1
    `, [fixture.accountId]);

    await assert.rejects(
      service.verifyTotp({
        challengeId: login.body.challengeId,
        code: credentials.totp(fixture.secret, Math.floor(Date.now() / 30_000)),
      }, 'suspended-challenge'),
      (error) => error instanceof TreasuryProblem
        && (error.getResponse() as { code?: string }).code === 'TRS-AUT-005',
    );
    await assert.rejects(
      service.login({
        login: 'admin',
        password: fixture.password,
      }, 'suspended-login'),
      (error) => error instanceof TreasuryProblem
        && (error.getResponse() as { code?: string }).code === 'TRS-AUT-001',
    );
    await assert.rejects(
      service.recoverPassword({
        login: 'admin',
        newPassword: 'safe suspended recovery password 2026',
        method: 'AUTHENTICATOR',
        totpCode: credentials.totp(fixture.secret, Math.floor(Date.now() / 30_000)),
      }, 'suspended-recovery'),
      (error) => error instanceof TreasuryProblem
        && (error.getResponse() as { code?: string }).code === 'TRS-AUT-006',
    );
  } finally {
    await database.onModuleDestroy();
  }
});

test('PostgreSQL password+TOTP session and authenticator recovery are replay-safe and atomic', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = connectionString;
  process.env.LOGIN_THROTTLE_HMAC_KEY_BASE64 = Buffer.alloc(32, 1).toString('base64');
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 3).toString('base64');
  process.env.TOTP_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 2).toString('base64');

  const database = new DatabaseService();
  const credentials = new CredentialService();
  const repository = new AuthRepository(database);
  const service = new AuthService(repository, credentials);
  try {
    const fixture = await seedAccount(database, credentials);
    const login = await service.login({
      login: 'ADMIN',
      password: fixture.password,
      deviceLabel: 'integration',
    }, 'request-login');
    assert.equal(login.status, 202);
    if (login.status !== 202) throw new Error('Expected TOTP challenge');

    const now = Date.now();
    const previousCounter = Math.floor(now / 30_000) - 1;
    const verified = await service.verifyTotp({
      challengeId: login.body.challengeId,
      code: credentials.totp(fixture.secret, previousCounter),
    }, 'request-totp');
    assert.equal(verified.status, 201);
    if (verified.status !== 201) throw new Error('Expected established session');

    const session = await service.authenticateSession(verified.sessionToken);
    assert.equal(session.session.assurance, 'PASSWORD_TOTP');
    assert.ok(session.session.effectivePermissions.includes('master-data.manage'));
    await database.pool.query(`
      UPDATE auth_sessions SET last_rotated_at = now() - interval '16 minutes'
      WHERE id = $1
    `, [session.session.sessionId]);
    const rotated = await service.authenticateSession(verified.sessionToken);
    assert.ok(rotated.rotatedSessionToken);
    assert.ok(rotated.refreshedXsrfToken);
    const currentXsrfDigest = digest(rotated.refreshedXsrfToken!);
    const predecessor = await service.authenticateSession(verified.sessionToken);
    assert.equal(predecessor.matchedCurrent, false);
    assert.equal(predecessor.xsrfDigest, digest(verified.xsrfToken));
    assert.equal(await service.refreshXsrf(predecessor), null);
    assert.equal(await service.refreshXsrf(session), null);
    const persistedXsrf = await database.pool.query<{ xsrf_digest: string }>(
      `SELECT tail.xsrf_digest
       FROM auth_sessions tail
       WHERE tail.logical_session_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM auth_sessions successor
           WHERE successor.rotation_parent_id = tail.id
         )`,
      [session.session.sessionId],
    );
    assert.equal(persistedXsrf.rows[0]!.xsrf_digest, currentXsrfDigest);
    const currentSession = await service.authenticateSession(rotated.rotatedSessionToken!);
    assert.equal(currentSession.xsrfDigest, currentXsrfDigest);
    const concurrentRefreshes = await Promise.all(
      Array.from({ length: 8 }, () => service.refreshXsrf({
        ...currentSession,
        session: { ...currentSession.session },
      })),
    );
    const refreshWinners = concurrentRefreshes.filter((value): value is string => value !== null);
    assert.equal(refreshWinners.length, 1);
    const casState = await database.pool.query<{ xsrf_digest: string }>(
      'SELECT xsrf_digest FROM auth_sessions WHERE id = $1',
      [currentSession.physicalSessionId],
    );
    assert.equal(casState.rows[0]!.xsrf_digest, digest(refreshWinners[0]!));

    const recovered = await service.recoverPassword({
      login: 'admin',
      newPassword: 'a different safe recovery password 2026',
      method: 'AUTHENTICATOR',
      totpCode: credentials.totp(fixture.secret, previousCounter + 1),
    }, 'request-recovery');
    assert.equal(recovered.outcome, 'PASSWORD_RESET');
    assert.notEqual(recovered.replacementRecoveryCode, fixture.recoveryCode);

    await assert.rejects(
      service.authenticateSession(verified.sessionToken),
      (error) => error instanceof TreasuryProblem && error.getStatus() === 401,
    );
    await assert.rejects(
      service.recoverPassword({
        login: 'admin',
        newPassword: 'yet another safe recovery password 2026',
        method: 'AUTHENTICATOR',
        totpCode: credentials.totp(fixture.secret, previousCounter + 1),
      }, 'request-replay'),
      (error) => error instanceof TreasuryProblem && error.getStatus() === 401,
    );

    const state = await database.pool.query<{
      recovery_version: number;
      active_sessions: string;
      active_challenges: string;
    }>(`
      SELECT ia.recovery_version,
             (SELECT count(*) FROM auth_sessions s
              WHERE s.identity_account_id = ia.id
                AND s.state = 'ACTIVE'
                AND s.revoked_at IS NULL
                AND s.idle_expires_at > now()
                AND s.absolute_expires_at > now())::text AS active_sessions,
             (SELECT count(*) FROM auth_challenges c WHERE c.identity_account_id = ia.id AND c.consumed_at IS NULL)::text AS active_challenges
      FROM identity_accounts ia WHERE ia.normalized_login = 'admin'
    `);
    assert.equal(state.rows[0]!.recovery_version, 2);
    assert.equal(state.rows[0]!.active_sessions, '0');
    assert.equal(state.rows[0]!.active_challenges, '0');

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await assert.rejects(
        service.recoverPassword({
          login: 'missing-account',
          newPassword: 'safe unknown recovery password 2026',
          method: 'RECOVERY_CODE',
          recoveryCode: 'unknown-code',
        }, `unknown-recovery-${attempt}`),
        (error) => error instanceof TreasuryProblem
          && error.getStatus() === (attempt === 5 ? 429 : 401),
      );
    }
    const recoveryBudget = await database.pool.query<{ attempts: number }>(
      'SELECT max(attempts)::int AS attempts FROM auth_recovery_attempts',
    );
    assert.equal(recoveryBudget.rows[0]!.attempts, 5);

    const relogin = await service.login({
      login: 'admin',
      password: 'a different safe recovery password 2026',
    }, 'request-relogin');
    assert.equal(relogin.status, 202);
    if (relogin.status !== 202) throw new Error('Expected TOTP challenge');
    await database.pool.query(
      `UPDATE auth_challenges SET expires_at = now() + interval '12 seconds' WHERE token_digest = $1`,
      [digest(relogin.body.challengeId)],
    );
    const invalidCode = ['000000', '111111', '222222'].find((candidate) => (
      candidate !== credentials.totp(fixture.secret, Math.floor(Date.now() / 30_000))
      && candidate !== credentials.totp(fixture.secret, Math.floor(Date.now() / 30_000) - 1)
    ))!;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await assert.rejects(
        service.verifyTotp({ challengeId: relogin.body.challengeId, code: invalidCode }, `bad-totp-${attempt}`),
        (error) => {
          if (!(error instanceof TreasuryProblem)) return false;
          if (attempt < 5) return error.getStatus() === 401;
          const body = error.getResponse() as { extensions?: { retryAfter?: number } };
          return error.getStatus() === 429
            && Number(body.extensions?.retryAfter) >= 1
            && Number(body.extensions?.retryAfter) <= 12;
        },
      );
    }
  } finally {
    await database.onModuleDestroy();
  }
});

test('saved recovery code rotates itself without advancing the TOTP counter', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = connectionString;
  process.env.LOGIN_THROTTLE_HMAC_KEY_BASE64 = Buffer.alloc(32, 11).toString('base64');
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 12).toString('base64');
  process.env.TOTP_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 13).toString('base64');
  process.env.TOTP_KEY_VERSION = '1';
  const database = new DatabaseService();
  const credentials = new CredentialService();
  const service = new AuthService(new AuthRepository(database), credentials);
  const replacementPassword = 'saved code recovery password 2026';
  try {
    const fixture = await seedAccount(database, credentials);
    await database.pool.query(
      'UPDATE identity_accounts SET totp_last_counter = $2 WHERE id = $1',
      [fixture.accountId, 424_242],
    );

    const recovered = await service.recoverPassword({
      login: 'admin',
      newPassword: replacementPassword,
      method: 'RECOVERY_CODE',
      recoveryCode: fixture.recoveryCode,
    }, 'saved-code-only-recovery');
    assert.equal(recovered.outcome, 'PASSWORD_RESET');
    assert.notEqual(recovered.replacementRecoveryCode, fixture.recoveryCode);

    const state = await database.pool.query<{
      password_hash: string;
      recovery_code_hash: string;
      recovery_version: number;
      totp_last_counter: string;
    }>(`
      SELECT password_hash, recovery_code_hash, recovery_version,
             totp_last_counter::text
      FROM identity_accounts
      WHERE id = $1
    `, [fixture.accountId]);
    assert.equal(state.rows[0]!.totp_last_counter, '424242');
    assert.equal(state.rows[0]!.recovery_version, 2);
    assert.equal(
      await credentials.verifyPassword(state.rows[0]!.password_hash, replacementPassword),
      true,
    );
    assert.equal(
      await credentials.verifyRecoveryCode(
        state.rows[0]!.recovery_code_hash,
        recovered.replacementRecoveryCode,
      ),
      true,
    );
    assert.equal(
      await credentials.verifyRecoveryCode(
        state.rows[0]!.recovery_code_hash,
        fixture.recoveryCode,
      ),
      false,
    );

    await assert.rejects(
      service.recoverPassword({
        login: 'admin',
        newPassword: 'another saved code recovery password 2026',
        method: 'RECOVERY_CODE',
        recoveryCode: fixture.recoveryCode,
      }, 'saved-code-replay'),
      (error) => error instanceof TreasuryProblem
        && (error.getResponse() as { code?: string }).code === 'TRS-AUT-006',
    );
  } finally {
    await database.onModuleDestroy();
  }
});

test('password admission rejects synchronized attempts 11+ before password verification', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = connectionString;
  process.env.LOGIN_THROTTLE_HMAC_KEY_BASE64 = Buffer.alloc(32, 1).toString('base64');
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 3).toString('base64');
  process.env.TOTP_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 2).toString('base64');
  const database = new DatabaseService();
  const credentials = new CredentialService();
  const service = new AuthService(new AuthRepository(database), credentials);
  try {
    const fixture = await seedAccount(database, credentials);
    let verificationCalls = 0;
    let release!: () => void;
    const admitted = new Promise<void>((resolve) => {
      release = resolve;
    });
    credentials.verifyPassword = async () => {
      verificationCalls += 1;
      if (verificationCalls === 10) release();
      await admitted;
      return false;
    };
    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) => service.login({
        login: 'admin',
        password: `${fixture.password}-${index}`,
      }, `synchronized-password-${index}`)),
    );
    assert.equal(verificationCalls, 10);
    assert.ok(attempts.every((result) => (
      result.status === 'rejected' && result.reason instanceof TreasuryProblem
    )));
    const throttle = await database.pool.query<{
      failure_count: number;
      reservations: string;
    }>(`
      SELECT failure_count,
             (SELECT count(*) FROM auth_password_attempt_reservations)::text AS reservations
      FROM auth_throttle_buckets
      WHERE failure_count > 0
    `);
    assert.equal(throttle.rows[0]!.failure_count, 10);
    assert.equal(throttle.rows[0]!.reservations, '0');
  } finally {
    await database.onModuleDestroy();
  }
});

test('expired abandoned password leases recover across a worker restart', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = connectionString;
  process.env.LOGIN_THROTTLE_HMAC_KEY_BASE64 = Buffer.alloc(32, 1).toString('base64');
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 3).toString('base64');
  process.env.TOTP_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 2).toString('base64');
  const firstDatabase = new DatabaseService();
  const firstCredentials = new CredentialService();
  const firstService = new AuthService(new AuthRepository(firstDatabase), firstCredentials);
  const fixture = await seedAccount(firstDatabase, firstCredentials);
  const internals = firstService as unknown as {
    throttleBucket(subject: string): string;
    reservePasswordAttempt(bucket: string): Promise<unknown>;
  };
  const bucket = internals.throttleBucket('password:admin');
  await Promise.all(Array.from({ length: 10 }, () => internals.reservePasswordAttempt(bucket)));
  await assert.rejects(
    internals.reservePasswordAttempt(bucket),
    (error) => {
      if (!(error instanceof TreasuryProblem) || error.getStatus() !== 429) return false;
      const body = error.getResponse() as { extensions?: { retryAfter?: number } };
      return Number(body.extensions?.retryAfter) >= 100
        && Number(body.extensions?.retryAfter) <= 120;
    },
  );
  const abandoned = await firstDatabase.pool.query<{ count: string }>(`
    UPDATE auth_password_attempt_reservations
    SET expires_at = now() - interval '1 second'
    WHERE bucket_digest = $1
    RETURNING id
  `, [bucket]);
  assert.equal(abandoned.rowCount, 10);
  await firstDatabase.onModuleDestroy();

  const restartedDatabase = new DatabaseService();
  const restartedService = new AuthService(
    new AuthRepository(restartedDatabase),
    new CredentialService(),
  );
  try {
    const login = await restartedService.login({
      login: 'admin',
      password: fixture.password,
    }, 'post-restart-valid-login');
    assert.equal(login.status, 202);
    const state = await restartedDatabase.pool.query<{
      failure_count: number;
      reservations: string;
    }>(`
      SELECT failure_count,
             (SELECT count(*) FROM auth_password_attempt_reservations)::text AS reservations
      FROM auth_throttle_buckets WHERE bucket_digest = $1
    `, [bucket]);
    assert.equal(state.rows[0]!.failure_count, 0);
    assert.equal(state.rows[0]!.reservations, '0');
  } finally {
    await restartedDatabase.onModuleDestroy();
  }
});

test('late completion of an expired password lease is pruned without a failure mutation', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = connectionString;
  process.env.LOGIN_THROTTLE_HMAC_KEY_BASE64 = Buffer.alloc(32, 1).toString('base64');
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 3).toString('base64');
  process.env.TOTP_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 2).toString('base64');
  const database = new DatabaseService();
  const credentials = new CredentialService();
  const service = new AuthService(new AuthRepository(database), credentials);
  try {
    await seedAccount(database, credentials);
    const internals = service as unknown as {
      throttleBucket(subject: string): string;
      reservePasswordAttempt(bucket: string): Promise<{ id: string; generation: number }>;
      finalizePasswordFailure(
        bucket: string,
        reservation: { id: string; generation: number },
      ): Promise<number>;
    };
    const bucket = internals.throttleBucket('password:admin');
    const reservation = await internals.reservePasswordAttempt(bucket);
    await database.pool.query(`
      UPDATE auth_password_attempt_reservations
      SET expires_at = now() - interval '1 second'
      WHERE id = $1
    `, [reservation.id]);
    assert.equal(await internals.finalizePasswordFailure(bucket, reservation), 0);
    const state = await database.pool.query<{
      failure_count: number;
      reservations: string;
    }>(`
      SELECT failure_count,
             (SELECT count(*) FROM auth_password_attempt_reservations)::text AS reservations
      FROM auth_throttle_buckets WHERE bucket_digest = $1
    `, [bucket]);
    assert.equal(state.rows[0]!.failure_count, 0);
    assert.equal(state.rows[0]!.reservations, '0');
  } finally {
    await database.onModuleDestroy();
  }
});

test('recovery admission rejects synchronized attempts 6+ before either proof check', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = connectionString;
  process.env.LOGIN_THROTTLE_HMAC_KEY_BASE64 = Buffer.alloc(32, 1).toString('base64');
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 3).toString('base64');
  process.env.TOTP_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 2).toString('base64');
  const database = new DatabaseService();
  const credentials = new CredentialService();
  const service = new AuthService(new AuthRepository(database), credentials);
  try {
    await seedAccount(database, credentials);
    let recoveryProofCalls = 0;
    let totpProofCalls = 0;
    let release!: () => void;
    const admitted = new Promise<void>((resolve) => {
      release = resolve;
    });
    credentials.verifyRecoveryCode = async () => {
      recoveryProofCalls += 1;
      if (recoveryProofCalls === 5) release();
      await admitted;
      return false;
    };
    credentials.verifyTotp = () => {
      totpProofCalls += 1;
      return null;
    };
    const attempts = await Promise.allSettled(
      Array.from({ length: 7 }, (_, index) => service.recoverPassword({
        login: 'unknown-account',
        newPassword: 'safe synchronized recovery password 2026',
        method: 'RECOVERY_CODE',
        recoveryCode: `unknown-${index}`,
      }, `synchronized-recovery-${index}`)),
    );
    assert.equal(recoveryProofCalls, 5);
    assert.equal(totpProofCalls, 0);
    assert.ok(attempts.every((result) => (
      result.status === 'rejected' && result.reason instanceof TreasuryProblem
    )));
  } finally {
    await database.onModuleDestroy();
  }
});

test('password recovery closes enrollment challenges and clears pending secrets', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = connectionString;
  process.env.LOGIN_THROTTLE_HMAC_KEY_BASE64 = Buffer.alloc(32, 1).toString('base64');
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 3).toString('base64');
  process.env.TOTP_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 2).toString('base64');
  const database = new DatabaseService();
  const repository = new AuthRepository(database);
  try {
    const fixture = await seedAccount(database, new CredentialService());
    await database.pool.query(`
      INSERT INTO totp_enrollment_challenges (
        organization_id, identity_account_id, user_ref_id, enrollment_id_digest,
        pending_secret_ciphertext, pending_secret_iv, pending_secret_auth_tag,
        pending_secret_key_version, pending_password_hash, account_version, expires_at
      )
      SELECT ur.organization_id, ia.id, ia.user_ref_id, repeat('a', 64),
             'ciphertext', 'iv', 'auth-tag', 1, 'pending-password', ia.version,
             now() + interval '5 minutes'
      FROM identity_accounts ia
      JOIN user_refs ur ON ur.id = ia.user_ref_id
      WHERE ia.id = $1
    `, [fixture.accountId]);

    await repository.transaction((client) =>
      repository.revokeAllAccountSecrets(client, fixture.accountId),
    );

    const challenge = await database.pool.query<{
      state: string;
      closed_at: Date | null;
      pending_secret_ciphertext: string | null;
      pending_password_hash: string | null;
    }>(`
      SELECT state, closed_at, pending_secret_ciphertext, pending_password_hash
      FROM totp_enrollment_challenges
      WHERE identity_account_id = $1
    `, [fixture.accountId]);
    assert.equal(challenge.rows[0]!.state, 'EXPIRED');
    assert.ok(challenge.rows[0]!.closed_at);
    assert.equal(challenge.rows[0]!.pending_secret_ciphertext, null);
    assert.equal(challenge.rows[0]!.pending_password_hash, null);
  } finally {
    await database.onModuleDestroy();
  }
});

test('expired enrollment cleanup clears abandoned pending material', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = connectionString;
  process.env.TOTP_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 2).toString('base64');
  const database = new DatabaseService();
  const repository = new AuthRepository(database);
  try {
    const fixture = await seedAccount(database, new CredentialService());
    await database.pool.query(`
      INSERT INTO totp_enrollment_challenges (
        organization_id, identity_account_id, user_ref_id, enrollment_id_digest,
        pending_secret_ciphertext, pending_secret_iv, pending_secret_auth_tag,
        pending_secret_key_version, pending_password_hash, account_version,
        expires_at, created_at, updated_at
      )
      SELECT ur.organization_id, ia.id, ia.user_ref_id, repeat('b', 64),
             'ciphertext', 'iv', 'auth-tag', 1, 'pending-password', ia.version,
             now() - interval '1 minute', now() - interval '6 minutes',
             now() - interval '6 minutes'
      FROM identity_accounts ia
      JOIN user_refs ur ON ur.id = ia.user_ref_id
      WHERE ia.id = $1
    `, [fixture.accountId]);

    await repository.sweepExpiredTotpEnrollments();

    const challenge = await database.pool.query<{
      state: string;
      pending_secret_ciphertext: string | null;
      pending_password_hash: string | null;
    }>(`
      SELECT state, pending_secret_ciphertext, pending_password_hash
      FROM totp_enrollment_challenges
      WHERE identity_account_id = $1
    `, [fixture.accountId]);
    assert.equal(challenge.rows[0]!.state, 'EXPIRED');
    assert.equal(challenge.rows[0]!.pending_secret_ciphertext, null);
    assert.equal(challenge.rows[0]!.pending_password_hash, null);
  } finally {
    await database.onModuleDestroy();
  }
});

test('concurrent TOTP verification and recovery share identity-first lock order without deadlock', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = connectionString;
  process.env.LOGIN_THROTTLE_HMAC_KEY_BASE64 = Buffer.alloc(32, 1).toString('base64');
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 3).toString('base64');
  process.env.TOTP_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 2).toString('base64');
  const database = new DatabaseService();
  const credentials = new CredentialService();
  const service = new AuthService(new AuthRepository(database), credentials);
  try {
    const fixture = await seedAccount(database, credentials);
    const login = await service.login({
      login: 'admin',
      password: fixture.password,
    }, 'deadlock-login');
    assert.equal(login.status, 202);
    if (login.status !== 202) throw new Error('Expected TOTP challenge');
    const counter = Math.floor(Date.now() / 30_000);
    const settled = await Promise.allSettled([
      service.verifyTotp({
        challengeId: login.body.challengeId,
        code: credentials.totp(fixture.secret, counter),
      }, 'deadlock-totp'),
      service.recoverPassword({
        login: 'admin',
        newPassword: 'deadlock safe replacement password 2026',
        method: 'AUTHENTICATOR',
        totpCode: credentials.totp(fixture.secret, counter),
      }, 'deadlock-recovery'),
    ]);
    assert.ok(settled.some((result) => result.status === 'fulfilled'));
    for (const result of settled) {
      if (result.status === 'rejected') {
        assert.equal(['40P01', '40001'].includes((result.reason as { code?: string }).code ?? ''), false);
        assert.ok(result.reason instanceof TreasuryProblem);
      }
    }
  } finally {
    await database.onModuleDestroy();
  }
});

async function seedAccount(database: DatabaseService, credentials: CredentialService) {
  const password = 'safe integration password 2026';
  const secret = Buffer.alloc(32, 7);
  const recoveryCode = credentials.generateRecoveryCode();
  const encrypted = credentials.encryptTotpSecret(
    secret,
    Buffer.from(process.env.TOTP_ENCRYPTION_KEY_BASE64!, 'base64'),
    1,
  );
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    for (const table of [
      'auth_step_up_proofs',
      'auth_challenges',
      'auth_sessions',
      'security_audit_events',
      'auth_password_attempt_reservations',
      'auth_throttle_buckets',
      'auth_recovery_attempts',
      'role_permissions',
      'access_grant_currency_scopes',
      'access_grant_method_category_scopes',
      'access_grant_document_type_scopes',
      'access_grant_bank_account_scopes',
      'access_grant_cashbox_scopes',
      'access_grant_treasury_unit_scopes',
      'access_grant_branch_scopes',
      'access_grants',
      'totp_enrollment_challenges',
      'identity_accounts',
      'roles',
      'user_refs',
      'idempotency_records',
      'method_amount_limits',
      'method_allowed_currencies',
      'method_required_references',
      'method_mappings',
      'method_definitions',
      'treasury_units',
      'branches',
      'currencies',
      'organizations',
    ]) {
      await client.query(`DELETE FROM ${table}`);
    }
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
      VALUES ($1, 'administrator', 'Administrator') RETURNING id
    `, [organizationId]);
    const account = await client.query<{ id: string }>(`
      INSERT INTO identity_accounts (
        user_ref_id, normalized_login, password_hash,
        totp_ciphertext, totp_iv, totp_auth_tag, totp_key_version,
        recovery_code_hash, privileged
      ) VALUES ($1, 'admin', $2, $3, $4, $5, 1, $6, true)
      RETURNING id
    `, [
      user.rows[0]!.id,
      await credentials.hashPassword(password),
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.authTag,
      await credentials.hashRecoveryCode(recoveryCode),
    ]);
    const role = await client.query<{ id: string }>(`
      INSERT INTO roles (organization_id, code, name)
      VALUES ($1, 'SYSTEM_ADMIN', 'System Administrator') RETURNING id
    `, [organizationId]);
    for (const permission of ['auth.logout', 'master-data.view', 'master-data.manage']) {
      await client.query(
        'INSERT INTO role_permissions (role_id, permission) VALUES ($1,$2)',
        [role.rows[0]!.id, permission],
      );
    }
    await client.query(`
      INSERT INTO access_grants (
        organization_id, user_ref_id, role_id, scope_type, scope_id,
        organization_wide
      )
      VALUES ($1,$2,$3,'ORGANIZATION',$1,true)
    `, [organizationId, user.rows[0]!.id, role.rows[0]!.id]);
    await client.query('COMMIT');
    return { password, secret, recoveryCode, accountId: account.rows[0]!.id };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
