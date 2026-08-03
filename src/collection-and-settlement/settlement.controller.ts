import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';

import { RequirePermission, RequireStepUp } from '../access-control/auth.decorators';
import type { TreasuryRequest } from '../access-control/auth.guard';
import { SettlementBatchQuery, SettlementCreateDto, SettlementReverseDto } from './settlement.dto';
import { SettlementService } from './settlement.service';

@Controller('v1')
export class SettlementController {
  constructor(@Inject(SettlementService) private readonly service: SettlementService) {}

  @Get('settlement-batches')
  @RequirePermission('settlement.view', 'listSettlementBatches', 'ONE_GRANT_RESOURCE')
  list(
    @Req() request: TreasuryRequest,
    @Query() query: SettlementBatchQuery,
  ) {
    return this.service.list(
      request.auth!.organizationId,
      request.auth!.session.userId,
      query,
    );
  }

  @Get('settlement-batches/:resourceId')
  @RequirePermission('settlement.view', 'getSettlementBatch', 'ONE_GRANT_RESOURCE')
  async get(
    @Req() request: TreasuryRequest,
    @Param('resourceId') resourceId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const batch = await this.service.get(
      request.auth!.organizationId,
      request.auth!.session.userId,
      resourceId,
    );
    response.setHeader('ETag', `"${batch.version}"`);
    return batch;
  }

  @Post('settlement-batches')
  @RequirePermission('settlement.create', 'createSettlementBatch', 'ONE_GRANT_RESOURCE')
  async create(
    @Req() request: TreasuryRequest,
    @Headers('Idempotency-Key') key: string,
    @Headers('X-Request-Id') requestId: string,
    @Body() body: SettlementCreateDto,
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

  @Post('settlement-batches/:resourceId/confirm')
  @HttpCode(200)
  @RequirePermission('settlement.confirm', 'confirmSettlementBatch', 'ONE_GRANT_RESOURCE')
  async confirm(
    @Req() request: TreasuryRequest,
    @Param('resourceId') resourceId: string,
    @Headers('Idempotency-Key') key: string,
    @Headers('If-Match') ifMatch: string,
    @Headers('X-Request-Id') requestId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const confirmed = await this.service.confirm({
      organizationId: request.auth!.organizationId,
      actorUserId: request.auth!.session.userId,
      physicalSessionId: request.auth!.physicalSessionId,
      batchId: resourceId,
      key,
      ifMatch,
      requestId,
    });
    response.setHeader('ETag', `"${confirmed.version}"`);
    return confirmed;
  }

  @Post('settlement-batches/:resourceId/reverse')
  @RequirePermission('settlement.reverse', 'reverseSettlementBatch', 'ONE_GRANT_RESOURCE')
  @RequireStepUp('reverseSettlementBatch')
  async reverse(
    @Req() request: TreasuryRequest,
    @Param('resourceId') resourceId: string,
    @Headers('Idempotency-Key') key: string,
    @Headers('If-Match') ifMatch: string,
    @Headers('X-Request-Id') requestId: string,
    @Body() body: SettlementReverseDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.service.reverse({
      organizationId: request.auth!.organizationId,
      actorUserId: request.auth!.session.userId,
      physicalSessionId: request.auth!.physicalSessionId,
      batchId: resourceId,
      key,
      ifMatch,
      requestId,
      stepUp: request.stepUp,
    }, body);
    response.setHeader('ETag', `"${result.original.version}"`);
    return result;
  }
}
