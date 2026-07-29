import { Module } from '@nestjs/common';

import { ChequeController } from './cheque.controller';
import { ChequeRepository } from './cheque.repository';
import { ChequeService } from './cheque.service';

@Module({
  controllers: [ChequeController],
  providers: [ChequeService, ChequeRepository],
})
export class ChequeModule {}
