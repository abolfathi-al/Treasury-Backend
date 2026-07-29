import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { AccessControlModule } from '../access-control/access-control.module';
import { BankingModule } from '../banking/banking.module';
import { CashboxModule } from '../cashbox-and-custody/cashbox.module';
import { ChequeModule } from '../cheques/cheque.module';
import { CollectionEffectsModule } from '../collection-and-settlement/collection-effects.module';
import { FoundationEffectsModule } from '../foundation-effects/foundation-effects.module';
import { ReceiptApprovalRepository } from './receipt-approval.repository';
import { ReceiptApprovalService } from './receipt-approval.service';
import { ReceiptController } from './receipt.controller';
import { ReceiptRepository } from './receipt.repository';
import { ReceiptService } from './receipt.service';
import { ReceiptExecutionRepository } from './receipt-execution.repository';
import { ReceiptExecutionService } from './receipt-execution.service';

@Module({
  imports: [
    DatabaseModule,
    AccessControlModule,
    BankingModule,
    CashboxModule,
    ChequeModule,
    CollectionEffectsModule,
    FoundationEffectsModule,
  ],
  controllers: [ReceiptController],
  providers: [
    ReceiptRepository,
    ReceiptService,
    ReceiptApprovalRepository,
    ReceiptApprovalService,
    ReceiptExecutionRepository,
    ReceiptExecutionService,
  ],
})
export class ReceiptModule {}
