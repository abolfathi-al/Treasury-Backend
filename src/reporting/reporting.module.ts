import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { ReportingController } from './reporting.controller';
import { ReportingRepository } from './reporting.repository';
import { ReportingService } from './reporting.service';

@Module({
  imports: [DatabaseModule],
  controllers: [ReportingController],
  providers: [ReportingRepository, ReportingService],
})
export class ReportingModule {}
