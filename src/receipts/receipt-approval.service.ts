import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { commandDigest } from '../common/http';
import { TreasuryProblem } from '../common/problem';
import { DatabaseService } from '../database/database.service';
import {
  ApprovalContext,
  ApprovalPolicy,
  ComposedApprovalStep,
  ReceiptApprovalRepository,
} from './receipt-approval.repository';
import {
  ReceiptApprovalAction,
  ReceiptApprovalActionDto,
  ReceiptView,
} from './receipt.dto';
import { ReceiptRepository } from './receipt.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

@Injectable()
export class ReceiptApprovalService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ReceiptApprovalRepository)
    private readonly repository: ReceiptApprovalRepository,
    @Inject(ReceiptRepository) private readonly receipts: ReceiptRepository,
  ) {}

  submit(
    organizationId: string,
    actorUserId: string,
    receiptId: string,
    rawKey: string,
    rawIfMatch: string,
    requestId: string,
  ): Promise<ReceiptView> {
    this.uuid(receiptId);
    this.requiredRequestId(requestId);
    const key = this.key(rawKey);
    const expectedVersion = this.ifMatch(rawIfMatch);
    const digest = commandDigest('submitReceipt', {
      actorUserId,
      receiptId,
      ifMatch: rawIfMatch,
    });
    return this.map(() => this.transaction(async (client) => {
      const scope = `submitReceipt:${actorUserId}:${receiptId}`;
      const replay = await this.repository.lockIdempotency(
        client, organizationId, scope, key,
      );
      if (replay) {
        if (replay.requestDigest !== digest || !replay.response) {
          throw new Error('IDEMPOTENCY_CONFLICT');
        }
        if (!await this.repository.scopeAllowed(
          client, organizationId, actorUserId, receiptId, 'receipt.submit',
        )) throw new Error('SCOPE_DENIED');
        return replay.response;
      }
      await this.repository.startIdempotency(
        client, organizationId, scope, key, digest,
      );
      if (!await this.repository.scopeAllowed(
        client, organizationId, actorUserId, receiptId, 'receipt.submit',
      )) throw new Error('SCOPE_DENIED');
      const receipt = await this.repository.lockReceipt(client, organizationId, receiptId);
      if (!receipt) throw new Error('RESOURCE_HIDDEN');
      if (receipt.state !== 'DRAFT') throw new Error('STATE_CONFLICT');
      if (receipt.version !== expectedVersion) throw new Error('STALE_VERSION');
      const lines = await this.repository.lines(client, organizationId, receiptId);
      if (lines.length === 0) throw new Error('RECEIPT_INCOMPLETE');
      await this.receipts.revalidateSubmission(
        client,
        organizationId,
        actorUserId,
        await this.receipts.view(client, organizationId, receiptId),
      );
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
        const candidates = await this.repository.policies(
          client,
          organizationId,
          receipt,
          context.currency,
          context.methodCategory,
        );
        const policy = uniqueMaximal(candidates);
        if (!policy || policy.steps.some((step) =>
          (step.roleId && step.roleState !== 'ACTIVE')
          || (step.approverUserId && step.approverState !== 'ACTIVE'))) {
          throw new Error('APPROVAL_POLICY_UNAVAILABLE');
        }
        contexts.push({ order: index + 1, ...context, policy });
      }
      const steps = composeSteps(contexts);
      const snapshotId = randomUUID();
      const documentVersion = receipt.version + 1;
      await this.repository.insertSnapshot(
        client,
        organizationId,
        receipt,
        snapshotId,
        documentVersion,
        new Date(),
        contexts,
        steps,
      );
      await this.repository.completeSubmission(
        client,
        organizationId,
        receiptId,
        snapshotId,
        steps.length === 0 ? 'APPROVED' : 'APPROVAL_PENDING',
      );
      const response = await this.receipts.view(client, organizationId, receiptId);
      await this.repository.finishIdempotency(
        client, organizationId, scope, key, response,
      );
      return response;
    }));
  }

  act(
    organizationId: string,
    actorUserId: string,
    receiptId: string,
    dto: ReceiptApprovalActionDto,
    rawKey: string,
    rawIfMatch: string,
    requestId: string,
  ): Promise<ReceiptView> {
    this.uuid(receiptId);
    this.requiredRequestId(requestId);
    this.action(dto);
    const key = this.key(rawKey);
    const expectedVersion = this.ifMatch(rawIfMatch);
    const permission = dto.action === ReceiptApprovalAction.APPROVE
      ? 'receipt.approve' as const
      : 'receipt.reject' as const;
    const digest = commandDigest('actOnReceiptApproval', {
      actorUserId,
      receiptId,
      ifMatch: rawIfMatch,
      body: dto,
    });
    return this.map(() => this.transaction(async (client) => {
      const scope = `actOnReceiptApproval:${actorUserId}:${receiptId}`;
      const replay = await this.repository.lockIdempotency(
        client, organizationId, scope, key,
      );
      if (replay) {
        if (replay.requestDigest !== digest || !replay.response) {
          throw new Error('IDEMPOTENCY_CONFLICT');
        }
        if (!await this.repository.scopeAllowed(
          client, organizationId, actorUserId, receiptId, permission,
        )) throw new Error('SCOPE_DENIED');
        return replay.response;
      }
      await this.repository.startIdempotency(
        client, organizationId, scope, key, digest,
      );
      if (!await this.repository.scopeAllowed(
        client, organizationId, actorUserId, receiptId, permission,
      )) throw new Error('SCOPE_DENIED');
      const receipt = await this.repository.lockReceipt(client, organizationId, receiptId);
      if (!receipt) throw new Error('RESOURCE_HIDDEN');
      if (receipt.version !== expectedVersion) throw new Error('STALE_VERSION');
      if (
        dto.action === ReceiptApprovalAction.RETURN
          ? !['APPROVAL_PENDING', 'APPROVED'].includes(receipt.state)
          : receipt.state !== 'APPROVAL_PENDING'
      ) throw new Error('STATE_CONFLICT');
      if (!receipt.currentApprovalSnapshotId) throw new Error('STATE_CONFLICT');
      const steps = await this.repository.currentSteps(
        client, organizationId, receipt.currentApprovalSnapshotId,
      );
      const current = steps.find(({ approvalsRecorded, approvalsRequired }) =>
        approvalsRecorded < approvalsRequired);
      const step = current
        ?? (dto.action === ReceiptApprovalAction.RETURN ? steps.at(-1) : undefined);
      if (steps.length > 0 && !step) throw new Error('STATE_CONFLICT');
      if (dto.action !== ReceiptApprovalAction.RETURN && !current) {
        throw new Error('STATE_CONFLICT');
      }
      if (step) {
        const eligible = step.approverUserId
          ? step.approverUserId === actorUserId
          : Boolean(step.roleId) && await this.repository.roleEligible(
            client,
            organizationId,
            actorUserId,
            receiptId,
            permission,
            step.roleId!,
          );
        if (!eligible) throw new Error('SCOPE_DENIED');
        if (
          step.separationRules.some((rule) =>
            rule === 'REQUESTER_NOT_APPROVER' || rule === 'CREATOR_NOT_APPROVER')
          && receipt.creatorUserId === actorUserId
        ) throw new Error('SCOPE_DENIED');
      }
      const action = {
        [ReceiptApprovalAction.APPROVE]: 'APPROVED',
        [ReceiptApprovalAction.REJECT]: 'REJECTED',
        [ReceiptApprovalAction.RETURN]: 'RETURNED',
      } as const;
      await this.repository.insertAction(
        client,
        organizationId,
        receipt.currentApprovalSnapshotId,
        step,
        actorUserId,
        action[dto.action],
        dto.reason?.trim(),
      );
      let state: 'APPROVAL_PENDING' | 'APPROVED' | 'REJECTED' | 'DRAFT';
      if (dto.action === ReceiptApprovalAction.REJECT) state = 'REJECTED';
      else if (dto.action === ReceiptApprovalAction.RETURN) state = 'DRAFT';
      else {
        const completedCurrent = current!.approvalsRecorded + 1
          >= current!.approvalsRequired;
        const hasLater = steps.some(({ order }) => order > current!.order);
        state = completedCurrent && !hasLater ? 'APPROVED' : 'APPROVAL_PENDING';
      }
      await this.repository.completeAction(
        client, organizationId, receiptId, state,
      );
      const response = await this.receipts.view(client, organizationId, receiptId);
      await this.repository.finishIdempotency(
        client, organizationId, scope, key, response,
      );
      return response;
    }));
  }

  private action(dto: ReceiptApprovalActionDto): void {
    if (
      (dto.action === ReceiptApprovalAction.REJECT
        || dto.action === ReceiptApprovalAction.RETURN)
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

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
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

  private async map<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof TreasuryProblem) throw error;
      const message = error instanceof Error ? error.message : '';
      const mapped = {
        IDEMPOTENCY_CONFLICT: ['TRS-GEN-007', 409],
        SCOPE_DENIED: ['TRS-GEN-003', 403],
        RESOURCE_HIDDEN: ['TRS-GEN-004', 404],
        INACTIVE_REFERENCE: ['TRS-MST-001', 409],
        METHOD_INVALID: ['TRS-MST-004', 422],
        RATE_INVALID: ['TRS-MST-003', 422],
        TOTAL_MISMATCH: ['TRS-RCP-001', 422],
        RECEIPT_INCOMPLETE: ['TRS-RCP-002', 422],
        ALLOCATION_EXCEEDED: ['TRS-RCP-003', 422],
        APPROVAL_POLICY_UNAVAILABLE: ['TRS-RCP-005', 409],
        STATE_CONFLICT: ['TRS-GEN-005', 409],
        STALE_VERSION: ['TRS-GEN-006', 409],
      } as const;
      const problem = mapped[message as keyof typeof mapped];
      if (problem) throw new TreasuryProblem(problem[0], problem[1]);
      const databaseError = error as { code?: string };
      if (databaseError.code === '23505') {
        throw new TreasuryProblem('TRS-GEN-005', 409);
      }
      if (databaseError.code === '23503') {
        throw new TreasuryProblem('TRS-GEN-004', 404);
      }
      if (databaseError.code === '22003' || databaseError.code === '23514') {
        throw new TreasuryProblem('TRS-GEN-001', 422);
      }
      throw error;
    }
  }
}

function uniqueMaximal(candidates: ApprovalPolicy[]): ApprovalPolicy | undefined {
  const maximal = candidates.filter((candidate) =>
    !candidates.some((other) => other.id !== candidate.id && dominates(other, candidate)));
  return maximal.length === 1 ? maximal[0] : undefined;
}

function dominates(left: ApprovalPolicy, right: ApprovalPolicy): boolean {
  let strict = false;
  for (const key of [
    'branchId',
    'treasuryUnitId',
    'currency',
    'methodCategory',
  ] as const) {
    const narrower = optionalNarrower(left[key], right[key]);
    if (!narrower.allowed) return false;
    strict ||= narrower.strict;
  }
  const minimum = lowerNarrower(left.amountMinimum, right.amountMinimum);
  const maximum = upperNarrower(left.amountMaximum, right.amountMaximum);
  return minimum.allowed && maximum.allowed
    && (strict || minimum.strict || maximum.strict);
}

function optionalNarrower(
  left: string | null,
  right: string | null,
): { allowed: boolean; strict: boolean } {
  if (right === null) return { allowed: true, strict: left !== null };
  return { allowed: left === right, strict: false };
}

function lowerNarrower(
  left: string | null,
  right: string | null,
): { allowed: boolean; strict: boolean } {
  if (right === null) return { allowed: true, strict: left !== null };
  if (left === null) return { allowed: false, strict: false };
  const comparison = compareDecimal(left, right);
  return { allowed: comparison >= 0, strict: comparison > 0 };
}

function upperNarrower(
  left: string | null,
  right: string | null,
): { allowed: boolean; strict: boolean } {
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
          priority: [
            context.order,
            context.policy.id,
            context.policy.version,
            step.stepOrder,
            key,
          ],
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
  while (ready.length > 0) {
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
