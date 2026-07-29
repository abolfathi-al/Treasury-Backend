import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { RequirePermission } from '../access-control/auth.decorators';
import { TreasuryRequest } from '../access-control/auth.guard';
import { CashboxCreateDto, HandoverCreateDto } from './cashbox.dto';
import { CashboxService } from './cashbox.service';

@Controller('v1')
export class CashboxController {
  constructor(@Inject(CashboxService) private readonly service: CashboxService) {}

  @Get('cashboxes')
  @RequirePermission('cashbox.view', 'listCashboxes', 'ONE_GRANT_RESOURCE')
  list(
    @Req() request: TreasuryRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.list(
      request.auth!.organizationId,
      request.auth!.session.userId,
      limit,
      cursor,
    );
  }

  @Post('cashboxes')
  @RequirePermission('cashbox.manage', 'createCashbox', 'ONE_GRANT_RESOURCE')
  async create(
    @Req() request: TreasuryRequest,
    @Headers('Idempotency-Key') key: string,
    @Headers('X-Request-Id') requestId: string,
    @Body() body: CashboxCreateDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const created = await this.service.create(
      request.auth!.organizationId,
      request.auth!.session.userId,
      body,
      key,
      requestId,
    );
    response.setHeader('ETag', `"${created.version}"`);
    return created;
  }

  @Post('cashboxes/:cashboxId/handovers')
  @RequirePermission('cashbox.handover', 'createCashboxHandover', 'ONE_GRANT_RESOURCE')
  async createHandover(
    @Req() request: TreasuryRequest,
    @Param('cashboxId') cashboxId: string,
    @Headers('Idempotency-Key') key: string,
    @Headers('If-Match') ifMatch: string,
    @Headers('X-Request-Id') requestId: string,
    @Body() body: HandoverCreateDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const created = await this.service.createHandover(
      request.auth!.organizationId,
      request.auth!.session.userId,
      cashboxId,
      body,
      key,
      ifMatch,
      requestId,
    );
    response.setHeader('ETag', `"${created.version}"`);
    return created;
  }
}
