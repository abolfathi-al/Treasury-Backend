import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import type { DatabaseTransaction } from '../database/database.service';
import { bankAccounts, treasuryUnits } from '../database/schema';

export interface CollectionDestination {
  branchId?: string;
  treasuryUnitId: string;
}

@Injectable()
export class ReceiptBankingEffectsRepository {
  async receivable(
    transaction: DatabaseTransaction,
    organizationId: string,
    bankAccountId: string,
    currency: string,
  ): Promise<boolean> {
    const rows = await transaction
      .select({ id: bankAccounts.id })
      .from(bankAccounts)
      .where(and(
        eq(bankAccounts.organizationId, organizationId),
        eq(bankAccounts.id, bankAccountId),
        eq(bankAccounts.currency, currency),
        eq(bankAccounts.state, 'ACTIVE'),
        eq(bankAccounts.canReceive, true),
      ))
      .for('update');
    return rows.length === 1;
  }

  async collectionDestination(
    transaction: DatabaseTransaction,
    organizationId: string,
    bankAccountId: string,
    currency: string,
  ): Promise<CollectionDestination | undefined> {
    const rows = await transaction
      .select({
        treasuryUnitId: treasuryUnits.id,
        branchId: treasuryUnits.branchId,
      })
      .from(bankAccounts)
      .innerJoin(
        treasuryUnits,
        and(
          eq(treasuryUnits.organizationId, bankAccounts.organizationId),
          eq(treasuryUnits.id, bankAccounts.treasuryUnitId),
        ),
      )
      .where(and(
        eq(bankAccounts.organizationId, organizationId),
        eq(bankAccounts.id, bankAccountId),
        eq(bankAccounts.currency, currency),
        eq(bankAccounts.state, 'ACTIVE'),
        eq(bankAccounts.canReceive, true),
      ))
      .for('update');
    const row = rows[0];
    return row
      ? {
        treasuryUnitId: row.treasuryUnitId,
        ...(row.branchId ? { branchId: row.branchId } : {}),
      }
      : undefined;
  }
}

@Injectable()
export class ReceiptBankingEffectsService {
  constructor(
    @Inject(ReceiptBankingEffectsRepository)
    private readonly repository: ReceiptBankingEffectsRepository,
  ) {}

  receivable(
    transaction: DatabaseTransaction,
    organizationId: string,
    bankAccountId: string,
    currency: string,
  ): Promise<boolean> {
    return this.repository.receivable(transaction, organizationId, bankAccountId, currency);
  }

  collectionDestination(
    transaction: DatabaseTransaction,
    organizationId: string,
    bankAccountId: string,
    currency: string,
  ): Promise<CollectionDestination | undefined> {
    return this.repository.collectionDestination(
      transaction,
      organizationId,
      bankAccountId,
      currency,
    );
  }
}
