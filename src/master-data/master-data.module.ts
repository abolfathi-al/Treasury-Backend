import { Module } from '@nestjs/common';

import { MasterDataController } from './master-data.controller';
import { MasterDataRepository } from './master-data.repository';
import { MasterDataService } from './master-data.service';
import { PrintTemplateController } from './print-template.controller';
import { PrintTemplateRepository } from './print-template.repository';
import { PrintTemplateService } from './print-template.service';

@Module({
  controllers: [MasterDataController, PrintTemplateController],
  providers: [
    MasterDataService,
    MasterDataRepository,
    PrintTemplateService,
    PrintTemplateRepository,
  ],
  exports: [MasterDataService],
})
export class MasterDataModule {}
