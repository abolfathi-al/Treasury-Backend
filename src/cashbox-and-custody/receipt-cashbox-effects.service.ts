import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';

import type { DatabaseTransaction } from '../database/database.service';
import { cashboxCurrencyControls, cashboxDays, cashboxes } from '../database/schema';

@Injectable()
export class ReceiptCashboxEffectsRepository {
  async receivable(
    transaction: DatabaseTransaction,
    organizationId: string,
    cashboxId: string,
    currency: string,
    businessDate: string,
  ): Promise<'OK' | 'UNAVAILABLE' | 'CLOSED'> {
    const rows = await transaction
      .select({
        state: cashboxes.state,
        canReceive: cashboxes.canReceive,
        activeFrom: cashboxes.activeFrom,
        activeTo: cashboxes.activeTo,
        currency: cashboxCurrencyControls.currency,
      })
      .from(cashboxes)
      .innerJoin(
        cashboxCurrencyControls,
        and(
          eq(cashboxCurrencyControls.cashboxId, cashboxes.id),
          eq(cashboxCurrencyControls.organizationId, cashboxes.organizationId),
          eq(cashboxCurrencyControls.currency, currency),
        ),
      )
      .where(and(
        eq(cashboxes.organizationId, organizationId),
        eq(cashboxes.id, cashboxId),
      ))
      .for('update', { of: cashboxes });
    const row = rows[0];
    const at = new Date(`${businessDate}T00:00:00.000Z`);
    if (
      !row
      || row.state !== 'ACTIVE'
      || !row.canReceive
      || row.activeFrom > at
      || (row.activeTo !== null && row.activeTo <= at)
    ) return 'UNAVAILABLE';

    const days = await transaction
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
    return days[0]?.state === 'CLOSED' ? 'CLOSED' : 'OK';
  }
}

@Injectable()
export class ReceiptCashboxEffectsService {
  constructor(
    @Inject(ReceiptCashboxEffectsRepository)
    private readonly repository: ReceiptCashboxEffectsRepository,
  ) {}

  receivable(
    transaction: DatabaseTransaction,
    organizationId: string,
    cashboxId: string,
    currency: string,
    businessDate: string,
  ) {
    return this.repository.receivable(
      transaction,
      organizationId,
      cashboxId,
      currency,
      businessDate,
    );
  }
}
