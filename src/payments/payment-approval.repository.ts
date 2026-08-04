import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type { DatabaseTransaction } from '../database/database.service';
import {
  approvalSteps,
  methodDefinitions,
  paymentApprovalActions,
  paymentApprovalAggregationParticipants,
  paymentApprovalAggregations,
  paymentApprovalSnapshotContexts,
  paymentApprovalSnapshots,
  paymentApprovalSnapshotSteps,
  paymentDocuments,
  paymentLines,
  paymentRequests,
  roles,
  treasuryUnits,
  userRefs,
} from '../database/schema';
import type { PaymentApprovalSnapshotView } from './payment.dto';

export interface ApprovalPayment extends Record<string, unknown> {
  id: string;
  businessNumber: string;
  businessDate: string;
  beneficiaryPartyId: string;
  state: string;
  version: number;
  branchId: string | null;
  treasuryUnitId: string;
  baseCurrency: string;
  totalBaseAmount: string;
  creatorUserId: string;
  requesterUserId: string | null;
  currentApprovalSnapshotId: string | null;
}

export interface ApprovalLine extends Record<string, unknown> {
  lineNumber: number;
  currency: string;
  methodCategory: string;
  requiresApproval: boolean;
  methodState: string;
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
  aggregationWindowKind: string | null;
  aggregationKeys: string[];
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

export interface CurrentApprovalStep extends ComposedApprovalStep, Record<string, unknown> {
  approvalsRecorded: number;
}

export interface AggregationParticipant extends Record<string, unknown> {
  paymentId: string;
  paymentNumber: string;
  paymentVersion: number;
  baseAmount: string;
  baseCurrency: string;
}

export interface AggregationEvidence {
  businessDate: string;
  keys: Array<'BENEFICIARY' | 'EXTERNAL_OBLIGATION'>;
  beneficiaryPartyId: string | null;
  externalObligationKey: string | null;
  participants: Array<AggregationParticipant & {
    versionBasis: 'SUBMITTED_CONTENT' | 'LIVE_AGGREGATE';
  }>;
}

@Injectable()
export class PaymentApprovalRepository {
  async lockPayment(
    transaction: DatabaseTransaction,
    organizationId: string,
    paymentId: string,
  ): Promise<ApprovalPayment | undefined> {
    const result = await transaction.execute<ApprovalPayment>(sql`
      SELECT pd.id, pd.business_number AS "businessNumber",
             pd.business_date AS "businessDate",
             pd.beneficiary_party_id AS "beneficiaryPartyId", pd.state,
             pd.version::int, COALESCE(pd.branch_id, tu.branch_id) AS "branchId",
             pd.treasury_unit_id AS "treasuryUnitId",
             pd.base_currency AS "baseCurrency",
             pd.total_base_amount::text AS "totalBaseAmount",
             pd.creator_user_id AS "creatorUserId",
             pr.requester_user_id AS "requesterUserId",
             pd.current_approval_snapshot_id AS "currentApprovalSnapshotId"
      FROM payment_documents pd
      JOIN treasury_units tu
        ON tu.organization_id = pd.organization_id AND tu.id = pd.treasury_unit_id
      LEFT JOIN payment_requests pr
        ON pr.organization_id = pd.organization_id AND pr.id = pd.payment_request_id
      WHERE pd.organization_id = ${organizationId} AND pd.id = ${paymentId}
      FOR UPDATE OF pd
    `);
    return result.rows[0];
  }

  async treasuryUnitBranch(
    transaction: DatabaseTransaction,
    organizationId: string,
    treasuryUnitId: string,
  ): Promise<string | null> {
    const [row] = await transaction.select({ branchId: treasuryUnits.branchId })
      .from(treasuryUnits)
      .where(and(
        eq(treasuryUnits.organizationId, organizationId),
        eq(treasuryUnits.id, treasuryUnitId),
      ))
      .limit(1);
    return row?.branchId ?? null;
  }

  async paymentRequester(
    transaction: DatabaseTransaction,
    organizationId: string,
    paymentId: string,
  ): Promise<string | null> {
    const [row] = await transaction.select({ requesterUserId: paymentRequests.requesterUserId })
      .from(paymentDocuments)
      .leftJoin(paymentRequests, and(
        eq(paymentRequests.organizationId, paymentDocuments.organizationId),
        eq(paymentRequests.id, paymentDocuments.paymentRequestId),
      ))
      .where(and(
        eq(paymentDocuments.organizationId, organizationId),
        eq(paymentDocuments.id, paymentId),
      ))
      .limit(1);
    return row?.requesterUserId ?? null;
  }

  async lines(
    transaction: DatabaseTransaction,
    organizationId: string,
    paymentId: string,
  ): Promise<ApprovalLine[]> {
    const result = await transaction.execute<ApprovalLine>(sql`
      SELECT pl.line_number AS "lineNumber", pl.currency,
             pl.method_category AS "methodCategory",
             pl.requires_approval AS "requiresApproval", md.state AS "methodState"
      FROM payment_lines pl
      JOIN method_definitions md
        ON md.organization_id = pl.organization_id AND md.id = pl.method_id
      WHERE pl.organization_id = ${organizationId} AND pl.payment_document_id = ${paymentId}
      ORDER BY pl.line_number
      FOR SHARE OF pl, md
    `);
    return result.rows;
  }

  async policies(
    transaction: DatabaseTransaction,
    organizationId: string,
    payment: ApprovalPayment,
    currency: string,
    methodCategory: string,
    amountBasis: string,
  ): Promise<ApprovalPolicy[]> {
    const policyResult = await transaction.execute<Omit<ApprovalPolicy, 'steps'>>(sql`
      SELECT id, code, name, branch_id AS "branchId",
             treasury_unit_id AS "treasuryUnitId", currency,
             method_category AS "methodCategory",
             minimum_base_amount::text AS "amountMinimum",
             maximum_base_amount::text AS "amountMaximum",
             aggregation_window_kind AS "aggregationWindowKind",
             aggregation_keys AS "aggregationKeys", policy_version AS version
      FROM approval_policies
      WHERE organization_id = ${organizationId}
        AND document_type = 'PAYMENT' AND state = 'ACTIVE'
        AND (branch_id IS NULL OR branch_id = ${payment.branchId})
        AND (treasury_unit_id IS NULL OR treasury_unit_id = ${payment.treasuryUnitId})
        AND (currency IS NULL OR currency = ${currency})
        AND (method_category IS NULL OR method_category = ${methodCategory})
        AND (minimum_base_amount IS NULL OR minimum_base_amount <= ${amountBasis}::numeric)
        AND (maximum_base_amount IS NULL OR maximum_base_amount >= ${amountBasis}::numeric)
      ORDER BY id, version
      FOR SHARE
    `);
    if (!policyResult.rows.length) return [];
    const policyIds = policyResult.rows.map(({ id }) => id);
    const stepRows = await transaction.select({
      id: approvalSteps.id,
      policyId: approvalSteps.approvalPolicyId,
      stepOrder: approvalSteps.stepOrder,
      roleId: approvalSteps.requiredRoleId,
      approverUserId: approvalSteps.namedApproverId,
      approvalsRequired: approvalSteps.approvalsRequired,
      separationRules: approvalSteps.separationRules,
    }).from(approvalSteps).where(and(
      eq(approvalSteps.organizationId, organizationId),
      inArray(approvalSteps.approvalPolicyId, policyIds),
    )).orderBy(asc(approvalSteps.approvalPolicyId), asc(approvalSteps.stepOrder));
    const roleIds = stepRows.flatMap(({ roleId }) => roleId ? [roleId] : []);
    const approverIds = stepRows.flatMap(({ approverUserId }) => approverUserId ? [approverUserId] : []);
    const roleRows = roleIds.length ? await transaction.select({
      id: roles.id,
      name: roles.name,
      state: roles.state,
    }).from(roles).where(and(eq(roles.organizationId, organizationId), inArray(roles.id, roleIds))) : [];
    const approverRows = approverIds.length ? await transaction.select({
      id: userRefs.id,
      name: userRefs.displayName,
      state: userRefs.state,
    }).from(userRefs).where(and(
      eq(userRefs.organizationId, organizationId),
      inArray(userRefs.id, approverIds),
    )) : [];
    const roleMap = new Map(roleRows.map((role) => [role.id, role]));
    const approverMap = new Map(approverRows.map((approver) => [approver.id, approver]));
    return policyResult.rows.map((policy) => ({
      ...policy,
      aggregationKeys: policy.aggregationKeys ?? [],
      steps: stepRows.filter(({ policyId }) => policyId === policy.id).map((step) => ({
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

  async lockAggregation(
    transaction: DatabaseTransaction,
    organizationId: string,
    businessDate: string,
    keys: string[],
    beneficiaryPartyId: string,
  ): Promise<void> {
    await transaction.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtext(${organizationId}),
        hashtext(${'PAYMENT_AGG:' + businessDate + ':' + [...keys].sort().join(',') + ':' + beneficiaryPartyId})
      )
    `);
  }

  async matchingParticipants(
    transaction: DatabaseTransaction,
    organizationId: string,
    businessDate: string,
    beneficiaryPartyId: string,
    excludedPaymentId: string,
  ): Promise<AggregationParticipant[]> {
    const result = await transaction.execute<AggregationParticipant>(sql`
      SELECT id AS "paymentId", business_number AS "paymentNumber", version::int AS "paymentVersion",
             total_base_amount::text AS "baseAmount", base_currency AS "baseCurrency"
      FROM payment_documents
      WHERE organization_id = ${organizationId}
        AND business_date = ${businessDate}
        AND beneficiary_party_id = ${beneficiaryPartyId}
        AND id <> ${excludedPaymentId}
        AND state IN (
          'SUBMITTED', 'APPROVAL_PENDING', 'APPROVED', 'SCHEDULED', 'EXECUTED',
          'ACCOUNTING_READY', 'ACCOUNTING_POSTED'
        )
      ORDER BY id
      FOR SHARE
    `);
    return result.rows;
  }

  async insertSnapshot(
    transaction: DatabaseTransaction,
    organizationId: string,
    payment: ApprovalPayment,
    snapshotId: string,
    documentVersion: number,
    amountBasis: string,
    evaluatedAt: Date,
    contexts: ApprovalContext[],
    steps: ComposedApprovalStep[],
    aggregation?: AggregationEvidence,
  ): Promise<void> {
    await transaction.insert(paymentApprovalSnapshots).values({
      id: snapshotId,
      organizationId,
      paymentDocumentId: payment.id,
      documentVersion,
      amountBasis,
      baseCurrency: payment.baseCurrency,
      evaluatedAt,
    });
    if (contexts.length) await transaction.insert(paymentApprovalSnapshotContexts).values(
      contexts.map((context) => ({
        organizationId,
        approvalSnapshotId: snapshotId,
        contextOrder: context.order,
        firstLineNumber: context.firstLineNumber,
        currency: context.currency,
        methodCategory: context.methodCategory,
        policyId: context.policy.id,
        policyCode: context.policy.code,
        policyName: context.policy.name,
        policyVersion: context.policy.version,
      })),
    );
    if (steps.length) await transaction.insert(paymentApprovalSnapshotSteps).values(
      steps.map((step) => ({
        id: step.id,
        organizationId,
        approvalSnapshotId: snapshotId,
        stepOrder: step.order,
        roleId: step.roleId,
        roleName: step.roleName,
        approverUserId: step.approverUserId,
        approverName: step.approverName,
        approvalsRequired: step.approvalsRequired,
        separationRules: step.separationRules,
        sourceContextOrders: step.sourceContextOrders,
        obligationKey: step.obligationKey,
      })),
    );
    if (aggregation) {
      await transaction.insert(paymentApprovalAggregations).values({
        organizationId,
        approvalSnapshotId: snapshotId,
        businessDate: aggregation.businessDate,
        aggregationKeys: aggregation.keys,
        beneficiaryPartyId: aggregation.beneficiaryPartyId,
        externalObligationKey: aggregation.externalObligationKey,
      });
      await transaction.insert(paymentApprovalAggregationParticipants).values(
        aggregation.participants.map((participant) => ({
          organizationId,
          approvalSnapshotId: snapshotId,
          paymentDocumentId: participant.paymentId,
          paymentNumber: participant.paymentNumber,
          versionBasis: participant.versionBasis,
          paymentVersion: participant.paymentVersion,
          baseAmount: participant.baseAmount,
          baseCurrency: participant.baseCurrency,
        })),
      );
    }
  }

  async completeSubmission(
    transaction: DatabaseTransaction,
    organizationId: string,
    paymentId: string,
    snapshotId: string,
    state: 'APPROVAL_PENDING' | 'APPROVED',
  ): Promise<void> {
    await transaction.update(paymentDocuments).set({
      state,
      workflowState: state,
      currentApprovalSnapshotId: snapshotId,
      version: sql`${paymentDocuments.version} + 1`,
      updatedAt: new Date(),
    }).where(and(
      eq(paymentDocuments.organizationId, organizationId),
      eq(paymentDocuments.id, paymentId),
    ));
  }

  async currentSteps(
    transaction: DatabaseTransaction,
    organizationId: string,
    snapshotId: string,
  ): Promise<CurrentApprovalStep[]> {
    const result = await transaction.execute<CurrentApprovalStep>(sql`
      SELECT s.id, s.step_order AS "order", s.role_id AS "roleId",
             s.role_name AS "roleName", s.approver_user_id AS "approverUserId",
             s.approver_name AS "approverName", s.approvals_required AS "approvalsRequired",
             s.separation_rules AS "separationRules",
             s.source_context_orders AS "sourceContextOrders", s.obligation_key AS "obligationKey",
             count(DISTINCT a.actor_user_id) FILTER (WHERE a.action = 'APPROVED')::int
               AS "approvalsRecorded"
      FROM payment_approval_snapshot_steps s
      LEFT JOIN payment_approval_actions a
        ON a.organization_id = s.organization_id
       AND a.approval_snapshot_id = s.approval_snapshot_id
       AND a.approval_snapshot_step_id = s.id
      WHERE s.organization_id = ${organizationId} AND s.approval_snapshot_id = ${snapshotId}
      GROUP BY s.id
      ORDER BY s.step_order
    `);
    return result.rows;
  }

  async insertAction(
    transaction: DatabaseTransaction,
    organizationId: string,
    snapshotId: string,
    step: CurrentApprovalStep | undefined,
    actorUserId: string,
    delegatedFromUserId: string | undefined,
    action: 'APPROVED' | 'REJECTED' | 'RETURNED',
    reason?: string,
  ): Promise<void> {
    await transaction.insert(paymentApprovalActions).values({
      organizationId,
      approvalSnapshotId: snapshotId,
      approvalSnapshotStepId: step?.id,
      stepOrder: step?.order,
      actorUserId,
      delegatedFromUserId,
      action,
      reason,
    });
  }

  async completeAction(
    transaction: DatabaseTransaction,
    organizationId: string,
    paymentId: string,
    state: 'APPROVAL_PENDING' | 'APPROVED' | 'REJECTED' | 'DRAFT',
  ): Promise<void> {
    await transaction.update(paymentDocuments).set({
      state,
      workflowState: state,
      ...(state === 'DRAFT' ? { currentApprovalSnapshotId: null } : {}),
      version: sql`${paymentDocuments.version} + 1`,
      updatedAt: new Date(),
    }).where(and(
      eq(paymentDocuments.organizationId, organizationId),
      eq(paymentDocuments.id, paymentId),
    ));
  }

  async aggregation(
    transaction: DatabaseTransaction,
    organizationId: string,
    snapshotId: string,
  ): Promise<AggregationEvidence | undefined> {
    const rows = await transaction.select().from(paymentApprovalAggregations).where(and(
      eq(paymentApprovalAggregations.organizationId, organizationId),
      eq(paymentApprovalAggregations.approvalSnapshotId, snapshotId),
    )).limit(1);
    const row = rows[0];
    if (!row) return undefined;
    const participants = await transaction.select({
      paymentId: paymentApprovalAggregationParticipants.paymentDocumentId,
      paymentNumber: paymentApprovalAggregationParticipants.paymentNumber,
      paymentVersion: paymentApprovalAggregationParticipants.paymentVersion,
      baseAmount: paymentApprovalAggregationParticipants.baseAmount,
      baseCurrency: paymentApprovalAggregationParticipants.baseCurrency,
      versionBasis: paymentApprovalAggregationParticipants.versionBasis,
    }).from(paymentApprovalAggregationParticipants).where(and(
      eq(paymentApprovalAggregationParticipants.organizationId, organizationId),
      eq(paymentApprovalAggregationParticipants.approvalSnapshotId, snapshotId),
    )).orderBy(asc(paymentApprovalAggregationParticipants.paymentDocumentId));
    return {
      businessDate: row.businessDate,
      keys: row.aggregationKeys as AggregationEvidence['keys'],
      beneficiaryPartyId: row.beneficiaryPartyId,
      externalObligationKey: row.externalObligationKey,
      participants: participants as AggregationEvidence['participants'],
    };
  }

  async snapshotViewsForPayments(
    transaction: DatabaseTransaction,
    organizationId: string,
    paymentIds: string[],
  ): Promise<Map<string, PaymentApprovalSnapshotView>> {
    if (!paymentIds.length) return new Map();
    const links = await transaction.select({
      paymentId: paymentDocuments.id,
      snapshotId: paymentDocuments.currentApprovalSnapshotId,
    }).from(paymentDocuments).where(and(
      eq(paymentDocuments.organizationId, organizationId),
      inArray(paymentDocuments.id, paymentIds),
    ));
    const snapshotIds = links.flatMap(({ snapshotId }) => snapshotId ? [snapshotId] : []);
    if (!snapshotIds.length) return new Map();
    const snapshots = await transaction.select().from(paymentApprovalSnapshots).where(and(
        eq(paymentApprovalSnapshots.organizationId, organizationId),
        inArray(paymentApprovalSnapshots.id, snapshotIds),
      ));
    const contexts = await transaction.select().from(paymentApprovalSnapshotContexts).where(and(
        eq(paymentApprovalSnapshotContexts.organizationId, organizationId),
        inArray(paymentApprovalSnapshotContexts.approvalSnapshotId, snapshotIds),
      )).orderBy(asc(paymentApprovalSnapshotContexts.contextOrder));
    const steps = await transaction.select().from(paymentApprovalSnapshotSteps).where(and(
        eq(paymentApprovalSnapshotSteps.organizationId, organizationId),
        inArray(paymentApprovalSnapshotSteps.approvalSnapshotId, snapshotIds),
      )).orderBy(asc(paymentApprovalSnapshotSteps.stepOrder));
    const actions = await transaction.select().from(paymentApprovalActions).where(and(
        eq(paymentApprovalActions.organizationId, organizationId),
        inArray(paymentApprovalActions.approvalSnapshotId, snapshotIds),
      )).orderBy(asc(paymentApprovalActions.actedAt), asc(paymentApprovalActions.id));
    const aggregations = await transaction.select().from(paymentApprovalAggregations).where(and(
        eq(paymentApprovalAggregations.organizationId, organizationId),
        inArray(paymentApprovalAggregations.approvalSnapshotId, snapshotIds),
      ));
    const participants = await transaction.select().from(paymentApprovalAggregationParticipants).where(and(
        eq(paymentApprovalAggregationParticipants.organizationId, organizationId),
        inArray(paymentApprovalAggregationParticipants.approvalSnapshotId, snapshotIds),
      )).orderBy(asc(paymentApprovalAggregationParticipants.paymentDocumentId));
    const actorIds = [...new Set(actions.flatMap(({ actorUserId, delegatedFromUserId }) =>
      delegatedFromUserId ? [actorUserId, delegatedFromUserId] : [actorUserId]))];
    const actorRows = actorIds.length ? await transaction.select({
      id: userRefs.id,
      label: userRefs.displayName,
    }).from(userRefs).where(and(eq(userRefs.organizationId, organizationId), inArray(userRefs.id, actorIds))) : [];
    const actorMap = new Map(actorRows.map((actor) => [actor.id, actor.label]));
    const bySnapshot = new Map<string, PaymentApprovalSnapshotView>();
    for (const snapshot of snapshots) {
      const snapshotActions = actions.filter(({ approvalSnapshotId }) => approvalSnapshotId === snapshot.id);
      const snapshotSteps = steps.filter(({ approvalSnapshotId }) => approvalSnapshotId === snapshot.id);
      let currentAssigned = false;
      const actionViews = snapshotActions.map((action) => compact({
        id: action.id,
        approvalSnapshotId: action.approvalSnapshotId,
        approvalSnapshotStepId: action.approvalSnapshotStepId ?? undefined,
        stepOrder: action.stepOrder ?? undefined,
        actorUserId: action.actorUserId,
        actor: { id: action.actorUserId, label: actorMap.get(action.actorUserId)! },
        delegatedFromUserId: action.delegatedFromUserId ?? undefined,
        delegatedFrom: action.delegatedFromUserId
          ? { id: action.delegatedFromUserId, label: actorMap.get(action.delegatedFromUserId)! }
          : undefined,
        action: action.action as 'APPROVED' | 'REJECTED' | 'RETURNED',
        reason: action.reason ?? undefined,
        actedAt: action.actedAt.toISOString(),
      }));
      const stepViews = snapshotSteps.map((step) => {
        const ownActions = snapshotActions.filter(({ approvalSnapshotStepId }) =>
          approvalSnapshotStepId === step.id);
        const approvalsRecorded = new Set(ownActions.filter(({ action }) =>
          action === 'APPROVED').map(({ actorUserId }) => actorUserId)).size;
        let state: 'WAITING' | 'CURRENT' | 'APPROVED' | 'REJECTED' | 'RETURNED';
        if (ownActions.some(({ action }) => action === 'RETURNED')) state = 'RETURNED';
        else if (ownActions.some(({ action }) => action === 'REJECTED')) state = 'REJECTED';
        else if (approvalsRecorded >= step.approvalsRequired) state = 'APPROVED';
        else if (!currentAssigned) {
          currentAssigned = true;
          state = 'CURRENT';
        } else state = 'WAITING';
        return compact({
          order: step.stepOrder,
          roleId: step.roleId ?? undefined,
          role: step.roleId ? { id: step.roleId, label: step.roleName! } : undefined,
          approverUserId: step.approverUserId ?? undefined,
          approver: step.approverUserId
            ? { id: step.approverUserId, label: step.approverName! }
            : undefined,
          approvalsRequired: step.approvalsRequired,
          approvalsRecorded,
          separationRules: step.separationRules,
          sourceContextOrders: step.sourceContextOrders,
          state,
        });
      });
      const aggregation = aggregations.find(({ approvalSnapshotId }) => approvalSnapshotId === snapshot.id);
      const hasReturned = snapshotActions.some(({ action }) => action === 'RETURNED');
      const hasRejected = snapshotActions.some(({ action }) => action === 'REJECTED');
      const snapshotState = hasReturned ? 'RETURNED'
        : hasRejected ? 'REJECTED'
          : stepViews.every(({ state }) => state === 'APPROVED') ? 'APPROVED' : 'PENDING';
      bySnapshot.set(snapshot.id, compact({
        id: snapshot.id,
        documentVersion: snapshot.documentVersion,
        amountBasis: { amount: snapshot.amountBasis, currency: snapshot.baseCurrency },
        evaluatedAt: snapshot.evaluatedAt.toISOString(),
        policyContexts: contexts.filter(({ approvalSnapshotId }) =>
          approvalSnapshotId === snapshot.id).map((context) => ({
          order: context.contextOrder,
          firstLineNumber: context.firstLineNumber,
          currency: context.currency,
          methodCategory: context.methodCategory,
          policyId: context.policyId,
          policy: { id: context.policyId, label: context.policyName },
          policyVersion: context.policyVersion,
        })),
        steps: stepViews,
        actions: actionViews,
        paymentAggregation: aggregation ? {
          businessDate: aggregation.businessDate,
          keys: aggregation.aggregationKeys as Array<'BENEFICIARY' | 'EXTERNAL_OBLIGATION'>,
          participants: participants.filter(({ approvalSnapshotId }) =>
            approvalSnapshotId === snapshot.id).map((participant) => ({
            paymentId: participant.paymentDocumentId,
            payment: { id: participant.paymentDocumentId, label: participant.paymentNumber },
            versionBasis: participant.versionBasis as 'SUBMITTED_CONTENT' | 'LIVE_AGGREGATE',
            paymentVersion: participant.paymentVersion,
            baseAmount: { amount: participant.baseAmount, currency: participant.baseCurrency },
          })),
        } : undefined,
        state: snapshotState,
      }) as PaymentApprovalSnapshotView);
    }
    return new Map(links.flatMap(({ paymentId, snapshotId }) => {
      const view = snapshotId ? bySnapshot.get(snapshotId) : undefined;
      return view ? [[paymentId, view] as const] : [];
    }));
  }
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)) as T;
}
