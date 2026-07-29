import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Post,
  Query,
  Req,
} from '@nestjs/common';

import { RequirePermission } from '../access-control/auth.decorators';
import { TreasuryRequest } from '../access-control/auth.guard';
import { PrintTemplateCreateDto } from './print-template.dto';
import { PrintTemplateService } from './print-template.service';

@Controller('v1')
export class PrintTemplateController {
  constructor(@Inject(PrintTemplateService) private readonly service: PrintTemplateService) {}

  @Get('print-templates')
  @RequirePermission('print-template.view', 'listPrintTemplates', 'ONE_GRANT_RESOURCE')
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

  @Post('print-templates')
  @RequirePermission('print-template.manage', 'createPrintTemplate', 'ONE_GRANT_RESOURCE')
  create(
    @Req() request: TreasuryRequest,
    @Headers('Idempotency-Key') key: string,
    @Headers('X-Request-Id') requestId: string,
    @Body() body: PrintTemplateCreateDto,
  ) {
    return this.service.create(
      request.auth!.organizationId,
      request.auth!.session.userId,
      body,
      key,
      requestId,
    );
  }
}
