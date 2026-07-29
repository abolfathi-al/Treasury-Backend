import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import type { DatabaseTransaction } from '../database/database.service';
import { chequeEvents, receivedCheques } from '../database/schema';
import type { ReceiptChequeInputDto } from '../receipts/receipt.dto';

@Injectable()
export class ReceiptChequeEffectsRepository {
  async createReceived(
    transaction: DatabaseTransaction,
    input: {
      organizationId: string;
      receiptLineId: string;
      cheque: ReceiptChequeInputDto;
      amount: string;
      currency: string;
      custodianType: 'CASHBOX' | 'TREASURY_UNIT';
      custodianId: string;
    },
  ): Promise<string> {
    const id = randomUUID();
    const observation = input.cheque.sayadObservation;
    await transaction.insert(receivedCheques).values({
      id,
      organizationId: input.organizationId,
      receiptLineId: input.receiptLineId,
      issuerBankId: input.cheque.bankId,
      issuerBankBranchId: input.cheque.bankBranchId,
      chequeNumber: input.cheque.chequeNumber,
      series: input.cheque.series,
      localTrackingId: input.cheque.localTrackingId,
      issuerAccountRef: input.cheque.issuerAccountRef,
      payerPartyId: input.cheque.payerPartyId,
      amount: input.amount,
      currency: input.currency,
      receiptDate: input.cheque.receiptDate,
      dueDate: input.cheque.dueDate,
      custodianType: input.custodianType,
      custodianId: input.custodianId,
      sayadId: observation?.sayadId,
      sayadStatus: observation?.status,
      sayadSource: observation?.source,
      sayadObservedAt: observation ? new Date(observation.observedAt) : undefined,
      sayadSourceDigest: observation?.sourceDigest,
      issuerNationalId: observation?.issuerNationalId,
      beneficiaryNationalId: observation?.beneficiaryNationalId,
      state: 'RECEIVED',
      version: 0,
    });
    return id;
  }

  async reversalEvent(
    transaction: DatabaseTransaction,
    receivedChequeId: string,
  ): Promise<string | undefined> {
    const rows = await transaction
      .select({ id: chequeEvents.id })
      .from(chequeEvents)
      .where(and(
        eq(chequeEvents.chequeType, 'RECEIVED'),
        eq(chequeEvents.chequeId, receivedChequeId),
        inArray(chequeEvents.toState, [
          'RETURNED',
          'RETURNED_AFTER_CLEARANCE',
          'RETURNED_TO_PARTY',
          'CANCELLED',
        ]),
      ))
      .orderBy(desc(chequeEvents.sequenceNo))
      .limit(1);
    return rows[0]?.id;
  }
}

@Injectable()
export class ReceiptChequeEffectsService {
  constructor(
    @Inject(ReceiptChequeEffectsRepository)
    private readonly repository: ReceiptChequeEffectsRepository,
  ) {}

  createReceived(
    transaction: DatabaseTransaction,
    input: Parameters<ReceiptChequeEffectsRepository['createReceived']>[1],
  ): Promise<string> {
    return this.repository.createReceived(transaction, input);
  }

  reversalEvent(
    transaction: DatabaseTransaction,
    receivedChequeId: string,
  ): Promise<string | undefined> {
    return this.repository.reversalEvent(transaction, receivedChequeId);
  }
}
