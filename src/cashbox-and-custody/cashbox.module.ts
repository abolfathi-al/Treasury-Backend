import { Module } from '@nestjs/common';

import { AccessControlModule } from '../access-control/access-control.module';
import { FoundationEffectsModule } from '../foundation-effects/foundation-effects.module';
import { MasterDataModule } from '../master-data/master-data.module';
import { CashboxOperationsRepository } from './cashbox-operations.repository';
import { CashboxOperationsService } from './cashbox-operations.service';
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
  imports: [AccessControlModule, FoundationEffectsModule, MasterDataModule],
  controllers: [CashboxController],
  providers: [
    CashboxService,
    CashboxRepository,
    CashboxOperationsRepository,
    CashboxOperationsService,
    ReceiptCashboxEffectsRepository,
    ReceiptCashboxEffectsService,
    PaymentCashboxEffectsRepository,
    PaymentCashboxEffectsService,
  ],
  exports: [ReceiptCashboxEffectsService, PaymentCashboxEffectsService],
})
export class CashboxModule {}
