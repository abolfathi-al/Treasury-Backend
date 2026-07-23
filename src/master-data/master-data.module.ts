import { Module } from '@nestjs/common';

import { MasterDataController } from './master-data.controller';
import { MasterDataRepository } from './master-data.repository';
import { MasterDataService } from './master-data.service';

@Module({
  controllers: [MasterDataController],
  providers: [MasterDataService, MasterDataRepository],
})
export class MasterDataModule {}
