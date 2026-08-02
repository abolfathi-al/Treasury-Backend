import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { AccessAuthorizationService } from '../access-control/access-authorization.service';
import type { TreasuryRequest } from '../access-control/auth.guard';
import { commandDigest, digest } from '../common/http';
import { TreasuryProblem } from '../common/problem';
import { DatabaseService, type DatabaseTransaction } from '../database/database.service';
import { FoundationEffectsService } from '../foundation-effects/foundation-effects.service';
import {
  SettlementBatchView,
  SettlementCreateDto,
  SettlementDiscrepancyDisposition,
  SettlementEffectType,
  SettlementMatchKind,
  SettlementReversalResult,
  SettlementReverseDto,
} from './settlement.dto';
import {
  LockedSettlement,
  SettlementFacts,
  SettlementRepository,
} from './settlement.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SCALE = 100_000_000n;

interface SettlementCommandContext {
  organizationId: string;
  actorUserId: string;
  physicalSessionId: string;
  batchId: string;
  key: string;
  ifMatch: string;
  requestId: string;
  stepUp?: TreasuryRequest['stepUp'];
}

@Injectable()
export class SettlementService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SettlementRepository) private readonly repository: SettlementRepository,
    @Inject(AccessAuthorizationService)
    private readonly authorization: AccessAuthorizationService,
    @Inject(FoundationEffectsService)
    private readonly foundation: FoundationEffectsService,
  ) {}

  create(
    organizationId: string,
    actorUserId: string,
    dto: SettlementCreateDto,
    rawKey: string,
    requestId: string,
  ): Promise<SettlementBatchView> {
    return this.map(async () => {
      this.requiredRequestId(requestId);
      const key = this.key(rawKey);
      const normalized = this.validateCreate(dto);
      const scope = `createSettlementBatch:${actorUserId}`;
      const requestDigest = commandDigest('createSettlementBatch', {
        actorUserId,
        body: normalized,
      });
      return this.database.db.transaction(async (transaction) => {
      await this.repository.acquireIdempotencyLock(transaction, organizationId, scope, key);
      const replay = await this.repository.findIdempotency<SettlementBatchView>(
        transaction, organizationId, scope, key,
      );
      if (replay) {
        if (replay.requestDigest !== requestDigest || !replay.response) {
          throw new Error('IDEMPOTENCY_CONFLICT');
        }
        const locked = await this.repository.lock(
          transaction,
          organizationId,
          replay.response.id,
        );
        if (!locked) throw new Error('RESOURCE_HIDDEN');
        await this.assertAuthorized(
          transaction,
          organizationId,
          actorUserId,
          replay.response.destinationBankAccountId,
          replay.response.gross.currency,
          replay.response.gross.amount,
          locked.items,
          'settlement.create',
        );
        return replay.response;
      }
      const facts = await this.repository.facts(transaction, organizationId, actorUserId, normalized);
      this.validateFacts(normalized, facts);
      await this.assertAuthorized(
        transaction,
        organizationId,
        actorUserId,
        normalized.destinationBankAccountId,
        normalized.gross.currency,
        normalized.gross.amount,
        facts.items,
        'settlement.create',
      );
      await this.repository.startIdempotency(
        transaction, organizationId, scope, key, requestDigest,
      );
      const id = randomUUID();
      await this.repository.insertProposal(transaction, {
        id,
        organizationId,
        actorUserId,
        businessNumber: await this.repository.nextNumber(transaction, organizationId),
        currency: normalized.gross.currency,
        state: units(normalized.discrepancy.amount) === 0n ? 'MATCHED' : 'DISCREPANCY',
        dto: normalized,
      });
      const response = await this.repository.view(transaction, organizationId, id);
      if (!response) throw new Error('CONFIRMATION_UNKNOWN');
      await this.repository.finishIdempotency(
        transaction, organizationId, scope, key, response, 201,
      );
      return response;
      });
    });
  }

  confirm(context: SettlementCommandContext): Promise<SettlementBatchView> {
    const expectedVersion = this.validateCommand(context);
    const scope = `confirmSettlementBatch:${context.actorUserId}:${context.batchId}`;
    const requestDigest = commandDigest('confirmSettlementBatch', {
      actorUserId: context.actorUserId,
      batchId: context.batchId,
      ifMatch: context.ifMatch,
    });
    return this.map(() => this.database.db.transaction(async (transaction) => {
      await this.repository.acquireIdempotencyLock(
        transaction, context.organizationId, scope, context.key,
      );
      const locked = await this.repository.lock(
        transaction, context.organizationId, context.batchId,
      );
      if (!locked) throw new Error('RESOURCE_HIDDEN');
      await this.assertAuthorizedForBatch(transaction, context, locked, 'settlement.confirm');
      const replay = await this.repository.findIdempotency<SettlementBatchView>(
        transaction, context.organizationId, scope, context.key,
      );
      if (replay) {
        if (replay.requestDigest !== requestDigest || !replay.response) {
          throw new Error('IDEMPOTENCY_CONFLICT');
        }
        return replay.response;
      }
      await this.repository.startIdempotency(
        transaction, context.organizationId, scope, context.key, requestDigest,
      );
      if (Number(locked.batch.version) !== expectedVersion) throw new Error('STALE_VERSION');
      if (!['MATCHED', 'DISCREPANCY'].includes(locked.batch.state)) throw new Error('STATE_CONFLICT');
      if (locked.batch.creatorUserId === context.actorUserId) throw new Error('SCOPE_DENIED');
      if (
        units(locked.batch.discrepancyAmount) !== 0n
        && locked.batch.discrepancyDisposition !== 'APPROVED_DIFFERENCE'
      ) throw new Error('DISCREPANCY_UNRESOLVED');
      const evidence = await this.repository.confirmationFacts(
        transaction, context.organizationId, locked.batch,
      );
      if (
        !evidence.account
        || evidence.account.state !== 'ACTIVE'
        || !evidence.account.canReceive
        || evidence.account.currency !== locked.batch.currency
        || !evidence.attachments.length
        || evidence.attachments.some(({ state, linkedDigest, currentDigest }) =>
          state !== 'ACTIVE' || linkedDigest !== currentDigest)
      ) throw new Error('EVIDENCE_INVALID');
      this.validateLockedAllocations(locked);

      const confirmedAt = new Date();
      const sourceVersion = expectedVersion + 1;
      await this.repository.confirmBatch(
        transaction,
        context.organizationId,
        context.batchId,
        context.actorUserId,
        confirmedAt,
      );
      for (const allocation of locked.allocations) {
        const item = locked.items.find(({ id }) => id === allocation.collectionItemId)!;
        const nextAllocated = units(item.allocatedAmount) + units(allocation.allocatedAmount);
        const nextRemaining = units(item.remainingAmount) - units(allocation.allocatedAmount);
        await this.repository.allocationState(
          transaction, context.organizationId, allocation.id, 'CONFIRMED',
        );
        await this.repository.collectionBalance(
          transaction,
          context.organizationId,
          item.id,
          amount(nextAllocated),
          amount(nextRemaining),
          nextRemaining === 0n ? 'SETTLED' : 'PARTIALLY_ALLOCATED',
          confirmedAt,
        );
      }

      const bankMovementId = await this.foundation.appendMovement(transaction, {
        organizationId: context.organizationId,
        owner: 'domain.collection-and-settlement',
        sourceType: 'SettlementBatch',
        sourceId: context.batchId,
        sourceLineId: context.batchId,
        effectKey: 'bank-credit',
        endpointType: 'BANK_ACCOUNT',
        endpointId: locked.batch.destinationBankAccountId,
        direction: 'CREDIT',
        amount: locked.batch.actualNetAmount,
        currency: locked.batch.currency,
        businessDate: locked.batch.settlementDate,
        state: 'POSTED',
      });
      await this.repository.appendEffect(transaction, {
        organizationId: context.organizationId,
        settlementBatchId: context.batchId,
        effectKey: 'bank-credit',
        effectType: 'BANK_CREDIT',
        direction: 'SETTLEMENT',
        amount: locked.batch.actualNetAmount,
        currency: locked.batch.currency,
        businessDate: locked.batch.settlementDate,
        sourceVersion,
        movementFactId: bankMovementId,
      });
      for (const allocation of locked.allocations) {
        await this.repository.appendEffect(transaction, {
          organizationId: context.organizationId,
          settlementBatchId: context.batchId,
          effectKey: `allocation:${allocation.id}`,
          effectType: 'ALLOCATION_CONSUMPTION',
          direction: 'SETTLEMENT',
          amount: allocation.allocatedAmount,
          currency: allocation.currency,
          businessDate: locked.batch.settlementDate,
          sourceVersion,
          collectionItemId: allocation.collectionItemId,
        });
      }
      await this.appendOptionalEvidenceEffects(transaction, locked, sourceVersion);
      await this.foundation.appendAudit(transaction, {
        organizationId: context.organizationId,
        requestId: context.requestId,
        actorUserId: context.actorUserId,
        entityType: 'SettlementBatch',
        entityId: context.batchId,
        action: 'SETTLEMENT_CONFIRMED',
      });
      const response = await this.repository.view(
        transaction, context.organizationId, context.batchId,
      );
      if (!response || response.version !== sourceVersion) throw new Error('CONFIRMATION_UNKNOWN');
      await this.foundation.appendOutbox(transaction, {
        organizationId: context.organizationId,
        aggregateType: 'SettlementBatch',
        aggregateId: context.batchId,
        aggregateVersion: sourceVersion,
        eventType: 'treasury.collection.settled.v1',
        payload: {
          sourceType: 'SettlementBatch',
          sourceId: context.batchId,
          sourceVersion,
          businessDate: locked.batch.settlementDate,
          destinationBankAccountId: locked.batch.destinationBankAccountId,
          match: response.match,
          actualNet: response.actualNet,
          allocations: response.allocations,
          effects: response.effects,
        },
      });
      await this.repository.finishIdempotency(
        transaction, context.organizationId, scope, context.key, response, 200,
      );
      return response;
    }));
  }

  reverse(
    context: SettlementCommandContext,
    body: SettlementReverseDto,
  ): Promise<SettlementReversalResult> {
    const expectedVersion = this.validateCommand(context);
    const reason = body.reason.trim();
    if (!reason) this.validation('reason is required.');
    const scope = `reverseSettlementBatch:${context.actorUserId}:${context.batchId}`;
    const requestDigest = commandDigest('reverseSettlementBatch', {
      actorUserId: context.actorUserId,
      batchId: context.batchId,
      ifMatch: context.ifMatch,
      body: { ...body, reason },
    });
    return this.map(() => this.database.db.transaction(async (transaction) => {
      await this.repository.acquireIdempotencyLock(
        transaction, context.organizationId, scope, context.key,
      );
      const locked = await this.repository.lock(
        transaction, context.organizationId, context.batchId,
      );
      if (!locked) throw new Error('RESOURCE_HIDDEN');
      await this.assertAuthorizedForBatch(transaction, context, locked, 'settlement.reverse');
      const replay = await this.repository.findIdempotency<SettlementReversalResult>(
        transaction, context.organizationId, scope, context.key,
      );
      if (replay) {
        if (replay.requestDigest !== requestDigest || !replay.response) {
          throw new Error('IDEMPOTENCY_CONFLICT');
        }
        return replay.response;
      }
      await this.repository.startIdempotency(
        transaction, context.organizationId, scope, context.key, requestDigest,
      );
      if (Number(locked.batch.version) !== expectedVersion) throw new Error('STALE_VERSION');
      if (locked.batch.state !== 'CONFIRMED') throw new Error('REVERSAL_CONFLICT');
      if (
        locked.batch.creatorUserId === context.actorUserId
        || locked.batch.confirmedBy === context.actorUserId
      ) throw new Error('SCOPE_DENIED');
      if (!locked.effects.length || !locked.effects.some(({ effectType }) => effectType === 'BANK_CREDIT')) {
        throw new Error('REVERSAL_CONFLICT');
      }
      await this.consumeProof(transaction, context);

      const reversedAt = new Date();
      const reversalId = randomUUID();
      await this.repository.reverseBatch(
        transaction,
        context.organizationId,
        context.batchId,
        context.actorUserId,
        reversedAt,
      );
      await this.repository.insertReversal(transaction, {
        id: reversalId,
        organizationId: context.organizationId,
        businessNumber: await this.repository.nextNumber(transaction, context.organizationId),
        original: locked.batch,
        actorUserId: context.actorUserId,
        reason,
        businessDate: body.businessDate,
        at: reversedAt,
      });
      for (const allocation of locked.allocations) {
        const item = locked.items.find(({ id }) => id === allocation.collectionItemId);
        if (!item || allocation.state !== 'CONFIRMED') throw new Error('REVERSAL_CONFLICT');
        const nextAllocated = units(item.allocatedAmount) - units(allocation.allocatedAmount);
        const nextRemaining = units(item.remainingAmount) + units(allocation.allocatedAmount);
        if (nextAllocated < 0n || nextRemaining > units(item.grossAmount)) {
          throw new Error('REVERSAL_CONFLICT');
        }
        await this.repository.allocationState(
          transaction, context.organizationId, allocation.id, 'REVERSED',
        );
        await this.repository.collectionBalance(
          transaction,
          context.organizationId,
          item.id,
          amount(nextAllocated),
          amount(nextRemaining),
          nextAllocated === 0n ? 'REOPENED_AFTER_REVERSAL' : 'PARTIALLY_ALLOCATED',
          reversedAt,
        );
      }
      for (const effect of locked.effects) {
        let movementFactId: string | undefined;
        if (effect.effectType === 'BANK_CREDIT') {
          if (!effect.movementFactId) throw new Error('REVERSAL_CONFLICT');
          movementFactId = await this.foundation.appendMovement(transaction, {
            organizationId: context.organizationId,
            owner: 'domain.collection-and-settlement',
            sourceType: 'SettlementBatch',
            sourceId: reversalId,
            sourceLineId: reversalId,
            effectKey: 'bank-credit-reversal',
            endpointType: 'BANK_ACCOUNT',
            endpointId: locked.batch.destinationBankAccountId,
            direction: 'DEBIT',
            amount: effect.amount,
            currency: effect.currency,
            businessDate: body.businessDate,
            reversalOfFactId: effect.movementFactId,
            state: 'REVERSED',
          });
        }
        await this.repository.appendEffect(transaction, {
          organizationId: context.organizationId,
          settlementBatchId: reversalId,
          effectKey: `reverse:${effect.effectKey}`,
          effectType: effect.effectType as SettlementEffectType,
          direction: 'REVERSAL',
          amount: effect.amount,
          currency: effect.currency,
          businessDate: body.businessDate,
          sourceVersion: 0,
          ...(movementFactId ? { movementFactId } : {}),
          ...(effect.collectionItemId ? { collectionItemId: effect.collectionItemId } : {}),
          reversalOfEffectId: effect.id,
        });
      }
      await this.foundation.appendAudit(transaction, {
        organizationId: context.organizationId,
        requestId: context.requestId,
        actorUserId: context.actorUserId,
        entityType: 'SettlementBatch',
        entityId: context.batchId,
        action: 'SETTLEMENT_REVERSED',
        reason,
      });
      const original = await this.repository.view(
        transaction, context.organizationId, context.batchId,
      );
      const reversal = await this.repository.reversalView(
        transaction, context.organizationId, reversalId,
      );
      if (!original || !reversal) throw new Error('REVERSAL_CONFLICT');
      const response = { original, reversal };
      await this.foundation.appendOutbox(transaction, {
        organizationId: context.organizationId,
        aggregateType: 'SettlementBatch',
        aggregateId: context.batchId,
        aggregateVersion: expectedVersion + 1,
        eventType: 'treasury.collection.settlement-reversed.v1',
        payload: {
          sourceType: 'SettlementBatch',
          sourceId: context.batchId,
          sourceVersion: expectedVersion + 1,
          businessDate: body.businessDate,
          reversalBatchId: reversal.id,
          reversalBatchVersion: reversal.version,
          effects: reversal.effects,
        },
      });
      await this.repository.finishIdempotency(
        transaction, context.organizationId, scope, context.key, response, 201,
      );
      return response;
    }));
  }

  private validateCreate(dto: SettlementCreateDto): SettlementCreateDto {
    const currencies = [
      dto.gross,
      dto.fee,
      dto.deduction,
      dto.expectedNet,
      dto.actualNet,
      dto.discrepancy,
      ...dto.allocations.map(({ amount: money }) => money),
    ].map(({ currency }) => currency);
    if (new Set(currencies).size !== 1) throw new Error('ARITHMETIC_MISMATCH');
    const gross = units(dto.gross.amount);
    const fee = units(dto.fee.amount);
    const deduction = units(dto.deduction.amount);
    const expected = units(dto.expectedNet.amount);
    const actual = units(dto.actualNet.amount);
    const discrepancy = units(dto.discrepancy.amount);
    if (
      gross <= 0n || fee < 0n || deduction < 0n || expected <= 0n || actual <= 0n
      || gross - fee - deduction !== expected
      || actual - expected !== discrepancy
      || dto.allocations.reduce((sum, allocation) => sum + units(allocation.amount.amount), 0n) !== gross
    ) throw new Error('ARITHMETIC_MISMATCH');
    const reason = dto.discrepancyReason?.trim();
    if (
      (discrepancy === 0n && (dto.discrepancyDisposition !== SettlementDiscrepancyDisposition.NONE || reason))
      || (discrepancy !== 0n && (dto.discrepancyDisposition === SettlementDiscrepancyDisposition.NONE || !reason))
    ) throw new Error('ARITHMETIC_MISMATCH');
    if (
      (dto.match.kind === SettlementMatchKind.DETERMINISTIC
        && (!dto.match.ruleId?.trim() || !dto.match.ruleVersion?.trim() || dto.match.reason))
      || (dto.match.kind === SettlementMatchKind.MANUAL
        && (!dto.match.reason?.trim() || dto.match.ruleId || dto.match.ruleVersion))
    ) this.validation('match provenance is invalid.');
    if (dto.bankStatementLineId) throw new Error('EVIDENCE_INVALID');
    return {
      ...dto,
      providerReference: dto.providerReference?.trim() || undefined,
      discrepancyReason: reason,
      match: {
        ...dto.match,
        ruleId: dto.match.ruleId?.trim(),
        ruleVersion: dto.match.ruleVersion?.trim(),
        reason: dto.match.reason?.trim(),
      },
    };
  }

  private validateFacts(dto: SettlementCreateDto, facts: SettlementFacts): void {
    if (!facts.organization || !facts.actor || !facts.account) throw new Error('RESOURCE_HIDDEN');
    if (facts.actor.state !== 'ACTIVE') throw new Error('RESOURCE_HIDDEN');
    if (
      facts.account.state !== 'ACTIVE'
      || !facts.account.canReceive
      || facts.account.currency !== dto.gross.currency
    ) throw new Error('EVIDENCE_INVALID');
    if (facts.attachments.length !== dto.attachments.length) throw new Error('EVIDENCE_INVALID');
    const evidence = new Map(facts.attachments.map((item) => [`${item.id}:${item.contentDigest}`, item]));
    if (dto.attachments.some((item) => evidence.get(`${item.id}:${item.contentDigest}`)?.state !== 'ACTIVE')) {
      throw new Error('EVIDENCE_INVALID');
    }
    if (facts.items.length !== dto.allocations.length) throw new Error('ALLOCATION_CONFLICT');
    const items = new Map(facts.items.map((item) => [item.id, item]));
    for (const allocation of dto.allocations) {
      const item = items.get(allocation.collectionItemId);
      if (
        !item
        || !['OPEN', 'REOPENED_AFTER_REVERSAL', 'PARTIALLY_ALLOCATED'].includes(item.state)
        || Number(item.version) !== allocation.collectionItemVersion
        || item.destinationBankAccountId !== dto.destinationBankAccountId
        || item.currency !== dto.gross.currency
        || units(allocation.amount.amount) > units(item.remainingAmount)
      ) throw new Error('ALLOCATION_CONFLICT');
    }
    if (dto.replacementForBatchId && (
      !facts.replacement
      || facts.replacement.state !== 'REVERSED'
      || facts.replacement.destinationBankAccountId !== dto.destinationBankAccountId
      || facts.replacement.currency !== dto.gross.currency
    )) throw new Error('EVIDENCE_INVALID');
  }

  private validateLockedAllocations(locked: LockedSettlement): void {
    if (
      !locked.allocations.length
      || locked.allocations.length !== locked.items.length
      || locked.allocations.some(({ state }) => state !== 'PROPOSED')
    ) throw new Error('ALLOCATION_CONFLICT');
    const items = new Map(locked.items.map((item) => [item.id, item]));
    for (const allocation of locked.allocations) {
      const item = items.get(allocation.collectionItemId);
      if (
        !item
        || !['OPEN', 'REOPENED_AFTER_REVERSAL', 'PARTIALLY_ALLOCATED'].includes(item.state)
        || Number(item.version) !== Number(allocation.collectionItemVersion)
        || item.destinationBankAccountId !== locked.batch.destinationBankAccountId
        || item.currency !== locked.batch.currency
        || units(allocation.allocatedAmount) > units(item.remainingAmount)
      ) throw new Error('ALLOCATION_CONFLICT');
    }
  }

  private async appendOptionalEvidenceEffects(
    transaction: DatabaseTransaction,
    locked: LockedSettlement,
    sourceVersion: number,
  ): Promise<void> {
    const values: Array<[SettlementEffectType, string, string]> = [
      ['FEE_EVIDENCE', 'fee', locked.batch.feeAmount],
      ['DEDUCTION_EVIDENCE', 'deduction', locked.batch.deductionAmount],
      ['APPROVED_DISCREPANCY_EVIDENCE', 'approved-discrepancy', locked.batch.discrepancyAmount],
    ];
    for (const [effectType, effectKey, value] of values) {
      if (units(value) === 0n) continue;
      await this.repository.appendEffect(transaction, {
        organizationId: locked.batch.organizationId,
        settlementBatchId: locked.batch.id,
        effectKey,
        effectType,
        direction: 'SETTLEMENT',
        amount: value,
        currency: locked.batch.currency,
        businessDate: locked.batch.settlementDate,
        sourceVersion,
      });
    }
  }

  private assertAuthorizedForBatch(
    transaction: DatabaseTransaction,
    context: SettlementCommandContext,
    locked: LockedSettlement,
    permission: 'settlement.confirm' | 'settlement.reverse',
  ): Promise<void> {
    return this.assertAuthorized(
      transaction,
      context.organizationId,
      context.actorUserId,
      locked.batch.destinationBankAccountId,
      locked.batch.currency,
      locked.batch.grossAmount,
      locked.items,
      permission,
    );
  }

  private async assertAuthorized(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    bankAccountId: string,
    currency: string,
    amountValue: string,
    items: Array<{ branchId: string | null; treasuryUnitId: string }>,
    permission: 'settlement.create' | 'settlement.confirm' | 'settlement.reverse',
  ): Promise<void> {
    if (!await this.authorization.resolveSettlementAuthority(
      transaction,
      organizationId,
      actorUserId,
      {
        branchIds: [...new Set(items.flatMap(({ branchId }) => branchId ? [branchId] : []))],
        treasuryUnitIds: [...new Set(items.map(({ treasuryUnitId }) => treasuryUnitId))],
        bankAccountId,
        currency,
        amount: amountValue,
      },
      permission,
    )) throw new Error('SCOPE_DENIED');
  }

  private async consumeProof(
    transaction: DatabaseTransaction,
    context: SettlementCommandContext,
  ): Promise<void> {
    if (
      !context.stepUp
      || !await this.authorization.consumeStepUpProof(transaction, {
        proofDigest: digest(context.stepUp.proofId),
        physicalSessionId: context.physicalSessionId,
        ...context.stepUp.command,
      })
    ) throw new Error('STEP_UP_REQUIRED');
  }

  private validateCommand(context: SettlementCommandContext): number {
    if (!UUID.test(context.batchId)) this.validation('resourceId is malformed.');
    this.requiredRequestId(context.requestId);
    this.key(context.key);
    const match = /^"([0-9]+)"$/u.exec(context.ifMatch);
    if (!match) this.validation('If-Match must be one strong numeric ETag.');
    return Number(match![1]);
  }

  private key(value: string): string {
    if (!value || value.length < 8 || value.length > 128) {
      this.validation('Idempotency-Key must contain 8 through 128 characters.');
    }
    return value;
  }

  private requiredRequestId(value: string): void {
    if (!value || value.length > 128) this.validation('X-Request-Id is required.');
  }

  private async map<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const mapped = {
        RESOURCE_HIDDEN: ['TRS-GEN-004', 404],
        SCOPE_DENIED: ['TRS-GEN-003', 403],
        STATE_CONFLICT: ['TRS-GEN-005', 409],
        STALE_VERSION: ['TRS-GEN-006', 409],
        IDEMPOTENCY_CONFLICT: ['TRS-GEN-007', 409],
        ALLOCATION_CONFLICT: ['TRS-COL-001', 409],
        ARITHMETIC_MISMATCH: ['TRS-COL-002', 422],
        DISCREPANCY_UNRESOLVED: ['TRS-COL-003', 422],
        CONFIRMATION_UNKNOWN: ['TRS-COL-004', 409],
        REVERSAL_CONFLICT: ['TRS-COL-005', 409],
        EVIDENCE_INVALID: ['TRS-COL-006', 422],
        STEP_UP_REQUIRED: ['TRS-AUT-010', 428],
      } as const;
      const value = error instanceof Error
        ? mapped[error.message as keyof typeof mapped]
        : undefined;
      if (value) throw new TreasuryProblem(value[0], value[1]);
      const databaseError = error as { code?: string; constraint?: string };
      if (databaseError.constraint?.startsWith('settlement_')) {
        if (databaseError.constraint.includes('allocation')) {
          throw new TreasuryProblem('TRS-COL-001', 409);
        }
        if (databaseError.constraint.includes('evidence')) {
          throw new TreasuryProblem('TRS-COL-006', 422);
        }
        throw new TreasuryProblem('TRS-COL-005', 409);
      }
      if (databaseError.code === '23505') throw new TreasuryProblem('TRS-GEN-005', 409);
      if (databaseError.code === '23503') throw new TreasuryProblem('TRS-GEN-004', 404);
      if (['22003', '22P02', '23514'].includes(databaseError.code ?? '')) {
        throw new TreasuryProblem('TRS-COL-002', 422);
      }
      throw error;
    }
  }

  private validation(detail: string): never {
    throw new TreasuryProblem('TRS-GEN-001', 422, detail);
  }
}

function units(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const result = BigInt(whole!) * SCALE + BigInt(fraction.padEnd(8, '0'));
  return negative ? -result : result;
}

function amount(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const fraction = String(absolute % SCALE).padStart(8, '0').replace(/0+$/u, '');
  return `${negative ? '-' : ''}${absolute / SCALE}${fraction ? `.${fraction}` : ''}`;
}
