import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import type { DatabaseTransaction } from '../database/database.service';
import {
  auditEvents,
  movementFacts,
  outboxEvents,
} from '../database/schema';

export interface MovementFactCommand {
  organizationId: string;
  owner?: 'domain.receipts' | 'domain.payments' | 'domain.transfers';
  sourceType?: 'RECEIPT' | 'Payment' | 'Transfer';
  sourceId: string;
  sourceLineId?: string;
  effectKey: string;
  endpointType: 'CASHBOX' | 'BANK_ACCOUNT' | 'USER';
  endpointId: string;
  amount: string;
  currency: string;
  businessDate: string;
  reversalOfFactId?: string;
  direction?: 'DEBIT' | 'CREDIT';
  state?: 'POSTED' | 'REVERSED';
}

@Injectable()
export class FoundationEffectsRepository {
  async appendMovement(
    transaction: DatabaseTransaction,
    command: MovementFactCommand,
  ): Promise<string> {
    const id = randomUUID();
    await transaction.insert(movementFacts).values({
      id,
      organizationId: command.organizationId,
      owner: command.owner ?? 'domain.receipts',
      sourceType: command.sourceType ?? 'RECEIPT',
      sourceId: command.sourceId,
      sourceLineId: command.sourceLineId,
      effectKey: command.effectKey,
      endpointType: command.endpointType,
      endpointId: command.endpointId,
      direction: command.direction ?? (command.reversalOfFactId ? 'DEBIT' : 'CREDIT'),
      amount: command.amount,
      currency: command.currency,
      businessDate: command.businessDate,
      reversalOfFactId: command.reversalOfFactId,
      state: command.state ?? (command.reversalOfFactId ? 'REVERSED' : 'POSTED'),
    });
    return id;
  }

  async appendAudit(
    transaction: DatabaseTransaction,
    input: {
      organizationId: string;
      requestId: string;
      actorUserId: string;
      entityType?: 'Receipt' | 'Payment' | 'Transfer' | 'BankInstruction' | 'AccountingExport';
      entityId: string;
      action: string;
      reason?: string;
    },
  ): Promise<void> {
    await transaction.insert(auditEvents).values({
      organizationId: input.organizationId,
      requestId: input.requestId,
      sequenceNo: 1,
      actorUserId: input.actorUserId,
      entityType: input.entityType ?? 'Receipt',
      entityId: input.entityId,
      action: input.action,
      reason: input.reason,
      outcome: 'SUCCEEDED',
    });
  }

  async appendOutbox(
    transaction: DatabaseTransaction,
    input: {
      organizationId: string;
      aggregateType?: 'Receipt' | 'Payment' | 'Transfer' | 'BankInstruction' | 'AccountingExport';
      aggregateId: string;
      aggregateVersion: number;
      eventType: string;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    await transaction.insert(outboxEvents).values({
      organizationId: input.organizationId,
      aggregateType: input.aggregateType ?? 'Receipt',
      aggregateId: input.aggregateId,
      aggregateVersion: input.aggregateVersion,
      eventType: input.eventType,
      payload: input.payload,
    });
  }
}

@Injectable()
export class FoundationEffectsService {
  constructor(
    @Inject(FoundationEffectsRepository)
    private readonly repository: FoundationEffectsRepository,
  ) {}

  appendMovement(
    transaction: DatabaseTransaction,
    command: MovementFactCommand,
  ): Promise<string> {
    return this.repository.appendMovement(transaction, command);
  }

  appendAudit(
    transaction: DatabaseTransaction,
    input: Parameters<FoundationEffectsRepository['appendAudit']>[1],
  ): Promise<void> {
    return this.repository.appendAudit(transaction, input);
  }

  appendOutbox(
    transaction: DatabaseTransaction,
    input: Parameters<FoundationEffectsRepository['appendOutbox']>[1],
  ): Promise<void> {
    return this.repository.appendOutbox(transaction, input);
  }
}
