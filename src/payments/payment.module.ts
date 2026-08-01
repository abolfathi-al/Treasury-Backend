import { Module } from '@nestjs/common';

import { AccessControlModule } from '../access-control/access-control.module';
import { DatabaseModule } from '../database/database.module';
import { PaymentApprovalRepository } from './payment-approval.repository';
import { PaymentApprovalService } from './payment-approval.service';
import { PaymentController } from './payment.controller';
import { PaymentRepository } from './payment.repository';
import { PaymentService } from './payment.service';

@Module({
  imports: [DatabaseModule, AccessControlModule],
  controllers: [PaymentController],
  providers: [PaymentRepository, PaymentApprovalRepository, PaymentService, PaymentApprovalService],
})
export class PaymentModule {}
