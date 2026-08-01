import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { AccessAuthorizationService } from '../access-control/access-authorization.service';
import type { PaymentAuthorizationContext } from '../access-control/access-authorization.repository';
import type { TreasuryRequest } from '../access-control/auth.guard';
import { PaymentBankingEffectsService } from '../banking/payment-banking-effects.service';
import { ReceiptBankingEffectsService } from '../banking/receipt-banking-effects.service';
import { PaymentCashboxEffectsService } from '../cashbox-and-custody/payment-cashbox-effects.service';
import { ReceiptCashboxEffectsService } from '../cashbox-and-custody/receipt-cashbox-effects.service';
import { commandDigest, digest } from '../common/http';
import { TreasuryProblem } from '../common/problem';
import { DatabaseService, type DatabaseTransaction } from '../database/database.service';
import { FoundationEffectsService } from '../foundation-effects/foundation-effects.service';
import {
  LockedPayment,
  PaymentExecutionRepository,
} from './payment-execution.repository';
import {
  PaymentExecuteDto,
  PaymentExecutionEffectType,
  PaymentReverseDto,
  PaymentReversalResult,
  PaymentView,
} from './payment.dto';
import { PaymentRepository } from './payment.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BANK_METHODS = new Set([
  'BANK_TRANSFER',
  'DIRECT_DEPOSIT',
  'CARD_TRANSFER',
  'FOREIGN_REMITTANCE',
]);
const REVERSAL_BLOCKED_ACCOUNTING_STATES = new Set([
  'QUEUED',
  'SENDING',
  'SENDING_UNKNOWN',
  'ACCEPTED',
]);

interface CommandContext {
  organizationId: string;
  actorUserId: string;
  physicalSessionId: string;
  paymentId: string;
  key: string;
  ifMatch: string;
  requestId: string;
  stepUp?: TreasuryRequest['stepUp'];
}

@Injectable()
export class PaymentExecutionService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PaymentExecutionRepository)
    private readonly repository: PaymentExecutionRepository,
    @Inject(PaymentRepository) private readonly payments: PaymentRepository,
    @Inject(AccessAuthorizationService)
    private readonly authorization: AccessAuthorizationService,
    @Inject(PaymentCashboxEffectsService)
    private readonly cashboxes: PaymentCashboxEffectsService,
    @Inject(PaymentBankingEffectsService)
    private readonly banking: PaymentBankingEffectsService,
    @Inject(ReceiptCashboxEffectsService)
    private readonly receivingCashboxes: ReceiptCashboxEffectsService,
    @Inject(ReceiptBankingEffectsService)
    private readonly receivingBanking: ReceiptBankingEffectsService,
    @Inject(FoundationEffectsService)
    private readonly foundation: FoundationEffectsService,
  ) {}

  execute(context: CommandContext, body?: PaymentExecuteDto): Promise<PaymentView> {
    const expectedVersion = this.validate(context);
    const requestDigest = commandDigest('executePayment', {
      actorUserId: context.actorUserId,
      paymentId: context.paymentId,
      ifMatch: context.ifMatch,
      body: body ?? null,
    });
    return this.map(() => this.database.db.transaction(async (transaction) => {
      const scope = `executePayment:${context.actorUserId}:${context.paymentId}`;
      await this.payments.acquireIdempotencyLock(
        transaction, context.organizationId, scope, context.key,
      );
      const replay = await this.payments.findIdempotency<PaymentView>(
        transaction, context.organizationId, scope, context.key,
      );
      const payment = await this.repository.lockPayment(
        transaction, context.organizationId, context.paymentId,
      );
      if (!payment) throw new Error('RESOURCE_HIDDEN');
      await this.assertAuthorized(transaction, context, payment, 'payment.execute');
      if (replay) {
        if (replay.requestDigest !== requestDigest || !replay.response) {
          throw new Error('IDEMPOTENCY_CONFLICT');
        }
        return replay.response;
      }
      await this.payments.insertIdempotency(
        transaction, context.organizationId, scope, context.key, requestDigest,
      );
      if (Number(payment.document.version) !== expectedVersion) throw new Error('STALE_VERSION');
      if (payment.document.state !== 'APPROVED' || !payment.document.currentApprovalSnapshotId) {
        throw new Error('STATE_CONFLICT');
      }
      if (!payment.lines.length || payment.lines.some(({ methodState }) => methodState !== 'ACTIVE')) {
        throw new Error('AGGREGATE_STALE');
      }
      this.exactTotal(payment);
      await this.separation(transaction, context, payment, body);
      await this.allocations(transaction, payment);
      const reservationIds = this.reservations(payment);
      await this.checkSources(transaction, payment);

      const executedAt = new Date();
      const sourceVersion = expectedVersion + 1;
      await this.repository.consumeReservations(
        transaction, context.organizationId, reservationIds,
      );
      await this.repository.completeExecution(transaction, {
        organizationId: context.organizationId,
        paymentId: context.paymentId,
        actorUserId: context.actorUserId,
        executedAt,
        sourceVersion,
      });
      const effects = [];
      for (const line of payment.lines) {
        effects.push(...await this.executeLine(
          transaction, payment, line, sourceVersion,
        ));
      }
      await this.foundation.appendAudit(transaction, {
        organizationId: context.organizationId,
        requestId: context.requestId,
        actorUserId: context.actorUserId,
        entityType: 'Payment',
        entityId: context.paymentId,
        action: 'PAYMENT_EXECUTED',
      });
      await this.foundation.appendOutbox(transaction, {
        organizationId: context.organizationId,
        aggregateType: 'Payment',
        aggregateId: context.paymentId,
        aggregateVersion: sourceVersion,
        eventType: 'treasury.payment.executed.v1',
        payload: {
          sourceType: 'Payment',
          sourceId: context.paymentId,
          sourceVersion,
          businessDate: payment.document.businessDate,
          effects,
        },
      });
      const response = await this.payments.paymentView(
        transaction, context.organizationId, context.paymentId,
      );
      if (!response || response.version !== sourceVersion) throw new Error('IDEMPOTENCY_CONFLICT');
      await this.payments.saveIdempotency(
        transaction, context.organizationId, scope, context.key, response, 200,
      );
      return response;
    }));
  }

  reverse(context: CommandContext, body: PaymentReverseDto): Promise<PaymentReversalResult> {
    const expectedVersion = this.validate(context);
    const reason = body.reason.trim();
    if (!reason) this.validation('reason is required.');
    const requestDigest = commandDigest('reversePayment', {
      actorUserId: context.actorUserId,
      paymentId: context.paymentId,
      ifMatch: context.ifMatch,
      body: { ...body, reason },
    });
    return this.map(() => this.database.db.transaction(async (transaction) => {
      const scope = `reversePayment:${context.actorUserId}:${context.paymentId}`;
      await this.payments.acquireIdempotencyLock(
        transaction, context.organizationId, scope, context.key,
      );
      const replay = await this.payments.findIdempotency<PaymentView>(
        transaction, context.organizationId, scope, context.key,
      );
      const original = await this.repository.lockPayment(
        transaction, context.organizationId, context.paymentId,
      );
      if (!original) throw new Error('RESOURCE_HIDDEN');
      await this.assertAuthorized(transaction, context, original, 'payment.reverse');
      if (replay) {
        if (
          replay.requestDigest !== requestDigest || !replay.response
          || !replay.response.reversedPaymentId
        ) throw new Error('IDEMPOTENCY_CONFLICT');
        const reversal = await this.payments.paymentView(
          transaction, context.organizationId, replay.response.reversedPaymentId,
        );
        if (!reversal) throw new Error('IDEMPOTENCY_CONFLICT');
        return { original: replay.response, reversal };
      }
      await this.payments.insertIdempotency(
        transaction, context.organizationId, scope, context.key, requestDigest,
      );
      if (Number(original.document.version) !== expectedVersion) throw new Error('STALE_VERSION');
      if (
        original.document.reversedPaymentId
        || !['EXECUTED', 'ACCOUNTING_READY', 'ACCOUNTING_POSTED'].includes(original.document.state)
        || REVERSAL_BLOCKED_ACCOUNTING_STATES.has(original.document.accountingState)
      ) throw new Error('REVERSAL_BLOCKED');
      const conflicts = new Set([
        original.document.creatorUserId,
        original.document.executedByUserId,
        ...original.approverUserIds,
      ]);
      if (conflicts.has(context.actorUserId)) throw new Error('SCOPE_DENIED');
      await this.consumeProof(transaction, context);

      const originalEffects = await this.repository.effects(
        transaction, context.organizationId, context.paymentId,
      );
      if (
        originalEffects.some(({ instructionState }) =>
          instructionState === 'CONFIRMED' || instructionState === 'RETURNED')
      ) throw new Error('REVERSAL_BLOCKED');
      const movements = originalEffects.filter(({ movementFactId }) => movementFactId !== null);
      if (movements.length !== original.lines.length) throw new Error('REVERSAL_BLOCKED');
      await this.checkReversalSources(transaction, original, body.businessDate);

      const at = new Date();
      const businessNumber = await this.payments.nextPaymentNumber(
        transaction, context.organizationId, body.businessDate,
      );
      const reversal = await this.repository.createReversal(transaction, {
        original,
        actorUserId: context.actorUserId,
        businessDate: body.businessDate,
        businessNumber,
        reason,
        executedAt: at,
      });
      await this.repository.completeReversal(transaction, {
        organizationId: context.organizationId,
        originalPaymentId: context.paymentId,
        reversalPaymentId: reversal.paymentId,
        originalVersion: expectedVersion + 1,
        at,
      });
      const effects = [];
      for (const effect of movements) {
        const reversalLineId = reversal.lineIds.get(effect.paymentLineId);
        if (!reversalLineId || !effect.movementFactId) throw new Error('REVERSAL_BLOCKED');
        const line = original.lines.find(({ id }) => id === effect.paymentLineId)!;
        const effectKey = `payment:${reversal.paymentId}:line:${reversalLineId}:reversal`;
        const movementFactId = await this.foundation.appendMovement(transaction, {
          organizationId: context.organizationId,
          owner: 'domain.payments',
          sourceType: 'Payment',
          sourceId: reversal.paymentId,
          sourceLineId: reversalLineId,
          effectKey,
          endpointType: effect.effectType === 'CASHBOX_MOVEMENT' ? 'CASHBOX' : 'BANK_ACCOUNT',
          endpointId: line.cashboxId ?? line.bankAccountId!,
          direction: 'CREDIT',
          state: 'POSTED',
          amount: effect.amount,
          currency: effect.currency,
          businessDate: body.businessDate,
          reversalOfFactId: effect.movementFactId,
        });
        const paymentEffectId = await this.repository.appendEffect(transaction, {
          organizationId: context.organizationId,
          paymentLineId: reversalLineId,
          effectKey,
          effectType: effect.effectType as PaymentExecutionEffectType,
          direction: 'REVERSAL',
          amount: effect.amount,
          currency: effect.currency,
          businessDate: body.businessDate,
          sourceVersion: 1,
          movementFactId,
          reversalOfEffectId: effect.id,
        });
        effects.push({
          paymentEffectId,
          paymentLineId: reversalLineId,
          effectKey,
          effectType: effect.effectType,
          effectId: movementFactId,
          direction: 'REVERSAL',
          money: { amount: effect.amount, currency: effect.currency },
          businessDate: body.businessDate,
          sourceVersion: 1,
          reversalOfEffectId: effect.id,
        });
      }
      await this.foundation.appendAudit(transaction, {
        organizationId: context.organizationId,
        requestId: context.requestId,
        actorUserId: context.actorUserId,
        entityType: 'Payment',
        entityId: context.paymentId,
        action: 'PAYMENT_REVERSED',
        reason,
      });
      await this.foundation.appendOutbox(transaction, {
        organizationId: context.organizationId,
        aggregateType: 'Payment',
        aggregateId: context.paymentId,
        aggregateVersion: expectedVersion + 1,
        eventType: 'treasury.payment.reversed.v1',
        payload: {
          sourceType: 'Payment',
          sourceId: context.paymentId,
          sourceVersion: expectedVersion + 1,
          businessDate: body.businessDate,
          reversalPaymentId: reversal.paymentId,
          reversalPaymentVersion: 1,
          effects,
        },
      });
      const originalView = await this.payments.paymentView(
        transaction, context.organizationId, context.paymentId,
      );
      const reversalView = await this.payments.paymentView(
        transaction, context.organizationId, reversal.paymentId,
      );
      if (!originalView || !reversalView) throw new Error('IDEMPOTENCY_CONFLICT');
      await this.payments.saveIdempotency(
        transaction, context.organizationId, scope, context.key, originalView, 201,
      );
      return { original: originalView, reversal: reversalView };
    }));
  }

  private async executeLine(
    transaction: DatabaseTransaction,
    payment: LockedPayment,
    line: LockedPayment['lines'][number],
    sourceVersion: number,
  ) {
    const source = line.cashboxId ?? line.bankAccountId;
    if (!source) throw new Error('EFFECT_MAPPING');
    const effectType: PaymentExecutionEffectType = line.methodCategory === 'CASH'
      ? 'CASHBOX_MOVEMENT'
      : BANK_METHODS.has(line.methodCategory)
        ? 'BANK_MOVEMENT'
        : (() => { throw new Error('EFFECT_MAPPING'); })();
    const effectKey = `payment:${payment.document.id}:line:${line.id}:outgoing`;
    const movementFactId = await this.foundation.appendMovement(transaction, {
      organizationId: payment.document.organizationId,
      owner: 'domain.payments',
      sourceType: 'Payment',
      sourceId: payment.document.id,
      sourceLineId: line.id,
      effectKey,
      endpointType: effectType === 'CASHBOX_MOVEMENT' ? 'CASHBOX' : 'BANK_ACCOUNT',
      endpointId: source,
      direction: 'DEBIT',
      state: 'POSTED',
      amount: line.amount,
      currency: line.currency,
      businessDate: payment.document.businessDate,
    });
    const paymentEffectId = await this.repository.appendEffect(transaction, {
      organizationId: payment.document.organizationId,
      paymentLineId: line.id,
      effectKey,
      effectType,
      direction: 'OUTGOING',
      amount: line.amount,
      currency: line.currency,
      businessDate: payment.document.businessDate,
      sourceVersion,
      movementFactId,
    });
    const result: Array<{
      paymentEffectId: string;
      paymentLineId: string;
      effectKey: string;
      effectType: PaymentExecutionEffectType;
      effectId: string;
      direction: 'OUTGOING';
      money: { amount: string; currency: string };
      businessDate: string;
      sourceVersion: number;
    }> = [{
      paymentEffectId,
      paymentLineId: line.id,
      effectKey,
      effectType,
      effectId: movementFactId,
      direction: 'OUTGOING',
      money: { amount: line.amount, currency: line.currency },
      businessDate: payment.document.businessDate,
      sourceVersion,
    }];
    if (effectType === 'BANK_MOVEMENT') {
      if (!line.bankAccountId || !line.beneficiaryAccountReference) {
        throw new Error('EFFECT_MAPPING');
      }
      const bankInstructionId = randomUUID();
      const instructionKey = `payment:${payment.document.id}:line:${line.id}:instruction`;
      await this.banking.createInstruction(transaction, {
        id: bankInstructionId,
        organizationId: payment.document.organizationId,
        paymentLineId: line.id,
        bankAccountId: line.bankAccountId,
        amount: line.amount,
        currency: line.currency,
        beneficiaryAccountReference: line.beneficiaryAccountReference,
        localReference: payment.document.businessNumber + '-' + line.lineNumber,
      });
      const instructionEffectId = await this.repository.appendEffect(transaction, {
        organizationId: payment.document.organizationId,
        paymentLineId: line.id,
        effectKey: instructionKey,
        effectType: 'BANK_INSTRUCTION',
        direction: 'OUTGOING',
        amount: line.amount,
        currency: line.currency,
        businessDate: payment.document.businessDate,
        sourceVersion,
        bankInstructionId,
      });
      result.push({
        paymentEffectId: instructionEffectId,
        paymentLineId: line.id,
        effectKey: instructionKey,
        effectType: 'BANK_INSTRUCTION',
        effectId: bankInstructionId,
        direction: 'OUTGOING',
        money: { amount: line.amount, currency: line.currency },
        businessDate: payment.document.businessDate,
        sourceVersion,
      });
    }
    return result;
  }

  private async separation(
    transaction: DatabaseTransaction,
    context: CommandContext,
    payment: LockedPayment,
    body?: PaymentExecuteDto,
  ): Promise<void> {
    const conflicts = [payment.document.creatorUserId, ...payment.approverUserIds]
      .filter((id) => id === context.actorUserId);
    if (!conflicts.length) return;
    const override = body?.separationOverride;
    if (!override) throw new Error('SCOPE_DENIED');
    if (!await this.authorization.hasOrganizationPermission(
      transaction, context.organizationId, context.actorUserId, 'separation.override',
    )) throw new Error('SCOPE_DENIED');
    await this.consumeProof(transaction, context);
    const result = await this.repository.overrideApprovalValid(transaction, {
      organizationId: context.organizationId,
      payment,
      approvalActionId: override.independentApprovalActionId,
      reason: override.reason,
      executorUserId: context.actorUserId,
      conflictingUserIds: conflicts,
    });
    if (result === 'INVALID_EVIDENCE') throw new Error('INVALID_APPROVAL_EVIDENCE');
    if (result !== 'VALID') throw new Error('SCOPE_DENIED');
  }

  private async allocations(
    transaction: DatabaseTransaction,
    payment: LockedPayment,
  ): Promise<void> {
    for (const allocation of payment.allocations) {
      if (allocation.state !== 'ACTIVE') throw new Error('ALLOCATION_INVALID');
      const siblings = await this.repository.siblingAllocations(
        transaction, payment.document.organizationId, allocation,
      );
      const knownTotal = allocation.knownObligationTotal;
      if (
        siblings.some((sibling) => sibling.knownObligationTotal !== knownTotal)
        || (knownTotal !== null && siblings.reduce(
          (sum, sibling) => sum + decimal(sibling.allocatedAmount), 0n,
        ) > decimal(knownTotal))
        || (knownTotal === null && siblings.filter(
          (sibling) => !sibling.overrideApprovalActionId,
        ).length > 1)
      ) throw new Error('ALLOCATION_INVALID');
    }
  }

  private reservations(payment: LockedPayment): string[] {
    if (!payment.reservations.length) return [];
    const totals = sourceTotals(payment);
    for (const reservation of payment.reservations) {
      const key = `${reservation.sourceType}:${reservation.sourceId}:${reservation.currency}`;
      if (
        !['ACTIVE', 'REVIEW_REQUIRED'].includes(reservation.state)
        || !totals.has(key)
        || totals.get(key) !== decimal(reservation.amount)
        || (reservation.state === 'ACTIVE' && reservation.reviewDueAt <= new Date())
      ) throw new Error('SOURCE_INVALID');
      totals.delete(key);
    }
    return payment.reservations.map(({ id }) => id);
  }

  private async checkSources(
    transaction: DatabaseTransaction,
    payment: LockedPayment,
  ): Promise<void> {
    for (const [key, amount] of sourceTotals(payment)) {
      const [sourceType, sourceId, currency] = key.split(':');
      if (sourceType === 'CASHBOX') {
        const state = await this.cashboxes.payable(
          transaction,
          payment.document.organizationId,
          sourceId!,
          currency!,
          payment.document.businessDate,
          payment.document.id,
          amountString(amount),
        );
        if (state === 'CLOSED') throw new Error('CASHBOX_DATE_CLOSED');
        if (state !== 'OK') throw new Error('SOURCE_INVALID');
      } else if (!await this.banking.payable(
        transaction,
        payment.document.organizationId,
        sourceId!,
        currency!,
        payment.document.businessDate,
        payment.document.id,
        amountString(amount),
      )) throw new Error('SOURCE_INVALID');
    }
  }

  private async checkReversalSources(
    transaction: DatabaseTransaction,
    payment: LockedPayment,
    businessDate: string,
  ): Promise<void> {
    for (const line of payment.lines) {
      if (line.cashboxId) {
        const state = await this.receivingCashboxes.receivable(
          transaction,
          payment.document.organizationId,
          line.cashboxId,
          line.currency,
          businessDate,
        );
        if (state === 'CLOSED') throw new Error('CASHBOX_DATE_CLOSED');
        if (state !== 'OK') throw new Error('REVERSAL_BLOCKED');
      } else if (
        !line.bankAccountId
        || !await this.receivingBanking.receivable(
          transaction,
          payment.document.organizationId,
          line.bankAccountId,
          line.currency,
        )
      ) throw new Error('REVERSAL_BLOCKED');
    }
  }

  private async assertAuthorized(
    transaction: DatabaseTransaction,
    context: CommandContext,
    payment: LockedPayment,
    permission: 'payment.execute' | 'payment.reverse',
  ): Promise<void> {
    if (!await this.authorization.canOperatePayment(
      transaction,
      context.organizationId,
      context.actorUserId,
      authorizationContext(payment),
      permission,
    )) throw new Error('SCOPE_DENIED');
  }

  private async consumeProof(
    transaction: DatabaseTransaction,
    context: CommandContext,
  ): Promise<void> {
    if (
      !context.stepUp
      || !await this.authorization.consumeStepUpProof(transaction, {
        proofDigest: digest(context.stepUp.proofId),
        physicalSessionId: context.physicalSessionId,
        ...context.stepUp.command,
      })
    ) throw new Error('STEP_UP_INVALID');
  }

  private exactTotal(payment: LockedPayment): void {
    const total = payment.lines.reduce((sum, line) => sum + decimal(line.baseAmount), 0n);
    if (total !== decimal(payment.document.totalBaseAmount)) throw new Error('TOTAL_MISMATCH');
  }

  private validate(context: CommandContext): number {
    if (!UUID.test(context.paymentId)) this.validation('resourceId is malformed.');
    if (!context.requestId || context.requestId.length > 128) {
      this.validation('X-Request-Id is required.');
    }
    if (!context.key || context.key.length < 8 || context.key.length > 128) {
      this.validation('Idempotency-Key must contain 8 through 128 characters.');
    }
    const match = /^"([0-9]+)"$/u.exec(context.ifMatch);
    if (!match) this.validation('If-Match must be one strong numeric ETag.');
    return Number(match![1]);
  }

  private async map<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const mapped = {
        RESOURCE_HIDDEN: ['TRS-GEN-004', 404],
        SCOPE_DENIED: ['TRS-GEN-003', 403],
        INVALID_APPROVAL_EVIDENCE: ['TRS-GEN-005', 409],
        STATE_CONFLICT: ['TRS-GEN-005', 409],
        STALE_VERSION: ['TRS-GEN-006', 409],
        IDEMPOTENCY_CONFLICT: ['TRS-GEN-007', 409],
        CASHBOX_DATE_CLOSED: ['TRS-GEN-009', 409],
        STEP_UP_INVALID: ['TRS-AUT-005', 401],
        SOURCE_INVALID: ['TRS-PAY-004', 409],
        EFFECT_MAPPING: ['TRS-PAY-005', 409],
        ALLOCATION_INVALID: ['TRS-PAY-006', 409],
        AGGREGATE_STALE: ['TRS-PAY-007', 409],
        REVERSAL_BLOCKED: ['TRS-PAY-009', 409],
        TOTAL_MISMATCH: ['TRS-PAY-001', 422],
      } as const;
      const value = error instanceof Error
        ? mapped[error.message as keyof typeof mapped]
        : undefined;
      if (value) throw new TreasuryProblem(value[0], value[1]);
      const databaseError = error as { code?: string };
      if (databaseError.code === '23505') throw new TreasuryProblem('TRS-GEN-005', 409);
      if (databaseError.code === '23503') throw new TreasuryProblem('TRS-GEN-004', 404);
      if (['22003', '22P02', '23514'].includes(databaseError.code ?? '')) {
        throw new TreasuryProblem('TRS-PAY-005', 409);
      }
      throw error;
    }
  }

  private validation(detail: string): never {
    throw new TreasuryProblem('TRS-GEN-001', 422, detail);
  }
}

function authorizationContext(payment: LockedPayment): PaymentAuthorizationContext {
  return {
    branchId: payment.effectiveBranchId,
    treasuryUnitId: payment.document.treasuryUnitId,
    cashboxIds: [...new Set(payment.lines.flatMap(({ cashboxId }) => cashboxId ? [cashboxId] : []))],
    bankAccountIds: [...new Set(payment.lines.flatMap(({ bankAccountId }) =>
      bankAccountId ? [bankAccountId] : []))],
    currencies: [...new Set([
      payment.document.baseCurrency,
      ...payment.lines.map(({ currency }) => currency),
    ])],
    methodCategories: [...new Set(payment.lines.map(({ methodCategory }) => methodCategory))],
    documentType: 'PAYMENT',
    amount: payment.document.totalBaseAmount,
    amountCurrency: payment.document.baseCurrency,
  };
}

function sourceTotals(payment: LockedPayment): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const line of payment.lines) {
    const sourceType = line.cashboxId ? 'CASHBOX' : 'BANK_ACCOUNT';
    const sourceId = line.cashboxId ?? line.bankAccountId;
    if (!sourceId) throw new Error('EFFECT_MAPPING');
    const key = `${sourceType}:${sourceId}:${line.currency}`;
    totals.set(key, (totals.get(key) ?? 0n) + decimal(line.amount));
  }
  return totals;
}

function decimal(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
}

function amountString(value: bigint): string {
  const whole = value / 100_000_000n;
  const fraction = String(value % 100_000_000n).padStart(8, '0').replace(/0+$/u, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}
