import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';

import { AccessControlModule } from './access-control/access-control.module';
import { ProblemFilter } from './common/problem';
import { NoStoreInterceptor } from './common/no-store.interceptor';
import { DatabaseModule } from './database/database.module';
import { MasterDataModule } from './master-data/master-data.module';

@Module({
  imports: [DatabaseModule, AccessControlModule, MasterDataModule],
  providers: [
    { provide: APP_FILTER, useClass: ProblemFilter },
    { provide: APP_INTERCEPTOR, useClass: NoStoreInterceptor },
  ],
})
export class AppModule {}
