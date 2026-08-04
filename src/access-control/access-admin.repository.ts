import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lt, lte, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { PoolClient } from 'pg';

import { stableJson } from '../common/http';
import { DatabaseService } from '../database/database.service';
import {
  accessGrants,
  approvalPolicies,
  approvalSteps,
  branches,
  delegations,
  organizations,
  roles,
  treasuryUnits,
  userRefs,
} from '../database/schema';
import {
  ApprovalPaymentAggregationDto,
  ApprovalPolicyCreateDto,
  ApprovalPolicyScopeDto,
  ApprovalPolicyStepDto,
  CanonicalGrantScope,
  DelegationScopeDto,
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
  organizationWide: boolean;
  scope: CanonicalGrantScope;
  validFrom: Date;
  validTo: Date | null;
  reason?: string;
}

export interface PreparedApprovalPolicy extends Omit<ApprovalPolicyCreateDto, 'scope'> {
  scope?: ApprovalPolicyScopeDto;
  steps: ApprovalPolicyStepDto[];
  separationRules: string[];
  paymentAggregation?: ApprovalPaymentAggregationDto;
}

export interface PreparedDelegation {
  accessGrantId: string;
  delegateUserId: string;
  scope: DelegationScopeDto;
  reason: string;
  validFrom: Date;
  validTo: Date;
}

export interface DelegationListItem {
  view: Record<string, unknown> & { id: string; createdAt: Date };
  authorizationScope: CanonicalGrantScope;
}

interface AccessGrantRow {
  id: string;
  userId: string;
  roleId: string;
  organizationWide: boolean;
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

type ScopeBearingGrantRow = Pick<
  AccessGrantRow,
  'id' | 'amountCeiling' | 'amountCeilingCurrency'
>;

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

  async organizationBaseCurrency(organizationId: string): Promise<string> {
    const rows = await this.database.db
      .select({ baseCurrency: organizations.baseCurrency })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    if (!rows[0]) throw new ReferenceError('RESOURCE_HIDDEN');
    return rows[0].baseCurrency as string;
  }

  async findApprovalPolicies(
    organizationId: string,
    cursorCreatedAt?: Date,
    cursorId?: string,
    cutoff = new Date(),
  ): Promise<Array<Record<string, unknown> & { id: string; createdAt: Date }>> {
    const position = cursorCreatedAt && cursorId
      ? or(
          lt(approvalPolicies.createdAt, cursorCreatedAt),
          and(
            eq(approvalPolicies.createdAt, cursorCreatedAt),
            lt(approvalPolicies.id, cursorId),
          ),
        )
      : undefined;
    const rows = await this.database.db
      .select({
        id: approvalPolicies.id,
        code: approvalPolicies.code,
        documentType: approvalPolicies.documentType,
        organizationWide: approvalPolicies.organizationWide,
        branchId: approvalPolicies.branchId,
        branchLabel: branches.name,
        treasuryUnitId: approvalPolicies.treasuryUnitId,
        treasuryUnitLabel: treasuryUnits.name,
        currency: approvalPolicies.currency,
        methodCategory: approvalPolicies.methodCategory,
        minimumBaseAmount: approvalPolicies.minimumBaseAmount,
        maximumBaseAmount: approvalPolicies.maximumBaseAmount,
        separationRules: approvalPolicies.separationRules,
        aggregationWindowKind: approvalPolicies.aggregationWindowKind,
        aggregationKeys: approvalPolicies.aggregationKeys,
        aggregationOverrideSecondApproval: approvalPolicies.aggregationOverrideSecondApproval,
        state: approvalPolicies.state,
        policyVersion: approvalPolicies.policyVersion,
        createdAt: approvalPolicies.createdAt,
        updatedAt: approvalPolicies.updatedAt,
      })
      .from(approvalPolicies)
      .leftJoin(branches, and(
        eq(branches.organizationId, approvalPolicies.organizationId),
        eq(branches.id, approvalPolicies.branchId),
      ))
      .leftJoin(treasuryUnits, and(
        eq(treasuryUnits.organizationId, approvalPolicies.organizationId),
        eq(treasuryUnits.id, approvalPolicies.treasuryUnitId),
      ))
      .where(and(
        eq(approvalPolicies.organizationId, organizationId),
        lte(approvalPolicies.createdAt, cutoff),
        position,
      ))
      .orderBy(desc(approvalPolicies.createdAt), desc(approvalPolicies.id));
    const ids = rows.map((row) => row.id);
    const stepRows = ids.length ? await this.database.db
      .select({
        id: approvalSteps.id,
        policyId: approvalSteps.approvalPolicyId,
        order: approvalSteps.stepOrder,
        roleId: approvalSteps.requiredRoleId,
        roleLabel: roles.name,
        approverUserId: approvalSteps.namedApproverId,
        approverLabel: userRefs.displayName,
        approvalsRequired: approvalSteps.approvalsRequired,
      })
      .from(approvalSteps)
      .leftJoin(roles, and(
        eq(roles.organizationId, approvalSteps.organizationId),
        eq(roles.id, approvalSteps.requiredRoleId),
      ))
      .leftJoin(userRefs, and(
        eq(userRefs.organizationId, approvalSteps.organizationId),
        eq(userRefs.id, approvalSteps.namedApproverId),
      ))
      .where(inArray(approvalSteps.approvalPolicyId, ids))
      .orderBy(approvalSteps.stepOrder)
      : [];
    return rows.map((row) => policyView(
      row,
      stepRows.filter((step) => step.policyId === row.id),
    ));
  }

  async findDelegations(
    organizationId: string,
    cursorCreatedAt?: Date,
    cursorId?: string,
    cutoff = new Date(),
  ): Promise<DelegationListItem[]> {
    const grantor = alias(userRefs, 'delegation_grantor');
    const delegate = alias(userRefs, 'delegation_delegate');
    const revokedBy = alias(userRefs, 'delegation_revoked_by');
    const position = cursorCreatedAt && cursorId
      ? or(
          lt(delegations.createdAt, cursorCreatedAt),
          and(eq(delegations.createdAt, cursorCreatedAt), lt(delegations.id, cursorId)),
        )
      : undefined;
    const rows = await this.database.db
      .select({
        id: delegations.id,
        accessGrantId: delegations.accessGrantId,
        sourceGrantVersion: delegations.sourceGrantVersion,
        sourceRoleLabel: roles.name,
        grantorUserId: delegations.grantorUserId,
        grantorLabel: grantor.displayName,
        delegateUserId: delegations.delegateUserId,
        delegateLabel: delegate.displayName,
        branchId: delegations.branchId,
        branchLabel: branches.name,
        treasuryUnitId: delegations.treasuryUnitId,
        treasuryUnitLabel: treasuryUnits.name,
        documentType: delegations.documentType,
        methodCategory: delegations.methodCategory,
        currency: delegations.currency,
        amountCeiling: delegations.amountCeiling,
        amountCeilingCurrency: delegations.amountCeilingCurrency,
        sourceAmountCeiling: accessGrants.amountCeiling,
        sourceAmountCeilingCurrency: accessGrants.amountCeilingCurrency,
        reason: delegations.reason,
        validFrom: delegations.validFrom,
        validTo: delegations.validTo,
        revokedAt: delegations.revokedAt,
        revokedByUserId: delegations.revokedByUserId,
        revokedByLabel: revokedBy.displayName,
        revocationReason: delegations.revocationReason,
        createdAt: delegations.createdAt,
      })
      .from(delegations)
      .innerJoin(accessGrants, and(
        eq(accessGrants.organizationId, delegations.organizationId),
        eq(accessGrants.id, delegations.accessGrantId),
      ))
      .innerJoin(roles, eq(roles.id, accessGrants.roleId))
      .innerJoin(grantor, and(
        eq(grantor.organizationId, delegations.organizationId),
        eq(grantor.id, delegations.grantorUserId),
      ))
      .innerJoin(delegate, and(
        eq(delegate.organizationId, delegations.organizationId),
        eq(delegate.id, delegations.delegateUserId),
      ))
      .leftJoin(revokedBy, and(
        eq(revokedBy.organizationId, delegations.organizationId),
        eq(revokedBy.id, delegations.revokedByUserId),
      ))
      .leftJoin(branches, and(
        eq(branches.organizationId, delegations.organizationId),
        eq(branches.id, delegations.branchId),
      ))
      .leftJoin(treasuryUnits, and(
        eq(treasuryUnits.organizationId, delegations.organizationId),
        eq(treasuryUnits.id, delegations.treasuryUnitId),
      ))
      .where(and(
        eq(delegations.organizationId, organizationId),
        lte(delegations.createdAt, cutoff),
        position,
      ))
      .orderBy(desc(delegations.createdAt), desc(delegations.id));
    const sourceGrants = [...new Map(rows.map((row) => [row.accessGrantId, {
      id: row.accessGrantId,
      amountCeiling: row.sourceAmountCeiling,
      amountCeilingCurrency: row.sourceAmountCeilingCurrency,
    }])).values()];
    const sourceScopes = await this.loadScopes(this.database.pool, sourceGrants);
    return rows.map((row) => ({
      view: delegationView(row),
      authorizationScope: effectiveDelegationScope(sourceScopes.get(row.accessGrantId)!, row),
    }));
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
    return this.permissionGrants(
      this.database.pool,
      organizationId,
      userId,
      permission,
    );
  }

  private async permissionGrants(
    executor: Pick<PoolClient, 'query'>,
    organizationId: string,
    userId: string,
    permission: string,
    lock = false,
  ): Promise<GrantAuthorization[]> {
    const result = await executor.query<AccessGrantRow>(`
      SELECT ag.id, ag.user_ref_id AS "userId", ag.role_id AS "roleId",
             ag.organization_wide AS "organizationWide",
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
      ${lock ? 'FOR SHARE OF ag, r' : ''}
    `, [organizationId, userId, permission]);
    const scopes = await this.loadScopes(executor, result.rows, lock);
    return result.rows.map((row) => ({
      organizationWide: row.organizationWide,
      scope: scopes.get(row.id)!,
      validFrom: row.validFrom,
      validTo: row.validTo,
    }));
  }

  async findAccessGrants(organizationId: string, cursor?: string) {
    const result = await this.database.pool.query<AccessGrantRow>(`
      SELECT ag.id, ag.user_ref_id AS "userId", ag.role_id AS "roleId",
             ag.organization_wide AS "organizationWide",
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
          organization_wide, amount_ceiling, amount_ceiling_currency,
          valid_from, valid_to, reason
        ) VALUES ($1,$2,$3,'ORGANIZATION',$1,$4,$5,$6,$7,$8,$9)
        RETURNING id, user_ref_id AS "userId", role_id AS "roleId",
                  organization_wide AS "organizationWide",
                  amount_ceiling AS "amountCeiling",
                  amount_ceiling_currency AS "amountCeilingCurrency",
                  valid_from AS "validFrom", valid_to AS "validTo",
                  reason, state, version,
                  created_at AS "createdAt", updated_at AS "updatedAt"
      `, [
        command.organizationId,
        dto.userId,
        dto.roleId,
        dto.organizationWide,
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

  createApprovalPolicy(
    dto: PreparedApprovalPolicy,
    actorUserId: string,
    command: ProtectedCommandContext,
  ): Promise<Record<string, unknown>> {
    return this.protectedCommand(command, async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [command.organizationId, `approval-policy:${dto.documentType}`],
      );
      const baseCurrency = await this.validateApprovalPolicyReferences(
        client,
        command.organizationId,
        dto,
      );
      const authority = await this.permissionGrants(
        client,
        command.organizationId,
        actorUserId,
        'approval-policy.manage',
        true,
      );
      if (!authority.some((grant) => policyGrantContains(grant, dto, baseCurrency))) {
        throw new TreasuryAuthorizationError();
      }
      const requiredSeparation = dto.documentType === 'SETTLEMENT'
        ? ['CREATOR_NOT_APPROVER']
        : ['PAYMENT', 'RECEIPT'].includes(dto.documentType)
          ? ['CREATOR_NOT_EXECUTOR', 'APPROVER_NOT_EXECUTOR']
          : [];
      if (requiredSeparation.some((rule) => !dto.separationRules.includes(rule))) {
        throw new ApprovalPolicyConflictError();
      }
      const active = await client.query<PolicyScopeRow>(`
        SELECT organization_wide AS "organizationWide", branch_id AS "branchId",
               treasury_unit_id AS "treasuryUnitId", currency, method_category AS "methodCategory",
               minimum_base_amount AS "minimumBaseAmount",
               maximum_base_amount AS "maximumBaseAmount"
        FROM approval_policies
        WHERE organization_id = $1 AND document_type = $2 AND state = 'ACTIVE'
        FOR UPDATE
      `, [command.organizationId, dto.documentType]);
      const candidate = policyScope(dto);
      if (active.rows.some((existing) => ambiguousPolicyOverlap(existing, candidate))) {
        throw new ApprovalPolicyConflictError();
      }
      let inserted;
      try {
        inserted = await client.query<{ id: string }>(`
          INSERT INTO approval_policies (
            organization_id, code, name, document_type, organization_wide,
            branch_id, treasury_unit_id, currency, method_category,
            minimum_base_amount, maximum_base_amount, separation_rules,
            aggregation_window_kind, aggregation_keys,
            aggregation_override_second_approval
          ) VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          RETURNING id
        `, [
          command.organizationId,
          dto.code,
          dto.documentType,
          dto.organizationWide,
          dto.scope?.branchId ?? null,
          dto.scope?.treasuryUnitId ?? null,
          dto.scope?.currency ?? null,
          dto.scope?.methodCategory ?? null,
          dto.scope?.minimumBaseAmount ?? null,
          dto.scope?.maximumBaseAmount ?? null,
          JSON.stringify(dto.separationRules),
          dto.paymentAggregation?.windowKind ?? null,
          dto.paymentAggregation ? JSON.stringify(dto.paymentAggregation.keys) : null,
          dto.paymentAggregation?.overrideRequiresSecondApproval ?? null,
        ]);
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw new ApprovalPolicyConflictError();
        throw error;
      }
      const policyId = inserted.rows[0]!.id;
      for (const step of dto.steps) {
        await client.query(`
          INSERT INTO approval_steps (
            organization_id, approval_policy_id, step_order,
            required_role_id, named_approver_id, approvals_required,
            separation_rules
          ) VALUES ($1,$2,$3,$4,$5,$6,$7)
        `, [
          command.organizationId,
          policyId,
          step.order,
          step.roleId ?? null,
          step.approverUserId ?? null,
          step.approvalsRequired,
          JSON.stringify(dto.separationRules),
        ]);
      }
      await this.audit(client, command, 'APPROVAL_POLICY_CREATED', { policyId });
      return this.approvalPolicyView(client, command.organizationId, policyId);
    });
  }

  createDelegation(
    dto: PreparedDelegation,
    actorUserId: string,
    command: ProtectedCommandContext,
  ): Promise<Record<string, unknown>> {
    return this.protectedCommand(command, async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [command.organizationId, `delegation:${dto.accessGrantId}`],
      );
      const sourceResult = await client.query<AccessGrantRow & { commandTime: Date }>(`
        SELECT ag.id, ag.user_ref_id AS "userId", ag.role_id AS "roleId",
               ag.organization_wide AS "organizationWide",
               ag.amount_ceiling AS "amountCeiling",
               ag.amount_ceiling_currency AS "amountCeilingCurrency",
               ag.valid_from AS "validFrom", ag.valid_to AS "validTo",
               ag.reason, ag.state, ag.version,
               ag.created_at AS "createdAt", ag.updated_at AS "updatedAt",
               now() AS "commandTime"
        FROM access_grants ag
        JOIN roles r ON r.id = ag.role_id AND r.organization_id = ag.organization_id
        JOIN role_permissions rp ON rp.role_id = r.id AND rp.permission = 'delegation.manage'
        JOIN user_refs grantor ON grantor.id = ag.user_ref_id
          AND grantor.organization_id = ag.organization_id
          AND grantor.state = 'ACTIVE'
        WHERE ag.organization_id = $1 AND ag.id = $2 AND ag.user_ref_id = $3
          AND ag.state = 'ACTIVE' AND r.state = 'ACTIVE'
          AND ag.valid_from <= now() AND (ag.valid_to IS NULL OR ag.valid_to > now())
          AND EXISTS (
            SELECT 1 FROM identity_accounts ia
            WHERE ia.user_ref_id = grantor.id AND ia.state = 'ACTIVE'
          )
        FOR UPDATE OF ag
      `, [command.organizationId, dto.accessGrantId, actorUserId]);
      const source = sourceResult.rows[0];
      if (!source) throw new DelegationConflictError();
      if (
        dto.validFrom < source.validFrom
        || (source.validTo && dto.validTo > source.validTo)
        || dto.validTo <= source.commandTime
      ) throw new DelegationConflictError();
      const delegate = await client.query<{ display_name: string }>(`
        SELECT ur.display_name
        FROM user_refs ur
        JOIN identity_accounts ia ON ia.user_ref_id = ur.id AND ia.state = 'ACTIVE'
        WHERE ur.organization_id = $1 AND ur.id = $2 AND ur.state = 'ACTIVE'
        FOR UPDATE OF ur, ia
      `, [command.organizationId, dto.delegateUserId]);
      if (!delegate.rowCount) throw new ReferenceError('RESOURCE_HIDDEN');
      if (dto.delegateUserId === actorUserId) throw new DelegationConflictError();
      await this.validateDelegationReferences(client, command.organizationId, dto.scope);
      const sourceScopes = await this.loadScopes(client, [source]);
      const sourceScope = sourceScopes.get(source.id)!;
      if (!strictlyNarrows(sourceScope, dto.scope)) throw new DelegationConflictError();
      const scopeDigest = await client.query<{ value: string }>(`
        SELECT access_grant_scope_digest($1) AS value
      `, [source.id]);
      const sourceScopeDigest = scopeDigest.rows[0]!.value;
      const inserted = await client.query<{ id: string }>(`
        INSERT INTO delegations (
          organization_id, access_grant_id, source_grant_version, source_scope_digest,
          grantor_user_id, delegate_user_id, branch_id, treasury_unit_id, currency,
          document_type, method_category, amount_ceiling, amount_ceiling_currency,
          reason, valid_from, valid_to
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        RETURNING id
      `, [
        command.organizationId,
        dto.accessGrantId,
        source.version,
        sourceScopeDigest,
        actorUserId,
        dto.delegateUserId,
        dto.scope.branchId ?? null,
        dto.scope.treasuryUnitId ?? null,
        dto.scope.currency ?? null,
        dto.scope.documentType ?? null,
        dto.scope.methodCategory ?? null,
        dto.scope.amountCeiling?.amount ?? null,
        dto.scope.amountCeiling?.currency ?? null,
        dto.reason,
        dto.validFrom,
        dto.validTo,
      ]);
      const delegationId = inserted.rows[0]!.id;
      await this.audit(client, command, 'DELEGATION_CREATED', {
        delegationId,
        accessGrantId: dto.accessGrantId,
        delegateUserId: dto.delegateUserId,
      });
      return this.delegationView(client, command.organizationId, delegationId);
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
        [
          'createRole',
          'createAccessGrant',
          'createApprovalPolicy',
          'createDelegation',
        ].includes(command.operationId) ? 201 : 200,
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

  private async validateApprovalPolicyReferences(
    client: PoolClient,
    organizationId: string,
    dto: PreparedApprovalPolicy,
  ): Promise<string> {
    await this.validateUuidReferences(
      client,
      'branches',
      dto.scope?.branchId ? [dto.scope.branchId] : [],
      organizationId,
    );
    await this.validateUuidReferences(
      client,
      'treasury_units',
      dto.scope?.treasuryUnitId ? [dto.scope.treasuryUnitId] : [],
      organizationId,
    );
    const organization = await client.query<{ base_currency: string }>(`
      SELECT base_currency FROM organizations WHERE id = $1 FOR SHARE
    `, [organizationId]);
    if (!organization.rows[0]) throw new ReferenceError('RESOURCE_HIDDEN');
    const baseCurrency = organization.rows[0].base_currency;
    const roleIds = [...new Set(dto.steps.flatMap((step) => step.roleId ? [step.roleId] : []))];
    const approverIds = [...new Set(
      dto.steps.flatMap((step) => step.approverUserId ? [step.approverUserId] : []),
    )];
    if (roleIds.length) {
      const found = await client.query<{ state: string }>(`
        SELECT state FROM roles WHERE organization_id = $1 AND id = ANY($2::uuid[])
      `, [organizationId, roleIds]);
      if (found.rowCount !== roleIds.length) throw new ReferenceError('RESOURCE_HIDDEN');
      if (found.rows.some((row) => row.state !== 'ACTIVE')) {
        throw new ApprovalPolicyConflictError();
      }
    }
    if (approverIds.length) {
      const found = await client.query<{ state: string; account_active: boolean }>(`
        SELECT ur.state, EXISTS (
          SELECT 1 FROM identity_accounts ia
          WHERE ia.user_ref_id = ur.id AND ia.state = 'ACTIVE'
        ) AS account_active
        FROM user_refs ur
        WHERE ur.organization_id = $1 AND ur.id = ANY($2::uuid[])
      `, [organizationId, approverIds]);
      if (found.rowCount !== approverIds.length) throw new ReferenceError('RESOURCE_HIDDEN');
      if (found.rows.some((row) => row.state !== 'ACTIVE' || !row.account_active)) {
        throw new ApprovalPolicyConflictError();
      }
    }
    const approvalPermission = {
      PAYMENT: 'payment.approve',
      RECEIPT: 'receipt.approve',
      SETTLEMENT: 'settlement.confirm',
      TRANSFER: 'transfer.approve',
    }[dto.documentType];
    if (approvalPermission) {
      for (const step of dto.steps) {
        if (!await this.approvalSubjectEligible(
          client,
          organizationId,
          baseCurrency,
          dto,
          approvalPermission,
          step.roleId,
          step.approverUserId,
          step.approvalsRequired,
        )) throw new ApprovalPolicyConflictError();
      }
    }
    const currencyCodes = [...new Set([
      ...(dto.scope?.currency ? [dto.scope.currency] : []),
      ...(dto.scope?.minimumBaseAmount !== undefined || dto.scope?.maximumBaseAmount !== undefined
        ? [baseCurrency]
        : []),
    ])];
    if (!currencyCodes.length) return baseCurrency;
    const currency = await client.query<{ code: string; state: string; decimal_places: number }>(`
      SELECT code, state, decimal_places FROM currencies
      WHERE organization_id = $1 AND code = ANY($2::varchar[])
    `, [organizationId, currencyCodes]);
    if (currency.rowCount !== currencyCodes.length) throw new ReferenceError('RESOURCE_HIDDEN');
    if (currency.rows.some((row) => row.state !== 'ACTIVE')) throw new RangeError('RESOURCE_INACTIVE');
    const base = currency.rows.find((row) => row.code === baseCurrency);
    for (const amount of [dto.scope?.minimumBaseAmount, dto.scope?.maximumBaseAmount]) {
      if (amount && base && (amount.split('.')[1]?.length ?? 0) > base.decimal_places) {
        throw new RangeError('AMOUNT_SCALE_INVALID');
      }
    }
    return baseCurrency;
  }

  private async approvalSubjectEligible(
    client: PoolClient,
    organizationId: string,
    baseCurrency: string,
    dto: PreparedApprovalPolicy,
    permission: string,
    roleId?: string,
    approverUserId?: string,
    approvalsRequired = 1,
  ): Promise<boolean> {
    const result = await client.query<{ userId: string }>(`
      SELECT ag.id, ag.user_ref_id AS "userId"
      FROM access_grants ag
      JOIN roles r ON r.id = ag.role_id
        AND r.organization_id = ag.organization_id AND r.state = 'ACTIVE'
      JOIN role_permissions rp ON rp.role_id = r.id AND rp.permission = $2
      JOIN user_refs ur ON ur.id = ag.user_ref_id
        AND ur.organization_id = ag.organization_id AND ur.state = 'ACTIVE'
      WHERE ag.organization_id = $1
        AND ($3::uuid IS NULL OR ag.role_id = $3)
        AND ($4::uuid IS NULL OR ag.user_ref_id = $4)
        AND ag.state = 'ACTIVE'
        AND ag.valid_from <= now() AND (ag.valid_to IS NULL OR ag.valid_to > now())
        AND EXISTS (
          SELECT 1 FROM identity_accounts ia
          WHERE ia.user_ref_id = ag.user_ref_id AND ia.state = 'ACTIVE'
        )
        AND (
          ag.organization_wide
          OR (
            $5::boolean = false
            AND (NOT EXISTS (SELECT 1 FROM access_grant_branch_scopes s WHERE s.access_grant_id = ag.id)
              OR ($6::uuid IS NOT NULL AND EXISTS (SELECT 1 FROM access_grant_branch_scopes s
                WHERE s.access_grant_id = ag.id AND s.branch_id = $6)))
            AND (NOT EXISTS (SELECT 1 FROM access_grant_treasury_unit_scopes s WHERE s.access_grant_id = ag.id)
              OR ($7::uuid IS NOT NULL AND EXISTS (SELECT 1 FROM access_grant_treasury_unit_scopes s
                WHERE s.access_grant_id = ag.id AND s.treasury_unit_id = $7)))
            AND NOT EXISTS (SELECT 1 FROM access_grant_cashbox_scopes s WHERE s.access_grant_id = ag.id)
            AND NOT EXISTS (SELECT 1 FROM access_grant_bank_account_scopes s WHERE s.access_grant_id = ag.id)
            AND (NOT EXISTS (SELECT 1 FROM access_grant_document_type_scopes s WHERE s.access_grant_id = ag.id)
              OR EXISTS (SELECT 1 FROM access_grant_document_type_scopes s
                WHERE s.access_grant_id = ag.id AND s.document_type = $8))
            AND (NOT EXISTS (SELECT 1 FROM access_grant_method_category_scopes s WHERE s.access_grant_id = ag.id)
              OR ($9::varchar IS NOT NULL AND EXISTS (SELECT 1 FROM access_grant_method_category_scopes s
                WHERE s.access_grant_id = ag.id AND s.method_category = $9)))
            AND (NOT EXISTS (SELECT 1 FROM access_grant_currency_scopes s WHERE s.access_grant_id = ag.id)
              OR ($10::varchar IS NOT NULL AND EXISTS (SELECT 1 FROM access_grant_currency_scopes s
                WHERE s.access_grant_id = ag.id AND s.currency = $10)))
            AND (ag.amount_ceiling IS NULL OR (
              $11::numeric IS NOT NULL
              AND ag.amount_ceiling_currency = $12
              AND ag.amount_ceiling >= $11::numeric
            ))
          )
        )
      FOR SHARE OF ag, r, ur
    `, [
      organizationId,
      permission,
      roleId ?? null,
      approverUserId ?? null,
      dto.organizationWide,
      dto.scope?.branchId ?? null,
      dto.scope?.treasuryUnitId ?? null,
      dto.documentType,
      dto.scope?.methodCategory ?? null,
      dto.scope?.currency ?? null,
      dto.scope?.maximumBaseAmount ?? null,
      baseCurrency,
    ]);
    return new Set(result.rows.map(({ userId }) => userId)).size >= approvalsRequired;
  }

  private async validateDelegationReferences(
    client: PoolClient,
    organizationId: string,
    scope: DelegationScopeDto,
  ): Promise<void> {
    await this.validateUuidReferences(
      client,
      'branches',
      scope.branchId ? [scope.branchId] : [],
      organizationId,
    );
    await this.validateUuidReferences(
      client,
      'treasury_units',
      scope.treasuryUnitId ? [scope.treasuryUnitId] : [],
      organizationId,
    );
    const currencies = [...new Set([
      ...(scope.currency ? [scope.currency] : []),
      ...(scope.amountCeiling ? [scope.amountCeiling.currency] : []),
    ])];
    if (!currencies.length) return;
    const found = await client.query<{ code: string; state: string; decimal_places: number }>(`
      SELECT code, state, decimal_places FROM currencies
      WHERE organization_id = $1 AND code = ANY($2::varchar[])
    `, [organizationId, currencies]);
    if (found.rowCount !== currencies.length) throw new ReferenceError('RESOURCE_HIDDEN');
    if (found.rows.some((row) => row.state !== 'ACTIVE')) throw new RangeError('RESOURCE_INACTIVE');
    if (scope.amountCeiling) {
      const currency = found.rows.find((row) => row.code === scope.amountCeiling!.currency)!;
      if ((scope.amountCeiling.amount.split('.')[1]?.length ?? 0) > currency.decimal_places) {
        throw new RangeError('AMOUNT_SCALE_INVALID');
      }
    }
  }

  private async approvalPolicyView(
    client: PoolClient,
    organizationId: string,
    policyId: string,
  ): Promise<Record<string, unknown>> {
    const result = await client.query<PolicyViewRow>(`
      SELECT p.id, p.code, p.document_type AS "documentType",
             p.organization_wide AS "organizationWide", p.branch_id AS "branchId",
             b.name AS "branchLabel", p.treasury_unit_id AS "treasuryUnitId",
             tu.name AS "treasuryUnitLabel", p.currency,
             p.method_category AS "methodCategory",
             p.minimum_base_amount AS "minimumBaseAmount",
             p.maximum_base_amount AS "maximumBaseAmount",
             p.separation_rules AS "separationRules",
             p.aggregation_window_kind AS "aggregationWindowKind",
             p.aggregation_keys AS "aggregationKeys",
             p.aggregation_override_second_approval AS "aggregationOverrideSecondApproval",
             p.state, p.policy_version AS "policyVersion",
             p.created_at AS "createdAt", p.updated_at AS "updatedAt"
      FROM approval_policies p
      LEFT JOIN branches b ON b.id = p.branch_id AND b.organization_id = p.organization_id
      LEFT JOIN treasury_units tu ON tu.id = p.treasury_unit_id AND tu.organization_id = p.organization_id
      WHERE p.organization_id = $1 AND p.id = $2
    `, [organizationId, policyId]);
    const steps = await client.query<PolicyStepViewRow>(`
      SELECT s.id, s.approval_policy_id AS "policyId", s.step_order AS "order",
             s.required_role_id AS "roleId", r.name AS "roleLabel",
             s.named_approver_id AS "approverUserId", ur.display_name AS "approverLabel",
             s.approvals_required AS "approvalsRequired"
      FROM approval_steps s
      LEFT JOIN roles r ON r.id = s.required_role_id AND r.organization_id = s.organization_id
      LEFT JOIN user_refs ur ON ur.id = s.named_approver_id AND ur.organization_id = s.organization_id
      WHERE s.organization_id = $1 AND s.approval_policy_id = $2
      ORDER BY s.step_order
    `, [organizationId, policyId]);
    return policyView(result.rows[0]!, steps.rows);
  }

  private async delegationView(
    client: PoolClient,
    organizationId: string,
    delegationId: string,
  ): Promise<Record<string, unknown>> {
    const result = await client.query<DelegationViewRow>(`
      SELECT d.id, d.access_grant_id AS "accessGrantId",
             d.source_grant_version AS "sourceGrantVersion", r.name AS "sourceRoleLabel",
             d.grantor_user_id AS "grantorUserId", grantor.display_name AS "grantorLabel",
             d.delegate_user_id AS "delegateUserId", delegate.display_name AS "delegateLabel",
             d.branch_id AS "branchId", b.name AS "branchLabel",
             d.treasury_unit_id AS "treasuryUnitId", tu.name AS "treasuryUnitLabel",
             d.document_type AS "documentType", d.method_category AS "methodCategory",
             d.currency, d.amount_ceiling AS "amountCeiling",
             d.amount_ceiling_currency AS "amountCeilingCurrency", d.reason,
             d.valid_from AS "validFrom", d.valid_to AS "validTo",
             d.revoked_at AS "revokedAt", d.revoked_by_user_id AS "revokedByUserId",
             revoker.display_name AS "revokedByLabel", d.revocation_reason AS "revocationReason",
             d.created_at AS "createdAt"
      FROM delegations d
      JOIN access_grants ag ON ag.id = d.access_grant_id AND ag.organization_id = d.organization_id
      JOIN roles r ON r.id = ag.role_id AND r.organization_id = ag.organization_id
      JOIN user_refs grantor ON grantor.id = d.grantor_user_id AND grantor.organization_id = d.organization_id
      JOIN user_refs delegate ON delegate.id = d.delegate_user_id AND delegate.organization_id = d.organization_id
      LEFT JOIN user_refs revoker ON revoker.id = d.revoked_by_user_id AND revoker.organization_id = d.organization_id
      LEFT JOIN branches b ON b.id = d.branch_id AND b.organization_id = d.organization_id
      LEFT JOIN treasury_units tu ON tu.id = d.treasury_unit_id AND tu.organization_id = d.organization_id
      WHERE d.organization_id = $1 AND d.id = $2
    `, [organizationId, delegationId]);
    return delegationView(result.rows[0]!);
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
             ag.organization_wide AS "organizationWide",
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
        AND ag.organization_wide = $6
        AND ag.amount_ceiling IS NOT DISTINCT FROM $7::numeric
        AND ag.amount_ceiling_currency IS NOT DISTINCT FROM $8::varchar
      FOR UPDATE
    `, [
      organizationId,
      dto.userId,
      dto.roleId,
      dto.validFrom,
      dto.validTo,
      dto.organizationWide,
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
    rows: ScopeBearingGrantRow[],
    lock = false,
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
        ${lock ? 'FOR SHARE' : ''}
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
      organizationWide: row.organizationWide,
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
export class ApprovalPolicyConflictError extends Error {}
export class DelegationConflictError extends Error {}

interface PolicyScopeRow {
  organizationWide: boolean;
  branchId: string | null;
  treasuryUnitId: string | null;
  currency: string | null;
  methodCategory: string | null;
  minimumBaseAmount: string | null;
  maximumBaseAmount: string | null;
}

interface PolicyViewRow extends PolicyScopeRow {
  id: string;
  code: string;
  documentType: string;
  branchLabel: string | null;
  treasuryUnitLabel: string | null;
  separationRules: string[];
  aggregationWindowKind: string | null;
  aggregationKeys: string[] | null;
  aggregationOverrideSecondApproval: boolean | null;
  state: string;
  policyVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

interface PolicyStepViewRow {
  id: string;
  policyId: string;
  order: number;
  roleId: string | null;
  roleLabel: string | null;
  approverUserId: string | null;
  approverLabel: string | null;
  approvalsRequired: number;
}

interface DelegationViewRow {
  id: string;
  accessGrantId: string;
  sourceGrantVersion: number;
  sourceRoleLabel: string;
  grantorUserId: string;
  grantorLabel: string;
  delegateUserId: string;
  delegateLabel: string;
  branchId: string | null;
  branchLabel: string | null;
  treasuryUnitId: string | null;
  treasuryUnitLabel: string | null;
  documentType: string | null;
  methodCategory: string | null;
  currency: string | null;
  amountCeiling: string | null;
  amountCeilingCurrency: string | null;
  sourceAmountCeiling: string | null;
  sourceAmountCeilingCurrency: string | null;
  reason: string;
  validFrom: Date;
  validTo: Date;
  revokedAt: Date | null;
  revokedByUserId: string | null;
  revokedByLabel: string | null;
  revocationReason: string | null;
  createdAt: Date;
}

function policyGrantContains(
  source: GrantAuthorization,
  policy: PreparedApprovalPolicy,
  baseCurrency: string,
): boolean {
  if (source.organizationWide) return true;
  const scope = policy.scope;
  const dimensions: Array<[string[], string[]]> = [
    [source.scope.branchIds, scope?.branchId ? [scope.branchId] : []],
    [source.scope.treasuryUnitIds, scope?.treasuryUnitId ? [scope.treasuryUnitId] : []],
    [source.scope.cashboxIds, []],
    [source.scope.bankAccountIds, []],
    [source.scope.documentTypes, [policy.documentType]],
    [source.scope.methodCategories, scope?.methodCategory ? [scope.methodCategory] : []],
  ];
  if (dimensions.some(([allowed, required]) => (
    allowed.length > 0
    && (required.length === 0 || required.some((value) => !allowed.includes(value)))
  ))) return false;
  const requiredCurrencies = scope?.currency
    ? [scope.currency]
    : scope?.maximumBaseAmount ? [baseCurrency] : [];
  const allowedCurrencies = source.scope.currencies.length
    ? source.scope.currencies
    : source.scope.amountCeiling ? [source.scope.amountCeiling.currency] : [];
  if (
    allowedCurrencies.length > 0
    && (requiredCurrencies.length === 0
      || requiredCurrencies.some((value) => !allowedCurrencies.includes(value)))
  ) return false;
  if (!source.scope.amountCeiling) return true;
  return !!scope?.maximumBaseAmount
    && source.scope.amountCeiling.currency === baseCurrency
    && decimalCompare(scope.maximumBaseAmount, source.scope.amountCeiling.amount) <= 0;
}

function policyScope(dto: PreparedApprovalPolicy): PolicyScopeRow {
  return {
    organizationWide: dto.organizationWide,
    branchId: dto.scope?.branchId ?? null,
    treasuryUnitId: dto.scope?.treasuryUnitId ?? null,
    currency: dto.scope?.currency ?? null,
    methodCategory: dto.scope?.methodCategory ?? null,
    minimumBaseAmount: dto.scope?.minimumBaseAmount ?? null,
    maximumBaseAmount: dto.scope?.maximumBaseAmount ?? null,
  };
}

function ambiguousPolicyOverlap(left: PolicyScopeRow, right: PolicyScopeRow): boolean {
  if (!policyScopesOverlap(left, right)) return false;
  return !strictlyNarrowerPolicy(left, right) && !strictlyNarrowerPolicy(right, left);
}

function policyScopesOverlap(left: PolicyScopeRow, right: PolicyScopeRow): boolean {
  for (const key of ['branchId', 'treasuryUnitId', 'currency', 'methodCategory'] as const) {
    if (left[key] && right[key] && left[key] !== right[key]) return false;
  }
  const leftMin = left.minimumBaseAmount;
  const leftMax = left.maximumBaseAmount;
  const rightMin = right.minimumBaseAmount;
  const rightMax = right.maximumBaseAmount;
  return !(leftMax && rightMin && decimalCompare(leftMax, rightMin) < 0)
    && !(rightMax && leftMin && decimalCompare(rightMax, leftMin) < 0);
}

function strictlyNarrowerPolicy(candidate: PolicyScopeRow, source: PolicyScopeRow): boolean {
  let strict = false;
  for (const key of ['branchId', 'treasuryUnitId', 'currency', 'methodCategory'] as const) {
    if (source[key] && candidate[key] !== source[key]) return false;
    if (!source[key] && candidate[key]) strict = true;
  }
  if (source.minimumBaseAmount) {
    if (!candidate.minimumBaseAmount || decimalCompare(candidate.minimumBaseAmount, source.minimumBaseAmount) < 0) {
      return false;
    }
    strict ||= decimalCompare(candidate.minimumBaseAmount, source.minimumBaseAmount) > 0;
  } else if (candidate.minimumBaseAmount) strict = true;
  if (source.maximumBaseAmount) {
    if (!candidate.maximumBaseAmount || decimalCompare(candidate.maximumBaseAmount, source.maximumBaseAmount) > 0) {
      return false;
    }
    strict ||= decimalCompare(candidate.maximumBaseAmount, source.maximumBaseAmount) < 0;
  } else if (candidate.maximumBaseAmount) strict = true;
  return strict;
}

function strictlyNarrows(source: CanonicalGrantScope, target: DelegationScopeDto): boolean {
  let strict = false;
  const dimensions: Array<[string[], string | undefined]> = [
    [source.branchIds, target.branchId],
    [source.treasuryUnitIds, target.treasuryUnitId],
    [source.documentTypes, target.documentType],
    [source.methodCategories, target.methodCategory],
  ];
  for (const [allowed, selected] of dimensions) {
    if (!selected) continue;
    if (allowed.length && !allowed.includes(selected)) return false;
    if (!allowed.length || allowed.length > 1) strict = true;
  }
  const targetCurrency = target.currency ?? target.amountCeiling?.currency;
  if (targetCurrency) {
    const allowed = source.currencies.length
      ? source.currencies
      : source.amountCeiling ? [source.amountCeiling.currency] : [];
    if (allowed.length && !allowed.includes(targetCurrency)) return false;
    if (!allowed.length || allowed.length > 1) strict = true;
  }
  if (target.amountCeiling) {
    if (source.amountCeiling) {
      if (
        source.amountCeiling.currency !== target.amountCeiling.currency
        || decimalCompare(target.amountCeiling.amount, source.amountCeiling.amount) > 0
      ) return false;
      strict ||= decimalCompare(target.amountCeiling.amount, source.amountCeiling.amount) < 0;
    } else strict = true;
  }
  return strict;
}

function policyView(
  row: PolicyViewRow,
  steps: PolicyStepViewRow[],
): Record<string, unknown> & { id: string; createdAt: Date } {
  const scope = {
    ...(row.branchId ? {
      branchId: row.branchId,
      branch: { id: row.branchId, label: row.branchLabel! },
    } : {}),
    ...(row.treasuryUnitId ? {
      treasuryUnitId: row.treasuryUnitId,
      treasuryUnit: { id: row.treasuryUnitId, label: row.treasuryUnitLabel! },
    } : {}),
    ...(row.currency ? { currency: row.currency } : {}),
    ...(row.methodCategory ? { methodCategory: row.methodCategory } : {}),
    ...(row.minimumBaseAmount ? { minimumBaseAmount: cleanDecimal(row.minimumBaseAmount) } : {}),
    ...(row.maximumBaseAmount ? { maximumBaseAmount: cleanDecimal(row.maximumBaseAmount) } : {}),
  };
  return {
    id: row.id,
    code: row.code,
    documentType: row.documentType,
    organizationWide: row.organizationWide,
    ...(Object.keys(scope).length ? { scope } : {}),
    steps: steps.map((step) => ({
      id: step.id,
      order: step.order,
      ...(step.roleId ? {
        roleId: step.roleId,
        role: { id: step.roleId, label: step.roleLabel! },
      } : {
        approverUserId: step.approverUserId!,
        approver: { id: step.approverUserId!, label: step.approverLabel! },
      }),
      approvalsRequired: step.approvalsRequired,
    })),
    separationRules: row.separationRules,
    ...(row.aggregationWindowKind ? {
      paymentAggregation: {
        windowKind: row.aggregationWindowKind,
        keys: row.aggregationKeys!,
        overrideRequiresSecondApproval: row.aggregationOverrideSecondApproval!,
      },
    } : {}),
    state: row.state,
    policyVersion: row.policyVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function delegationView(
  row: DelegationViewRow,
): Record<string, unknown> & { id: string; createdAt: Date } {
  const scope = {
    ...(row.branchId ? {
      branchId: row.branchId,
      branch: { id: row.branchId, label: row.branchLabel! },
    } : {}),
    ...(row.treasuryUnitId ? {
      treasuryUnitId: row.treasuryUnitId,
      treasuryUnit: { id: row.treasuryUnitId, label: row.treasuryUnitLabel! },
    } : {}),
    ...(row.documentType ? { documentType: row.documentType } : {}),
    ...(row.methodCategory ? { methodCategory: row.methodCategory } : {}),
    ...(row.currency ? { currency: row.currency } : {}),
    ...(row.amountCeiling && row.amountCeilingCurrency ? {
      amountCeiling: {
        amount: cleanDecimal(row.amountCeiling),
        currency: row.amountCeilingCurrency,
      },
    } : {}),
  };
  const now = new Date();
  const state = row.revokedAt
    ? 'REVOKED'
    : row.validFrom > now
      ? 'SCHEDULED'
      : row.validTo <= now ? 'EXPIRED' : 'ACTIVE';
  return {
    id: row.id,
    accessGrantId: row.accessGrantId,
    accessGrant: { id: row.accessGrantId, label: row.sourceRoleLabel },
    sourceGrantVersion: row.sourceGrantVersion,
    grantorUserId: row.grantorUserId,
    grantor: { id: row.grantorUserId, label: row.grantorLabel },
    delegateUserId: row.delegateUserId,
    delegate: { id: row.delegateUserId, label: row.delegateLabel },
    scope,
    reason: row.reason,
    validFrom: row.validFrom,
    validTo: row.validTo,
    ...(row.revokedAt ? {
      revokedAt: row.revokedAt,
      revokedByUserId: row.revokedByUserId!,
      revokedBy: { id: row.revokedByUserId!, label: row.revokedByLabel! },
      revocationReason: row.revocationReason!,
    } : {}),
    state,
    createdAt: row.createdAt,
  };
}

function effectiveDelegationScope(
  source: CanonicalGrantScope,
  delegation: DelegationViewRow,
): CanonicalGrantScope {
  return {
    ...source,
    branchIds: delegation.branchId ? [delegation.branchId] : source.branchIds,
    treasuryUnitIds: delegation.treasuryUnitId
      ? [delegation.treasuryUnitId]
      : source.treasuryUnitIds,
    documentTypes: delegation.documentType
      ? [delegation.documentType]
      : source.documentTypes,
    methodCategories: delegation.methodCategory
      ? [delegation.methodCategory]
      : source.methodCategories,
    currencies: delegation.currency
      ? [delegation.currency]
      : delegation.amountCeilingCurrency
        ? [delegation.amountCeilingCurrency]
        : source.currencies,
    ...(delegation.amountCeiling && delegation.amountCeilingCurrency
      ? {
          amountCeiling: {
            amount: cleanDecimal(delegation.amountCeiling),
            currency: delegation.amountCeilingCurrency,
          },
        }
      : {}),
  };
}

function decimalCompare(left: string, right: string): number {
  const [leftInteger, leftFraction = ''] = left.split('.');
  const [rightInteger, rightFraction = ''] = right.split('.');
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const leftValue = BigInt(`${leftInteger}${leftFraction.padEnd(scale, '0')}`);
  const rightValue = BigInt(`${rightInteger}${rightFraction.padEnd(scale, '0')}`);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function cleanDecimal(value: string): string {
  return value.includes('.') ? value.replace(/0+$/u, '').replace(/\.$/u, '') : value;
}

function emptyScope(row: ScopeBearingGrantRow): CanonicalGrantScope {
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
