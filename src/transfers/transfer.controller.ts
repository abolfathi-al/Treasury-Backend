import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';

import { RequirePermission } from '../access-control/auth.decorators';
import type { TreasuryRequest } from '../access-control/auth.guard';
import { TransferAcknowledgeDto, TransferApprovalActionDto, TransferCreateDto } from './transfer.dto';
import { TransferService } from './transfer.service';

@Controller('v1')
export class TransferController {
  constructor(@Inject(TransferService) private readonly service: TransferService) {}

  @Get('transfers')
  @RequirePermission('transfer.view', 'listTransfers', 'ONE_GRANT_RESOURCE')
  list(
    @Req() request: TreasuryRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.list(request.auth!.organizationId, request.auth!.session.userId, limit, cursor);
  }

  @Post('transfers')
  @RequirePermission('transfer.create', 'createTransfer', 'ONE_GRANT_RESOURCE')
  async create(
    @Req() request: TreasuryRequest,
    @Headers('Idempotency-Key') key: string,
    @Headers('X-Request-Id') requestId: string,
    @Body() body: TransferCreateDto,
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

  @Post('transfers/:resourceId/submit')
  @HttpCode(200)
  @RequirePermission('transfer.submit', 'submitTransfer', 'ONE_GRANT_RESOURCE')
  async submit(
    @Req() request: TreasuryRequest,
    @Param('resourceId') resourceId: string,
    @Headers('Idempotency-Key') key: string,
    @Headers('If-Match') ifMatch: string,
    @Headers('X-Request-Id') requestId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const submitted = await this.service.submit(
      request.auth!.organizationId,
      request.auth!.session.userId,
      resourceId,
      key,
      ifMatch,
      requestId,
    );
    response.setHeader('ETag', `"${submitted.version}"`);
    return submitted;
  }

  @Post('transfers/:resourceId/approval-actions')
  @HttpCode(200)
  async act(
    @Req() request: TreasuryRequest,
    @Param('resourceId') resourceId: string,
    @Headers('Idempotency-Key') key: string,
    @Headers('If-Match') ifMatch: string,
    @Headers('X-Request-Id') requestId: string,
    @Body() body: TransferApprovalActionDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const updated = await this.service.act(
      request.auth!.organizationId,
      request.auth!.session.userId,
      resourceId,
      body,
      key,
      ifMatch,
      requestId,
    );
    response.setHeader('ETag', `"${updated.version}"`);
    return updated;
  }

  @Post('transfers/:resourceId/release')
  @HttpCode(200)
  @RequirePermission('transfer.release', 'releaseTransfer', 'ONE_GRANT_RESOURCE')
  async release(
    @Req() request: TreasuryRequest,
    @Param('resourceId') resourceId: string,
    @Headers('Idempotency-Key') key: string,
    @Headers('If-Match') ifMatch: string,
    @Headers('X-Request-Id') requestId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const updated = await this.service.release(
      request.auth!.organizationId, request.auth!.session.userId, resourceId, key, ifMatch, requestId,
    );
    response.setHeader('ETag', `"${updated.version}"`);
    return updated;
  }

  @Post('transfers/:resourceId/acknowledge')
  @HttpCode(200)
  @RequirePermission('transfer.receive', 'acknowledgeTransfer', 'ONE_GRANT_RESOURCE')
  async acknowledge(
    @Req() request: TreasuryRequest,
    @Param('resourceId') resourceId: string,
    @Headers('Idempotency-Key') key: string,
    @Headers('If-Match') ifMatch: string,
    @Headers('X-Request-Id') requestId: string,
    @Body() body: TransferAcknowledgeDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const updated = await this.service.acknowledge(
      request.auth!.organizationId, request.auth!.session.userId, resourceId, body, key, ifMatch, requestId,
    );
    response.setHeader('ETag', `"${updated.version}"`);
    return updated;
  }
}
