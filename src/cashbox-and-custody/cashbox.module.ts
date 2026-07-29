import { Module } from '@nestjs/common';

import { AccessControlModule } from '../access-control/access-control.module';
import { MasterDataModule } from '../master-data/master-data.module';
import { CashboxController } from './cashbox.controller';
import { CashboxRepository } from './cashbox.repository';
import { CashboxService } from './cashbox.service';

@Module({
  imports: [AccessControlModule, MasterDataModule],
  controllers: [CashboxController],
  providers: [CashboxService, CashboxRepository],
})
export class CashboxModule {}
