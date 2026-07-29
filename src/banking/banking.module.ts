import { Module } from '@nestjs/common';

import { BankingController } from './banking.controller';
import { BankingRepository } from './banking.repository';
import { BankingService } from './banking.service';
import {
  ReceiptBankingEffectsRepository,
  ReceiptBankingEffectsService,
} from './receipt-banking-effects.service';

@Module({
  controllers: [BankingController],
  providers: [
    BankingService,
    BankingRepository,
    ReceiptBankingEffectsRepository,
    ReceiptBankingEffectsService,
  ],
  exports: [ReceiptBankingEffectsService],
})
export class BankingModule {}
