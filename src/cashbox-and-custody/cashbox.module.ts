import { Module } from '@nestjs/common';

import { CashboxController } from './cashbox.controller';
import { CashboxRepository } from './cashbox.repository';
import { CashboxService } from './cashbox.service';

@Module({
  controllers: [CashboxController],
  providers: [CashboxService, CashboxRepository],
})
export class CashboxModule {}
