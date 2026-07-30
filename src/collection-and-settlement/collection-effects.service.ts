import { Inject, Injectable } from '@nestjs/common';
import { and, eq, InferSelectModel } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import type { DatabaseTransaction } from '../database/database.service';
import { collectionItems } from '../database/schema';

type CollectionItemRow = InferSelectModel<typeof collectionItems>;

export interface CollectionItemCommand {
  organizationId: string;
  receiptLineId: string;
  branchId?: string;
  treasuryUnitId: string;
  channelType: string;
  channelId?: string;
  providerReference?: string;
  collectedPartyId: string;
  amount: string;
  currency: string;
  destinationBankAccountId: string;
  collectedAt: Date;
  expectedSettlementDate: string;
}

@Injectable()
export class CollectionEffectsRepository {
  async insert(
    transaction: DatabaseTransaction,
    command: CollectionItemCommand,
  ): Promise<string | undefined> {
    const id = randomUUID();
    const rows = await transaction
      .insert(collectionItems)
      .values({
        id,
        organizationId: command.organizationId,
        sourceFactType: 'RECEIPT_LINE',
        sourceFactId: command.receiptLineId,
        branchId: command.branchId,
        treasuryUnitId: command.treasuryUnitId,
        channelType: command.channelType,
        channelId: command.channelId,
        providerReference: command.providerReference,
        collectedPartyId: command.collectedPartyId,
        grossAmount: command.amount,
        currency: command.currency,
        allocatedAmount: '0',
        remainingAmount: command.amount,
        destinationBankAccountId: command.destinationBankAccountId,
        collectedAt: command.collectedAt,
        expectedSettlementDate: command.expectedSettlementDate,
        state: 'OPEN',
        version: 0,
      })
      .onConflictDoNothing({
        target: [
          collectionItems.organizationId,
          collectionItems.sourceFactType,
          collectionItems.sourceFactId,
        ],
      })
      .returning({ id: collectionItems.id });
    return rows[0]?.id;
  }

  async bySource(
    transaction: DatabaseTransaction,
    organizationId: string,
    receiptLineId: string,
  ): Promise<CollectionItemRow | undefined> {
    const rows = await transaction
      .select()
      .from(collectionItems)
      .where(and(
        eq(collectionItems.organizationId, organizationId),
        eq(collectionItems.sourceFactType, 'RECEIPT_LINE'),
        eq(collectionItems.sourceFactId, receiptLineId),
      ));
    return rows[0];
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

  async create(
    transaction: DatabaseTransaction,
    command: CollectionItemCommand,
  ): Promise<string> {
    const providerReference = command.providerReference?.trim() || undefined;
    const normalized = { ...command, providerReference };
    try {
      const insertedId = await this.repository.insert(transaction, normalized);
      if (insertedId) return insertedId;
    } catch (error) {
      const databaseError = error as { code?: string; constraint?: string };
      if (
        databaseError.code === '23505'
        && databaseError.constraint === 'uq_collection_item_provider_reference'
      ) throw new Error('COLLECTION_IDENTITY_CONFLICT');
      throw error;
    }

    const existing = await this.repository.bySource(
      transaction,
      command.organizationId,
      command.receiptLineId,
    );
    if (existing && this.sameImmutablePayload(existing, normalized)) return existing.id;
    throw new Error('COLLECTION_IDENTITY_CONFLICT');
  }

  reversibleSnapshot(
    transaction: DatabaseTransaction,
    organizationId: string,
    collectionItemId: string,
  ) {
    return this.repository.reversibleSnapshot(transaction, organizationId, collectionItemId);
  }

  private sameImmutablePayload(
    existing: CollectionItemRow,
    command: CollectionItemCommand,
  ): boolean {
    return existing.branchId === (command.branchId ?? null)
      && existing.treasuryUnitId === command.treasuryUnitId
      && existing.channelType === command.channelType
      && existing.channelId === (command.channelId ?? null)
      && existing.providerReference === (command.providerReference ?? null)
      && existing.collectedPartyId === command.collectedPartyId
      && this.decimal(existing.grossAmount) === this.decimal(command.amount)
      && existing.currency === command.currency
      && this.decimal(existing.allocatedAmount) === '0'
      && this.decimal(existing.remainingAmount) === this.decimal(command.amount)
      && existing.destinationBankAccountId === command.destinationBankAccountId
      && existing.collectedAt.getTime() === command.collectedAt.getTime()
      && existing.expectedSettlementDate === command.expectedSettlementDate
      && existing.state === 'OPEN'
      && Number(existing.version) === 0;
  }

  private decimal(value: string): string {
    const normalized = value
      .replace(/^(-?)0+(?=\d)/u, '$1')
      .replace(/(\.\d*?)0+$/u, '$1')
      .replace(/\.$/u, '');
    return normalized === '-0' ? '0' : normalized;
  }
}
