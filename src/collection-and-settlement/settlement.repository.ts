import { Injectable } from '@nestjs/common';
import { and, asc, eq, InferSelectModel, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import type { DatabaseTransaction } from '../database/database.service';
import {
  attachments,
  bankAccounts,
  collectionItems,
  idempotencyRecords,
  organizations,
  settlementAllocations,
  settlementAttachmentLinks,
  settlementBatches,
  settlementEffects,
  userRefs,
} from '../database/schema';
import type {
  SettlementBatchView,
  SettlementCreateDto,
  SettlementEffectType,
  SettlementEffectView,
  SettlementReversalView,
} from './settlement.dto';
import { SettlementMatchKind } from './settlement.dto';

type BatchRow = InferSelectModel<typeof settlementBatches>;
type AllocationRow = InferSelectModel<typeof settlementAllocations>;
type EffectRow = InferSelectModel<typeof settlementEffects>;
type CollectionItemRow = InferSelectModel<typeof collectionItems>;

export interface SettlementFacts {
  organization?: { id: string; label: string };
  actor?: { id: string; label: string; state: string };
  account?: {
    id: string;
    label: string;
    currency: string;
    state: string;
    canReceive: boolean;
  };
  attachments: Array<{
    id: string;
    contentDigest: string;
    label: string;
    state: string;
  }>;
  items: CollectionItemRow[];
  replacement?: Pick<BatchRow, 'id' | 'state' | 'destinationBankAccountId' | 'currency'>;
}

export interface LockedSettlement {
  batch: BatchRow;
  allocations: AllocationRow[];
  items: CollectionItemRow[];
  effects: EffectRow[];
}

export interface SettlementConfirmationFacts {
  account?: { state: string; canReceive: boolean; currency: string };
  attachments: Array<{
    id: string;
    linkedDigest: string;
    currentDigest: string | null;
    state: string | null;
  }>;
}

@Injectable()
export class SettlementRepository {
  acquireIdempotencyLock(
    transaction: DatabaseTransaction,
    organizationId: string,
    scope: string,
    key: string,
  ): Promise<unknown> {
    return transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${organizationId}:${scope}:${key}`}, 0))`);
  }

  async findIdempotency<T>(
    transaction: DatabaseTransaction,
    organizationId: string,
    scope: string,
    key: string,
  ): Promise<{ requestDigest: string; response?: T } | undefined> {
    const [row] = await transaction.select({
      requestDigest: idempotencyRecords.requestDigest,
      response: idempotencyRecords.responseBody,
    }).from(idempotencyRecords).where(and(
      eq(idempotencyRecords.organizationId, organizationId),
      eq(idempotencyRecords.scope, scope),
      eq(idempotencyRecords.idempotencyKey, key),
    )).limit(1);
    return row ? { requestDigest: row.requestDigest, response: row.response as T | undefined } : undefined;
  }

  startIdempotency(
    transaction: DatabaseTransaction,
    organizationId: string,
    scope: string,
    key: string,
    requestDigest: string,
  ): Promise<unknown> {
    return transaction.insert(idempotencyRecords).values({
      organizationId,
      scope,
      idempotencyKey: key,
      requestDigest,
    });
  }

  finishIdempotency<T>(
    transaction: DatabaseTransaction,
    organizationId: string,
    scope: string,
    key: string,
    response: T,
    status: number,
  ): Promise<unknown> {
    return transaction.update(idempotencyRecords).set({
      responseStatus: status,
      responseBody: response as Record<string, unknown>,
    }).where(and(
      eq(idempotencyRecords.organizationId, organizationId),
      eq(idempotencyRecords.scope, scope),
      eq(idempotencyRecords.idempotencyKey, key),
    ));
  }

  async facts(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    dto: SettlementCreateDto,
  ): Promise<SettlementFacts> {
    const [organization] = await transaction.select({
      id: organizations.id,
      label: organizations.legalName,
    }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
    const [actor] = await transaction.select({
      id: userRefs.id,
      label: userRefs.displayName,
      state: userRefs.state,
    }).from(userRefs).where(and(
      eq(userRefs.organizationId, organizationId),
      eq(userRefs.id, actorUserId),
    )).limit(1);
    const [account] = await transaction.select({
      id: bankAccounts.id,
      owner: bankAccounts.legalOwnerName,
      number: bankAccounts.accountNumber,
      currency: bankAccounts.currency,
      state: bankAccounts.state,
      canReceive: bankAccounts.canReceive,
    }).from(bankAccounts).where(and(
      eq(bankAccounts.organizationId, organizationId),
      eq(bankAccounts.id, dto.destinationBankAccountId),
    )).limit(1);
    const attachmentRows = await transaction.select({
      id: attachments.id,
      contentDigest: attachments.contentDigest,
      label: attachments.fileName,
      state: attachments.state,
    }).from(attachments).where(and(
      eq(attachments.organizationId, organizationId),
      inArray(attachments.id, dto.attachments.map(({ id }) => id)),
    ));
    const itemRows = await transaction.select().from(collectionItems).where(and(
      eq(collectionItems.organizationId, organizationId),
      inArray(collectionItems.id, dto.allocations.map(({ collectionItemId }) => collectionItemId)),
    ));
    const [replacement] = dto.replacementForBatchId
      ? await transaction.select({
        id: settlementBatches.id,
        state: settlementBatches.state,
        destinationBankAccountId: settlementBatches.destinationBankAccountId,
        currency: settlementBatches.currency,
      }).from(settlementBatches).where(and(
        eq(settlementBatches.organizationId, organizationId),
        eq(settlementBatches.id, dto.replacementForBatchId),
      )).limit(1)
      : [];
    return {
      organization,
      actor,
      account: account ? {
        id: account.id,
        label: `${account.owner} • ${account.number}`,
        currency: account.currency,
        state: account.state,
        canReceive: account.canReceive,
      } : undefined,
      attachments: attachmentRows,
      items: itemRows,
      replacement,
    };
  }

  async nextNumber(transaction: DatabaseTransaction, organizationId: string): Promise<string> {
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${organizationId}:settlement-number`}, 0))`);
    const result = await transaction.execute<{ value: number }>(sql`
      SELECT COALESCE(MAX(NULLIF(regexp_replace(business_number, '^SET-', ''), '')::bigint), 0) + 1 AS value
      FROM settlement_batches WHERE organization_id = ${organizationId}
    `);
    return `SET-${String(result.rows[0]!.value).padStart(8, '0')}`;
  }

  async insertProposal(
    transaction: DatabaseTransaction,
    input: {
      id: string;
      organizationId: string;
      actorUserId: string;
      businessNumber: string;
      currency: string;
      state: 'MATCHED' | 'DISCREPANCY';
      dto: SettlementCreateDto;
    },
  ): Promise<void> {
    const providerReference = input.dto.providerReference?.trim() || undefined;
    await transaction.insert(settlementBatches).values({
      id: input.id,
      organizationId: input.organizationId,
      businessNumber: input.businessNumber,
      destinationBankAccountId: input.dto.destinationBankAccountId,
      bankStatementLineId: input.dto.bankStatementLineId,
      providerReference,
      settlementDate: input.dto.settlementDate,
      matchKind: input.dto.match.kind,
      matchRuleId: input.dto.match.ruleId?.trim(),
      matchRuleVersion: input.dto.match.ruleVersion?.trim(),
      manualMatchReason: input.dto.match.reason?.trim(),
      currency: input.currency,
      grossAmount: input.dto.gross.amount,
      feeAmount: input.dto.fee.amount,
      deductionAmount: input.dto.deduction.amount,
      expectedNetAmount: input.dto.expectedNet.amount,
      actualNetAmount: input.dto.actualNet.amount,
      discrepancyAmount: input.dto.discrepancy.amount,
      discrepancyDisposition: input.dto.discrepancyDisposition,
      discrepancyReason: input.dto.discrepancyReason?.trim(),
      replacementForBatchId: input.dto.replacementForBatchId,
      creatorUserId: input.actorUserId,
      state: input.state,
    });
    await transaction.insert(settlementAllocations).values(input.dto.allocations.map((allocation) => ({
      id: randomUUID(),
      organizationId: input.organizationId,
      settlementBatchId: input.id,
      collectionItemId: allocation.collectionItemId,
      collectionItemVersion: allocation.collectionItemVersion,
      allocatedAmount: allocation.amount.amount,
      currency: allocation.amount.currency,
      state: 'PROPOSED',
    })));
    await transaction.insert(settlementAttachmentLinks).values(input.dto.attachments.map((attachment) => ({
      organizationId: input.organizationId,
      settlementBatchId: input.id,
      attachmentId: attachment.id,
      contentDigest: attachment.contentDigest,
      purpose: attachment.purpose,
    })));
  }

  async lock(
    transaction: DatabaseTransaction,
    organizationId: string,
    batchId: string,
  ): Promise<LockedSettlement | undefined> {
    const [batch] = await transaction.select().from(settlementBatches).where(and(
      eq(settlementBatches.organizationId, organizationId),
      eq(settlementBatches.id, batchId),
    )).for('update');
    if (!batch) return undefined;
    const allocations = await transaction.select().from(settlementAllocations).where(and(
      eq(settlementAllocations.organizationId, organizationId),
      eq(settlementAllocations.settlementBatchId, batchId),
    )).orderBy(asc(settlementAllocations.id)).for('update');
    const items = allocations.length ? await transaction.select().from(collectionItems).where(and(
      eq(collectionItems.organizationId, organizationId),
      inArray(collectionItems.id, allocations.map(({ collectionItemId }) => collectionItemId)),
    )).orderBy(asc(collectionItems.id)).for('update') : [];
    const effects = await transaction.select().from(settlementEffects).where(and(
      eq(settlementEffects.organizationId, organizationId),
      eq(settlementEffects.settlementBatchId, batchId),
    )).orderBy(asc(settlementEffects.createdAt), asc(settlementEffects.id));
    return { batch, allocations, items, effects };
  }

  async confirmationFacts(
    transaction: DatabaseTransaction,
    organizationId: string,
    batch: BatchRow,
  ): Promise<SettlementConfirmationFacts> {
    const [account] = await transaction.select({
      state: bankAccounts.state,
      canReceive: bankAccounts.canReceive,
      currency: bankAccounts.currency,
    }).from(bankAccounts).where(and(
      eq(bankAccounts.organizationId, organizationId),
      eq(bankAccounts.id, batch.destinationBankAccountId),
    )).limit(1);
    const evidence = await transaction.select({
      id: settlementAttachmentLinks.attachmentId,
      linkedDigest: settlementAttachmentLinks.contentDigest,
      currentDigest: attachments.contentDigest,
      state: attachments.state,
    }).from(settlementAttachmentLinks).leftJoin(attachments, and(
      eq(attachments.organizationId, settlementAttachmentLinks.organizationId),
      eq(attachments.id, settlementAttachmentLinks.attachmentId),
    )).where(and(
      eq(settlementAttachmentLinks.organizationId, organizationId),
      eq(settlementAttachmentLinks.settlementBatchId, batch.id),
      eq(settlementAttachmentLinks.purpose, 'BANK_CREDIT_EVIDENCE'),
    ));
    return { account, attachments: evidence };
  }

  confirmBatch(
    transaction: DatabaseTransaction,
    organizationId: string,
    batchId: string,
    actorUserId: string,
    at: Date,
  ): Promise<unknown> {
    return transaction.update(settlementBatches).set({
      state: 'CONFIRMED',
      confirmedBy: actorUserId,
      confirmedAt: at,
      version: sql`${settlementBatches.version} + 1`,
      updatedAt: at,
    }).where(and(
      eq(settlementBatches.organizationId, organizationId),
      eq(settlementBatches.id, batchId),
    ));
  }

  reverseBatch(
    transaction: DatabaseTransaction,
    organizationId: string,
    batchId: string,
    actorUserId: string,
    at: Date,
  ): Promise<unknown> {
    return transaction.update(settlementBatches).set({
      state: 'REVERSED',
      reversedBy: actorUserId,
      reversedAt: at,
      version: sql`${settlementBatches.version} + 1`,
      updatedAt: at,
    }).where(and(
      eq(settlementBatches.organizationId, organizationId),
      eq(settlementBatches.id, batchId),
    ));
  }

  allocationState(
    transaction: DatabaseTransaction,
    organizationId: string,
    allocationId: string,
    state: 'CONFIRMED' | 'REVERSED',
  ): Promise<unknown> {
    return transaction.update(settlementAllocations).set({
      state,
      version: sql`${settlementAllocations.version} + 1`,
    }).where(and(
      eq(settlementAllocations.organizationId, organizationId),
      eq(settlementAllocations.id, allocationId),
    ));
  }

  collectionBalance(
    transaction: DatabaseTransaction,
    organizationId: string,
    itemId: string,
    allocatedAmount: string,
    remainingAmount: string,
    state: 'PARTIALLY_ALLOCATED' | 'SETTLED' | 'REOPENED_AFTER_REVERSAL',
    at: Date,
  ): Promise<unknown> {
    return transaction.update(collectionItems).set({
      allocatedAmount,
      remainingAmount,
      state,
      version: sql`${collectionItems.version} + 1`,
      updatedAt: at,
    }).where(and(
      eq(collectionItems.organizationId, organizationId),
      eq(collectionItems.id, itemId),
    ));
  }

  async appendEffect(
    transaction: DatabaseTransaction,
    input: {
      organizationId: string;
      settlementBatchId: string;
      effectKey: string;
      effectType: SettlementEffectType;
      direction: 'SETTLEMENT' | 'REVERSAL';
      amount: string;
      currency: string;
      businessDate: string;
      sourceVersion: number;
      movementFactId?: string;
      collectionItemId?: string;
      reversalOfEffectId?: string;
    },
  ): Promise<string> {
    const id = randomUUID();
    await transaction.insert(settlementEffects).values({ id, ...input });
    return id;
  }

  async insertReversal(
    transaction: DatabaseTransaction,
    input: {
      id: string;
      organizationId: string;
      businessNumber: string;
      original: BatchRow;
      actorUserId: string;
      reason: string;
      businessDate: string;
      at: Date;
    },
  ): Promise<void> {
    await transaction.insert(settlementBatches).values({
      id: input.id,
      organizationId: input.organizationId,
      businessNumber: input.businessNumber,
      destinationBankAccountId: input.original.destinationBankAccountId,
      providerReference: input.original.providerReference,
      settlementDate: input.businessDate,
      currency: input.original.currency,
      grossAmount: input.original.grossAmount,
      feeAmount: input.original.feeAmount,
      deductionAmount: input.original.deductionAmount,
      expectedNetAmount: input.original.expectedNetAmount,
      actualNetAmount: input.original.actualNetAmount,
      discrepancyAmount: input.original.discrepancyAmount,
      discrepancyDisposition: input.original.discrepancyDisposition,
      discrepancyReason: input.original.discrepancyReason,
      creatorUserId: input.actorUserId,
      reversalOfBatchId: input.original.id,
      reversalReason: input.reason,
      state: 'REVERSAL',
      createdAt: input.at,
      updatedAt: input.at,
    });
  }

  async view(
    transaction: DatabaseTransaction,
    organizationId: string,
    batchId: string,
  ): Promise<SettlementBatchView | undefined> {
    const [row] = await transaction.select({
      batch: settlementBatches,
      organizationLabel: organizations.legalName,
      accountOwner: bankAccounts.legalOwnerName,
      accountNumber: bankAccounts.accountNumber,
    }).from(settlementBatches)
      .innerJoin(organizations, eq(organizations.id, settlementBatches.organizationId))
      .innerJoin(bankAccounts, and(
        eq(bankAccounts.organizationId, settlementBatches.organizationId),
        eq(bankAccounts.id, settlementBatches.destinationBankAccountId),
      )).where(and(
        eq(settlementBatches.organizationId, organizationId),
        eq(settlementBatches.id, batchId),
      )).limit(1);
    if (!row || row.batch.state === 'REVERSAL') return undefined;
    const actorIds = [row.batch.creatorUserId, row.batch.confirmedBy, row.batch.reversedBy]
      .filter((id): id is string => !!id);
    const actors = await transaction.select({ id: userRefs.id, label: userRefs.displayName })
      .from(userRefs).where(and(
        eq(userRefs.organizationId, organizationId),
        inArray(userRefs.id, actorIds),
      ));
    const actor = new Map(actors.map(({ id, label }) => [id, { id, label }]));
    const allocationRows = await transaction.select({
      allocation: settlementAllocations,
      sourceType: collectionItems.sourceFactType,
      sourceId: collectionItems.sourceFactId,
      providerReference: collectionItems.providerReference,
    }).from(settlementAllocations).innerJoin(collectionItems, and(
      eq(collectionItems.organizationId, settlementAllocations.organizationId),
      eq(collectionItems.id, settlementAllocations.collectionItemId),
    )).where(and(
      eq(settlementAllocations.organizationId, organizationId),
      eq(settlementAllocations.settlementBatchId, batchId),
    )).orderBy(asc(settlementAllocations.id));
    const attachmentRows = await transaction.select({
      id: settlementAttachmentLinks.attachmentId,
      contentDigest: settlementAttachmentLinks.contentDigest,
      purpose: settlementAttachmentLinks.purpose,
    }).from(settlementAttachmentLinks).where(and(
      eq(settlementAttachmentLinks.organizationId, organizationId),
      eq(settlementAttachmentLinks.settlementBatchId, batchId),
    )).orderBy(asc(settlementAttachmentLinks.attachmentId));
    const effects = await this.effectViews(transaction, organizationId, batchId);
    const [reversal] = await transaction.select({ id: settlementBatches.id })
      .from(settlementBatches).where(and(
        eq(settlementBatches.organizationId, organizationId),
        eq(settlementBatches.reversalOfBatchId, batchId),
      )).limit(1);
    const creator = actor.get(row.batch.creatorUserId);
    if (!creator) throw new Error('SEMANTIC_REFERENCE_MISSING');
    const currency = row.batch.currency;
    return {
      id: row.batch.id,
      organizationId,
      organization: { id: organizationId, label: row.organizationLabel },
      businessNumber: row.batch.businessNumber,
      destinationBankAccountId: row.batch.destinationBankAccountId,
      destinationBankAccount: {
        id: row.batch.destinationBankAccountId,
        label: `${row.accountOwner} • ${row.accountNumber}`,
      },
      ...(row.batch.bankStatementLineId ? { bankStatementLineId: row.batch.bankStatementLineId } : {}),
      ...(row.batch.providerReference ? { providerReference: row.batch.providerReference } : {}),
      settlementDate: row.batch.settlementDate,
      match: row.batch.matchKind === 'DETERMINISTIC'
        ? { kind: SettlementMatchKind.DETERMINISTIC, ruleId: row.batch.matchRuleId!, ruleVersion: row.batch.matchRuleVersion! }
        : { kind: SettlementMatchKind.MANUAL, reason: row.batch.manualMatchReason! },
      gross: { amount: row.batch.grossAmount, currency },
      fee: { amount: row.batch.feeAmount, currency },
      deduction: { amount: row.batch.deductionAmount, currency },
      expectedNet: { amount: row.batch.expectedNetAmount, currency },
      actualNet: { amount: row.batch.actualNetAmount, currency },
      discrepancy: { amount: row.batch.discrepancyAmount, currency },
      discrepancyDisposition: row.batch.discrepancyDisposition as SettlementBatchView['discrepancyDisposition'],
      ...(row.batch.discrepancyReason ? { discrepancyReason: row.batch.discrepancyReason } : {}),
      ...(row.batch.replacementForBatchId ? { replacementForBatchId: row.batch.replacementForBatchId } : {}),
      ...(reversal ? { reversalBatchId: reversal.id } : {}),
      allocations: allocationRows.map(({ allocation, sourceType, sourceId, providerReference }) => ({
        id: allocation.id,
        collectionItemId: allocation.collectionItemId,
        collectionItem: {
          id: allocation.collectionItemId,
          label: providerReference || `${sourceType} • ${sourceId}`,
        },
        collectionItemVersion: Number(allocation.collectionItemVersion),
        amount: { amount: allocation.allocatedAmount, currency: allocation.currency },
        state: allocation.state as SettlementBatchView['allocations'][number]['state'],
      })),
      attachments: attachmentRows.map(({ id, contentDigest }) => ({
        id,
        contentDigest,
        purpose: 'BANK_CREDIT_EVIDENCE',
      })),
      creatorUserId: row.batch.creatorUserId,
      creator,
      ...(row.batch.confirmedBy && actor.get(row.batch.confirmedBy)
        ? { confirmedByUserId: row.batch.confirmedBy, confirmedBy: actor.get(row.batch.confirmedBy)! }
        : {}),
      ...(row.batch.confirmedAt ? { confirmedAt: row.batch.confirmedAt.toISOString() } : {}),
      ...(row.batch.reversedBy && actor.get(row.batch.reversedBy)
        ? { reversedByUserId: row.batch.reversedBy, reversedBy: actor.get(row.batch.reversedBy)! }
        : {}),
      ...(row.batch.reversedAt ? { reversedAt: row.batch.reversedAt.toISOString() } : {}),
      effects,
      state: row.batch.state as SettlementBatchView['state'],
      version: Number(row.batch.version),
      createdAt: row.batch.createdAt.toISOString(),
      updatedAt: row.batch.updatedAt.toISOString(),
    };
  }

  async reversalView(
    transaction: DatabaseTransaction,
    organizationId: string,
    reversalId: string,
  ): Promise<SettlementReversalView | undefined> {
    const [row] = await transaction.select({
      batch: settlementBatches,
      actorLabel: userRefs.displayName,
    }).from(settlementBatches).innerJoin(userRefs, and(
      eq(userRefs.organizationId, settlementBatches.organizationId),
      eq(userRefs.id, settlementBatches.creatorUserId),
    )).where(and(
      eq(settlementBatches.organizationId, organizationId),
      eq(settlementBatches.id, reversalId),
      eq(settlementBatches.state, 'REVERSAL'),
    )).limit(1);
    if (!row || !row.batch.reversalOfBatchId || !row.batch.reversalReason) return undefined;
    return {
      id: row.batch.id,
      organizationId,
      businessNumber: row.batch.businessNumber,
      reversalOfBatchId: row.batch.reversalOfBatchId,
      destinationBankAccountId: row.batch.destinationBankAccountId,
      businessDate: row.batch.settlementDate,
      actualNet: { amount: row.batch.actualNetAmount, currency: row.batch.currency },
      reason: row.batch.reversalReason,
      reversedByUserId: row.batch.creatorUserId,
      reversedBy: { id: row.batch.creatorUserId, label: row.actorLabel },
      effects: await this.effectViews(transaction, organizationId, reversalId),
      state: 'REVERSAL',
      version: Number(row.batch.version),
      createdAt: row.batch.createdAt.toISOString(),
    };
  }

  private async effectViews(
    transaction: DatabaseTransaction,
    organizationId: string,
    batchId: string,
  ): Promise<SettlementEffectView[]> {
    const rows = await transaction.select().from(settlementEffects).where(and(
      eq(settlementEffects.organizationId, organizationId),
      eq(settlementEffects.settlementBatchId, batchId),
    )).orderBy(asc(settlementEffects.createdAt), asc(settlementEffects.id));
    return rows.map((effect) => ({
      id: effect.id,
      effectKey: effect.effectKey,
      effectType: effect.effectType as SettlementEffectType,
      direction: effect.direction as 'SETTLEMENT' | 'REVERSAL',
      money: { amount: effect.amount, currency: effect.currency },
      businessDate: effect.businessDate,
      sourceVersion: Number(effect.sourceVersion),
      ...(effect.movementFactId ? { movementFactId: effect.movementFactId } : {}),
      ...(effect.collectionItemId ? { collectionItemId: effect.collectionItemId } : {}),
      ...(effect.reversalOfEffectId ? { reversalOfEffectId: effect.reversalOfEffectId } : {}),
    }));
  }
}
