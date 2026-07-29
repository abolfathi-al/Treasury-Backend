import { Module } from '@nestjs/common';

import { BankingController } from './banking.controller';
import { BankingRepository } from './banking.repository';
import { BankingService } from './banking.service';

@Module({
  controllers: [BankingController],
  providers: [BankingService, BankingRepository],
})
export class BankingModule {}
