import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';

import { RequirePermission } from '../access-control/auth.decorators';
import { TreasuryRequest } from '../access-control/auth.guard';
import { ReportQuery } from './reporting.dto';
import { ReportingService } from './reporting.service';

@Controller('v1')
export class ReportingController {
  constructor(
    @Inject(ReportingService)
    private readonly service: ReportingService,
  ) {}

  @Get('reports/:reportKey')
  @RequirePermission('report.view', 'runOperationalReport', 'ONE_GRANT_RESOURCE')
  run(
    @Req() request: TreasuryRequest,
    @Param('reportKey') reportKey: string,
    @Query() query: ReportQuery,
  ) {
    return this.service.run(
      request.auth!.organizationId,
      request.auth!.session.userId,
      reportKey,
      query,
    );
  }
}
