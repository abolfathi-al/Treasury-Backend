import { Module } from '@nestjs/common';

import { ChequeController } from './cheque.controller';
import { ChequeRepository } from './cheque.repository';
import { ChequeService } from './cheque.service';
import {
  ReceiptChequeEffectsRepository,
  ReceiptChequeEffectsService,
} from './receipt-cheque-effects.service';

@Module({
  controllers: [ChequeController],
  providers: [
    ChequeService,
    ChequeRepository,
    ReceiptChequeEffectsRepository,
    ReceiptChequeEffectsService,
  ],
  exports: [ReceiptChequeEffectsService],
})
export class ChequeModule {}
