import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { RequirePermission } from '../access-control/auth.decorators';
import { TreasuryRequest } from '../access-control/auth.guard';
import { ReceiptCreateDto } from './receipt.dto';
import { ReceiptService } from './receipt.service';

@Controller('v1')
export class ReceiptController {
  constructor(@Inject(ReceiptService) private readonly service: ReceiptService) {}

  @Get('receipts')
  @RequirePermission('receipt.view', 'listReceipts', 'ONE_GRANT_RESOURCE')
  list(
    @Req() request: TreasuryRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('businessDateFrom') businessDateFrom?: string,
    @Query('businessDateTo') businessDateTo?: string,
  ) {
    return this.service.list(
      request.auth!.organizationId,
      request.auth!.session.userId,
      limit,
      cursor,
      businessDateFrom,
      businessDateTo,
    );
  }

  @Post('receipts')
  @RequirePermission('receipt.create', 'createReceipt', 'ONE_GRANT_RESOURCE')
  async create(
    @Req() request: TreasuryRequest,
    @Headers('Idempotency-Key') key: string,
    @Headers('X-Request-Id') requestId: string,
    @Body() body: ReceiptCreateDto,
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

  @Get('receipts/:resourceId')
  @RequirePermission('receipt.view', 'getReceipt', 'ONE_GRANT_RESOURCE')
  async get(
    @Req() request: TreasuryRequest,
    @Param('resourceId') resourceId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const receipt = await this.service.get(
      request.auth!.organizationId,
      request.auth!.session.userId,
      resourceId,
    );
    response.setHeader('ETag', `"${receipt.version}"`);
    return receipt;
  }

  @Put('receipts/:resourceId')
  @RequirePermission('receipt.edit-draft', 'replaceReceiptDraft', 'ONE_GRANT_RESOURCE')
  async replace(
    @Req() request: TreasuryRequest,
    @Param('resourceId') resourceId: string,
    @Headers('Idempotency-Key') key: string,
    @Headers('If-Match') ifMatch: string,
    @Headers('X-Request-Id') requestId: string,
    @Body() body: ReceiptCreateDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const replaced = await this.service.replace(
      request.auth!.organizationId,
      request.auth!.session.userId,
      resourceId,
      body,
      key,
      ifMatch,
      requestId,
    );
    response.setHeader('ETag', `"${replaced.version}"`);
    return replaced;
  }
}
