import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';

import type { DatabaseTransaction } from '../database/database.service';
import {
  bankAccounts,
  bankInstructions,
  movementFacts,
  paymentReservations,
} from '../database/schema';

@Injectable()
export class PaymentBankingEffectsRepository {
  async payable(
    transaction: DatabaseTransaction,
    organizationId: string,
    bankAccountId: string,
    currency: string,
    businessDate: string,
    paymentId: string,
    amount: string,
  ): Promise<boolean> {
    const [account] = await transaction
      .select({
        openingDate: bankAccounts.openingDate,
        closingDate: bankAccounts.closingDate,
        withdrawalCeiling: bankAccounts.withdrawalCeiling,
      })
      .from(bankAccounts)
      .where(and(
        eq(bankAccounts.organizationId, organizationId),
        eq(bankAccounts.id, bankAccountId),
        eq(bankAccounts.currency, currency),
        eq(bankAccounts.state, 'ACTIVE'),
        eq(bankAccounts.canPay, true),
      ))
      .for('update');
    if (
      !account || businessDate < account.openingDate
      || (account.closingDate !== null && businessDate > account.closingDate)
      || (account.withdrawalCeiling !== null && decimal(amount) > decimal(account.withdrawalCeiling))
    ) return false;
    const [position] = await transaction
      .select({
        balance: sql<string>`COALESCE(SUM(CASE
          WHEN ${movementFacts.direction} = 'CREDIT' THEN ${movementFacts.amount}
          ELSE -${movementFacts.amount}
        END), 0)::text`,
      })
      .from(movementFacts)
      .where(and(
        eq(movementFacts.organizationId, organizationId),
        eq(movementFacts.endpointType, 'BANK_ACCOUNT'),
        eq(movementFacts.endpointId, bankAccountId),
        eq(movementFacts.currency, currency),
      ));
    const reservations = await transaction.select({ amount: paymentReservations.amount })
      .from(paymentReservations).where(and(
        eq(paymentReservations.organizationId, organizationId),
        eq(paymentReservations.sourceType, 'BANK_ACCOUNT'),
        eq(paymentReservations.sourceId, bankAccountId),
        eq(paymentReservations.currency, currency),
        inArray(paymentReservations.state, ['ACTIVE', 'REVIEW_REQUIRED']),
        ne(paymentReservations.paymentDocumentId, paymentId),
      )).for('update');
    const reserved = reservations.reduce((sum, row) => sum + decimal(row.amount), 0n);
    return decimal(position!.balance) - reserved >= decimal(amount);
  }

  async createInstruction(
    transaction: DatabaseTransaction,
    input: {
      id: string;
      organizationId: string;
      paymentLineId: string;
      bankAccountId: string;
      amount: string;
      currency: string;
      beneficiaryAccountReference: string;
      localReference: string;
    },
  ): Promise<void> {
    await transaction.insert(bankInstructions).values(input);
  }
}

function decimal(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
}

@Injectable()
export class PaymentBankingEffectsService {
  constructor(
    @Inject(PaymentBankingEffectsRepository)
    private readonly repository: PaymentBankingEffectsRepository,
  ) {}

  payable(...args: Parameters<PaymentBankingEffectsRepository['payable']>) {
    return this.repository.payable(...args);
  }

  createInstruction(...args: Parameters<PaymentBankingEffectsRepository['createInstruction']>) {
    return this.repository.createInstruction(...args);
  }
}
