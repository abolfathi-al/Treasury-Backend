import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import {
  AccessAuthorizationService,
  type PaymentAuthority,
} from '../access-control/access-authorization.service';
import type { PaymentAuthorizationContext } from '../access-control/access-authorization.repository';
import { commandDigest } from '../common/http';
import { TreasuryProblem } from '../common/problem';
import { DatabaseService, type DatabaseTransaction } from '../database/database.service';
import {
  AggregationEvidence,
  ApprovalContext,
  ApprovalPayment,
  ApprovalPolicy,
  ComposedApprovalStep,
  PaymentApprovalRepository,
} from './payment-approval.repository';
import {
  PaymentApprovalAction,
  PaymentApprovalActionDto,
  PaymentView,
} from './payment.dto';
import { PaymentRepository } from './payment.repository';
import { PaymentService } from './payment.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

@Injectable()
export class PaymentApprovalService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PaymentApprovalRepository)
    private readonly repository: PaymentApprovalRepository,
    @Inject(PaymentRepository) private readonly payments: PaymentRepository,
    @Inject(PaymentService) private readonly paymentService: PaymentService,
    @Inject(AccessAuthorizationService)
    private readonly authorization: AccessAuthorizationService,
  ) {}

  submit(
    organizationId: string,
    actorUserId: string,
    paymentId: string,
    rawKey: string,
    rawIfMatch: string,
    requestId: string,
  ): Promise<PaymentView> {
    this.uuid(paymentId);
    this.requiredRequestId(requestId);
    const key = this.key(rawKey);
    const expectedVersion = this.ifMatch(rawIfMatch);
    const digest = commandDigest('submitPayment', {
      actorUserId,
      paymentId,
      ifMatch: rawIfMatch,
    });
    return this.map(() => this.database.db.transaction(async (transaction) => {
      const scope = `submitPayment:${actorUserId}:${paymentId}`;
      await this.payments.acquireIdempotencyLock(transaction, organizationId, scope, key);
      const replay = await this.payments.findIdempotency<PaymentView>(
        transaction, organizationId, scope, key,
      );
      if (replay) {
        if (replay.requestDigest !== digest || !replay.response) {
          throw new Error('IDEMPOTENCY_CONFLICT');
        }
        await this.assertAuthorized(
          transaction, organizationId, actorUserId, replay.response, 'payment.submit',
        );
        return replay.response;
      }
      await this.payments.insertIdempotency(transaction, organizationId, scope, key, digest);
      const payment = await this.repository.lockPayment(transaction, organizationId, paymentId);
      if (!payment) throw new Error('RESOURCE_HIDDEN');
      if (payment.state !== 'DRAFT') throw new Error('STATE_CONFLICT');
      if (payment.version !== expectedVersion) throw new Error('STALE_VERSION');
      const view = await this.baseView(transaction, organizationId, paymentId);
      await this.assertAuthorized(
        transaction, organizationId, actorUserId, view, 'payment.submit', undefined,
        payment.branchId,
      );
      await this.paymentService.revalidateSubmission(transaction, organizationId, view);
      const lines = await this.repository.lines(transaction, organizationId, paymentId);
      if (!lines.length) throw new Error('PAYMENT_INCOMPLETE');
      if (lines.some(({ methodState }) => methodState !== 'ACTIVE')) {
        throw new Error('INACTIVE_REFERENCE');
      }

      const provisional = await this.resolveContexts(
        transaction, organizationId, payment, lines, payment.totalBaseAmount,
      );
      let contexts = provisional;
      let amountBasis = payment.totalBaseAmount;
      let aggregation: AggregationEvidence | undefined;
      const config = aggregationConfig(provisional);
      const documentVersion = payment.version + 1;
      if (config) {
        if (
          config.windowKind !== 'BUSINESS_DATE'
          || config.keys.includes('EXTERNAL_OBLIGATION')
          || !config.keys.includes('BENEFICIARY')
        ) throw new Error('APPROVAL_POLICY_UNAVAILABLE');
        await this.repository.lockAggregation(
          transaction,
          organizationId,
          payment.businessDate,
          config.keys,
          payment.beneficiaryPartyId,
        );
        const others = await this.repository.matchingParticipants(
          transaction,
          organizationId,
          payment.businessDate,
          payment.beneficiaryPartyId,
          payment.id,
        );
        const participants: AggregationEvidence['participants'] = [
          {
            paymentId: payment.id,
            paymentNumber: payment.businessNumber,
            paymentVersion: documentVersion,
            baseAmount: payment.totalBaseAmount,
            baseCurrency: payment.baseCurrency,
            versionBasis: 'SUBMITTED_CONTENT' as const,
          },
          ...others.map((participant) => ({
            ...participant,
            versionBasis: 'LIVE_AGGREGATE' as const,
          })),
        ].sort((left, right) => left.paymentId.localeCompare(right.paymentId));
        amountBasis = sumAmounts(participants.map(({ baseAmount }) => baseAmount));
        contexts = await this.resolveContexts(
          transaction, organizationId, payment, lines, amountBasis,
        );
        if (
          contextSignature(contexts) !== contextSignature(provisional)
          || configSignature(aggregationConfig(contexts)) !== configSignature(config)
        ) throw new Error('APPROVAL_POLICY_UNAVAILABLE');
        aggregation = {
          businessDate: payment.businessDate,
          keys: config.keys,
          beneficiaryPartyId: payment.beneficiaryPartyId,
          externalObligationKey: null,
          participants,
        };
      }

      const steps = composeSteps(contexts);
      if (!payment.requesterUserId
        && steps.some(({ separationRules }) =>
          separationRules.includes('REQUESTER_NOT_APPROVER'))) {
        throw new Error('APPROVAL_POLICY_UNAVAILABLE');
      }
      const snapshotId = randomUUID();
      await this.repository.insertSnapshot(
        transaction,
        organizationId,
        payment,
        snapshotId,
        documentVersion,
        amountBasis,
        new Date(),
        contexts,
        steps,
        aggregation,
      );
      await this.repository.completeSubmission(
        transaction,
        organizationId,
        paymentId,
        snapshotId,
        steps.length ? 'APPROVAL_PENDING' : 'APPROVED',
      );
      const response = await this.view(transaction, organizationId, paymentId);
      await this.payments.saveIdempotency(
        transaction, organizationId, scope, key, response, 200,
      );
      return response;
    }));
  }

  act(
    organizationId: string,
    actorUserId: string,
    paymentId: string,
    dto: PaymentApprovalActionDto,
    rawKey: string,
    rawIfMatch: string,
    requestId: string,
  ): Promise<PaymentView> {
    this.uuid(paymentId);
    this.requiredRequestId(requestId);
    this.action(dto);
    const key = this.key(rawKey);
    const expectedVersion = this.ifMatch(rawIfMatch);
    const permission = dto.action === PaymentApprovalAction.APPROVE
      ? 'payment.approve' as const
      : 'payment.reject' as const;
    const digest = commandDigest('actOnPaymentApproval', {
      actorUserId,
      paymentId,
      ifMatch: rawIfMatch,
      body: dto,
    });
    return this.map(() => this.database.db.transaction(async (transaction) => {
      const scope = `actOnPaymentApproval:${actorUserId}:${paymentId}`;
      await this.payments.acquireIdempotencyLock(transaction, organizationId, scope, key);
      const replay = await this.payments.findIdempotency<PaymentView>(
        transaction, organizationId, scope, key,
      );
      if (replay) {
        if (replay.requestDigest !== digest || !replay.response) {
          throw new Error('IDEMPOTENCY_CONFLICT');
        }
        const replayAction = this.replayAction(replay.response, actorUserId, dto.action);
        if (!replayAction) throw new Error('IDEMPOTENCY_CONFLICT');
        const replayStep = replayAction.stepOrder === undefined
          ? undefined
          : replay.response.approvalSnapshot?.steps.find(
            ({ order }) => order === replayAction.stepOrder,
          );
        const authority = await this.assertAuthorized(
          transaction, organizationId, actorUserId, replay.response, permission,
          replayStep?.roleId,
          undefined,
          replayStep?.approverUserId,
        );
        const requesterUserId = await this.repository.paymentRequester(
          transaction, organizationId, paymentId,
        );
        this.assertStepEligibility(
          replay.response.creatorUserId,
          requesterUserId,
          replayStep,
          actorUserId,
          authority,
        );
        if ((replayAction.delegatedFromUserId ?? null)
          !== (authority.delegatedFromUserId ?? null)) throw new Error('SCOPE_DENIED');
        return replay.response;
      }
      await this.payments.insertIdempotency(transaction, organizationId, scope, key, digest);
      const payment = await this.repository.lockPayment(transaction, organizationId, paymentId);
      if (!payment) throw new Error('RESOURCE_HIDDEN');
      if (payment.version !== expectedVersion) throw new Error('STALE_VERSION');
      if (
        dto.action === PaymentApprovalAction.RETURN
          ? !['APPROVAL_PENDING', 'APPROVED'].includes(payment.state)
          : payment.state !== 'APPROVAL_PENDING'
      ) throw new Error('STATE_CONFLICT');
      if (!payment.currentApprovalSnapshotId) throw new Error('STATE_CONFLICT');
      await this.assertAggregationFresh(transaction, organizationId, payment);
      const steps = await this.repository.currentSteps(
        transaction, organizationId, payment.currentApprovalSnapshotId,
      );
      const current = steps.find(({ approvalsRecorded, approvalsRequired }) =>
        approvalsRecorded < approvalsRequired);
      const step = current
        ?? (dto.action === PaymentApprovalAction.RETURN ? steps.at(-1) : undefined);
      if (steps.length && !step) throw new Error('STATE_CONFLICT');
      if (dto.action !== PaymentApprovalAction.RETURN && !current) {
        throw new Error('STATE_CONFLICT');
      }
      const view = await this.baseView(transaction, organizationId, paymentId);
      const authority = await this.assertAuthorized(
        transaction,
        organizationId,
        actorUserId,
        view,
        permission,
        step?.roleId ?? undefined,
        payment.branchId,
        step?.approverUserId,
      );
      this.assertStepEligibility(
        payment.creatorUserId,
        payment.requesterUserId,
        step,
        actorUserId,
        authority,
      );
      const action = {
        [PaymentApprovalAction.APPROVE]: 'APPROVED',
        [PaymentApprovalAction.REJECT]: 'REJECTED',
        [PaymentApprovalAction.RETURN]: 'RETURNED',
      } as const;
      await this.repository.insertAction(
        transaction,
        organizationId,
        payment.currentApprovalSnapshotId,
        step,
        actorUserId,
        authority.delegatedFromUserId,
        action[dto.action],
        dto.reason?.trim(),
      );
      let state: 'APPROVAL_PENDING' | 'APPROVED' | 'REJECTED' | 'DRAFT';
      if (dto.action === PaymentApprovalAction.REJECT) state = 'REJECTED';
      else if (dto.action === PaymentApprovalAction.RETURN) state = 'DRAFT';
      else {
        const completedCurrent = current!.approvalsRecorded + 1 >= current!.approvalsRequired;
        const hasLater = steps.some(({ order }) => order > current!.order);
        state = completedCurrent && !hasLater ? 'APPROVED' : 'APPROVAL_PENDING';
      }
      await this.repository.completeAction(transaction, organizationId, paymentId, state);
      const response = await this.view(transaction, organizationId, paymentId);
      await this.payments.saveIdempotency(
        transaction, organizationId, scope, key, response, 200,
      );
      return response;
    }));
  }

  private async resolveContexts(
    transaction: DatabaseTransaction,
    organizationId: string,
    payment: ApprovalPayment,
    lines: Array<{ lineNumber: number; currency: string; methodCategory: string }>,
    amountBasis: string,
  ): Promise<ApprovalContext[]> {
    const grouped = new Map<string, {
      firstLineNumber: number;
      currency: string;
      methodCategory: string;
    }>();
    for (const line of lines) {
      const key = `${line.currency}:${line.methodCategory}`;
      if (!grouped.has(key)) grouped.set(key, {
        firstLineNumber: line.lineNumber,
        currency: line.currency,
        methodCategory: line.methodCategory,
      });
    }
    const contexts: ApprovalContext[] = [];
    for (const [index, context] of [...grouped.values()]
      .sort((left, right) => left.firstLineNumber - right.firstLineNumber)
      .entries()) {
      const policy = uniqueMaximal(await this.repository.policies(
        transaction,
        organizationId,
        payment,
        context.currency,
        context.methodCategory,
        amountBasis,
      ));
      if (
        !policy
        || policy.steps.some((step) =>
          (step.roleId && step.roleState !== 'ACTIVE')
          || (step.approverUserId && step.approverState !== 'ACTIVE'))
      ) throw new Error('APPROVAL_POLICY_UNAVAILABLE');
      contexts.push({ order: index + 1, ...context, policy });
    }
    return contexts;
  }

  private async assertAggregationFresh(
    transaction: DatabaseTransaction,
    organizationId: string,
    payment: ApprovalPayment,
  ): Promise<void> {
    const snapshotId = payment.currentApprovalSnapshotId!;
    const aggregation = await this.repository.aggregation(transaction, organizationId, snapshotId);
    if (!aggregation) return;
    if (
      aggregation.businessDate !== payment.businessDate
      || aggregation.beneficiaryPartyId !== payment.beneficiaryPartyId
      || aggregation.keys.includes('EXTERNAL_OBLIGATION')
    ) throw new Error('AGGREGATE_STALE');
    await this.repository.lockAggregation(
      transaction,
      organizationId,
      aggregation.businessDate,
      aggregation.keys,
      payment.beneficiaryPartyId,
    );
    const currentParticipant = aggregation.participants.find(({ paymentId: id }) =>
      id === payment.id);
    if (!currentParticipant || currentParticipant.versionBasis !== 'SUBMITTED_CONTENT') {
      throw new Error('AGGREGATE_STALE');
    }
    const current = await this.repository.matchingParticipants(
      transaction,
      organizationId,
      aggregation.businessDate,
      payment.beneficiaryPartyId,
      payment.id,
    );
    const expected = aggregation.participants
      .filter(({ versionBasis }) => versionBasis === 'LIVE_AGGREGATE')
      .map(({ paymentId, paymentVersion }) => `${paymentId}:${paymentVersion}`)
      .sort();
    const actual = current.map(({ paymentId, paymentVersion }) =>
      `${paymentId}:${paymentVersion}`).sort();
    if (expected.length !== actual.length || expected.some((value, index) => value !== actual[index])) {
      throw new Error('AGGREGATE_STALE');
    }
  }

  private async assertAuthorized(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    view: PaymentView,
    permission: 'payment.submit' | 'payment.approve' | 'payment.reject',
    roleId?: string,
    effectiveBranchId?: string | null,
    requiredAuthorityUserId?: string | null,
  ): Promise<PaymentAuthority> {
    const branchId = effectiveBranchId !== undefined
      ? effectiveBranchId
      : view.branchId ?? await this.repository.treasuryUnitBranch(
        transaction, organizationId, view.treasuryUnitId,
      );
    const authority = await this.authorization.resolvePaymentAuthority(
      transaction,
      organizationId,
      actorUserId,
      paymentContext(view, branchId),
      permission,
      roleId,
      requiredAuthorityUserId,
    );
    if (!authority) throw new Error('SCOPE_DENIED');
    return authority;
  }

  private assertStepEligibility(
    creatorUserId: string,
    requesterUserId: string | null,
    step: {
      approverUserId?: string | null;
      separationRules: readonly string[];
    } | undefined,
    actorUserId: string,
    authority: PaymentAuthority,
  ): void {
    if (!step) return;
    const subjects = new Set([
      actorUserId,
      ...(authority.delegatedFromUserId ? [authority.delegatedFromUserId] : []),
    ]);
    if (step.approverUserId && !subjects.has(step.approverUserId)) {
      throw new Error('SCOPE_DENIED');
    }
    if (step.separationRules.includes('CREATOR_NOT_APPROVER')
      && subjects.has(creatorUserId)) throw new Error('SCOPE_DENIED');
    if (step.separationRules.includes('REQUESTER_NOT_APPROVER')
      && (!requesterUserId || subjects.has(requesterUserId))) throw new Error('SCOPE_DENIED');
  }

  private replayAction(
    view: PaymentView,
    actorUserId: string,
    command: PaymentApprovalAction,
  ) {
    const action = {
      [PaymentApprovalAction.APPROVE]: 'APPROVED',
      [PaymentApprovalAction.REJECT]: 'REJECTED',
      [PaymentApprovalAction.RETURN]: 'RETURNED',
    } as const;
    return [...(view.approvalSnapshot?.actions ?? [])].reverse().find((candidate) =>
      candidate.actorUserId === actorUserId && candidate.action === action[command]);
  }

  private async baseView(
    transaction: DatabaseTransaction,
    organizationId: string,
    paymentId: string,
  ): Promise<PaymentView> {
    const view = await this.payments.paymentView(transaction, organizationId, paymentId);
    if (!view) throw new Error('RESOURCE_HIDDEN');
    return view;
  }

  private async view(
    transaction: DatabaseTransaction,
    organizationId: string,
    paymentId: string,
  ): Promise<PaymentView> {
    const view = await this.baseView(transaction, organizationId, paymentId);
    const snapshot = (await this.repository.snapshotViewsForPayments(
      transaction, organizationId, [paymentId],
    )).get(paymentId);
    return snapshot ? { ...view, approvalSnapshot: snapshot } : view;
  }

  private action(dto: PaymentApprovalActionDto): void {
    if (
      (dto.action === PaymentApprovalAction.REJECT || dto.action === PaymentApprovalAction.RETURN)
      && !dto.reason?.trim()
    ) this.validation('REJECT and RETURN require a non-empty reason.');
    if (dto.reason !== undefined && !dto.reason.trim()) {
      this.validation('Approval reasons must be non-empty when supplied.');
    }
  }

  private uuid(value: string): void {
    if (!UUID.test(value)) this.validation('resourceId is malformed.');
  }

  private key(value: string | undefined): string {
    if (!value || value.length < 8 || value.length > 128) {
      this.validation('Idempotency-Key must contain 8 through 128 characters.');
    }
    return value;
  }

  private requiredRequestId(value: string | undefined): string {
    if (!value || value.length > 128) {
      this.validation('X-Request-Id must contain 1 through 128 characters.');
    }
    return value;
  }

  private ifMatch(value: string | undefined): number {
    const match = value?.match(/^"([0-9]+)"$/u);
    const version = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(version)) {
      this.validation('If-Match must be one strong numeric version tag.');
    }
    return version;
  }

  private validation(detail: string): never {
    throw new TreasuryProblem('TRS-GEN-001', 422, detail);
  }

  private async map<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof TreasuryProblem) throw error;
      const mapped = {
        IDEMPOTENCY_CONFLICT: ['TRS-GEN-007', 409],
        SCOPE_DENIED: ['TRS-GEN-003', 403],
        RESOURCE_HIDDEN: ['TRS-GEN-004', 404],
        INACTIVE_REFERENCE: ['TRS-MST-001', 409],
        METHOD_INVALID: ['TRS-MST-004', 422],
        RATE_INVALID: ['TRS-MST-003', 422],
        TOTAL_MISMATCH: ['TRS-PAY-001', 422],
        PAYMENT_INCOMPLETE: ['TRS-PAY-002', 422],
        AGGREGATE_STALE: ['TRS-PAY-007', 409],
        APPROVAL_POLICY_UNAVAILABLE: ['TRS-PAY-008', 409],
        STATE_CONFLICT: ['TRS-GEN-005', 409],
        STALE_VERSION: ['TRS-GEN-006', 409],
        VALIDATION: ['TRS-GEN-001', 422],
      } as const;
      const message = error instanceof Error ? error.message : '';
      const problem = mapped[message as keyof typeof mapped];
      if (problem) throw new TreasuryProblem(problem[0], problem[1]);
      const databaseError = error as { code?: string };
      if (databaseError.code === '23505') throw new TreasuryProblem('TRS-GEN-005', 409);
      if (databaseError.code === '23503') throw new TreasuryProblem('TRS-GEN-004', 404);
      if (['22003', '22P02', '23514'].includes(databaseError.code ?? '')) {
        throw new TreasuryProblem('TRS-GEN-001', 422);
      }
      throw error;
    }
  }
}

function paymentContext(view: PaymentView, branchId: string | null): PaymentAuthorizationContext {
  return {
    branchId,
    treasuryUnitId: view.treasuryUnitId,
    cashboxIds: [...new Set(view.lines.flatMap((line) => line.cashboxId ? [line.cashboxId] : []))],
    bankAccountIds: [...new Set(view.lines.flatMap((line) =>
      line.bankAccountId ? [line.bankAccountId] : []))],
    currencies: [...new Set([view.baseCurrency, ...view.lines.map((line) => line.money.currency)])],
    methodCategories: [...new Set(view.lines.map((line) => line.methodBehaviorCategory))],
    documentType: 'PAYMENT',
    amount: view.totalBaseAmount.amount,
    amountCurrency: view.baseCurrency,
  };
}

function uniqueMaximal(candidates: ApprovalPolicy[]): ApprovalPolicy | undefined {
  const maximal = candidates.filter((candidate) =>
    !candidates.some((other) => other.id !== candidate.id && dominates(other, candidate)));
  return maximal.length === 1 ? maximal[0] : undefined;
}

function dominates(left: ApprovalPolicy, right: ApprovalPolicy): boolean {
  let strict = false;
  for (const key of ['branchId', 'treasuryUnitId', 'currency', 'methodCategory'] as const) {
    const narrower = optionalNarrower(left[key], right[key]);
    if (!narrower.allowed) return false;
    strict ||= narrower.strict;
  }
  const minimum = lowerNarrower(left.amountMinimum, right.amountMinimum);
  const maximum = upperNarrower(left.amountMaximum, right.amountMaximum);
  return minimum.allowed && maximum.allowed && (strict || minimum.strict || maximum.strict);
}

function optionalNarrower(left: string | null, right: string | null) {
  if (right === null) return { allowed: true, strict: left !== null };
  return { allowed: left === right, strict: false };
}

function lowerNarrower(left: string | null, right: string | null) {
  if (right === null) return { allowed: true, strict: left !== null };
  if (left === null) return { allowed: false, strict: false };
  const comparison = compareDecimal(left, right);
  return { allowed: comparison >= 0, strict: comparison > 0 };
}

function upperNarrower(left: string | null, right: string | null) {
  if (right === null) return { allowed: true, strict: left !== null };
  if (left === null) return { allowed: false, strict: false };
  const comparison = compareDecimal(left, right);
  return { allowed: comparison <= 0, strict: comparison < 0 };
}

function compareDecimal(left: string, right: string): number {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const scale = Math.max(a.scale, b.scale);
  const av = a.value * 10n ** BigInt(scale - a.scale);
  const bv = b.value * 10n ** BigInt(scale - b.scale);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

function decimalParts(value: string): { value: bigint; scale: number } {
  const [whole, fraction = ''] = value.split('.');
  return { value: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function sumAmounts(amounts: string[]): string {
  const scale = Math.max(...amounts.map((amount) => decimalParts(amount).scale));
  const total = amounts.reduce((sum, amount) => {
    const parsed = decimalParts(amount);
    return sum + parsed.value * 10n ** BigInt(scale - parsed.scale);
  }, 0n);
  const raw = total.toString().padStart(scale + 1, '0');
  return scale ? `${raw.slice(0, -scale)}.${raw.slice(-scale)}` : raw;
}

function aggregationConfig(contexts: ApprovalContext[]): {
  windowKind: string;
  keys: Array<'BENEFICIARY' | 'EXTERNAL_OBLIGATION'>;
} | undefined {
  const configs = contexts.map(({ policy }) => {
    const keys = [...new Set(policy.aggregationKeys)].sort() as Array<
      'BENEFICIARY' | 'EXTERNAL_OBLIGATION'
    >;
    if (!policy.aggregationWindowKind && !keys.length) return undefined;
    if (!policy.aggregationWindowKind || !keys.length) throw new Error('APPROVAL_POLICY_UNAVAILABLE');
    return { windowKind: policy.aggregationWindowKind, keys };
  });
  const signatures = new Set(configs.map(configSignature));
  if (signatures.size !== 1) throw new Error('APPROVAL_POLICY_UNAVAILABLE');
  return configs[0];
}

function configSignature(config?: { windowKind: string; keys: string[] }): string {
  return config ? `${config.windowKind}:${config.keys.join(',')}` : '';
}

function contextSignature(contexts: ApprovalContext[]): string {
  return contexts.map(({ currency, methodCategory, policy }) =>
    `${currency}:${methodCategory}:${policy.id}:${policy.version}`).join('|');
}

function composeSteps(contexts: ApprovalContext[]): ComposedApprovalStep[] {
  interface Node {
    key: string;
    roleId: string | null;
    roleName: string | null;
    approverUserId: string | null;
    approverName: string | null;
    approvalsRequired: number;
    separationRules: string[];
    sourceContextOrders: Set<number>;
    priority: [number, string, number, number, string];
  }
  const nodes = new Map<string, Node>();
  const edges = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const context of contexts) {
    let previous: string | undefined;
    for (const step of context.policy.steps) {
      const separationRules = [...new Set(step.separationRules)].sort();
      const subject = step.roleId ? `role:${step.roleId}` : `user:${step.approverUserId}`;
      const key = `${subject}|${step.approvalsRequired}|${separationRules.join(',')}`;
      const existing = nodes.get(key);
      if (existing) existing.sourceContextOrders.add(context.order);
      else {
        nodes.set(key, {
          key,
          roleId: step.roleId,
          roleName: step.roleName,
          approverUserId: step.approverUserId,
          approverName: step.approverName,
          approvalsRequired: step.approvalsRequired,
          separationRules,
          sourceContextOrders: new Set([context.order]),
          priority: [context.order, context.policy.id, context.policy.version, step.stepOrder, key],
        });
        edges.set(key, new Set());
        indegree.set(key, 0);
      }
      if (previous && previous !== key && !edges.get(previous)!.has(key)) {
        edges.get(previous)!.add(key);
        indegree.set(key, indegree.get(key)! + 1);
      }
      previous = key;
    }
  }
  const ready = [...nodes.values()].filter(({ key }) => indegree.get(key) === 0);
  const ordered: Node[] = [];
  while (ready.length) {
    ready.sort((left, right) => comparePriority(left.priority, right.priority));
    const node = ready.shift()!;
    ordered.push(node);
    for (const target of edges.get(node.key)!) {
      indegree.set(target, indegree.get(target)! - 1);
      if (indegree.get(target) === 0) ready.push(nodes.get(target)!);
    }
  }
  if (ordered.length !== nodes.size) throw new Error('APPROVAL_POLICY_UNAVAILABLE');
  return ordered.map((node, index) => ({
    id: randomUUID(),
    order: index + 1,
    roleId: node.roleId,
    roleName: node.roleName,
    approverUserId: node.approverUserId,
    approverName: node.approverName,
    approvalsRequired: node.approvalsRequired,
    separationRules: node.separationRules,
    sourceContextOrders: [...node.sourceContextOrders].sort((a, b) => a - b),
    obligationKey: node.key,
  }));
}

function comparePriority(
  left: [number, string, number, number, string],
  right: [number, string, number, number, string],
): number {
  return left[0] - right[0]
    || left[1].localeCompare(right[1])
    || left[2] - right[2]
    || left[3] - right[3]
    || left[4].localeCompare(right[4]);
}
