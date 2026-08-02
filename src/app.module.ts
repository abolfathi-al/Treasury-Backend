import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';

import { AccessControlModule } from './access-control/access-control.module';
import { AccountingModule } from './accounting-integration/accounting.module';
import { BankingModule } from './banking/banking.module';
import { ProblemFilter } from './common/problem';
import { NoStoreInterceptor } from './common/no-store.interceptor';
import { CashboxModule } from './cashbox-and-custody/cashbox.module';
import { ChequeModule } from './cheques/cheque.module';
import { DatabaseModule } from './database/database.module';
import { MasterDataModule } from './master-data/master-data.module';
import { PaymentModule } from './payments/payment.module';
import { ReceiptModule } from './receipts/receipt.module';
import { ReportingModule } from './reporting/reporting.module';
import { TransferModule } from './transfers/transfer.module';

@Module({
  imports: [
    DatabaseModule,
    AccessControlModule,
    AccountingModule,
    MasterDataModule,
    CashboxModule,
    BankingModule,
    ChequeModule,
    PaymentModule,
    ReceiptModule,
    ReportingModule,
    TransferModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ProblemFilter },
    { provide: APP_INTERCEPTOR, useClass: NoStoreInterceptor },
  ],
})
export class AppModule {}
