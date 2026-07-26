import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';

import { stableJson } from '../common/http';
import { DatabaseService } from '../database/database.service';
import {
  CanonicalGrantScope,
  GrantAuthorization,
  PRIVILEGED_PERMISSIONS,
  RoleCreateDto,
  SessionRevokeDto,
  SessionRevokeScope,
} from './access-admin.dto';

export interface ProtectedCommandContext {
  operationId: string;
  organizationId: string;
  actorAccountId: string;
  physicalSessionId: string;
  requestId: string;
  proofDigest: string;
  method: string;
  path: string;
  bodyDigest: string;
  idempotencyKey: string;
}

export interface PreparedAccessGrant {
  userId: string;
  roleId: string;
  scope: CanonicalGrantScope;
  validFrom: Date;
  validTo: Date | null;
  reason?: string;
}

interface AccessGrantRow {
  id: string;
  userId: string;
  roleId: string;
  amountCeiling: string | null;
  amountCeilingCurrency: string | null;
  validFrom: Date;
  validTo: Date | null;
  reason: string | null;
  state: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class AccessAdminRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async listIdentityAccounts(organizationId: string, limit: number, cursor?: string) {
    const result = await this.database.pool.query(`
      SELECT ia.id, ia.user_ref_id AS "userId", ia.normalized_login AS login,
             ia.state, ia.privileged,
             (ia.totp_ciphertext IS NOT NULL AND ia.totp_iv IS NOT NULL
               AND ia.totp_auth_tag IS NOT NULL AND ia.totp_key_version IS NOT NULL) AS "totpEnrolled",
             ia.version
      FROM identity_accounts ia
      JOIN user_refs ur ON ur.id = ia.user_ref_id
      WHERE ur.organization_id = $1 AND ($2::uuid IS NULL OR ia.id > $2)
      ORDER BY ia.id
      LIMIT $3
    `, [organizationId, cursor ?? null, limit + 1]);
    return page(result.rows, limit);
  }

  async listIdentityAccountSessions(
    organizationId: string,
    identityAccountId: string,
    currentLogicalSessionId: string,
    limit: number,
    cursor?: string,
  ) {
    const visible = await this.database.pool.query(`
      SELECT 1
      FROM identity_accounts ia
      JOIN user_refs ur ON ur.id = ia.user_ref_id
      WHERE ia.id = $1 AND ur.organization_id = $2
    `, [identityAccountId, organizationId]);
    if (!visible.rowCount) throw new ReferenceError('RESOURCE_HIDDEN');

    const result = await this.database.pool.query<{
      id: string;
      identityAccountId: string;
      deviceLabel: string | null;
      authenticatedAt: Date;
      lastSeenAt: Date;
      idleExpiresAt: Date;
      absoluteExpiresAt: Date;
      state: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
      current: boolean;
    }>(`
      SELECT tail.logical_session_id AS id,
             tail.identity_account_id AS "identityAccountId",
             tail.device_label AS "deviceLabel",
             tail.authenticated_at AS "authenticatedAt",
             tail.last_seen_at AS "lastSeenAt",
             tail.idle_expires_at AS "idleExpiresAt",
             tail.absolute_expires_at AS "absoluteExpiresAt",
             CASE
               WHEN tail.revoked_at IS NOT NULL OR tail.state = 'REVOKED' THEN 'REVOKED'
               WHEN tail.state <> 'ACTIVE'
                 OR tail.idle_expires_at <= now()
                 OR tail.absolute_expires_at <= now() THEN 'EXPIRED'
               ELSE 'ACTIVE'
             END AS state,
             (
               tail.logical_session_id = $2
               AND tail.revoked_at IS NULL
               AND tail.state = 'ACTIVE'
               AND tail.idle_expires_at > now()
               AND tail.absolute_expires_at > now()
             ) AS current
      FROM auth_sessions tail
      WHERE tail.identity_account_id = $1
        AND ($3::uuid IS NULL OR tail.logical_session_id > $3)
        AND NOT EXISTS (
          SELECT 1 FROM auth_sessions successor
          WHERE successor.rotation_parent_id = tail.id
        )
      ORDER BY tail.logical_session_id
      LIMIT $4
    `, [identityAccountId, currentLogicalSessionId, cursor ?? null, limit + 1]);
    const items = result.rows.map((row) => ({
      id: row.id,
      identityAccountId: row.identityAccountId,
      ...(row.deviceLabel ? { deviceLabel: row.deviceLabel } : {}),
      authenticatedAt: row.authenticatedAt,
      lastSeenAt: row.lastSeenAt,
      idleExpiresAt: row.idleExpiresAt,
      absoluteExpiresAt: row.absoluteExpiresAt,
      state: row.state,
      current: row.current,
    }));
    return page(items, limit);
  }

  async listRoles(organizationId: string, limit: number, cursor?: string) {
    const result = await this.database.pool.query(`
      SELECT r.id, r.code, r.name,
             array_agg(rp.permission ORDER BY rp.permission) AS permissions,
             r.state, r.version, r.created_at AS "createdAt", r.updated_at AS "updatedAt"
      FROM roles r
      JOIN role_permissions rp ON rp.role_id = r.id
      WHERE r.organization_id = $1 AND ($2::uuid IS NULL OR r.id > $2)
      GROUP BY r.id
      ORDER BY r.id
      LIMIT $3
    `, [organizationId, cursor ?? null, limit + 1]);
    return page(result.rows, limit);
  }

  createRole(
    dto: RoleCreateDto,
    command: ProtectedCommandContext,
  ): Promise<Record<string, unknown>> {
    return this.protectedCommand(command, async (client) => {
      const result = await client.query(`
        INSERT INTO roles (organization_id, code, name)
        VALUES ($1,$2,$3)
        RETURNING id, code, name, state, version,
                  created_at AS "createdAt", updated_at AS "updatedAt"
      `, [command.organizationId, dto.code, dto.name]);
      const role = result.rows[0] as Record<string, unknown>;
      const permissions = [...dto.permissions].sort();
      await client.query(`
        INSERT INTO role_permissions (role_id, permission)
        SELECT $1, permission FROM unnest($2::varchar[]) AS permission
      `, [role.id, permissions]);
      await this.audit(client, command, 'ACCESS_ROLE_CREATED', { roleId: role.id });
      return { ...role, permissions };
    });
  }

  async listPermissionGrants(
    organizationId: string,
    userId: string,
    permission: string,
  ): Promise<GrantAuthorization[]> {
    const result = await this.database.pool.query<AccessGrantRow>(`
      SELECT ag.id, ag.user_ref_id AS "userId", ag.role_id AS "roleId",
             ag.amount_ceiling AS "amountCeiling",
             ag.amount_ceiling_currency AS "amountCeilingCurrency",
             ag.valid_from AS "validFrom", ag.valid_to AS "validTo",
             ag.reason, ag.state, ag.version,
             ag.created_at AS "createdAt", ag.updated_at AS "updatedAt"
      FROM access_grants ag
      JOIN roles r ON r.id = ag.role_id AND r.organization_id = ag.organization_id
      JOIN role_permissions rp ON rp.role_id = r.id
      WHERE ag.organization_id = $1
        AND ag.user_ref_id = $2
        AND rp.permission = $3
        AND ag.state = 'ACTIVE'
        AND r.state = 'ACTIVE'
        AND ag.valid_from <= now()
        AND (ag.valid_to IS NULL OR ag.valid_to > now())
      ORDER BY ag.id
    `, [organizationId, userId, permission]);
    const scopes = await this.loadScopes(this.database.pool, result.rows);
    return result.rows.map((row) => ({
      scope: scopes.get(row.id)!,
      validFrom: row.validFrom,
      validTo: row.validTo,
    }));
  }

  async findAccessGrants(organizationId: string, cursor?: string) {
    const result = await this.database.pool.query<AccessGrantRow>(`
      SELECT ag.id, ag.user_ref_id AS "userId", ag.role_id AS "roleId",
             ag.amount_ceiling AS "amountCeiling",
             ag.amount_ceiling_currency AS "amountCeilingCurrency",
             ag.valid_from AS "validFrom", ag.valid_to AS "validTo",
             ag.reason, ag.state, ag.version,
             ag.created_at AS "createdAt", ag.updated_at AS "updatedAt"
      FROM access_grants ag
      WHERE ag.organization_id = $1 AND ($2::uuid IS NULL OR ag.id > $2)
      ORDER BY ag.id
    `, [organizationId, cursor ?? null]);
    const scopes = await this.loadScopes(this.database.pool, result.rows);
    return result.rows.map((row) => this.grantView(row, scopes.get(row.id)!));
  }

  createAccessGrant(
    dto: PreparedAccessGrant,
    command: ProtectedCommandContext,
  ): Promise<Record<string, unknown>> {
    return this.protectedCommand(command, async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [command.organizationId, `access-grant:${dto.userId}:${dto.roleId}`],
      );
      const targetUser = await client.query<{ state: string }>(`
        SELECT state FROM user_refs
        WHERE id = $1 AND organization_id = $2
        FOR UPDATE
      `, [dto.userId, command.organizationId]);
      if (!targetUser.rowCount) throw new ReferenceError('RESOURCE_HIDDEN');
      if (targetUser.rows[0]!.state !== 'ACTIVE') throw new RangeError('RESOURCE_INACTIVE');
      const target = await client.query<{
        account_id: string;
        account_state: string;
        privileged: boolean;
        totp_enrolled: boolean;
      }>(`
        SELECT ia.id AS account_id, ia.state AS account_state, ia.privileged,
               (ia.totp_ciphertext IS NOT NULL AND ia.totp_iv IS NOT NULL
                 AND ia.totp_auth_tag IS NOT NULL AND ia.totp_key_version IS NOT NULL) AS totp_enrolled
        FROM identity_accounts ia
        WHERE ia.user_ref_id = $1
        FOR UPDATE
      `, [dto.userId]);
      if (!target.rowCount || target.rows[0]!.account_state !== 'ACTIVE') {
        throw new RangeError('TARGET_ACCOUNT_INELIGIBLE');
      }

      const role = await client.query<{ state: string }>(`
        SELECT state FROM roles
        WHERE id = $1 AND organization_id = $2
        FOR UPDATE
      `, [dto.roleId, command.organizationId]);
      if (!role.rowCount) throw new ReferenceError('RESOURCE_HIDDEN');
      if (role.rows[0]!.state !== 'ACTIVE') throw new RangeError('RESOURCE_INACTIVE');
      const privileged = await client.query<{ privileged: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM role_permissions
          WHERE role_id = $1 AND permission = ANY($2::varchar[])
        ) AS privileged
      `, [dto.roleId, PRIVILEGED_PERMISSIONS]);
      if (privileged.rows[0]!.privileged && (
        !target.rows[0]!.privileged || !target.rows[0]!.totp_enrolled
      )) {
        throw new RangeError('TARGET_ACCOUNT_INELIGIBLE');
      }

      await this.validateScopeReferences(client, command.organizationId, dto.scope);
      if (await this.exactGrantExists(client, command.organizationId, dto)) {
        throw new URIError('ACCESS_CONTROL_IDENTITY_CONFLICT');
      }

      const result = await client.query<AccessGrantRow>(`
        INSERT INTO access_grants (
          organization_id, user_ref_id, role_id, scope_type, scope_id,
          amount_ceiling, amount_ceiling_currency, valid_from, valid_to, reason
        ) VALUES ($1,$2,$3,'ORGANIZATION',$1,$4,$5,$6,$7,$8)
        RETURNING id, user_ref_id AS "userId", role_id AS "roleId",
                  amount_ceiling AS "amountCeiling",
                  amount_ceiling_currency AS "amountCeilingCurrency",
                  valid_from AS "validFrom", valid_to AS "validTo",
                  reason, state, version,
                  created_at AS "createdAt", updated_at AS "updatedAt"
      `, [
        command.organizationId,
        dto.userId,
        dto.roleId,
        dto.scope.amountCeiling?.amount ?? null,
        dto.scope.amountCeiling?.currency ?? null,
        dto.validFrom,
        dto.validTo,
        dto.reason ?? null,
      ]);
      const grant = result.rows[0]!;
      await this.insertScopes(client, command.organizationId, grant.id, dto.scope);
      await client.query(`
        UPDATE identity_accounts
        SET authorization_epoch = authorization_epoch + 1, version = version + 1
        WHERE id = $1
      `, [target.rows[0]!.account_id]);
      await this.audit(client, command, 'ACCESS_GRANT_CREATED', {
        grantId: grant.id,
        targetAccountId: target.rows[0]!.account_id,
      });
      return this.grantView(grant, dto.scope);
    });
  }

  revokeIdentitySessions(
    identityAccountId: string,
    dto: SessionRevokeDto,
    actorLogicalSessionId: string,
    command: ProtectedCommandContext,
  ): Promise<Record<string, unknown>> {
    return this.protectedCommand(command, async (client) => {
      const target = await client.query(`
        SELECT 1
        FROM identity_accounts ia
        JOIN user_refs ur ON ur.id = ia.user_ref_id
        WHERE ia.id = $1 AND ur.organization_id = $2
        FOR UPDATE OF ia
      `, [identityAccountId, command.organizationId]);
      if (!target.rowCount) throw new ReferenceError('RESOURCE_HIDDEN');

      let logicalIds: string[];
      if (dto.scope === SessionRevokeScope.CURRENT) {
        if (identityAccountId !== command.actorAccountId) {
          throw new TreasuryAuthorizationError();
        }
        logicalIds = [actorLogicalSessionId];
      } else if (dto.scope === SessionRevokeScope.ONE_SESSION) {
        const selected = await client.query<{ logical_session_id: string }>(`
          SELECT logical_session_id
          FROM auth_sessions
          WHERE identity_account_id = $1 AND logical_session_id = $2
          LIMIT 1
        `, [identityAccountId, dto.sessionId]);
        if (!selected.rowCount) throw new ReferenceError('RESOURCE_HIDDEN');
        logicalIds = [selected.rows[0]!.logical_session_id];
      } else {
        const selected = await client.query<{ logical_session_id: string }>(`
          SELECT tail.logical_session_id
          FROM auth_sessions tail
          WHERE tail.identity_account_id = $1
            AND tail.state = 'ACTIVE'
            AND tail.revoked_at IS NULL
            AND tail.idle_expires_at > now()
            AND tail.absolute_expires_at > now()
            AND NOT EXISTS (
              SELECT 1 FROM auth_sessions successor
              WHERE successor.rotation_parent_id = tail.id
            )
          FOR UPDATE OF tail
        `, [identityAccountId]);
        logicalIds = selected.rows.map((row) => row.logical_session_id);
      }

      const usable = logicalIds.length
        ? await client.query<{ logical_session_id: string }>(`
            SELECT tail.logical_session_id
            FROM auth_sessions tail
            WHERE tail.identity_account_id = $1
              AND tail.logical_session_id = ANY($2::uuid[])
              AND tail.state = 'ACTIVE'
              AND tail.revoked_at IS NULL
              AND tail.idle_expires_at > now()
              AND tail.absolute_expires_at > now()
              AND NOT EXISTS (
                SELECT 1 FROM auth_sessions successor
                WHERE successor.rotation_parent_id = tail.id
              )
            FOR UPDATE OF tail
          `, [identityAccountId, logicalIds])
        : { rows: [] as { logical_session_id: string }[] };
      const usableIds = usable.rows.map((row) => row.logical_session_id);
      const revokedAt = new Date();
      if (usableIds.length) {
        await client.query(`
          UPDATE auth_sessions
          SET revoked_at = $3, revocation_reason = $4, state = 'REVOKED',
              rotated_at = NULL, predecessor_valid_until = NULL
          WHERE identity_account_id = $1
            AND logical_session_id = ANY($2::uuid[])
            AND revoked_at IS NULL
            AND (
              (state = 'ACTIVE' AND idle_expires_at > $3 AND absolute_expires_at > $3)
              OR (state = 'ROTATED' AND predecessor_valid_until > $3)
            )
        `, [identityAccountId, usableIds, revokedAt, dto.reason]);
      }
      const response = {
        identityAccountId,
        scope: dto.scope,
        revokedSessionCount: usableIds.length,
        revokedAt,
      };
      await this.audit(client, command, 'AUTH_SESSIONS_REVOKED', {
        targetAccountId: identityAccountId,
        scope: dto.scope,
        revokedSessionCount: usableIds.length,
        reason: dto.reason,
      });
      return response;
    });
  }

  private async protectedCommand<T extends Record<string, unknown>>(
    command: ProtectedCommandContext,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const proof = await client.query<{
        id: string;
        consumed_at: Date | null;
      }>(`
        SELECT p.id, p.consumed_at
        FROM auth_step_up_proofs p
        JOIN auth_challenges c ON c.id = p.challenge_id
        WHERE p.token_digest = $1
          AND c.session_id = $2
          AND c.http_method = $3
          AND c.http_path = $4
          AND c.request_body_digest = $5
          AND c.idempotency_key = $6
          AND p.expires_at > now()
        FOR UPDATE OF p
      `, [
        command.proofDigest,
        command.physicalSessionId,
        command.method,
        command.path,
        command.bodyDigest,
        command.idempotencyKey,
      ]);
      if (!proof.rowCount) throw new RangeError('STEP_UP_INVALID');

      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [command.organizationId, `${command.operationId}:${command.idempotencyKey}`],
      );
      const existing = await client.query<{
        request_digest: string;
        response_body: T | null;
      }>(`
        SELECT request_digest, response_body
        FROM idempotency_records
        WHERE organization_id = $1 AND scope = $2 AND idempotency_key = $3
      `, [command.organizationId, command.operationId, command.idempotencyKey]);
      if (existing.rows[0]) {
        if (
          existing.rows[0].request_digest !== command.bodyDigest
          || !existing.rows[0].response_body
        ) {
          throw new SyntaxError('IDEMPOTENCY_CONFLICT');
        }
        await client.query('COMMIT');
        return existing.rows[0].response_body;
      }
      if (
        proof.rows[0]!.consumed_at
      ) {
        throw new RangeError('STEP_UP_INVALID');
      }

      await client.query(`
        INSERT INTO idempotency_records (
          organization_id, scope, idempotency_key, request_digest
        ) VALUES ($1,$2,$3,$4)
      `, [
        command.organizationId,
        command.operationId,
        command.idempotencyKey,
        command.bodyDigest,
      ]);
      const response = await work(client);
      await client.query(`
        UPDATE idempotency_records
        SET response_status = $1, response_body = $2
        WHERE organization_id = $3 AND scope = $4 AND idempotency_key = $5
      `, [
        command.operationId === 'createRole' || command.operationId === 'createAccessGrant' ? 201 : 200,
        response,
        command.organizationId,
        command.operationId,
        command.idempotencyKey,
      ]);
      await client.query('UPDATE auth_step_up_proofs SET consumed_at = now() WHERE id = $1', [
        proof.rows[0]!.id,
      ]);
      await client.query('COMMIT');
      return response;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async validateScopeReferences(
    client: PoolClient,
    organizationId: string,
    scope: CanonicalGrantScope,
  ): Promise<void> {
    await this.validateUuidReferences(client, 'branches', scope.branchIds, organizationId);
    await this.validateUuidReferences(client, 'treasury_units', scope.treasuryUnitIds, organizationId);
    await this.validateUuidReferences(client, 'cashboxes', scope.cashboxIds, organizationId);
    await this.validateUuidReferences(
      client,
      'bank_accounts',
      scope.bankAccountIds,
      organizationId,
    );
    const currencies = [...new Set([
      ...scope.currencies,
      ...(scope.amountCeiling ? [scope.amountCeiling.currency] : []),
    ])];
    if (!currencies.length) return;
    const found = await client.query<{ code: string; state: string; decimal_places: number }>(`
      SELECT code, state, decimal_places
      FROM currencies
      WHERE organization_id = $1 AND code = ANY($2::varchar[])
    `, [organizationId, currencies]);
    if (found.rowCount !== currencies.length) throw new ReferenceError('RESOURCE_HIDDEN');
    if (found.rows.some((row) => row.state !== 'ACTIVE')) throw new RangeError('RESOURCE_INACTIVE');
    if (scope.amountCeiling) {
      const currency = found.rows.find((row) => row.code === scope.amountCeiling!.currency)!;
      const scale = scope.amountCeiling.amount.split('.')[1]?.length ?? 0;
      if (scale > currency.decimal_places) throw new RangeError('AMOUNT_SCALE_INVALID');
    }
  }

  private async validateUuidReferences(
    client: PoolClient,
    table: 'branches' | 'treasury_units' | 'cashboxes' | 'bank_accounts',
    ids: string[],
    organizationId: string,
  ): Promise<void> {
    if (!ids.length) return;
    const found = await client.query<{ state: string }>(`
      SELECT state FROM ${table}
      WHERE organization_id = $1 AND id = ANY($2::uuid[])
    `, [organizationId, ids]);
    if (found.rowCount !== ids.length) throw new ReferenceError('RESOURCE_HIDDEN');
    if (found.rows.some((row) => row.state !== 'ACTIVE')) throw new RangeError('RESOURCE_INACTIVE');
  }

  private async exactGrantExists(
    client: PoolClient,
    organizationId: string,
    dto: PreparedAccessGrant,
  ): Promise<boolean> {
    const result = await client.query<AccessGrantRow>(`
      SELECT ag.id, ag.user_ref_id AS "userId", ag.role_id AS "roleId",
             ag.amount_ceiling AS "amountCeiling",
             ag.amount_ceiling_currency AS "amountCeilingCurrency",
             ag.valid_from AS "validFrom", ag.valid_to AS "validTo",
             ag.reason, ag.state, ag.version,
             ag.created_at AS "createdAt", ag.updated_at AS "updatedAt"
      FROM access_grants ag
      WHERE ag.organization_id = $1
        AND ag.user_ref_id = $2
        AND ag.role_id = $3
        AND ag.state = 'ACTIVE'
        AND ag.valid_from = $4
        AND ag.valid_to IS NOT DISTINCT FROM $5::timestamptz
        AND ag.amount_ceiling IS NOT DISTINCT FROM $6::numeric
        AND ag.amount_ceiling_currency IS NOT DISTINCT FROM $7::varchar
      FOR UPDATE
    `, [
      organizationId,
      dto.userId,
      dto.roleId,
      dto.validFrom,
      dto.validTo,
      dto.scope.amountCeiling?.amount ?? null,
      dto.scope.amountCeiling?.currency ?? null,
    ]);
    if (!result.rowCount) return false;
    const scopes = await this.loadScopes(client, result.rows);
    return result.rows.some((row) => (
      stableJson(comparableScope(scopes.get(row.id)!)) === stableJson(comparableScope(dto.scope))
    ));
  }

  private async insertScopes(
    client: PoolClient,
    organizationId: string,
    grantId: string,
    scope: CanonicalGrantScope,
  ): Promise<void> {
    const inserts: [
      string,
      string[],
      unknown[],
    ][] = [
      ['access_grant_branch_scopes', scope.branchIds, [grantId]],
      ['access_grant_treasury_unit_scopes', scope.treasuryUnitIds, [grantId]],
      ['access_grant_cashbox_scopes', scope.cashboxIds, [grantId]],
      ['access_grant_bank_account_scopes', scope.bankAccountIds, [grantId]],
      ['access_grant_document_type_scopes', scope.documentTypes, [grantId]],
      ['access_grant_method_category_scopes', scope.methodCategories, [grantId]],
    ];
    const columns = [
      'branch_id',
      'treasury_unit_id',
      'cashbox_id',
      'bank_account_id',
      'document_type',
      'method_category',
    ];
    for (const [index, [table, values, parameters]] of inserts.entries()) {
      if (!values.length) continue;
      await client.query(`
        INSERT INTO ${table} (access_grant_id, ${columns[index]})
        SELECT $1, value FROM unnest($2::${index < 4 ? 'uuid' : 'varchar'}[]) AS value
      `, [...parameters, values]);
    }
    if (scope.currencies.length) {
      await client.query(`
        INSERT INTO access_grant_currency_scopes (
          access_grant_id, organization_id, currency
        )
        SELECT $1, $2, value FROM unnest($3::varchar[]) AS value
      `, [grantId, organizationId, scope.currencies]);
    }
  }

  private async loadScopes(
    executor: Pick<PoolClient, 'query'>,
    rows: AccessGrantRow[],
  ): Promise<Map<string, CanonicalGrantScope>> {
    const scopes = new Map(rows.map((row) => [row.id, emptyScope(row)]));
    if (!rows.length) return scopes;
    const ids = rows.map((row) => row.id);
    const dimensions = [
      ['access_grant_branch_scopes', 'branch_id', 'branchIds'],
      ['access_grant_treasury_unit_scopes', 'treasury_unit_id', 'treasuryUnitIds'],
      ['access_grant_cashbox_scopes', 'cashbox_id', 'cashboxIds'],
      ['access_grant_bank_account_scopes', 'bank_account_id', 'bankAccountIds'],
      ['access_grant_document_type_scopes', 'document_type', 'documentTypes'],
      ['access_grant_method_category_scopes', 'method_category', 'methodCategories'],
      ['access_grant_currency_scopes', 'currency', 'currencies'],
    ] as const;
    for (const [table, column, property] of dimensions) {
      const result = await executor.query<{ access_grant_id: string; value: string }>(`
        SELECT access_grant_id, ${column}::text AS value
        FROM ${table}
        WHERE access_grant_id = ANY($1::uuid[])
        ORDER BY access_grant_id, ${column}
      `, [ids]);
      for (const row of result.rows) scopes.get(row.access_grant_id)![property].push(row.value);
    }
    return scopes;
  }

  private grantView(row: AccessGrantRow, scope: CanonicalGrantScope): Record<string, unknown> {
    const hasScope = Object.values(scope).some((value) => (
      Array.isArray(value) ? value.length > 0 : Boolean(value)
    ));
    return {
      id: row.id,
      userId: row.userId,
      roleId: row.roleId,
      ...(hasScope ? { scope: compactScope(scope) } : {}),
      validFrom: row.validFrom,
      ...(row.validTo ? { validTo: row.validTo } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
      state: row.state,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private audit(
    client: PoolClient,
    command: ProtectedCommandContext,
    eventType: string,
    details: Record<string, unknown>,
  ): Promise<unknown> {
    return client.query(`
      INSERT INTO security_audit_events (
        organization_id, identity_account_id, request_id, event_type, outcome, details
      ) VALUES ($1,$2,$3,$4,'SUCCEEDED',$5)
    `, [
      command.organizationId,
      command.actorAccountId,
      command.requestId,
      eventType,
      details,
    ]);
  }
}

export class TreasuryAuthorizationError extends Error {}

function emptyScope(row: AccessGrantRow): CanonicalGrantScope {
  return {
    branchIds: [],
    treasuryUnitIds: [],
    cashboxIds: [],
    bankAccountIds: [],
    documentTypes: [],
    methodCategories: [],
    currencies: [],
    ...(row.amountCeiling && row.amountCeilingCurrency
      ? {
          amountCeiling: {
            amount: row.amountCeiling.replace(/0+$/u, '').replace(/\.$/u, ''),
            currency: row.amountCeilingCurrency,
          },
        }
      : {}),
  };
}

function compactScope(scope: CanonicalGrantScope): Record<string, unknown> {
  return Object.fromEntries(Object.entries(scope).filter(([, value]) => (
    Array.isArray(value) ? value.length > 0 : Boolean(value)
  )));
}

function comparableScope(scope: CanonicalGrantScope): CanonicalGrantScope {
  return {
    ...scope,
    currencies: scope.currencies.length
      ? scope.currencies
      : scope.amountCeiling
        ? [scope.amountCeiling.currency]
        : [],
  };
}

function page<T extends { id: string }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  return {
    items,
    page: {
      limit,
      hasMore,
      ...(hasMore ? { nextCursor: items.at(-1)!.id } : {}),
      asOf: new Date().toISOString(),
    },
  };
}
