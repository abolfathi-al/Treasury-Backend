import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';

import { RequirePermission, RequireStepUp, RequireStepUpWhenPresent } from '../access-control/auth.decorators';
import type { TreasuryRequest } from '../access-control/auth.guard';
import { PaymentApprovalService } from './payment-approval.service';
import {
  PaymentApprovalActionDto,
  PaymentCreateDto,
  PaymentExecuteDto,
  PaymentRequestCreateDto,
  PaymentReverseDto,
} from './payment.dto';
import { PaymentExecutionService } from './payment-execution.service';
import { PaymentService } from './payment.service';

@Controller('v1')
export class PaymentController {
  constructor(
    @Inject(PaymentService) private readonly service: PaymentService,
    @Inject(PaymentApprovalService) private readonly approvals: PaymentApprovalService,
    @Inject(PaymentExecutionService) private readonly execution: PaymentExecutionService,
  ) {}

  @Post('payment-requests')
  @RequirePermission('payment-request.create', 'createPaymentRequest', 'ONE_GRANT_RESOURCE')
  async createRequest(
    @Req() request: TreasuryRequest,
    @Headers('Idempotency-Key') key: string,
    @Headers('X-Request-Id') requestId: string,
    @Body() body: PaymentRequestCreateDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const created = await this.service.createRequest(
      request.auth!.organizationId,
      request.auth!.session.userId,
      body,
      key,
      requestId,
    );
    response.setHeader('ETag', `"${created.version}"`);
    return created;
  }

  @Get('payments')
  @RequirePermission('payment.view', 'listPayments', 'ONE_GRANT_RESOURCE')
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

  @Post('payments')
  @RequirePermission('payment.create', 'createPayment', 'ONE_GRANT_RESOURCE')
  async create(
    @Req() request: TreasuryRequest,
    @Headers('Idempotency-Key') key: string,
    @Headers('X-Request-Id') requestId: string,
    @Body() body: PaymentCreateDto,
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

  @Post('payments/:resourceId/submit')
  @RequirePermission('payment.submit', 'submitPayment', 'ONE_GRANT_RESOURCE')
  async submit(
    @Req() request: TreasuryRequest,
    @Param('resourceId') resourceId: string,
    @Headers('Idempotency-Key') key: string,
    @Headers('If-Match') ifMatch: string,
    @Headers('X-Request-Id') requestId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const submitted = await this.approvals.submit(
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

  @Post('payments/:resourceId/approval-actions')
  async actOnApproval(
    @Req() request: TreasuryRequest,
    @Param('resourceId') resourceId: string,
    @Headers('Idempotency-Key') key: string,
    @Headers('If-Match') ifMatch: string,
    @Headers('X-Request-Id') requestId: string,
    @Body() body: PaymentApprovalActionDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const updated = await this.approvals.act(
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

  @Post('payments/:resourceId/execute')
  @HttpCode(200)
  @RequirePermission('payment.execute', 'executePayment', 'ONE_GRANT_RESOURCE')
  @RequireStepUpWhenPresent('executePayment', 'separationOverride')
  async execute(
    @Req() request: TreasuryRequest,
    @Param('resourceId') resourceId: string,
    @Headers('Idempotency-Key') key: string,
    @Headers('If-Match') ifMatch: string,
    @Headers('X-Request-Id') requestId: string,
    @Body() body: PaymentExecuteDto | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const payment = await this.execution.execute({
      organizationId: request.auth!.organizationId,
      actorUserId: request.auth!.session.userId,
      physicalSessionId: request.auth!.physicalSessionId,
      paymentId: resourceId,
      key,
      ifMatch,
      requestId,
      stepUp: request.stepUp,
    }, body);
    response.setHeader('ETag', `"${payment.version}"`);
    return payment;
  }

  @Post('payments/:resourceId/reverse')
  @RequirePermission('payment.reverse', 'reversePayment', 'ONE_GRANT_RESOURCE')
  @RequireStepUp('reversePayment')
  async reverse(
    @Req() request: TreasuryRequest,
    @Param('resourceId') resourceId: string,
    @Headers('Idempotency-Key') key: string,
    @Headers('If-Match') ifMatch: string,
    @Headers('X-Request-Id') requestId: string,
    @Body() body: PaymentReverseDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.execution.reverse({
      organizationId: request.auth!.organizationId,
      actorUserId: request.auth!.session.userId,
      physicalSessionId: request.auth!.physicalSessionId,
      paymentId: resourceId,
      key,
      ifMatch,
      requestId,
      stepUp: request.stepUp,
    }, body);
    response.setHeader('ETag', `"${result.original.version}"`);
    return result;
  }
}
