import { Module } from '@nestjs/common';

import { AccessControlModule } from '../access-control/access-control.module';
import { DatabaseModule } from '../database/database.module';
import { FoundationEffectsModule } from '../foundation-effects/foundation-effects.module';
import { TransferController } from './transfer.controller';
import { TransferRepository } from './transfer.repository';
import { TransferService } from './transfer.service';

@Module({
  imports: [DatabaseModule, AccessControlModule, FoundationEffectsModule],
  controllers: [TransferController],
  providers: [TransferRepository, TransferService],
})
export class TransferModule {}
