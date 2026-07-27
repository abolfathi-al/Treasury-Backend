import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { RequirePermission } from '../access-control/auth.decorators';
import { TreasuryRequest } from '../access-control/auth.guard';
import { ChequeBookCreateDto, ChequeLeafTransitionDto } from './cheque.dto';
import { ChequeService } from './cheque.service';

@Controller('v1')
export class ChequeController {
  constructor(@Inject(ChequeService) private readonly service: ChequeService) {}

  @Post('cheque-books')
  @RequirePermission('cheque-book.manage', 'createChequeBook', 'ONE_GRANT_RESOURCE')
  async createChequeBook(
    @Req() request: TreasuryRequest,
    @Headers('Idempotency-Key') key: string,
    @Headers('X-Request-Id') requestId: string,
    @Body() body: ChequeBookCreateDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const created = await this.service.createChequeBook(
      request.auth!.organizationId,
      request.auth!.session.userId,
      body,
      key,
      requestId,
    );
    response.setHeader('ETag', `"${created.version}"`);
    return created;
  }

  @Post('cheque-books/:chequeBookId/leaves/:leafNumber/transitions')
  @HttpCode(200)
  @RequirePermission('cheque.transition', 'transitionCheque', 'ONE_GRANT_RESOURCE')
  async transitionCheque(
    @Req() request: TreasuryRequest,
    @Param('chequeBookId') chequeBookId: string,
    @Param('leafNumber') leafNumber: string,
    @Headers('Idempotency-Key') key: string,
    @Headers('If-Match') ifMatch: string,
    @Headers('X-Request-Id') requestId: string,
    @Body() body: ChequeLeafTransitionDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const updated = await this.service.transitionCheque(
      request.auth!.organizationId,
      request.auth!.session.userId,
      chequeBookId,
      leafNumber,
      body,
      key,
      ifMatch,
      requestId,
    );
    response.setHeader('ETag', `"${updated.version}"`);
    return updated;
  }
}
