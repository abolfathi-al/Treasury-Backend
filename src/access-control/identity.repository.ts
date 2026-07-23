import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';

import { DatabaseService } from '../database/database.service';
import { IdentityAccountCreateDto, UserRefCreateDto } from './identity.dto';

@Injectable()
export class IdentityRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async listUserRefs(organizationId: string, limit: number, cursor?: string) {
    const result = await this.database.pool.query(`
      SELECT id, subject_key AS "subjectKey", display_name AS "displayName", state, version
      FROM user_refs
      WHERE organization_id = $1 AND ($2::uuid IS NULL OR id > $2)
      ORDER BY id
      LIMIT $3
    `, [organizationId, cursor ?? null, limit + 1]);
    const hasMore = result.rows.length > limit;
    const items = result.rows.slice(0, limit);
    return {
      items,
      page: {
        limit,
        hasMore,
        ...(hasMore ? { nextCursor: items.at(-1).id as string } : {}),
        asOf: new Date().toISOString(),
      },
    };
  }

  createUserRef(
    organizationId: string,
    dto: UserRefCreateDto,
    idempotencyKey: string,
    requestDigest: string,
  ): Promise<Record<string, unknown>> {
    return this.idempotentCreate(organizationId, 'createUserRef', idempotencyKey, requestDigest, async (client) => {
      const result = await client.query(`
        INSERT INTO user_refs (organization_id, subject_key, display_name)
        VALUES ($1,$2,$3)
        RETURNING id, subject_key AS "subjectKey", display_name AS "displayName", state, version
      `, [organizationId, dto.subjectKey, dto.displayName]);
      return result.rows[0];
    });
  }

  createIdentityAccount(
    organizationId: string,
    dto: IdentityAccountCreateDto,
    normalizedLogin: string,
    passwordHash: string,
    idempotencyKey: string,
    requestDigest: string,
    stepUp: {
      proofDigest: string;
      sessionId: string;
      method: string;
      path: string;
      bodyDigest: string;
    },
  ): Promise<Record<string, unknown>> {
    return this.identityCreateTransaction(async (client) => {
        const proof = await client.query<{ id: string }>(`
          SELECT p.id
          FROM auth_step_up_proofs p
          JOIN auth_challenges c ON c.id = p.challenge_id
          WHERE p.token_digest = $1
            AND p.consumed_at IS NULL
            AND p.expires_at > now()
            AND c.session_id = $2
            AND c.http_method = $3
            AND c.http_path = $4
            AND c.request_body_digest = $5
            AND c.idempotency_key = $6
          FOR UPDATE OF p
        `, [
          stepUp.proofDigest,
          stepUp.sessionId,
          stepUp.method,
          stepUp.path,
          stepUp.bodyDigest,
          idempotencyKey,
        ]);
        if (!proof.rowCount) throw new RangeError('STEP_UP_INVALID');

        await client.query(
          'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
          [organizationId, `createIdentityAccount:${idempotencyKey}`],
        );
        const existing = await client.query<{
          request_digest: string;
          response_body: Record<string, unknown> | null;
        }>(`
          SELECT request_digest, response_body FROM idempotency_records
          WHERE organization_id = $1 AND scope = 'createIdentityAccount' AND idempotency_key = $2
        `, [organizationId, idempotencyKey]);
        let response = existing.rows[0]?.response_body;
        if (existing.rows[0]) {
          if (existing.rows[0].request_digest !== requestDigest || !response) {
            throw new SyntaxError('IDEMPOTENCY_CONFLICT');
          }
        } else {
          await client.query(`
            INSERT INTO idempotency_records (organization_id, scope, idempotency_key, request_digest)
            VALUES ($1,'createIdentityAccount',$2,$3)
          `, [organizationId, idempotencyKey, requestDigest]);
        const user = await client.query<{ display_name: string }>(`
          SELECT display_name FROM user_refs
          WHERE id = $1 AND organization_id = $2 AND state = 'ACTIVE'
          FOR UPDATE
        `, [dto.userId, organizationId]);
        if (!user.rowCount) throw new ReferenceError('USER_REF_UNAVAILABLE');
        const result = await client.query(`
          INSERT INTO identity_accounts (
            user_ref_id, normalized_login, password_hash, privileged, state
          ) VALUES ($1,$2,$3,$4,$5)
          RETURNING id, user_ref_id AS "userId", normalized_login AS login,
                    state, privileged, false AS "totpEnrolled", version
        `, [dto.userId, normalizedLogin, passwordHash, dto.privileged, dto.privileged ? 'INVITED' : 'ACTIVE']);
          response = result.rows[0];
          await client.query(`
            UPDATE idempotency_records SET response_status = 201, response_body = $1
            WHERE organization_id = $2 AND scope = 'createIdentityAccount' AND idempotency_key = $3
          `, [response, organizationId, idempotencyKey]);
        }
        await client.query('UPDATE auth_step_up_proofs SET consumed_at = now() WHERE id = $1', [
          proof.rows[0]!.id,
        ]);
        return response!;
    });
  }

  private async identityCreateTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async userContext(organizationId: string, userId: string): Promise<string[]> {
    const result = await this.database.pool.query<{ display_name: string }>(`
      SELECT display_name FROM user_refs WHERE id = $1 AND organization_id = $2
    `, [userId, organizationId]);
    return result.rows[0] ? [result.rows[0].display_name] : [];
  }

  private async idempotentCreate<T extends Record<string, unknown>>(
    organizationId: string,
    scope: string,
    idempotencyKey: string,
    requestDigest: string,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [organizationId, `${scope}:${idempotencyKey}`],
      );
      const existing = await client.query<{
        request_digest: string;
        response_body: T | null;
      }>(`
        SELECT request_digest, response_body FROM idempotency_records
        WHERE organization_id = $1 AND scope = $2 AND idempotency_key = $3
      `, [organizationId, scope, idempotencyKey]);
      const replay = existing.rows[0];
      if (replay) {
        if (replay.request_digest !== requestDigest || !replay.response_body) {
          throw new SyntaxError('IDEMPOTENCY_CONFLICT');
        }
        await client.query('COMMIT');
        return replay.response_body;
      }
      await client.query(`
        INSERT INTO idempotency_records (organization_id, scope, idempotency_key, request_digest)
        VALUES ($1,$2,$3,$4)
      `, [organizationId, scope, idempotencyKey, requestDigest]);
      const response = await work(client);
      await client.query(`
        UPDATE idempotency_records SET response_status = 201, response_body = $1
        WHERE organization_id = $2 AND scope = $3 AND idempotency_key = $4
      `, [response, organizationId, scope, idempotencyKey]);
      await client.query('COMMIT');
      return response;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
