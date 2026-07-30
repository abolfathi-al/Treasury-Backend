import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';

import { ReceiptView } from './receipt.dto';
import { storedAuthoritySql, storedScopeSql } from './receipt.repository';

export interface ReceiptApprovalAuthority {
  grantUserId: string;
  delegatedFromUserId: string | null;
}

export interface ApprovalReceipt {
  id: string;
  state: string;
  version: number;
  branchId: string | null;
  treasuryUnitId: string;
  baseCurrency: string;
  totalBaseAmount: string;
  creatorUserId: string;
  currentApprovalSnapshotId: string | null;
}

export interface ApprovalLine {
  lineNumber: number;
  currency: string;
  baseCurrency: string;
  methodCategory: string;
  requiresApproval: boolean;
  methodState: string;
  rateSource: string;
  rateRecordId: string | null;
  rateAt: Date;
  exchangeRate: string;
  baseAmount: string;
}

export interface ApprovalPolicyStep {
  id: string;
  stepOrder: number;
  roleId: string | null;
  roleName: string | null;
  roleState: string | null;
  approverUserId: string | null;
  approverName: string | null;
  approverState: string | null;
  approvalsRequired: number;
  separationRules: string[];
}

export interface ApprovalPolicy {
  id: string;
  code: string;
  name: string;
  branchId: string | null;
  treasuryUnitId: string | null;
  currency: string | null;
  methodCategory: string | null;
  amountMinimum: string | null;
  amountMaximum: string | null;
  version: number;
  steps: ApprovalPolicyStep[];
}

export interface ApprovalContext {
  order: number;
  firstLineNumber: number;
  currency: string;
  methodCategory: string;
  policy: ApprovalPolicy;
}

export interface ComposedApprovalStep {
  id: string;
  order: number;
  roleId: string | null;
  roleName: string | null;
  approverUserId: string | null;
  approverName: string | null;
  approvalsRequired: number;
  separationRules: string[];
  sourceContextOrders: number[];
  obligationKey: string;
}

export interface CurrentApprovalStep extends ComposedApprovalStep {
  approvalsRecorded: number;
}

interface IdempotencyEnvelope {
  response: ReceiptView;
}

@Injectable()
export class ReceiptApprovalRepository {
  async lockReceipt(
    client: PoolClient,
    organizationId: string,
    receiptId: string,
  ): Promise<ApprovalReceipt | undefined> {
    const result = await client.query<{
      id: string;
      state: string;
      version: number;
      branchId: string | null;
      treasuryUnitId: string;
      baseCurrency: string;
      totalBaseAmount: string;
      creatorUserId: string;
      currentApprovalSnapshotId: string | null;
    }>(`
      SELECT id, state, version::int, branch_id AS "branchId",
             treasury_unit_id AS "treasuryUnitId", base_currency AS "baseCurrency",
             total_base_amount::text AS "totalBaseAmount",
             creator_user_id AS "creatorUserId",
             current_approval_snapshot_id AS "currentApprovalSnapshotId"
      FROM receipt_documents
      WHERE organization_id = $1 AND id = $2
      FOR UPDATE
    `, [organizationId, receiptId]);
    return result.rows[0];
  }

  async scopeAllowed(
    client: PoolClient,
    organizationId: string,
    actorUserId: string,
    receiptId: string,
    permission: 'receipt.submit' | 'receipt.approve' | 'receipt.reject',
  ): Promise<boolean> {
    const result = await client.query<{ allowed: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM receipt_documents rd
        WHERE rd.organization_id = $1 AND rd.id = $3
          AND ${storedScopeSql(permission)}
      ) AS allowed
    `, [organizationId, actorUserId, receiptId]);
    return result.rows[0]!.allowed;
  }

  async roleEligible(
    client: PoolClient,
    organizationId: string,
    actorUserId: string,
    receiptId: string,
    permission: 'receipt.approve' | 'receipt.reject',
    roleId: string,
  ): Promise<boolean> {
    const result = await client.query<{ allowed: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM receipt_documents rd
        WHERE rd.organization_id = $1 AND rd.id = $3
          AND ${storedScopeSql(permission, 'AND ag.role_id = $4')}
      ) AS allowed
    `, [organizationId, actorUserId, receiptId, roleId]);
    return result.rows[0]!.allowed;
  }

  async approvalAuthority(
    client: PoolClient,
    organizationId: string,
    actorUserId: string,
    receiptId: string,
    permission: 'receipt.approve' | 'receipt.reject',
    roleId?: string,
    requiredApproverUserId?: string | null,
  ): Promise<ReceiptApprovalAuthority | undefined> {
    const parameters: Array<string> = [organizationId, actorUserId, receiptId];
    let authorityPredicate = '';
    if (roleId) {
      parameters.push(roleId);
      authorityPredicate += ` AND ag.role_id = $${parameters.length}`;
    }
    if (requiredApproverUserId) {
      parameters.push(requiredApproverUserId);
      authorityPredicate += ` AND ag.user_ref_id = $${parameters.length}`;
    }
    const projection = `ag.user_ref_id AS "grantUserId",
      CASE WHEN authority.delegation_id IS NULL
        THEN NULL ELSE ag.user_ref_id END AS "delegatedFromUserId"`;
    const result = await client.query<ReceiptApprovalAuthority>(`
      SELECT DISTINCT receipt_authority.*
      FROM receipt_documents rd
      JOIN LATERAL (
        ${storedAuthoritySql(permission, authorityPredicate, projection)}
      ) receipt_authority ON true
      WHERE rd.organization_id = $1 AND rd.id = $3
    `, parameters);
    const direct = result.rows.find(({ delegatedFromUserId }) => delegatedFromUserId === null);
    if (direct) return direct;
    const grantors = new Set(result.rows.map(({ delegatedFromUserId }) => delegatedFromUserId));
    return grantors.size === 1 ? result.rows[0] : undefined;
  }

  async lines(
    client: PoolClient,
    organizationId: string,
    receiptId: string,
  ): Promise<ApprovalLine[]> {
    const result = await client.query<ApprovalLine>(`
      SELECT rl.line_number AS "lineNumber", rl.currency,
             rl.base_currency AS "baseCurrency",
             rl.method_category AS "methodCategory",
             rl.requires_approval AS "requiresApproval",
             md.state AS "methodState", rl.rate_source AS "rateSource",
             rl.rate_record_id AS "rateRecordId", rl.rate_at AS "rateAt",
             rl.exchange_rate::text AS "exchangeRate",
             rl.base_amount::text AS "baseAmount"
      FROM receipt_lines rl
      JOIN method_definitions md
        ON md.organization_id = rl.organization_id AND md.id = rl.method_id
      WHERE rl.organization_id = $1 AND rl.receipt_document_id = $2
      ORDER BY rl.line_number
      FOR SHARE OF rl, md
    `, [organizationId, receiptId]);
    return result.rows;
  }

  async policies(
    client: PoolClient,
    organizationId: string,
    receipt: ApprovalReceipt,
    currency: string,
    methodCategory: string,
  ): Promise<ApprovalPolicy[]> {
    const policies = await client.query<Omit<ApprovalPolicy, 'steps'>>(`
      SELECT id, code, name, branch_id AS "branchId",
             treasury_unit_id AS "treasuryUnitId", currency,
             method_category AS "methodCategory",
             minimum_base_amount::text AS "amountMinimum",
             maximum_base_amount::text AS "amountMaximum",
             policy_version AS version
      FROM approval_policies
      WHERE organization_id = $1 AND document_type = 'RECEIPT' AND state = 'ACTIVE'
        AND (branch_id IS NULL OR branch_id = $2)
        AND (treasury_unit_id IS NULL OR treasury_unit_id = $3)
        AND (currency IS NULL OR currency = $4)
        AND (method_category IS NULL OR method_category = $5)
        AND (minimum_base_amount IS NULL OR minimum_base_amount <= $6::numeric)
        AND (maximum_base_amount IS NULL OR maximum_base_amount >= $6::numeric)
      ORDER BY id, version
      FOR SHARE
    `, [
      organizationId,
      receipt.branchId,
      receipt.treasuryUnitId,
      currency,
      methodCategory,
      receipt.totalBaseAmount,
    ]);
    if (policies.rows.length === 0) return [];
    const steps = await client.query<ApprovalPolicyStep & { policyId: string }>(`
      SELECT s.id, s.approval_policy_id AS "policyId", s.step_order AS "stepOrder",
             s.required_role_id AS "roleId", NULL::text AS "roleName",
             NULL::text AS "roleState",
             s.named_approver_id AS "approverUserId",
             NULL::text AS "approverName", NULL::text AS "approverState",
             s.approvals_required AS "approvalsRequired",
             s.separation_rules AS "separationRules"
      FROM approval_steps s
      WHERE s.organization_id = $1 AND s.approval_policy_id = ANY($2::uuid[])
      ORDER BY s.approval_policy_id, s.step_order
      FOR SHARE
    `, [organizationId, policies.rows.map(({ id }) => id)]);
    const roleIds = steps.rows.flatMap(({ roleId }) => roleId ? [roleId] : []);
    const roles = roleIds.length === 0 ? [] : (await client.query<{
      id: string;
      name: string;
      state: string;
    }>(`
      SELECT id, name, state FROM roles
      WHERE organization_id = $1 AND id = ANY($2::uuid[])
      FOR SHARE
    `, [organizationId, roleIds])).rows;
    const approverIds = steps.rows.flatMap(
      ({ approverUserId }) => approverUserId ? [approverUserId] : [],
    );
    const approvers = approverIds.length === 0 ? [] : (await client.query<{
      id: string;
      name: string;
      state: string;
    }>(`
      SELECT id, display_name AS name, state FROM user_refs
      WHERE organization_id = $1 AND id = ANY($2::uuid[])
      FOR SHARE
    `, [organizationId, approverIds])).rows;
    const roleMap = new Map(roles.map((role) => [role.id, role]));
    const approverMap = new Map(approvers.map((approver) => [approver.id, approver]));
    return policies.rows.map((policy) => ({
      ...policy,
      steps: steps.rows.filter((step) =>
        step.policyId === policy.id).map((step) => ({
          ...step,
          roleName: step.roleId ? roleMap.get(step.roleId)?.name ?? null : null,
          roleState: step.roleId ? roleMap.get(step.roleId)?.state ?? null : null,
          approverName: step.approverUserId
            ? approverMap.get(step.approverUserId)?.name ?? null
            : null,
          approverState: step.approverUserId
            ? approverMap.get(step.approverUserId)?.state ?? null
            : null,
        })),
    }));
  }

  async insertSnapshot(
    client: PoolClient,
    organizationId: string,
    receipt: ApprovalReceipt,
    snapshotId: string,
    documentVersion: number,
    evaluatedAt: Date,
    contexts: ApprovalContext[],
    steps: ComposedApprovalStep[],
  ): Promise<void> {
    await client.query(`
      INSERT INTO receipt_approval_snapshots (
        id, organization_id, receipt_document_id, document_version,
        amount_basis, base_currency, evaluated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [
      snapshotId,
      organizationId,
      receipt.id,
      documentVersion,
      receipt.totalBaseAmount,
      receipt.baseCurrency,
      evaluatedAt,
    ]);
    for (const context of contexts) {
      await client.query(`
        INSERT INTO receipt_approval_snapshot_contexts (
          organization_id, approval_snapshot_id, context_order, first_line_number,
          currency, method_category, policy_id, policy_code, policy_name, policy_version
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      `, [
        organizationId,
        snapshotId,
        context.order,
        context.firstLineNumber,
        context.currency,
        context.methodCategory,
        context.policy.id,
        context.policy.code,
        context.policy.name,
        context.policy.version,
      ]);
    }
    for (const step of steps) {
      await client.query(`
        INSERT INTO receipt_approval_snapshot_steps (
          id, organization_id, approval_snapshot_id, step_order,
          role_id, role_name, approver_user_id, approver_name,
          approvals_required, separation_rules, source_context_orders, obligation_key
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `, [
        step.id,
        organizationId,
        snapshotId,
        step.order,
        step.roleId,
        step.roleName,
        step.approverUserId,
        step.approverName,
        step.approvalsRequired,
        step.separationRules,
        step.sourceContextOrders,
        step.obligationKey,
      ]);
    }
  }

  async completeSubmission(
    client: PoolClient,
    organizationId: string,
    receiptId: string,
    snapshotId: string,
    state: 'APPROVAL_PENDING' | 'APPROVED',
  ): Promise<void> {
    await client.query(`
      UPDATE receipt_documents
      SET state = $3, workflow_state = $3, current_approval_snapshot_id = $4,
          version = version + 1, updated_at = now()
      WHERE organization_id = $1 AND id = $2
    `, [organizationId, receiptId, state, snapshotId]);
  }

  async currentSteps(
    client: PoolClient,
    organizationId: string,
    snapshotId: string,
  ): Promise<CurrentApprovalStep[]> {
    const result = await client.query<CurrentApprovalStep>(`
      SELECT s.id, s.step_order AS "order", s.role_id AS "roleId",
             s.role_name AS "roleName", s.approver_user_id AS "approverUserId",
             s.approver_name AS "approverName",
             s.approvals_required AS "approvalsRequired",
             s.separation_rules AS "separationRules",
             s.source_context_orders AS "sourceContextOrders",
             s.obligation_key AS "obligationKey",
             count(DISTINCT a.actor_user_id) FILTER (WHERE a.action = 'APPROVED')::int
               AS "approvalsRecorded"
      FROM receipt_approval_snapshot_steps s
      LEFT JOIN receipt_approval_actions a
        ON a.organization_id = s.organization_id
          AND a.approval_snapshot_id = s.approval_snapshot_id
          AND a.approval_snapshot_step_id = s.id
      WHERE s.organization_id = $1 AND s.approval_snapshot_id = $2
      GROUP BY s.id
      ORDER BY s.step_order
    `, [organizationId, snapshotId]);
    return result.rows;
  }

  async insertAction(
    client: PoolClient,
    organizationId: string,
    snapshotId: string,
    step: CurrentApprovalStep | undefined,
    actorUserId: string,
    delegatedFromUserId: string | null,
    action: 'APPROVED' | 'REJECTED' | 'RETURNED',
    reason: string | undefined,
  ): Promise<void> {
    await client.query(`
      INSERT INTO receipt_approval_actions (
        organization_id, approval_snapshot_id, approval_snapshot_step_id,
        step_order, actor_user_id, delegated_from_user_id, action, reason
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [
      organizationId,
      snapshotId,
      step?.id ?? null,
      step?.order ?? null,
      actorUserId,
      delegatedFromUserId,
      action,
      reason ?? null,
    ]);
  }

  async completeAction(
    client: PoolClient,
    organizationId: string,
    receiptId: string,
    state: 'APPROVAL_PENDING' | 'APPROVED' | 'REJECTED' | 'DRAFT',
  ): Promise<void> {
    await client.query(`
      UPDATE receipt_documents
      SET state = $3::varchar, workflow_state = $3::varchar,
          current_approval_snapshot_id = CASE WHEN $3::varchar = 'DRAFT'
            THEN NULL ELSE current_approval_snapshot_id END,
          version = version + 1, updated_at = now()
      WHERE organization_id = $1 AND id = $2
    `, [organizationId, receiptId, state]);
  }

  async lockIdempotency(
    client: PoolClient,
    organizationId: string,
    scope: string,
    key: string,
  ): Promise<{ requestDigest: string; response: ReceiptView | null } | undefined> {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [organizationId, `${scope}:${key}`],
    );
    const result = await client.query<{
      requestDigest: string;
      responseBody: IdempotencyEnvelope | null;
    }>(`
      SELECT request_digest AS "requestDigest", response_body AS "responseBody"
      FROM idempotency_records
      WHERE organization_id = $1 AND scope = $2 AND idempotency_key = $3
    `, [organizationId, scope, key]);
    const row = result.rows[0];
    return row && {
      requestDigest: row.requestDigest,
      response: row.responseBody?.response ?? null,
    };
  }

  async startIdempotency(
    client: PoolClient,
    organizationId: string,
    scope: string,
    key: string,
    requestDigest: string,
  ): Promise<void> {
    await client.query(`
      INSERT INTO idempotency_records (
        organization_id, scope, idempotency_key, request_digest
      ) VALUES ($1,$2,$3,$4)
    `, [organizationId, scope, key, requestDigest]);
  }

  async finishIdempotency(
    client: PoolClient,
    organizationId: string,
    scope: string,
    key: string,
    response: ReceiptView,
  ): Promise<void> {
    await client.query(`
      UPDATE idempotency_records
      SET response_status = 200, response_body = $1
      WHERE organization_id = $2 AND scope = $3 AND idempotency_key = $4
    `, [{ response }, organizationId, scope, key]);
  }
}
