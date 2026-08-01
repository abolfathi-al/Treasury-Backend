import { Module } from '@nestjs/common';

import { AccessControlModule } from '../access-control/access-control.module';
import { BankingModule } from '../banking/banking.module';
import { CashboxModule } from '../cashbox-and-custody/cashbox.module';
import { DatabaseModule } from '../database/database.module';
import { FoundationEffectsModule } from '../foundation-effects/foundation-effects.module';
import { PaymentApprovalRepository } from './payment-approval.repository';
import { PaymentApprovalService } from './payment-approval.service';
import { PaymentController } from './payment.controller';
import { PaymentExecutionRepository } from './payment-execution.repository';
import { PaymentExecutionService } from './payment-execution.service';
import { PaymentRepository } from './payment.repository';
import { PaymentService } from './payment.service';

@Module({
  imports: [
    DatabaseModule,
    AccessControlModule,
    BankingModule,
    CashboxModule,
    FoundationEffectsModule,
  ],
  controllers: [PaymentController],
  providers: [
    PaymentRepository,
    PaymentApprovalRepository,
    PaymentExecutionRepository,
    PaymentService,
    PaymentApprovalService,
    PaymentExecutionService,
  ],
})
export class PaymentModule {}
