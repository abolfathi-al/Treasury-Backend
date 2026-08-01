import { Module } from '@nestjs/common';

import { AccessControlModule } from '../access-control/access-control.module';
import { MasterDataModule } from '../master-data/master-data.module';
import { CashboxController } from './cashbox.controller';
import { CashboxRepository } from './cashbox.repository';
import { CashboxService } from './cashbox.service';
import {
  ReceiptCashboxEffectsRepository,
  ReceiptCashboxEffectsService,
} from './receipt-cashbox-effects.service';
import {
  PaymentCashboxEffectsRepository,
  PaymentCashboxEffectsService,
} from './payment-cashbox-effects.service';

@Module({
  imports: [AccessControlModule, MasterDataModule],
  controllers: [CashboxController],
  providers: [
    CashboxService,
    CashboxRepository,
    ReceiptCashboxEffectsRepository,
    ReceiptCashboxEffectsService,
    PaymentCashboxEffectsRepository,
    PaymentCashboxEffectsService,
  ],
  exports: [ReceiptCashboxEffectsService, PaymentCashboxEffectsService],
})
export class CashboxModule {}
