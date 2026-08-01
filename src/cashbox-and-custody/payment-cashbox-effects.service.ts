import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';

import type { DatabaseTransaction } from '../database/database.service';
import {
  cashboxCurrencyControls,
  cashboxDays,
  cashboxes,
  movementFacts,
  paymentReservations,
} from '../database/schema';

export type PaymentSourceState = 'OK' | 'UNAVAILABLE' | 'CLOSED' | 'INSUFFICIENT';

@Injectable()
export class PaymentCashboxEffectsRepository {
  async payable(
    transaction: DatabaseTransaction,
    organizationId: string,
    cashboxId: string,
    currency: string,
    businessDate: string,
    paymentId: string,
    amount: string,
  ): Promise<PaymentSourceState> {
    const [row] = await transaction
      .select({
        state: cashboxes.state,
        canPay: cashboxes.canPay,
        activeFrom: cashboxes.activeFrom,
        activeTo: cashboxes.activeTo,
        transactionCeiling: cashboxCurrencyControls.transactionCeiling,
        minimumPosition: cashboxCurrencyControls.minimumPosition,
        allowNegative: cashboxCurrencyControls.allowNegative,
      })
      .from(cashboxes)
      .innerJoin(cashboxCurrencyControls, and(
        eq(cashboxCurrencyControls.organizationId, cashboxes.organizationId),
        eq(cashboxCurrencyControls.cashboxId, cashboxes.id),
        eq(cashboxCurrencyControls.currency, currency),
      ))
      .where(and(
        eq(cashboxes.organizationId, organizationId),
        eq(cashboxes.id, cashboxId),
      ))
      .for('update', { of: cashboxes });
    const at = new Date(`${businessDate}T00:00:00.000Z`);
    if (
      !row || row.state !== 'ACTIVE' || !row.canPay
      || row.activeFrom > at || (row.activeTo !== null && row.activeTo <= at)
    ) return 'UNAVAILABLE';

    const [day] = await transaction
      .select({ state: cashboxDays.state })
      .from(cashboxDays)
      .where(and(
        eq(cashboxDays.organizationId, organizationId),
        eq(cashboxDays.cashboxId, cashboxId),
        eq(cashboxDays.businessDate, businessDate),
      ))
      .orderBy(desc(cashboxDays.closeCycle))
      .limit(1)
      .for('update');
    if (day?.state === 'CLOSED') return 'CLOSED';

    if (row.transactionCeiling !== null && decimal(amount) > decimal(row.transactionCeiling)) {
      return 'INSUFFICIENT';
    }
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
        eq(movementFacts.endpointType, 'CASHBOX'),
        eq(movementFacts.endpointId, cashboxId),
        eq(movementFacts.currency, currency),
      ));
    const reservations = await transaction.select({ amount: paymentReservations.amount })
      .from(paymentReservations).where(and(
        eq(paymentReservations.organizationId, organizationId),
        eq(paymentReservations.sourceType, 'CASHBOX'),
        eq(paymentReservations.sourceId, cashboxId),
        eq(paymentReservations.currency, currency),
        inArray(paymentReservations.state, ['ACTIVE', 'REVIEW_REQUIRED']),
        ne(paymentReservations.paymentDocumentId, paymentId),
      )).for('update');
    const reserved = reservations.reduce((sum, reservation) => sum + decimal(reservation.amount), 0n);
    const floor = row.minimumPosition ?? (row.allowNegative ? null : '0');
    return floor !== null
      && decimal(position!.balance) - reserved - decimal(amount) < decimal(floor)
      ? 'INSUFFICIENT'
      : 'OK';
  }
}

function decimal(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
}

@Injectable()
export class PaymentCashboxEffectsService {
  constructor(
    @Inject(PaymentCashboxEffectsRepository)
    private readonly repository: PaymentCashboxEffectsRepository,
  ) {}

  payable(...args: Parameters<PaymentCashboxEffectsRepository['payable']>) {
    return this.repository.payable(...args);
  }
}
