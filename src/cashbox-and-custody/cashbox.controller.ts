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

import { RequirePermission, RequireStepUp } from '../access-control/auth.decorators';
import { TreasuryRequest } from '../access-control/auth.guard';
import { CashboxCreateDto, HandoverCreateDto } from './cashbox.dto';
import {
  CashboxDayApprovalActionDto,
  CashboxDayCloseApprovalRequestDto,
  CashboxDayReopenApprovalRequestDto,
  CloseDayDto,
  PettyCashFundCreateDto,
  ReopenDayDto,
} from './cashbox-operations.dto';
import { CashboxOperationsService } from './cashbox-operations.service';
import { CashboxService } from './cashbox.service';

@Controller('v1')
export class CashboxController {
  constructor(
    @Inject(CashboxService) private readonly service: CashboxService,
    @Inject(CashboxOperationsService) private readonly operations: CashboxOperationsService,
  ) {}

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

  @Get('petty-cash-funds')
  @RequirePermission('petty-cash.view', 'listPettyCashFunds', 'ONE_GRANT_RESOURCE')
  listPettyCashFunds(
    @Req() request: TreasuryRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('cashboxId') cashboxId?: string,
    @Query('state') state?: string,
  ) {
    return this.operations.listPettyCashFunds(
      request.auth!.organizationId,
      request.auth!.session.userId,
      limit,
      cursor,
      cashboxId,
      state,
    );
  }

  @Post('petty-cash-funds')
  @RequirePermission('petty-cash.create', 'createPettyCashFund', 'ONE_GRANT_RESOURCE')
  async createPettyCashFund(
    @Req() request: TreasuryRequest,
    @Headers('Idempotency-Key') key: string,
    @Headers('X-Request-Id') requestId: string,
    @Body() body: PettyCashFundCreateDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const created = await this.operations.createPettyCashFund({
      organizationId: request.auth!.organizationId,
      actorUserId: request.auth!.session.userId,
      key,
      requestId,
    }, body);
    response.setHeader('ETag', `"${created.version}"`);
    return created;
  }

  @Post('cashboxes/:cashboxId/days/:businessDate/close-approval-requests')
  @RequirePermission('cashbox.close', 'requestCashboxDayCloseApproval', 'ONE_GRANT_RESOURCE')
  async requestCloseApproval(
    @Req() request: TreasuryRequest,
    @Param('cashboxId') cashboxId: string,
    @Param('businessDate') businessDate: string,
    @Headers('Idempotency-Key') key: string,
    @Headers('X-Request-Id') requestId: string,
    @Body() body: CashboxDayCloseApprovalRequestDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const created = await this.operations.requestCloseApproval({
      organizationId: request.auth!.organizationId,
      actorUserId: request.auth!.session.userId,
      key,
      requestId,
    }, cashboxId, businessDate, body);
    response.setHeader('ETag', `"${created.version}"`);
    return created;
  }

  @Post('cashboxes/:cashboxId/days/:businessDate/reopen-approval-requests')
  @RequirePermission('cashbox.reopen', 'requestCashboxDayReopenApproval', 'ONE_GRANT_RESOURCE')
  async requestReopenApproval(
    @Req() request: TreasuryRequest,
    @Param('cashboxId') cashboxId: string,
    @Param('businessDate') businessDate: string,
    @Headers('Idempotency-Key') key: string,
    @Headers('X-Request-Id') requestId: string,
    @Body() body: CashboxDayReopenApprovalRequestDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const created = await this.operations.requestReopenApproval({
      organizationId: request.auth!.organizationId,
      actorUserId: request.auth!.session.userId,
      key,
      requestId,
    }, cashboxId, businessDate, body);
    response.setHeader('ETag', `"${created.version}"`);
    return created;
  }

  @Get('cashbox-day-approval-requests')
  listApprovalRequests(
    @Req() request: TreasuryRequest,
    @Query('queue') queue: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('cashboxId') cashboxId?: string,
    @Query('commandKind') commandKind?: string,
    @Query('state') state?: string,
    @Query('businessDateFrom') businessDateFrom?: string,
    @Query('businessDateTo') businessDateTo?: string,
  ) {
    return this.operations.listApprovalRequests(
      request.auth!.organizationId,
      request.auth!.session.userId,
      queue,
      limit,
      cursor,
      cashboxId,
      commandKind,
      state,
      businessDateFrom,
      businessDateTo,
    );
  }

  @Post('cashbox-day-approval-requests/:approvalRequestId/actions')
  @HttpCode(200)
  @RequireStepUp('actOnCashboxDayApproval')
  async actOnApproval(
    @Req() request: TreasuryRequest,
    @Param('approvalRequestId') approvalRequestId: string,
    @Headers('Idempotency-Key') key: string,
    @Headers('If-Match') ifMatch: string,
    @Headers('X-Request-Id') requestId: string,
    @Body() body: CashboxDayApprovalActionDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const updated = await this.operations.actOnApproval({
      organizationId: request.auth!.organizationId,
      actorUserId: request.auth!.session.userId,
      physicalSessionId: request.auth!.physicalSessionId,
      key,
      requestId,
      ifMatch,
      stepUp: request.stepUp,
    }, approvalRequestId, body);
    response.setHeader('ETag', `"${updated.version}"`);
    return updated;
  }

  @Post('cashboxes/:cashboxId/days/:businessDate/close')
  @HttpCode(200)
  @RequirePermission('cashbox.close', 'closeCashboxDay', 'ONE_GRANT_RESOURCE')
  async closeDay(
    @Req() request: TreasuryRequest,
    @Param('cashboxId') cashboxId: string,
    @Param('businessDate') businessDate: string,
    @Headers('Idempotency-Key') key: string,
    @Headers('X-Request-Id') requestId: string,
    @Body() body: CloseDayDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const updated = await this.operations.closeDay({
      organizationId: request.auth!.organizationId,
      actorUserId: request.auth!.session.userId,
      key,
      requestId,
    }, cashboxId, businessDate, body);
    response.setHeader('ETag', `"${updated.version}"`);
    return updated;
  }

  @Post('cashboxes/:cashboxId/days/:businessDate/reopen')
  @HttpCode(200)
  @RequirePermission('cashbox.reopen', 'reopenCashboxDay', 'ONE_GRANT_RESOURCE')
  @RequireStepUp('reopenCashboxDay')
  async reopenDay(
    @Req() request: TreasuryRequest,
    @Param('cashboxId') cashboxId: string,
    @Param('businessDate') businessDate: string,
    @Headers('Idempotency-Key') key: string,
    @Headers('If-Match') ifMatch: string,
    @Headers('X-Request-Id') requestId: string,
    @Body() body: ReopenDayDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const updated = await this.operations.reopenDay({
      organizationId: request.auth!.organizationId,
      actorUserId: request.auth!.session.userId,
      physicalSessionId: request.auth!.physicalSessionId,
      key,
      requestId,
      ifMatch,
      stepUp: request.stepUp,
    }, cashboxId, businessDate, body);
    response.setHeader('ETag', `"${updated.version}"`);
    return updated;
  }
}
