import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import type { DatabaseTransaction } from '../database/database.service';
import { bankAccounts } from '../database/schema';

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
}
