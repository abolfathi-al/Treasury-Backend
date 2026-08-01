import { Injectable } from '@nestjs/common';
import { and, asc, eq, InferSelectModel, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import type { DatabaseTransaction } from '../database/database.service';
import {
  bankInstructions,
  methodDefinitions,
  paymentAllocations,
  paymentApprovalActions,
  paymentApprovalSnapshots,
  paymentDocuments,
  paymentExecutionEffects,
  paymentLines,
  paymentReservations,
  treasuryUnits,
} from '../database/schema';
import type { PaymentExecutionEffectType } from './payment.dto';

type PaymentRow = InferSelectModel<typeof paymentDocuments>;
type PaymentLineRow = InferSelectModel<typeof paymentLines>;
type PaymentEffectRow = InferSelectModel<typeof paymentExecutionEffects>;
type PaymentAllocationRow = InferSelectModel<typeof paymentAllocations>;
type PaymentReservationRow = InferSelectModel<typeof paymentReservations>;

export interface LockedPayment {
  document: PaymentRow;
  lines: Array<PaymentLineRow & { methodState: string }>;
  approverUserIds: string[];
  allocations: PaymentAllocationRow[];
  reservations: PaymentReservationRow[];
  effectiveBranchId: string | null;
}

@Injectable()
export class PaymentExecutionRepository {
  async lockPayment(
    transaction: DatabaseTransaction,
    organizationId: string,
    paymentId: string,
  ): Promise<LockedPayment | undefined> {
    const [document] = await transaction.select().from(paymentDocuments).where(and(
      eq(paymentDocuments.organizationId, organizationId),
      eq(paymentDocuments.id, paymentId),
    )).for('update');
    if (!document) return undefined;

    const lineRows = await transaction.select({
      line: paymentLines,
      methodState: methodDefinitions.state,
    }).from(paymentLines).innerJoin(methodDefinitions, and(
      eq(methodDefinitions.organizationId, paymentLines.organizationId),
      eq(methodDefinitions.id, paymentLines.methodId),
    )).where(and(
      eq(paymentLines.organizationId, organizationId),
      eq(paymentLines.paymentDocumentId, paymentId),
    )).orderBy(asc(paymentLines.lineNumber)).for('update', { of: paymentLines });

    const approvers = document.currentApprovalSnapshotId
      ? await transaction.select({
        actorUserId: paymentApprovalActions.actorUserId,
        delegatedFromUserId: paymentApprovalActions.delegatedFromUserId,
      })
        .from(paymentApprovalActions)
        .where(and(
          eq(paymentApprovalActions.organizationId, organizationId),
          eq(paymentApprovalActions.approvalSnapshotId, document.currentApprovalSnapshotId),
          eq(paymentApprovalActions.action, 'APPROVED'),
        ))
      : [];
    const allocations = await transaction.select().from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, organizationId),
      eq(paymentAllocations.paymentDocumentId, paymentId),
    )).for('update');
    const reservations = await transaction.select().from(paymentReservations).where(and(
      eq(paymentReservations.organizationId, organizationId),
      eq(paymentReservations.paymentDocumentId, paymentId),
    )).for('update');
    const [unit] = await transaction.select({ branchId: treasuryUnits.branchId })
      .from(treasuryUnits).where(and(
        eq(treasuryUnits.organizationId, organizationId),
        eq(treasuryUnits.id, document.treasuryUnitId),
      )).limit(1);
    return {
      document,
      lines: lineRows.map(({ line, methodState }) => ({ ...line, methodState })),
      approverUserIds: [...new Set(approvers.flatMap(({ actorUserId, delegatedFromUserId }) => [
        actorUserId,
        ...(delegatedFromUserId ? [delegatedFromUserId] : []),
      ]))],
      allocations,
      reservations,
      effectiveBranchId: document.branchId ?? unit?.branchId ?? null,
    };
  }

  async overrideApprovalValid(
    transaction: DatabaseTransaction,
    input: {
      organizationId: string;
      payment: LockedPayment;
      approvalActionId: string;
      reason: string;
      executorUserId: string;
      conflictingUserIds: string[];
    },
  ): Promise<'VALID' | 'INVALID_EVIDENCE' | 'NOT_INDEPENDENT'> {
    const [row] = await transaction.select({
      actorUserId: paymentApprovalActions.actorUserId,
      reason: paymentApprovalActions.reason,
      approvalSnapshotId: paymentApprovalActions.approvalSnapshotId,
      action: paymentApprovalActions.action,
      documentVersion: paymentApprovalSnapshots.documentVersion,
    }).from(paymentApprovalActions).innerJoin(paymentApprovalSnapshots, and(
      eq(paymentApprovalSnapshots.organizationId, paymentApprovalActions.organizationId),
      eq(paymentApprovalSnapshots.id, paymentApprovalActions.approvalSnapshotId),
    )).where(and(
      eq(paymentApprovalActions.organizationId, input.organizationId),
      eq(paymentApprovalActions.id, input.approvalActionId),
    )).limit(1);
    if (
      !row || row.action !== 'APPROVED'
      || row.approvalSnapshotId !== input.payment.document.currentApprovalSnapshotId
      || row.reason?.trim() !== input.reason.trim()
      || Number(row.documentVersion) > Number(input.payment.document.version)
    ) return 'INVALID_EVIDENCE';
    return row.actorUserId === input.executorUserId
      || input.conflictingUserIds.includes(row.actorUserId)
      ? 'NOT_INDEPENDENT'
      : 'VALID';
  }

  async consumeReservations(
    transaction: DatabaseTransaction,
    organizationId: string,
    reservationIds: string[],
  ): Promise<void> {
    if (!reservationIds.length) return;
    await transaction.update(paymentReservations).set({
      state: 'CONSUMED',
      version: sql`${paymentReservations.version} + 1`,
    }).where(and(
      eq(paymentReservations.organizationId, organizationId),
      inArray(paymentReservations.id, reservationIds),
    ));
  }

  siblingAllocations(
    transaction: DatabaseTransaction,
    organizationId: string,
    allocation: PaymentAllocationRow,
  ): Promise<PaymentAllocationRow[]> {
    return transaction.select().from(paymentAllocations).where(and(
      eq(paymentAllocations.organizationId, organizationId),
      eq(paymentAllocations.sourceNamespace, allocation.sourceNamespace),
      eq(paymentAllocations.externalObjectType, allocation.externalObjectType),
      eq(paymentAllocations.externalObjectId, allocation.externalObjectId),
      eq(paymentAllocations.currency, allocation.currency),
      eq(paymentAllocations.state, 'ACTIVE'),
    )).for('update');
  }

  async appendEffect(
    transaction: DatabaseTransaction,
    input: {
      organizationId: string;
      paymentLineId: string;
      effectKey: string;
      effectType: PaymentExecutionEffectType;
      direction: 'OUTGOING' | 'REVERSAL';
      amount: string;
      currency: string;
      businessDate: string;
      sourceVersion: number;
      movementFactId?: string;
      bankInstructionId?: string;
      issuedChequeId?: string;
      reversalOfEffectId?: string;
    },
  ): Promise<string> {
    const id = randomUUID();
    await transaction.insert(paymentExecutionEffects).values({ id, ...input });
    return id;
  }

  async completeExecution(
    transaction: DatabaseTransaction,
    input: {
      organizationId: string;
      paymentId: string;
      actorUserId: string;
      executedAt: Date;
      sourceVersion: number;
    },
  ): Promise<void> {
    await transaction.update(paymentDocuments).set({
      state: 'EXECUTED',
      executionState: 'EXECUTED',
      executedAt: input.executedAt,
      executedByUserId: input.actorUserId,
      version: input.sourceVersion,
      updatedAt: input.executedAt,
    }).where(and(
      eq(paymentDocuments.organizationId, input.organizationId),
      eq(paymentDocuments.id, input.paymentId),
    ));
    await transaction.update(paymentLines).set({
      state: 'EXECUTED',
      executedAt: input.executedAt,
      executedByUserId: input.actorUserId,
      version: sql`${paymentLines.version} + 1`,
      updatedAt: input.executedAt,
    }).where(and(
      eq(paymentLines.organizationId, input.organizationId),
      eq(paymentLines.paymentDocumentId, input.paymentId),
    ));
  }

  effects(
    transaction: DatabaseTransaction,
    organizationId: string,
    paymentId: string,
  ): Promise<Array<PaymentEffectRow & { paymentDocumentId: string; instructionState: string | null }>> {
    return transaction.select({
      effect: paymentExecutionEffects,
      paymentDocumentId: paymentLines.paymentDocumentId,
      instructionState: bankInstructions.state,
    }).from(paymentExecutionEffects).innerJoin(paymentLines, and(
      eq(paymentLines.organizationId, paymentExecutionEffects.organizationId),
      eq(paymentLines.id, paymentExecutionEffects.paymentLineId),
    )).leftJoin(bankInstructions, and(
      eq(bankInstructions.organizationId, paymentExecutionEffects.organizationId),
      eq(bankInstructions.id, paymentExecutionEffects.bankInstructionId),
    )).where(and(
      eq(paymentExecutionEffects.organizationId, organizationId),
      eq(paymentLines.paymentDocumentId, paymentId),
    )).orderBy(asc(paymentLines.lineNumber), asc(paymentExecutionEffects.createdAt))
      .then((rows) => rows.map(({ effect, ...row }) => ({ ...effect, ...row })));
  }

  async createReversal(
    transaction: DatabaseTransaction,
    input: {
      original: LockedPayment;
      actorUserId: string;
      businessDate: string;
      businessNumber: string;
      reason: string;
      executedAt: Date;
    },
  ): Promise<{ paymentId: string; lineIds: Map<string, string> }> {
    const id = randomUUID();
    await transaction.insert(paymentDocuments).values({
      id,
      organizationId: input.original.document.organizationId,
      businessNumber: input.businessNumber,
      businessDate: input.businessDate,
      beneficiaryPartyId: input.original.document.beneficiaryPartyId,
      branchId: input.original.document.branchId,
      treasuryUnitId: input.original.document.treasuryUnitId,
      baseCurrency: input.original.document.baseCurrency,
      totalBaseAmount: input.original.document.totalBaseAmount,
      dueDate: input.original.document.dueDate,
      purpose: `Reversal of ${input.original.document.businessNumber}: ${input.reason}`,
      creatorUserId: input.actorUserId,
      state: 'EXECUTED',
      workflowState: 'APPROVED',
      executionState: 'EXECUTED',
      accountingState: 'NOT_READY',
      executedAt: input.executedAt,
      executedByUserId: input.actorUserId,
      version: 1,
      createdAt: input.executedAt,
      updatedAt: input.executedAt,
    });
    const lineIds = new Map<string, string>();
    await transaction.insert(paymentLines).values(input.original.lines.map((line) => {
      const lineId = randomUUID();
      lineIds.set(line.id, lineId);
      return {
        id: lineId,
        organizationId: line.organizationId,
        paymentDocumentId: id,
        lineNumber: line.lineNumber,
        methodId: line.methodId,
        methodName: line.methodName,
        methodCategory: line.methodCategory,
        methodRequiredReferences: line.methodRequiredReferences,
        requiresApproval: line.requiresApproval,
        amount: line.amount,
        currency: line.currency,
        baseCurrency: line.baseCurrency,
        exchangeRate: line.exchangeRate,
        rateType: line.rateType,
        rateSource: line.rateSource,
        rateRecordId: line.rateRecordId,
        rateAt: line.rateAt,
        baseAmount: line.baseAmount,
        roundingDifference: line.roundingDifference,
        cashboxId: line.cashboxId,
        bankAccountId: line.bankAccountId,
        beneficiaryPartyId: line.beneficiaryPartyId,
        beneficiaryAccountReference: line.beneficiaryAccountReference,
        trackingNumber: line.trackingNumber,
        dueDate: line.dueDate,
        description: line.description,
        accountingDimensions: line.accountingDimensions,
        executedAt: input.executedAt,
        executedByUserId: input.actorUserId,
        state: 'EXECUTED',
        version: 1,
        createdAt: input.executedAt,
        updatedAt: input.executedAt,
      };
    }));
    return { paymentId: id, lineIds };
  }

  async completeReversal(
    transaction: DatabaseTransaction,
    input: {
      organizationId: string;
      originalPaymentId: string;
      reversalPaymentId: string;
      originalVersion: number;
      at: Date;
    },
  ): Promise<void> {
    await transaction.update(paymentDocuments).set({
      reversedPaymentId: input.reversalPaymentId,
      state: 'REVERSED',
      executionState: 'REVERSED',
      version: input.originalVersion,
      updatedAt: input.at,
    }).where(and(
      eq(paymentDocuments.organizationId, input.organizationId),
      eq(paymentDocuments.id, input.originalPaymentId),
    ));
    await transaction.update(paymentLines).set({
      state: 'REVERSED',
      version: sql`${paymentLines.version} + 1`,
      updatedAt: input.at,
    }).where(and(
      eq(paymentLines.organizationId, input.organizationId),
      eq(paymentLines.paymentDocumentId, input.originalPaymentId),
    ));
    await transaction.update(paymentAllocations).set({
      state: 'REVERSED',
      version: sql`${paymentAllocations.version} + 1`,
    }).where(and(
      eq(paymentAllocations.organizationId, input.organizationId),
      eq(paymentAllocations.paymentDocumentId, input.originalPaymentId),
      eq(paymentAllocations.state, 'ACTIVE'),
    ));
  }
}
