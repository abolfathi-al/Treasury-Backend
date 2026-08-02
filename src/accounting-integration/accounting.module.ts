import { Module } from '@nestjs/common';

import { AccessControlModule } from '../access-control/access-control.module';
import { DatabaseModule } from '../database/database.module';
import { FoundationEffectsModule } from '../foundation-effects/foundation-effects.module';
import { AccountingController } from './accounting.controller';
import { AccountingRepository } from './accounting.repository';
import { AccountingService } from './accounting.service';

@Module({
  imports: [DatabaseModule, AccessControlModule, FoundationEffectsModule],
  controllers: [AccountingController],
  providers: [AccountingRepository, AccountingService],
})
export class AccountingModule {}
