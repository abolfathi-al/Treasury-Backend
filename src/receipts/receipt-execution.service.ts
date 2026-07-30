import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { AccessAuthorizationService } from '../access-control/access-authorization.service';
import type { TreasuryRequest } from '../access-control/auth.guard';
import { ReceiptBankingEffectsService } from '../banking/receipt-banking-effects.service';
import { ReceiptCashboxEffectsService } from '../cashbox-and-custody/receipt-cashbox-effects.service';
import { ReceiptChequeEffectsService } from '../cheques/receipt-cheque-effects.service';
import { CollectionEffectsService } from '../collection-and-settlement/collection-effects.service';
import { commandDigest, digest } from '../common/http';
import { TreasuryProblem } from '../common/problem';
import { DatabaseService, type DatabaseTransaction } from '../database/database.service';
import { FoundationEffectsService } from '../foundation-effects/foundation-effects.service';
import type {
  ReceiptExecuteDto,
  ReceiptExecutionEffectType,
  ReceiptReverseDto,
  ReceiptReversalResult,
  ReceiptView,
} from './receipt.dto';
import {
  LockedReceipt,
  ReceiptExecutionRepository,
  StoredExecutionResult,
} from './receipt-execution.repository';
import { ReceiptService } from './receipt.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TRANSIT = new Set([
  'BANK_TRANSFER',
  'DIRECT_DEPOSIT',
  'POS',
  'GATEWAY',
  'CARD_TRANSFER',
  'WALLET',
  'FOREIGN_REMITTANCE',
]);
const NON_TRANSIT_ONLY = new Set(['CASH', 'CHEQUE', 'OFFSET', 'OTHER_CONTROLLED']);
const REVERSIBLE_RECEIPT_STATES = new Set([
  'EXECUTED',
  'ACCOUNTING_READY',
  'ACCOUNTING_POSTED',
]);
const REVERSAL_BLOCKED_ACCOUNTING_STATES = new Set([
  'QUEUED',
  'SENDING',
  'SENDING_UNKNOWN',
  'ACCEPTED',
]);
const REVERSIBLE_POSTED_ACCOUNTING_STATES = new Set(['RETURNED', 'CORRECTED']);

interface CommandContext {
  organizationId: string;
  actorUserId: string;
  physicalSessionId: string;
  receiptId: string;
  key: string;
  ifMatch: string;
  requestId: string;
  stepUp?: TreasuryRequest['stepUp'];
}

@Injectable()
export class ReceiptExecutionService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ReceiptExecutionRepository)
    private readonly repository: ReceiptExecutionRepository,
    @Inject(ReceiptService) private readonly receipts: ReceiptService,
    @Inject(AccessAuthorizationService)
    private readonly authorization: AccessAuthorizationService,
    @Inject(ReceiptCashboxEffectsService)
    private readonly cashboxes: ReceiptCashboxEffectsService,
    @Inject(ReceiptBankingEffectsService)
    private readonly banking: ReceiptBankingEffectsService,
    @Inject(ReceiptChequeEffectsService)
    private readonly cheques: ReceiptChequeEffectsService,
    @Inject(CollectionEffectsService)
    private readonly collections: CollectionEffectsService,
    @Inject(FoundationEffectsService)
    private readonly foundation: FoundationEffectsService,
  ) {}

  async execute(
    context: CommandContext,
    body?: ReceiptExecuteDto,
  ): Promise<ReceiptView> {
    const expectedVersion = this.validate(context);
    const scope = `executeReceipt:${context.actorUserId}:${context.receiptId}`;
    const requestDigest = commandDigest('executeReceipt', {
      actorUserId: context.actorUserId,
      receiptId: context.receiptId,
      ifMatch: context.ifMatch,
      body: body ?? null,
    });
    const result = await this.map<StoredExecutionResult>(() => this.database.db.transaction(async (transaction) => {
      const replay = await this.idempotency(
        transaction,
        context,
        scope,
        requestDigest,
        'receipt.execute',
      );
      if (replay) {
        if (!replay.response || replay.etag !== `"${replay.version}"`) {
          throw new Error('IDEMPOTENCY_CONFLICT');
        }
        return replay;
      }

      const receipt = await this.repository.lockReceipt(
        transaction,
        context.organizationId,
        context.receiptId,
      );
      if (!receipt) throw new Error('RESOURCE_HIDDEN');
      if (Number(receipt.document.version) !== expectedVersion) throw new Error('STALE_VERSION');
      if (receipt.document.state !== 'APPROVED') throw new Error('STATE_CONFLICT');
      this.exactTotal(receipt);

      const conflicts = [
        receipt.document.creatorUserId,
        ...receipt.approverUserIds,
      ].filter((id) => id === context.actorUserId);
      if (conflicts.length > 0) {
        const override = body?.separationOverride;
        if (!override) throw new Error('SCOPE_DENIED');
        if (!await this.authorization.hasOrganizationPermission(
          transaction,
          context.organizationId,
          context.actorUserId,
          'separation.override',
        )) throw new Error('SCOPE_DENIED');
        const evidence = await this.repository.overrideApprovalValid(transaction, {
          organizationId: context.organizationId,
          receipt,
          approvalActionId: override.independentApprovalActionId,
          reason: override.reason,
          executorUserId: context.actorUserId,
          conflictingUserIds: conflicts,
        });
        if (evidence === 'INVALID_EVIDENCE') throw new Error('INVALID_APPROVAL_EVIDENCE');
        if (evidence === 'NOT_INDEPENDENT') throw new Error('SCOPE_DENIED');
        await this.consumeProof(transaction, context);
      } else if (body?.separationOverride) {
        throw new Error('INVALID_APPROVAL_EVIDENCE');
      }

      const executedAt = new Date();
      const sourceVersion = expectedVersion + 1;
      const effects = [];
      for (const line of receipt.lines) {
        const effect = await this.executeLine(
          transaction,
          receipt,
          line,
          sourceVersion,
          executedAt,
        );
        effects.push(effect);
      }
      await this.repository.markExecuted(transaction, {
        organizationId: context.organizationId,
        receiptId: context.receiptId,
        actorUserId: context.actorUserId,
        executedAt,
        version: sourceVersion,
      });
      await this.foundation.appendAudit(transaction, {
        organizationId: context.organizationId,
        requestId: context.requestId,
        actorUserId: context.actorUserId,
        entityId: context.receiptId,
        action: body?.separationOverride ? 'RECEIPT_EXECUTED_OVERRIDE' : 'RECEIPT_EXECUTED',
        reason: body?.separationOverride?.reason,
      });
      await this.foundation.appendOutbox(transaction, {
        organizationId: context.organizationId,
        aggregateId: context.receiptId,
        aggregateVersion: sourceVersion,
        eventType: 'treasury.receipt.executed.v1',
        payload: {
          sourceType: 'Receipt',
          sourceId: context.receiptId,
          sourceVersion,
          businessDate: receipt.document.businessDate,
          effects,
        },
      });
      const response = await this.repository.completedExecutionResponse(
        transaction,
        context.organizationId,
        context.receiptId,
      );
      if (!response || response.version !== sourceVersion) {
        throw new Error('IDEMPOTENCY_CONFLICT');
      }
      const outcome: StoredExecutionResult = {
        receiptId: context.receiptId,
        version: sourceVersion,
        response,
        etag: `"${sourceVersion}"`,
      };
      await this.repository.finishIdempotency(
        transaction,
        context.organizationId,
        scope,
        context.key,
        200,
        outcome,
      );
      return outcome;
    }));
    if (!result.response || result.etag !== `"${result.version}"`) {
      throw new TreasuryProblem('TRS-GEN-007', 409);
    }
    return result.response;
  }

  async reverse(
    context: CommandContext,
    body: ReceiptReverseDto,
  ): Promise<ReceiptReversalResult> {
    const expectedVersion = this.validate(context);
    const reason = body.reason.trim();
    if (!reason) this.validation('reason is required.');
    const requestDigest = commandDigest('reverseReceipt', {
      actorUserId: context.actorUserId,
      receiptId: context.receiptId,
      ifMatch: context.ifMatch,
      body: { ...body, reason },
    });
    const result = await this.map(() => this.database.db.transaction(async (transaction) => {
      const scope = `reverseReceipt:${context.actorUserId}:${context.receiptId}`;
      const replay = await this.idempotency(
        transaction,
        context,
        scope,
        requestDigest,
        'receipt.reverse',
      );
      if (replay) return replay;
      const original = await this.repository.lockReceipt(
        transaction,
        context.organizationId,
        context.receiptId,
      );
      if (!original) throw new Error('RESOURCE_HIDDEN');
      if (this.isReversalBlocked(original.document)) throw new Error('REVERSAL_BLOCKED');
      if (Number(original.document.version) !== expectedVersion) throw new Error('STALE_VERSION');

      const priorActors = new Set([
        original.document.creatorUserId,
        original.document.executedByUserId,
        ...original.approverUserIds,
      ]);
      if (priorActors.has(context.actorUserId)) throw new Error('SCOPE_DENIED');
      await this.consumeProof(transaction, context);

      const at = new Date();
      const reversal = await this.repository.createReversalReceipt(transaction, {
        original,
        actorUserId: context.actorUserId,
        businessDate: body.businessDate,
        executedAt: at,
      });
      const originalEffects = await this.repository.effects(
        transaction,
        context.organizationId,
        context.receiptId,
      );
      if (originalEffects.length !== original.lines.length) throw new Error('REVERSAL_BLOCKED');
      const reversalEffects = [];
      for (const effect of originalEffects) {
        const reversalLineId = reversal.lineIds.get(effect.receiptLineId);
        if (!reversalLineId) throw new Error('REVERSAL_BLOCKED');
        const concrete = await this.reverseEffect(
          transaction,
          context,
          effect,
          reversal.receiptId,
          reversalLineId,
          body.businessDate,
        );
        reversalEffects.push(concrete);
      }
      await this.repository.completeReversal(transaction, {
        organizationId: context.organizationId,
        originalReceiptId: context.receiptId,
        reversalReceiptId: reversal.receiptId,
        originalVersion: expectedVersion + 1,
        at,
      });
      await this.foundation.appendAudit(transaction, {
        organizationId: context.organizationId,
        requestId: context.requestId,
        actorUserId: context.actorUserId,
        entityId: context.receiptId,
        action: 'RECEIPT_REVERSED',
        reason,
      });
      await this.foundation.appendOutbox(transaction, {
        organizationId: context.organizationId,
        aggregateId: context.receiptId,
        aggregateVersion: expectedVersion + 1,
        eventType: 'treasury.receipt.reversed.v1',
        payload: {
          sourceType: 'Receipt',
          sourceId: context.receiptId,
          sourceVersion: expectedVersion + 1,
          businessDate: body.businessDate,
          reversalReceiptId: reversal.receiptId,
          reversalReceiptVersion: 1,
          effects: reversalEffects,
        },
      });
      const outcome = {
        receiptId: context.receiptId,
        version: expectedVersion + 1,
        reversalReceiptId: reversal.receiptId,
        reversalReceiptVersion: 1,
      };
      await this.repository.finishIdempotency(
        transaction,
        context.organizationId,
        scope,
        context.key,
        201,
        outcome,
      );
      return outcome;
    }));
    return {
      originalReceipt: await this.view(context, result.receiptId),
      reversalReceipt: await this.view(context, result.reversalReceiptId!),
    };
  }

  private isReversalBlocked(document: LockedReceipt['document']): boolean {
    if (
      document.reversalReceiptId
      || !REVERSIBLE_RECEIPT_STATES.has(document.state)
      || REVERSAL_BLOCKED_ACCOUNTING_STATES.has(document.accountingState)
    ) return true;
    return document.state === 'ACCOUNTING_POSTED'
      && !REVERSIBLE_POSTED_ACCOUNTING_STATES.has(document.accountingState);
  }

  private async executeLine(
    transaction: DatabaseTransaction,
    receipt: LockedReceipt,
    line: LockedReceipt['lines'][number],
    sourceVersion: number,
    executedAt: Date,
  ) {
    const category = line.methodCategory;
    if (NON_TRANSIT_ONLY.has(category) && line.createsFundsInTransit) {
      throw new Error('METHOD_CONFIG');
    }
    const effectKey = `receipt:${receipt.document.id}:line:${line.id}:incoming`;
    let effectType: ReceiptExecutionEffectType;
    let movementFactId: string | undefined;
    let receivedChequeId: string | undefined;
    let collectionItemId: string | undefined;

    if (category === 'CASH') {
      if (!line.cashboxId) throw new Error('EFFECT_MAPPING');
      const state = await this.cashboxes.receivable(
        transaction,
        receipt.document.organizationId,
        line.cashboxId,
        line.currency,
        receipt.document.businessDate,
      );
      if (state === 'CLOSED') throw new Error('CASHBOX_DATE_CLOSED');
      if (state !== 'OK') throw new Error('INACTIVE_REFERENCE');
      effectType = 'CASHBOX_MOVEMENT';
      movementFactId = await this.foundation.appendMovement(transaction, {
        organizationId: receipt.document.organizationId,
        sourceId: receipt.document.id,
        sourceLineId: line.id,
        effectKey,
        endpointType: 'CASHBOX',
        endpointId: line.cashboxId,
        amount: line.amount,
        currency: line.currency,
        businessDate: receipt.document.businessDate,
      });
    } else if (category === 'CHEQUE') {
      if (!line.chequeInput) throw new Error('EFFECT_MAPPING');
      effectType = 'RECEIVED_CHEQUE';
      receivedChequeId = await this.cheques.createReceived(transaction, {
        organizationId: receipt.document.organizationId,
        receiptLineId: line.id,
        cheque: line.chequeInput,
        amount: line.amount,
        currency: line.currency,
        custodianType: line.cashboxId ? 'CASHBOX' : 'TREASURY_UNIT',
        custodianId: line.cashboxId ?? receipt.document.treasuryUnitId,
      });
    } else if (TRANSIT.has(category) && line.createsFundsInTransit) {
      if (!line.effectiveBankAccountId || !line.dueDate) {
        throw new Error('EFFECT_MAPPING');
      }
      const destination = await this.banking.collectionDestination(
        transaction,
        receipt.document.organizationId,
        line.effectiveBankAccountId,
        line.currency,
      );
      if (!destination) throw new Error('BANK_UNAVAILABLE');
      effectType = 'COLLECTION_ITEM';
      collectionItemId = await this.collections.create(transaction, {
        organizationId: receipt.document.organizationId,
        receiptLineId: line.id,
        branchId: destination.branchId,
        treasuryUnitId: destination.treasuryUnitId,
        channelType: category,
        channelId: line.posTerminalId ?? line.paymentGatewayId ?? undefined,
        providerReference: line.trackingNumber ?? undefined,
        collectedPartyId: receipt.document.partyId,
        amount: line.amount,
        currency: line.currency,
        destinationBankAccountId: line.effectiveBankAccountId,
        collectedAt: executedAt,
        expectedSettlementDate: line.dueDate,
      });
    } else if (TRANSIT.has(category) && !line.createsFundsInTransit) {
      if (!line.effectiveBankAccountId) throw new Error('EFFECT_MAPPING');
      if (!await this.banking.receivable(
        transaction,
        receipt.document.organizationId,
        line.effectiveBankAccountId,
        line.currency,
      )) throw new Error('BANK_UNAVAILABLE');
      effectType = 'BANK_MOVEMENT';
      movementFactId = await this.foundation.appendMovement(transaction, {
        organizationId: receipt.document.organizationId,
        sourceId: receipt.document.id,
        sourceLineId: line.id,
        effectKey,
        endpointType: 'BANK_ACCOUNT',
        endpointId: line.effectiveBankAccountId,
        amount: line.amount,
        currency: line.currency,
        businessDate: receipt.document.businessDate,
      });
    } else {
      throw new Error('EFFECT_MAPPING');
    }
    const receiptEffectId = await this.repository.appendEffect(transaction, {
      organizationId: receipt.document.organizationId,
      receiptLineId: line.id,
      effectKey,
      effectType,
      direction: 'INCOMING',
      amount: line.amount,
      currency: line.currency,
      businessDate: receipt.document.businessDate,
      sourceVersion,
      movementFactId,
      receivedChequeId,
      collectionItemId,
    });
    return {
      receiptEffectId,
      receiptLineId: line.id,
      effectKey,
      effectType,
      effectId: movementFactId ?? receivedChequeId ?? collectionItemId,
      direction: 'INCOMING',
      money: { amount: line.amount, currency: line.currency },
      businessDate: receipt.document.businessDate,
      sourceVersion,
    };
  }

  private async reverseEffect(
    transaction: DatabaseTransaction,
    context: CommandContext,
    effect: Awaited<ReturnType<ReceiptExecutionRepository['effects']>>[number],
    reversalReceiptId: string,
    reversalLineId: string,
    businessDate: string,
  ) {
    const effectKey = `receipt:${reversalReceiptId}:line:${reversalLineId}:reversal`;
    let movementFactId: string | undefined;
    let chequeEventId: string | undefined;
    let collectionItemVersion: number | undefined;
    let collectionItemState: 'RETURNED' | 'REOPENED_AFTER_REVERSAL' | undefined;
    if (effect.movementFactId) {
      const endpointId = await this.endpointId(transaction, effect.movementFactId);
      if (effect.effectType === 'CASHBOX_MOVEMENT') {
        const state = await this.cashboxes.receivable(
          transaction,
          context.organizationId,
          endpointId,
          effect.currency,
          businessDate,
        );
        if (state === 'CLOSED') throw new Error('CASHBOX_DATE_CLOSED');
        if (state !== 'OK') throw new Error('REVERSAL_BLOCKED');
      } else if (!await this.banking.receivable(
        transaction,
        context.organizationId,
        endpointId,
        effect.currency,
      )) {
        throw new Error('REVERSAL_BLOCKED');
      }
      movementFactId = await this.foundation.appendMovement(transaction, {
        organizationId: context.organizationId,
        sourceId: reversalReceiptId,
        sourceLineId: reversalLineId,
        effectKey,
        endpointType: effect.effectType === 'CASHBOX_MOVEMENT' ? 'CASHBOX' : 'BANK_ACCOUNT',
        endpointId,
        amount: effect.amount,
        currency: effect.currency,
        businessDate,
        reversalOfFactId: effect.movementFactId,
      });
    } else if (effect.receivedChequeId) {
      chequeEventId = await this.cheques.reversalEvent(transaction, effect.receivedChequeId);
      if (!chequeEventId) throw new Error('REVERSAL_BLOCKED');
    } else if (effect.collectionItemId) {
      const snapshot = await this.collections.reversibleSnapshot(
        transaction,
        context.organizationId,
        effect.collectionItemId,
      );
      if (!snapshot) throw new Error('REVERSAL_BLOCKED');
      collectionItemVersion = snapshot.version;
      collectionItemState = snapshot.state;
    } else {
      throw new Error('REVERSAL_BLOCKED');
    }
    const receiptEffectId = await this.repository.appendEffect(transaction, {
      organizationId: context.organizationId,
      receiptLineId: reversalLineId,
      effectKey,
      effectType: effect.effectType as ReceiptExecutionEffectType,
      direction: 'REVERSAL',
      amount: effect.amount,
      currency: effect.currency,
      businessDate,
      sourceVersion: 1,
      movementFactId,
      chequeEventId,
      collectionItemId: effect.collectionItemId ?? undefined,
      collectionItemVersion,
      collectionItemState,
      reversalOfEffectId: effect.id,
    });
    return {
      receiptEffectId,
      receiptLineId: reversalLineId,
      effectKey,
      effectType: effect.effectType,
      ...(movementFactId ? { effectId: movementFactId } : {}),
      ...(chequeEventId ? { chequeEventId } : {}),
      ...(effect.collectionItemId ? { collectionItemId: effect.collectionItemId } : {}),
      ...(collectionItemVersion === undefined ? {} : { collectionItemVersion }),
      ...(collectionItemState ? { collectionItemState } : {}),
      direction: 'REVERSAL',
      money: { amount: effect.amount, currency: effect.currency },
      businessDate,
      sourceVersion: 1,
      reversalOfEffectId: effect.id,
    };
  }

  private async endpointId(
    transaction: DatabaseTransaction,
    movementFactId: string,
  ): Promise<string> {
    const result = await transaction.execute<{ endpointId: string }>(
      // The original endpoint is required for an exact inverse and the self-reference is locked.
      // This is deliberately explicit PostgreSQL SQL rather than a query-builder abstraction.
      sql`
        SELECT endpoint_id AS "endpointId"
        FROM movement_facts
        WHERE id = ${movementFactId}
        FOR KEY SHARE
      `,
    );
    if (result.rows.length !== 1) throw new Error('REVERSAL_BLOCKED');
    return result.rows[0]!.endpointId;
  }

  private async idempotency(
    transaction: DatabaseTransaction,
    context: CommandContext,
    scope: string,
    requestDigest: string,
    permission: 'receipt.execute' | 'receipt.reverse',
  ): Promise<StoredExecutionResult | undefined> {
    await this.repository.acquireIdempotencyLock(
      transaction,
      context.organizationId,
      scope,
      context.key,
    );
    const replay = await this.repository.findIdempotency(
      transaction,
      context.organizationId,
      scope,
      context.key,
    );
    if (!await this.authorization.canOperateReceipt(
      transaction,
      context.organizationId,
      context.actorUserId,
      context.receiptId,
      permission,
    )) throw new Error('SCOPE_DENIED');
    if (replay) {
      if (replay.requestDigest !== requestDigest || !replay.result) {
        throw new Error('IDEMPOTENCY_CONFLICT');
      }
      return replay.result;
    }
    await this.repository.startIdempotency(
      transaction,
      context.organizationId,
      scope,
      context.key,
      requestDigest,
    );
    return undefined;
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

  private validate(context: CommandContext): number {
    if (!UUID.test(context.receiptId)) this.validation('resourceId is malformed.');
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

  private exactTotal(receipt: LockedReceipt): void {
    const total = receipt.lines.reduce(
      (sum, line) => sum + decimalUnits(line.baseAmount),
      0n,
    );
    if (total !== decimalUnits(receipt.document.totalBaseAmount)) {
      throw new Error('TOTAL_MISMATCH');
    }
  }

  private async view(context: CommandContext, receiptId: string): Promise<ReceiptView> {
    const view = await this.receipts.get(
      context.organizationId,
      context.actorUserId,
      receiptId,
    );
    const effects = await this.database.db.transaction((transaction) =>
      this.repository.effects(transaction, context.organizationId, receiptId));
    const byLine = new Map<string, typeof effects>();
    for (const effect of effects) {
      const list = byLine.get(effect.receiptLineId) ?? [];
      list.push(effect);
      byLine.set(effect.receiptLineId, list);
    }
    return {
      ...view,
      lines: view.lines.map((line) => ({
        ...line,
        executionEffects: (byLine.get(line.id) ?? [])
          .map((effect) => this.repository.effectView(effect)),
      })),
    };
  }

  private async map<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === '23505' && String((error as { constraint?: string }).constraint)
        .includes('received_cheques')) throw new TreasuryProblem('TRS-CHQ-005', 409);
      const mapped = {
        RESOURCE_HIDDEN: ['TRS-GEN-004', 404],
        SCOPE_DENIED: ['TRS-GEN-003', 403],
        INVALID_APPROVAL_EVIDENCE: ['TRS-GEN-005', 409],
        STATE_CONFLICT: ['TRS-GEN-005', 409],
        COLLECTION_IDENTITY_CONFLICT: ['TRS-GEN-005', 409],
        STALE_VERSION: ['TRS-GEN-006', 409],
        IDEMPOTENCY_CONFLICT: ['TRS-GEN-007', 409],
        CASHBOX_DATE_CLOSED: ['TRS-GEN-009', 409],
        INACTIVE_REFERENCE: ['TRS-MST-001', 409],
        METHOD_CONFIG: ['TRS-MST-004', 409],
        BANK_UNAVAILABLE: ['TRS-BNK-001', 409],
        EFFECT_MAPPING: ['TRS-RCP-004', 422],
        REVERSAL_BLOCKED: ['TRS-RCP-006', 409],
        TOTAL_MISMATCH: ['TRS-RCP-001', 422],
        STEP_UP_INVALID: ['TRS-AUT-005', 401],
      } as const;
      const value = error instanceof Error
        ? mapped[error.message as keyof typeof mapped]
        : undefined;
      if (value) throw new TreasuryProblem(value[0], value[1]);
      throw error;
    }
  }

  private validation(detail: string): never {
    throw new TreasuryProblem('TRS-GEN-001', 422, detail);
  }
}

function decimalUnits(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 100_000_000n
    + BigInt(fraction.padEnd(8, '0').slice(0, 8));
}
