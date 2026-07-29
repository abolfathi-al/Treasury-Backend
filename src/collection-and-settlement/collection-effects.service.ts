import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import type { DatabaseTransaction } from '../database/database.service';
import { collectionItems } from '../database/schema';

export interface CollectionItemCommand {
  organizationId: string;
  receiptLineId: string;
  channelType: string;
  channelId?: string;
  providerReference?: string;
  amount: string;
  currency: string;
  destinationBankAccountId: string;
  collectedAt: Date;
  expectedSettlementDate?: string;
}

@Injectable()
export class CollectionEffectsRepository {
  async create(
    transaction: DatabaseTransaction,
    command: CollectionItemCommand,
  ): Promise<string> {
    const id = randomUUID();
    await transaction.insert(collectionItems).values({
      id,
      organizationId: command.organizationId,
      sourceFactType: 'RECEIPT_LINE',
      sourceFactId: command.receiptLineId,
      channelType: command.channelType,
      channelId: command.channelId,
      providerReference: command.providerReference,
      grossAmount: command.amount,
      currency: command.currency,
      allocatedAmount: '0',
      remainingAmount: command.amount,
      destinationBankAccountId: command.destinationBankAccountId,
      collectedAt: command.collectedAt,
      expectedSettlementDate: command.expectedSettlementDate,
      state: 'OPEN',
      version: 0,
    });
    return id;
  }

  async reversibleSnapshot(
    transaction: DatabaseTransaction,
    organizationId: string,
    collectionItemId: string,
  ): Promise<{ id: string; version: number; state: 'RETURNED' | 'REOPENED_AFTER_REVERSAL' } | undefined> {
    const rows = await transaction
      .select({
        id: collectionItems.id,
        version: collectionItems.version,
        state: collectionItems.state,
      })
      .from(collectionItems)
      .where(and(
        eq(collectionItems.organizationId, organizationId),
        eq(collectionItems.id, collectionItemId),
      ))
      .for('update');
    const row = rows[0];
    if (
      !row
      || (row.state !== 'RETURNED' && row.state !== 'REOPENED_AFTER_REVERSAL')
    ) return undefined;
    return { id: row.id, version: Number(row.version), state: row.state };
  }
}

@Injectable()
export class CollectionEffectsService {
  constructor(
    @Inject(CollectionEffectsRepository)
    private readonly repository: CollectionEffectsRepository,
  ) {}

  create(
    transaction: DatabaseTransaction,
    command: CollectionItemCommand,
  ): Promise<string> {
    return this.repository.create(transaction, command);
  }

  reversibleSnapshot(
    transaction: DatabaseTransaction,
    organizationId: string,
    collectionItemId: string,
  ) {
    return this.repository.reversibleSnapshot(transaction, organizationId, collectionItemId);
  }
}
