import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { RequirePermission } from '../access-control/auth.decorators';
import type { TreasuryRequest } from '../access-control/auth.guard';
import {
  AccountingFileQuery,
  AccountingExportQuery,
  AccountingSystemQuery,
  ExportAcknowledgementDto,
  ExportRequestDto,
} from './accounting.dto';
import { AccountingService } from './accounting.service';

@Controller('v1')
export class AccountingController {
  constructor(@Inject(AccountingService) private readonly service: AccountingService) {}

  @Get('accounting/systems')
  @RequirePermission('accounting.export', 'listAccountingSystems', 'ONE_GRANT_RESOURCE')
  listSystems(
    @Req() request: TreasuryRequest,
    @Query() query: AccountingSystemQuery,
  ) {
    return this.service.listSystems(
      request.auth!.organizationId,
      request.auth!.session.userId,
      query,
    );
  }

  @Get('accounting/exports')
  @RequirePermission('accounting.acknowledge', 'listAccountingExports', 'ONE_GRANT_RESOURCE')
  listExports(
    @Req() request: TreasuryRequest,
    @Query() query: AccountingExportQuery,
  ) {
    return this.service.listExports(
      request.auth!.organizationId,
      request.auth!.session.userId,
      query,
    );
  }

  @Post('accounting/exports')
  @HttpCode(202)
  @RequirePermission('accounting.export', 'createAccountingExport', 'ONE_GRANT_RESOURCE')
  async createExport(
    @Req() request: TreasuryRequest,
    @Headers('Idempotency-Key') key: string,
    @Headers('X-Request-Id') requestId: string,
    @Body() body: ExportRequestDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const accountingExport = await this.service.createExport(
      request.auth!.organizationId,
      request.auth!.session.userId,
      body,
      key,
      requestId,
    );
    response.setHeader('ETag', `"${accountingExport.version}"`);
    return accountingExport;
  }

  @Get('accounting/exports/:resourceId/file')
  @RequirePermission('accounting.export', 'downloadAccountingExportFile', 'ONE_GRANT_RESOURCE')
  async download(
    @Req() request: TreasuryRequest,
    @Param('resourceId') resourceId: string,
    @Query() query: AccountingFileQuery,
    @Res() response: Response,
  ): Promise<void> {
    const file = await this.service.download(
      request.auth!.organizationId,
      request.auth!.session.userId,
      resourceId,
      query,
    );
    response.setHeader('Content-Type', file.mediaType);
    response.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    response.setHeader('ETag', file.etag);
    response.send(file.bytes);
  }

  @Post('accounting/exports/:resourceId/acknowledgements')
  @HttpCode(200)
  @RequirePermission(
    'accounting.acknowledge',
    'recordAccountingAcknowledgement',
    'ONE_GRANT_RESOURCE',
  )
  async acknowledge(
    @Req() request: TreasuryRequest,
    @Param('resourceId') resourceId: string,
    @Headers('Idempotency-Key') key: string,
    @Headers('If-Match') ifMatch: string,
    @Headers('X-Request-Id') requestId: string,
    @Body() body: ExportAcknowledgementDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.service.acknowledge(
      request.auth!.organizationId,
      request.auth!.session.userId,
      resourceId,
      body,
      key,
      ifMatch,
      requestId,
    );
    response.setHeader('ETag', `"${result.export.version}"`);
    return result;
  }
}
