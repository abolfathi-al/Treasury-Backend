import { Module } from '@nestjs/common';

import { AccessControlModule } from '../access-control/access-control.module';
import { DatabaseModule } from '../database/database.module';
import { FoundationEffectsModule } from '../foundation-effects/foundation-effects.module';
import { SettlementController } from './settlement.controller';
import { SettlementRepository } from './settlement.repository';
import { SettlementService } from './settlement.service';

@Module({
  imports: [DatabaseModule, AccessControlModule, FoundationEffectsModule],
  controllers: [SettlementController],
  providers: [SettlementRepository, SettlementService],
})
export class SettlementModule {}
