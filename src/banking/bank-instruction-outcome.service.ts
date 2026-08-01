import { Inject, Injectable } from '@nestjs/common';

import { AccessAuthorizationService } from '../access-control/access-authorization.service';
import { commandDigest } from '../common/http';
import { TreasuryProblem } from '../common/problem';
import { DatabaseService } from '../database/database.service';
import { FoundationEffectsService } from '../foundation-effects/foundation-effects.service';
import { BankInstructionOutcomeRepository } from './bank-instruction-outcome.repository';
import {
  BankInstructionOutcome,
  BankInstructionOutcomeDto,
  BankInstructionView,
} from './banking.dto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

@Injectable()
export class BankInstructionOutcomeService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(BankInstructionOutcomeRepository)
    private readonly repository: BankInstructionOutcomeRepository,
    @Inject(AccessAuthorizationService)
    private readonly authorization: AccessAuthorizationService,
    @Inject(FoundationEffectsService)
    private readonly foundation: FoundationEffectsService,
  ) {}

  record(
    organizationId: string,
    actorUserId: string,
    instructionId: string,
    rawKey: string,
    rawIfMatch: string,
    requestId: string,
    dto: BankInstructionOutcomeDto,
  ): Promise<BankInstructionView> {
    const expectedVersion = this.validate(instructionId, rawKey, rawIfMatch, requestId);
    this.shape(dto);
    const requestDigest = commandDigest('recordBankInstructionOutcome', {
      actorUserId,
      instructionId,
      ifMatch: rawIfMatch,
      body: dto,
    });
    return this.map(() => this.database.db.transaction(async (transaction) => {
      const scope = `bankOutcome:${actorUserId}:${instructionId}`;
      await this.repository.acquireIdempotencyLock(transaction, organizationId, scope, rawKey);
      const replay = await this.repository.findIdempotency(
        transaction, organizationId, scope, rawKey,
      );
      const instruction = await this.repository.lockInstruction(
        transaction, organizationId, instructionId,
      );
      if (!instruction) throw new Error('RESOURCE_HIDDEN');
      if (!await this.authorization.canOperatePayment(
        transaction,
        organizationId,
        actorUserId,
        this.repository.authorizationContext(instruction),
        'bank-instruction.record-outcome',
      )) throw new Error('SCOPE_DENIED');
      if (
        dto.outcome !== BankInstructionOutcome.CONFIRMED
        && instruction.paymentExecutedByUserId === actorUserId
      ) throw new Error('OUTCOME_CONFLICT');
      if (replay) {
        if (replay.requestDigest !== requestDigest || !replay.response) {
          throw new Error('IDEMPOTENCY_CONFLICT');
        }
        return replay.response;
      }
      await this.repository.startIdempotency(
        transaction, organizationId, scope, rawKey, requestDigest,
      );
      if (instruction.version !== expectedVersion) throw new Error('STALE_VERSION');
      this.transition(instruction.state, dto.outcome);
      if (dto.statementLineId) throw new Error('OUTCOME_CONFLICT');

      const attachments = dto.attachments?.length
        ? await this.repository.activeEvidence(transaction, organizationId, dto.attachments)
        : [];
      if (attachments.length !== (dto.attachments?.length ?? 0) || !attachments.length) {
        throw new Error('OUTCOME_CONFLICT');
      }
      if (
        dto.correctionPaymentId
        && !await this.repository.correctionValid(
          transaction, organizationId, instruction.paymentId, dto.correctionPaymentId,
        )
      ) throw new Error('OUTCOME_CONFLICT');
      const evidence = {
        attachments,
        ...(dto.correctionPaymentId ? { correctionPaymentId: dto.correctionPaymentId } : {}),
      };
      const version = await this.repository.record(transaction, {
        instruction,
        dto,
        actorUserId,
        evidence,
      });
      await this.foundation.appendAudit(transaction, {
        organizationId,
        requestId,
        actorUserId,
        entityType: 'BankInstruction',
        entityId: instructionId,
        action: `BANK_INSTRUCTION_${dto.outcome}`,
        reason: dto.reason?.trim(),
      });
      const response = await this.repository.view(transaction, organizationId, instructionId);
      if (!response || response.version !== version) throw new Error('IDEMPOTENCY_CONFLICT');
      await this.repository.finishIdempotency(
        transaction, organizationId, scope, rawKey, response,
      );
      return response;
    }));
  }

  private shape(dto: BankInstructionOutcomeDto): void {
    const negative = dto.outcome !== BankInstructionOutcome.CONFIRMED;
    if (
      (dto.outcome === BankInstructionOutcome.CONFIRMED
        && (!!dto.reason || !!dto.correctionPaymentId
          || (!dto.statementLineId && !dto.attachments?.length)))
      || (negative && (
        !dto.reason?.trim() || !dto.correctionPaymentId || !dto.attachments?.length
        || !!dto.statementLineId
      ))
    ) this.validation('Bank instruction outcome evidence is incomplete.');
  }

  private transition(state: string, outcome: BankInstructionOutcome): void {
    if (
      (state === 'PENDING_CONFIRMATION' && outcome !== BankInstructionOutcome.RETURNED)
      || (state === 'CONFIRMED' && outcome === BankInstructionOutcome.RETURNED)
    ) return;
    throw new Error('OUTCOME_CONFLICT');
  }

  private validate(
    instructionId: string,
    key: string,
    ifMatch: string,
    requestId: string,
  ): number {
    if (!UUID.test(instructionId)) this.validation('resourceId is malformed.');
    if (!requestId || requestId.length > 128) this.validation('X-Request-Id is required.');
    if (!key || key.length < 8 || key.length > 128) {
      this.validation('Idempotency-Key must contain 8 through 128 characters.');
    }
    const match = /^"([0-9]+)"$/u.exec(ifMatch);
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
        STALE_VERSION: ['TRS-GEN-006', 409],
        IDEMPOTENCY_CONFLICT: ['TRS-GEN-007', 409],
        OUTCOME_CONFLICT: ['TRS-BNK-005', 409],
      } as const;
      const value = error instanceof Error
        ? mapped[error.message as keyof typeof mapped]
        : undefined;
      if (value) throw new TreasuryProblem(value[0], value[1]);
      const databaseError = error as { code?: string };
      if (databaseError.code === '23505' || databaseError.code === '23514') {
        throw new TreasuryProblem('TRS-BNK-005', 409);
      }
      if (databaseError.code === '23503') throw new TreasuryProblem('TRS-GEN-004', 404);
      throw error;
    }
  }

  private validation(detail: string): never {
    throw new TreasuryProblem('TRS-GEN-001', 422, detail);
  }
}
