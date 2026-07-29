import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { ReceiptApprovalRepository } from './receipt-approval.repository';
import { ReceiptApprovalService } from './receipt-approval.service';
import { ReceiptController } from './receipt.controller';
import { ReceiptRepository } from './receipt.repository';
import { ReceiptService } from './receipt.service';

@Module({
  imports: [DatabaseModule],
  controllers: [ReceiptController],
  providers: [
    ReceiptRepository,
    ReceiptService,
    ReceiptApprovalRepository,
    ReceiptApprovalService,
  ],
})
export class ReceiptModule {}
