import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';

import { DatabaseService } from '../database/database.service';

export interface AccountRow {
  id: string;
  user_ref_id: string;
  organization_id: string;
  display_name: string;
  normalized_login: string;
  password_hash: string;
  password_profile_version: number;
  totp_ciphertext: string | null;
  totp_iv: string | null;
  totp_auth_tag: string | null;
  totp_key_version: number | null;
  totp_last_counter: string | null;
  recovery_code_hash: string | null;
  authorization_epoch: string;
  privileged: boolean;
  state: string;
  permissions: string[];
}

export interface ChallengeRow extends AccountRow {
  challenge_row_id: string;
  challenge_kind: 'LOGIN' | 'STEP_UP';
  challenge_attempts: number;
  challenge_expires_at: Date;
  challenge_consumed_at: Date | null;
  challenge_session_id: string | null;
  http_method: string | null;
  http_path: string | null;
  request_body_digest: string | null;
  idempotency_key: string | null;
  device_label: string | null;
}

export interface SessionRow {
  id: string;
  presented_id: string;
  logical_session_id: string;
  identity_account_id: string;
  organization_id: string;
  user_ref_id: string;
  display_name: string;
  assurance: 'PASSWORD' | 'PASSWORD_TOTP';
  device_label: string | null;
  authenticated_at: Date;
  last_seen_at: Date;
  last_rotated_at: Date;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  xsrf_digest: string;
  token_digest: string;
  previous_token_digest: string | null;
  previous_valid_until: Date | null;
  previous_xsrf_digest: string | null;
  matched_current: boolean;
  authorized_epoch: string;
  account_authorization_epoch: string;
  permissions: string[];
  organization_permissions: string[];
}

export interface ThrottleRow {
  failure_count: number;
  generation: string;
  delay_until: Date | null;
  locked_until: Date | null;
}

export interface RecoveryAttemptRow {
  attempts: number;
  expires_at: Date;
}

@Injectable()
export class AuthRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.withTransaction(work);
  }

  private async withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const client = await this.database.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        if (attempt === 0 && ['40P01', '40001'].includes((error as { code?: string }).code ?? '')) {
          continue;
        }
        throw error;
      } finally {
        client.release();
      }
    }
  }

  async findAccountByLogin(normalizedLogin: string, client?: PoolClient, forUpdate = false): Promise<AccountRow | null> {
    const executor = client ?? this.database.pool;
    if (forUpdate) {
      const locked = await executor.query<{ id: string }>(`
        SELECT id FROM identity_accounts WHERE normalized_login = $1 FOR UPDATE
      `, [normalizedLogin]);
      if (!locked.rowCount) return null;
    }
    const result = await executor.query<AccountRow>(`
      SELECT ia.id, ia.user_ref_id, ur.organization_id, ur.display_name,
             ia.normalized_login, ia.password_hash, ia.password_profile_version,
             ia.totp_ciphertext, ia.totp_iv, ia.totp_auth_tag, ia.totp_key_version,
             ia.totp_last_counter, ia.recovery_code_hash, ia.authorization_epoch,
             ia.privileged, ia.state,
             COALESCE(array_agg(DISTINCT rp.permission) FILTER (WHERE rp.permission IS NOT NULL), '{}') AS permissions
      FROM identity_accounts ia
      JOIN user_refs ur ON ur.id = ia.user_ref_id
      LEFT JOIN access_grants ag ON ag.user_ref_id = ur.id
        AND ag.organization_id = ur.organization_id
        AND ag.state = 'ACTIVE'
        AND ag.valid_from <= now()
        AND (ag.valid_to IS NULL OR ag.valid_to > now())
      LEFT JOIN roles r ON r.id = ag.role_id AND r.state = 'ACTIVE'
      LEFT JOIN role_permissions rp ON rp.role_id = r.id
      WHERE ia.normalized_login = $1
      GROUP BY ia.id, ur.id
    `, [normalizedLogin]);
    return result.rows[0] ?? null;
  }

  async findThrottle(bucketDigest: string, client: PoolClient, forUpdate = false): Promise<ThrottleRow | null> {
    const result = await client.query<ThrottleRow>(`
      SELECT failure_count, generation, delay_until, locked_until
      FROM auth_throttle_buckets
      WHERE bucket_digest = $1
      ${forUpdate ? 'FOR UPDATE' : ''}
    `, [bucketDigest]);
    return result.rows[0] ?? null;
  }

  async lockAuthBucket(client: PoolClient, namespace: string, bucketDigest: string): Promise<void> {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [namespace, bucketDigest],
    );
  }

  async setThrottle(
    client: PoolClient,
    bucketDigest: string,
    failureCount: number,
    generation: number,
    delayUntil: Date | null,
    lockedUntil: Date | null,
  ): Promise<void> {
    await client.query(`
      INSERT INTO auth_throttle_buckets (
        bucket_digest, failure_count, generation,
        delay_until, locked_until, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, now())
      ON CONFLICT (bucket_digest) DO UPDATE
      SET failure_count = EXCLUDED.failure_count,
          generation = EXCLUDED.generation,
          delay_until = EXCLUDED.delay_until,
          locked_until = EXCLUDED.locked_until,
          updated_at = now()
    `, [bucketDigest, failureCount, generation, delayUntil, lockedUntil]);
  }

  async clearThrottle(bucketDigest: string, client: PoolClient): Promise<void> {
    await client.query(`
      INSERT INTO auth_throttle_buckets (
        bucket_digest, failure_count, generation, updated_at
      ) VALUES ($1,0,1,now())
      ON CONFLICT (bucket_digest) DO UPDATE
      SET failure_count = 0,
          generation = auth_throttle_buckets.generation + 1,
          delay_until = NULL,
          locked_until = NULL,
          updated_at = now()
    `, [bucketDigest]);
    await client.query(
      'DELETE FROM auth_password_attempt_reservations WHERE bucket_digest = $1',
      [bucketDigest],
    );
  }

  async activePasswordReservations(
    client: PoolClient,
    bucketDigest: string,
    generation: number,
  ): Promise<{ count: number; earliestExpiresAt: Date | null }> {
    const result = await client.query<{ count: string; earliest_expires_at: Date | null }>(`
      SELECT count(*)::text AS count, min(expires_at) AS earliest_expires_at
      FROM auth_password_attempt_reservations
      WHERE bucket_digest = $1 AND generation = $2 AND expires_at > now()
    `, [bucketDigest, generation]);
    return {
      count: Number(result.rows[0]!.count),
      earliestExpiresAt: result.rows[0]!.earliest_expires_at,
    };
  }

  async createPasswordReservation(
    client: PoolClient,
    input: { id: string; bucketDigest: string; generation: number; expiresAt: Date },
  ): Promise<void> {
    await client.query(`
      INSERT INTO auth_password_attempt_reservations (id, bucket_digest, generation, expires_at)
      VALUES ($1,$2,$3,$4)
    `, [input.id, input.bucketDigest, input.generation, input.expiresAt]);
  }

  async consumeActivePasswordReservation(
    client: PoolClient,
    bucketDigest: string,
    reservationId: string,
    generation: number,
  ): Promise<boolean> {
    const result = await client.query(`
      DELETE FROM auth_password_attempt_reservations
      WHERE id = $1
        AND bucket_digest = $2
        AND generation = $3
        AND expires_at > now()
      RETURNING id
    `, [reservationId, bucketDigest, generation]);
    return result.rowCount === 1;
  }

  async deletePasswordReservation(
    client: PoolClient,
    bucketDigest: string,
    reservationId: string,
    generation: number,
  ): Promise<void> {
    await client.query(`
      DELETE FROM auth_password_attempt_reservations
      WHERE id = $1 AND bucket_digest = $2 AND generation = $3
    `, [reservationId, bucketDigest, generation]);
  }

  async discardStalePasswordReservations(
    client: PoolClient,
    bucketDigest: string,
    generation: number,
  ): Promise<void> {
    await client.query(`
      DELETE FROM auth_password_attempt_reservations
      WHERE bucket_digest = $1
        AND (generation <> $2 OR expires_at <= now())
    `, [bucketDigest, generation]);
  }

  async findRecoveryAttempts(
    client: PoolClient,
    bucketDigest: string,
    forUpdate = false,
  ): Promise<RecoveryAttemptRow | null> {
    const result = await client.query<RecoveryAttemptRow>(`
      SELECT attempts, expires_at
      FROM auth_recovery_attempts
      WHERE bucket_digest = $1
      ${forUpdate ? 'FOR UPDATE' : ''}
    `, [bucketDigest]);
    return result.rows[0] ?? null;
  }

  async setRecoveryAttempts(
    client: PoolClient,
    bucketDigest: string,
    attempts: number,
    expiresAt: Date,
  ): Promise<void> {
    await client.query(`
      INSERT INTO auth_recovery_attempts (bucket_digest, attempts, expires_at, updated_at)
      VALUES ($1,$2,$3,now())
      ON CONFLICT (bucket_digest) DO UPDATE
      SET attempts = EXCLUDED.attempts,
          expires_at = EXCLUDED.expires_at,
          updated_at = now()
    `, [bucketDigest, attempts, expiresAt]);
  }

  async clearRecoveryAttempts(client: PoolClient, bucketDigest: string): Promise<void> {
    await client.query('DELETE FROM auth_recovery_attempts WHERE bucket_digest = $1', [bucketDigest]);
  }

  async updatePasswordHash(client: PoolClient, accountId: string, passwordHash: string): Promise<void> {
    await client.query(`
      UPDATE identity_accounts
      SET password_hash = $2, password_profile_version = password_profile_version + 1, version = version + 1
      WHERE id = $1
    `, [accountId, passwordHash]);
  }

  async createChallenge(
    client: PoolClient,
    input: {
      accountId: string;
      sessionId?: string;
      tokenDigest: string;
      kind: 'LOGIN' | 'STEP_UP';
      expiresAt: Date;
      httpMethod?: string;
      httpPath?: string;
      requestBodyDigest?: string;
      idempotencyKey?: string;
      deviceLabel?: string;
    },
  ): Promise<void> {
    await client.query(`
      INSERT INTO auth_challenges (
        identity_account_id, session_id, token_digest, kind, expires_at,
        http_method, http_path, request_body_digest, idempotency_key, device_label
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, [
      input.accountId,
      input.sessionId ?? null,
      input.tokenDigest,
      input.kind,
      input.expiresAt,
      input.httpMethod ?? null,
      input.httpPath ?? null,
      input.requestBodyDigest ?? null,
      input.idempotencyKey ?? null,
      input.deviceLabel ?? null,
    ]);
  }

  async findChallengeForUpdate(tokenDigest: string, client: PoolClient): Promise<ChallengeRow | null> {
    const located = await client.query<{ identity_account_id: string }>(`
      SELECT identity_account_id FROM auth_challenges WHERE token_digest = $1
    `, [tokenDigest]);
    if (!located.rows[0]) return null;
    await client.query('SELECT id FROM identity_accounts WHERE id = $1 FOR UPDATE', [
      located.rows[0].identity_account_id,
    ]);
    await client.query('SELECT id FROM auth_challenges WHERE token_digest = $1 FOR UPDATE', [tokenDigest]);
    const result = await client.query<ChallengeRow>(`
      SELECT ia.id, ia.user_ref_id, ur.organization_id, ur.display_name,
             ia.normalized_login, ia.password_hash, ia.password_profile_version,
             ia.totp_ciphertext, ia.totp_iv, ia.totp_auth_tag, ia.totp_key_version,
             ia.totp_last_counter, ia.recovery_code_hash, ia.authorization_epoch,
             ia.privileged, ia.state,
             c.id AS challenge_row_id, c.kind AS challenge_kind,
             c.attempts AS challenge_attempts, c.expires_at AS challenge_expires_at,
             c.consumed_at AS challenge_consumed_at, c.session_id AS challenge_session_id,
             c.http_method, c.http_path, c.request_body_digest, c.idempotency_key, c.device_label,
             COALESCE(array_agg(DISTINCT rp.permission) FILTER (WHERE rp.permission IS NOT NULL), '{}') AS permissions
      FROM auth_challenges c
      JOIN identity_accounts ia ON ia.id = c.identity_account_id
      JOIN user_refs ur ON ur.id = ia.user_ref_id
      LEFT JOIN access_grants ag ON ag.user_ref_id = ur.id
        AND ag.organization_id = ur.organization_id
        AND ag.state = 'ACTIVE'
        AND ag.valid_from <= now()
        AND (ag.valid_to IS NULL OR ag.valid_to > now())
      LEFT JOIN roles r ON r.id = ag.role_id AND r.state = 'ACTIVE'
      LEFT JOIN role_permissions rp ON rp.role_id = r.id
      WHERE c.token_digest = $1
      GROUP BY c.id, ia.id, ur.id
    `, [tokenDigest]);
    return result.rows[0] ?? null;
  }

  async recordChallengeFailure(client: PoolClient, challengeId: string, attempts: number): Promise<void> {
    await client.query(`
      UPDATE auth_challenges
      SET attempts = $2, consumed_at = CASE WHEN $2 >= 5 THEN now() ELSE consumed_at END
      WHERE id = $1
    `, [challengeId, attempts]);
  }

  async consumeChallengeAndCounter(
    client: PoolClient,
    challengeId: string,
    accountId: string,
    counter: number,
  ): Promise<void> {
    await client.query('UPDATE auth_challenges SET consumed_at = now() WHERE id = $1', [challengeId]);
    await client.query(`
      UPDATE identity_accounts SET totp_last_counter = $2, version = version + 1 WHERE id = $1
    `, [accountId, counter]);
  }

  async createSession(
    client: PoolClient,
    input: {
      accountId: string;
      tokenDigest: string;
      xsrfDigest: string;
      assurance: 'PASSWORD' | 'PASSWORD_TOTP';
      deviceLabel?: string;
      now: Date;
    },
  ): Promise<string> {
    const result = await client.query<{ id: string }>(`
      WITH session_id AS (SELECT gen_random_uuid() AS id)
      INSERT INTO auth_sessions (
        id, identity_account_id, logical_session_id, authorized_epoch,
        token_digest, xsrf_digest, authenticated_at, last_seen_at, last_rotated_at,
        idle_expires_at, absolute_expires_at, assurance, device_label, state
      )
      SELECT session_id.id, $1, session_id.id, ia.authorization_epoch,
             $2, $3, $4, $4, $4, $5, $6, $7, $8, 'ACTIVE'
      FROM session_id
      JOIN identity_accounts ia ON ia.id = $1
      RETURNING auth_sessions.id
    `, [
      input.accountId,
      input.tokenDigest,
      input.xsrfDigest,
      input.now,
      new Date(input.now.getTime() + 15 * 60_000),
      new Date(input.now.getTime() + 8 * 60 * 60_000),
      input.assurance,
      input.deviceLabel ?? null,
    ]);
    return result.rows[0]!.id;
  }

  async findSession(tokenDigest: string): Promise<SessionRow | null> {
    const result = await this.database.pool.query<SessionRow>(`
      WITH RECURSIVE presented AS (
        SELECT s.*,
               CASE
                 WHEN s.token_digest = $1 THEN s.xsrf_digest
                 ELSE s.previous_xsrf_digest
               END AS presented_xsrf_digest
        FROM auth_sessions s
        WHERE (
            s.token_digest = $1
            OR (s.previous_token_digest = $1 AND s.previous_valid_until > now())
          )
          AND s.revoked_at IS NULL
          AND s.absolute_expires_at > now()
          AND (
            (s.state = 'ACTIVE' AND s.idle_expires_at > now())
            OR (s.state = 'ROTATED' AND s.predecessor_valid_until > now())
            OR (s.previous_token_digest = $1 AND s.previous_valid_until > now())
          )
      ),
      chain AS (
        SELECT s.* FROM auth_sessions s JOIN presented p ON p.id = s.id
        UNION ALL
        SELECT successor.*
        FROM auth_sessions successor
        JOIN chain parent ON successor.rotation_parent_id = parent.id
      ),
      tail AS (
        SELECT c.*
        FROM chain c
        WHERE NOT EXISTS (
          SELECT 1 FROM auth_sessions successor
          WHERE successor.rotation_parent_id = c.id
        )
      )
      SELECT tail.*,
             p.id AS presented_id,
             p.presented_xsrf_digest AS xsrf_digest,
             ur.organization_id, ur.id AS user_ref_id, ur.display_name,
             (p.id = tail.id AND tail.token_digest = $1) AS matched_current,
             ia.authorization_epoch AS account_authorization_epoch,
             permission_set.permissions,
             permission_set.organization_permissions
      FROM presented p
      JOIN tail ON true
      JOIN identity_accounts ia ON ia.id = tail.identity_account_id AND ia.state = 'ACTIVE'
      JOIN user_refs ur ON ur.id = ia.user_ref_id AND ur.state = 'ACTIVE'
      CROSS JOIN LATERAL (
        SELECT COALESCE(
          array_agg(DISTINCT rp.permission) FILTER (WHERE rp.permission IS NOT NULL),
          '{}'
        ) AS permissions,
        COALESCE(
          array_agg(DISTINCT rp.permission) FILTER (
            WHERE rp.permission IS NOT NULL
              AND ag.amount_ceiling IS NULL
              AND NOT EXISTS (SELECT 1 FROM access_grant_branch_scopes s WHERE s.access_grant_id = ag.id)
              AND NOT EXISTS (SELECT 1 FROM access_grant_treasury_unit_scopes s WHERE s.access_grant_id = ag.id)
              AND NOT EXISTS (SELECT 1 FROM access_grant_cashbox_scopes s WHERE s.access_grant_id = ag.id)
              AND NOT EXISTS (SELECT 1 FROM access_grant_bank_account_scopes s WHERE s.access_grant_id = ag.id)
              AND NOT EXISTS (SELECT 1 FROM access_grant_document_type_scopes s WHERE s.access_grant_id = ag.id)
              AND NOT EXISTS (SELECT 1 FROM access_grant_method_category_scopes s WHERE s.access_grant_id = ag.id)
              AND NOT EXISTS (SELECT 1 FROM access_grant_currency_scopes s WHERE s.access_grant_id = ag.id)
          ),
          '{}'
        ) AS organization_permissions
        FROM access_grants ag
        JOIN roles r ON r.id = ag.role_id AND r.state = 'ACTIVE'
        JOIN role_permissions rp ON rp.role_id = r.id
        WHERE ag.user_ref_id = ur.id
          AND ag.organization_id = ur.organization_id
          AND ag.state = 'ACTIVE'
          AND ag.valid_from <= now()
          AND (ag.valid_to IS NULL OR ag.valid_to > now())
      ) permission_set
      WHERE tail.state = 'ACTIVE'
        AND tail.revoked_at IS NULL
        AND tail.idle_expires_at > now()
        AND tail.absolute_expires_at > now()
    `, [tokenDigest]);
    return result.rows[0] ?? null;
  }

  async rotateSession(
    sessionId: string,
    currentDigest: string,
    nextDigest: string,
    nextXsrfDigest: string,
    now: Date,
  ): Promise<string | null> {
    return this.withTransaction(async (client) => {
      const current = await client.query<SessionRow>(`
        SELECT s.*, ia.authorization_epoch AS account_authorization_epoch
        FROM auth_sessions s
        JOIN identity_accounts ia ON ia.id = s.identity_account_id
        WHERE s.id = $1
          AND s.token_digest = $2
          AND s.state = 'ACTIVE'
          AND s.revoked_at IS NULL
          AND s.idle_expires_at > $3
          AND s.absolute_expires_at > $3
          AND NOT EXISTS (
            SELECT 1 FROM auth_sessions successor
            WHERE successor.rotation_parent_id = s.id
          )
        FOR UPDATE OF s, ia
      `, [sessionId, currentDigest, now]);
      if (!current.rowCount) return null;
      const row = current.rows[0]!;
      const successor = await client.query<{ id: string }>(`
        INSERT INTO auth_sessions (
          identity_account_id, logical_session_id, authorized_epoch,
          token_digest, xsrf_digest, authenticated_at, last_seen_at, last_rotated_at,
          idle_expires_at, absolute_expires_at, assurance, device_label,
          rotation_parent_id, state
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12,'ACTIVE')
        RETURNING id
      `, [
        row.identity_account_id,
        row.logical_session_id,
        row.account_authorization_epoch,
        nextDigest,
        nextXsrfDigest,
        row.authenticated_at,
        now,
        new Date(Math.min(now.getTime() + 15 * 60_000, row.absolute_expires_at.getTime())),
        row.absolute_expires_at,
        row.assurance,
        row.device_label,
        row.id,
      ]);
      await client.query(`
        UPDATE auth_sessions
        SET state = 'ROTATED', rotated_at = $2, predecessor_valid_until = $3,
            previous_token_digest = NULL, previous_valid_until = NULL,
            previous_xsrf_digest = NULL
        WHERE id = $1
      `, [row.id, now, new Date(now.getTime() + 30_000)]);
      return successor.rows[0]!.id;
    });
  }

  async touchSession(sessionId: string, now: Date): Promise<boolean> {
    const result = await this.database.pool.query(`
      UPDATE auth_sessions
      SET last_seen_at = $2, idle_expires_at = LEAST($3, absolute_expires_at)
      WHERE id = $1 AND state = 'ACTIVE' AND revoked_at IS NULL
    `, [sessionId, now, new Date(now.getTime() + 15 * 60_000)]);
    return result.rowCount === 1;
  }

  async refreshXsrf(
    sessionId: string,
    currentDigest: string,
    previousXsrfDigest: string,
    xsrfDigest: string,
    now: Date,
  ): Promise<boolean> {
    const result = await this.database.pool.query(`
      UPDATE auth_sessions
      SET xsrf_digest = $4, last_seen_at = $5,
          idle_expires_at = LEAST($6, absolute_expires_at)
      WHERE id = $1
        AND token_digest = $2
        AND xsrf_digest = $3
        AND state = 'ACTIVE'
        AND revoked_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM auth_sessions successor
          WHERE successor.rotation_parent_id = auth_sessions.id
        )
    `, [
      sessionId,
      currentDigest,
      previousXsrfDigest,
      xsrfDigest,
      now,
      new Date(now.getTime() + 15 * 60_000),
    ]);
    return result.rowCount === 1;
  }

  async revokeSession(logicalSessionId: string, accountId: string): Promise<void> {
    await this.database.pool.query(`
      UPDATE auth_sessions
      SET revoked_at = now(), revocation_reason = 'LOGOUT', state = 'REVOKED',
          rotated_at = NULL, predecessor_valid_until = NULL
      WHERE logical_session_id = $1
        AND identity_account_id = $2
        AND revoked_at IS NULL
        AND (
          state = 'ACTIVE'
          OR (state = 'ROTATED' AND predecessor_valid_until > now())
        )
    `, [logicalSessionId, accountId]);
  }

  async revokeAllAccountSecrets(client: PoolClient, accountId: string): Promise<void> {
    await client.query(`
      UPDATE auth_sessions
      SET revoked_at = now(), revocation_reason = 'PASSWORD_RECOVERY', state = 'REVOKED',
          rotated_at = NULL, predecessor_valid_until = NULL
      WHERE identity_account_id = $1 AND revoked_at IS NULL
        AND (
          state = 'ACTIVE'
          OR (state = 'ROTATED' AND predecessor_valid_until > now())
        )
    `, [accountId]);
    await client.query('UPDATE auth_challenges SET consumed_at = now() WHERE identity_account_id = $1 AND consumed_at IS NULL', [accountId]);
    await client.query(`
      UPDATE auth_step_up_proofs p SET consumed_at = now()
      FROM auth_challenges c
      WHERE p.challenge_id = c.id AND c.identity_account_id = $1 AND p.consumed_at IS NULL
    `, [accountId]);
  }

  async replaceRecoveryCredentials(
    client: PoolClient,
    accountId: string,
    passwordHash: string,
    recoveryHash: string,
    counter: number,
  ): Promise<void> {
    await client.query(`
      UPDATE identity_accounts
      SET password_hash = $2,
          password_profile_version = password_profile_version + 1,
          recovery_code_hash = $3,
          recovery_version = recovery_version + 1,
          totp_last_counter = $4,
          version = version + 1
      WHERE id = $1
    `, [accountId, passwordHash, recoveryHash, counter]);
  }

  async createStepUpProof(
    client: PoolClient,
    challengeId: string,
    tokenDigest: string,
    expiresAt: Date,
  ): Promise<void> {
    await client.query(`
      INSERT INTO auth_step_up_proofs (challenge_id, token_digest, expires_at)
      VALUES ($1, $2, $3)
    `, [challengeId, tokenDigest, expiresAt]);
  }

  async validateStepUpProof(
    tokenDigest: string,
    expected: {
      organizationId: string;
      operationId: string;
      sessionId: string;
      method: string;
      path: string;
      bodyDigest: string;
      idempotencyKey: string;
    },
  ): Promise<boolean> {
    const result = await this.database.pool.query<{ id: string }>(`
        SELECT p.id
        FROM auth_step_up_proofs p
        JOIN auth_challenges c ON c.id = p.challenge_id
        WHERE p.token_digest = $1
          AND c.session_id = $2
          AND c.http_method = $3
          AND c.http_path = $4
          AND c.request_body_digest = $5
          AND c.idempotency_key = $6
          AND p.expires_at > now()
          AND (
            p.consumed_at IS NULL
            OR EXISTS (
              SELECT 1
              FROM idempotency_records i
              WHERE i.organization_id = $7
                AND i.scope = $8
                AND i.idempotency_key = $6
                AND i.request_digest = $5
                AND i.response_body IS NOT NULL
            )
          )
      `, [
        tokenDigest,
        expected.sessionId,
        expected.method,
        expected.path,
        expected.bodyDigest,
        expected.idempotencyKey,
        expected.organizationId,
        expected.operationId,
      ]);
    return result.rowCount === 1;
  }

  async audit(
    client: PoolClient,
    input: {
      organizationId?: string;
      accountId?: string;
      requestId: string;
      eventType: string;
      outcome: string;
      details?: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.query(`
      INSERT INTO security_audit_events (
        organization_id, identity_account_id, request_id, event_type, outcome, details
      ) VALUES ($1,$2,$3,$4,$5,$6)
    `, [
      input.organizationId ?? null,
      input.accountId ?? null,
      input.requestId,
      input.eventType,
      input.outcome,
      input.details ?? {},
    ]);
  }
}
