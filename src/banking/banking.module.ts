import { Module } from '@nestjs/common';

import { AccessControlModule } from '../access-control/access-control.module';
import { DatabaseModule } from '../database/database.module';
import { FoundationEffectsModule } from '../foundation-effects/foundation-effects.module';
import { BankInstructionOutcomeRepository } from './bank-instruction-outcome.repository';
import { BankInstructionOutcomeService } from './bank-instruction-outcome.service';
import { BankingController } from './banking.controller';
import { BankingRepository } from './banking.repository';
import { BankingService } from './banking.service';
import {
  ReceiptBankingEffectsRepository,
  ReceiptBankingEffectsService,
} from './receipt-banking-effects.service';
import {
  PaymentBankingEffectsRepository,
  PaymentBankingEffectsService,
} from './payment-banking-effects.service';

@Module({
  imports: [DatabaseModule, AccessControlModule, FoundationEffectsModule],
  controllers: [BankingController],
  providers: [
    BankingService,
    BankingRepository,
    ReceiptBankingEffectsRepository,
    ReceiptBankingEffectsService,
    PaymentBankingEffectsRepository,
    PaymentBankingEffectsService,
    BankInstructionOutcomeRepository,
    BankInstructionOutcomeService,
  ],
  exports: [ReceiptBankingEffectsService, PaymentBankingEffectsService],
})
export class BankingModule {}
