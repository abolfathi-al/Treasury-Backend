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
import {
  BankAccountCreateDto,
  BankBranchCreateDto,
  BankCreateDto,
  BankTypeCreateDto,
  PaymentGatewayCreateDto,
  PosTerminalCreateDto,
} from './banking.dto';
import { BankingService } from './banking.service';

@Controller('v1')
export class BankingController {
  constructor(@Inject(BankingService) private readonly service: BankingService) {}

  @Get('bank-types')
  @RequirePermission('bank-type.view', 'listBankTypes', 'ORGANIZATION_WIDE')
  listBankTypes(
    @Req() request: TreasuryRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.listBankTypes(
      request.auth!.organizationId,
      request.auth!.session.userId,
      limit,
      cursor,
    );
  }

  @Post('bank-types')
  @RequirePermission('bank-type.manage', 'createBankType', 'ORGANIZATION_WIDE')
  createBankType(
    @Req() request: TreasuryRequest,
    @Headers('Idempotency-Key') key: string,
    @Headers('X-Request-Id') requestId: string,
    @Body() body: BankTypeCreateDto,
  ) {
    return this.service.createBankType(
      request.auth!.organizationId,
      request.auth!.session.userId,
      body,
      key,
      requestId,
    );
  }

  @Get('banks')
  @RequirePermission('bank.view', 'listBanks', 'ORGANIZATION_WIDE')
  listBanks(
    @Req() request: TreasuryRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.listBanks(
      request.auth!.organizationId,
      request.auth!.session.userId,
      limit,
      cursor,
    );
  }

  @Post('banks')
  @RequirePermission('bank.manage', 'createBank', 'ORGANIZATION_WIDE')
  createBank(
    @Req() request: TreasuryRequest,
    @Headers('Idempotency-Key') key: string,
    @Headers('X-Request-Id') requestId: string,
    @Body() body: BankCreateDto,
  ) {
    return this.service.createBank(
      request.auth!.organizationId,
      request.auth!.session.userId,
      body,
      key,
      requestId,
    );
  }

  @Get('bank-branches')
  @RequirePermission('bank-branch.view', 'listBankBranches', 'ORGANIZATION_WIDE')
  listBankBranches(
    @Req() request: TreasuryRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.listBankBranches(
      request.auth!.organizationId,
      request.auth!.session.userId,
      limit,
      cursor,
    );
  }

  @Post('bank-branches')
  @RequirePermission('bank-branch.manage', 'createBankBranch', 'ORGANIZATION_WIDE')
  createBankBranch(
    @Req() request: TreasuryRequest,
    @Headers('Idempotency-Key') key: string,
    @Headers('X-Request-Id') requestId: string,
    @Body() body: BankBranchCreateDto,
  ) {
    return this.service.createBankBranch(
      request.auth!.organizationId,
      request.auth!.session.userId,
      body,
      key,
      requestId,
    );
  }

  @Get('bank-accounts')
  @RequirePermission('bank-account.view', 'listBankAccounts', 'ONE_GRANT_RESOURCE')
  listBankAccounts(
    @Req() request: TreasuryRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.listBankAccounts(
      request.auth!.organizationId,
      request.auth!.session.userId,
      limit,
      cursor,
    );
  }

  @Post('bank-accounts')
  @RequirePermission('bank-account.manage', 'createBankAccount', 'ONE_GRANT_RESOURCE')
  createBankAccount(
    @Req() request: TreasuryRequest,
    @Headers('Idempotency-Key') key: string,
    @Headers('X-Request-Id') requestId: string,
    @Body() body: BankAccountCreateDto,
  ) {
    return this.service.createBankAccount(
      request.auth!.organizationId,
      request.auth!.session.userId,
      body,
      key,
      requestId,
    );
  }

  @Get('pos-terminals')
  @RequirePermission('pos-terminal.view', 'listPosTerminals', 'ONE_GRANT_RESOURCE')
  listPosTerminals(
    @Req() request: TreasuryRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.listPosTerminals(
      request.auth!.organizationId,
      request.auth!.session.userId,
      limit,
      cursor,
    );
  }

  @Post('pos-terminals')
  @RequirePermission('pos-terminal.manage', 'createPosTerminal', 'ONE_GRANT_RESOURCE')
  createPosTerminal(
    @Req() request: TreasuryRequest,
    @Headers('Idempotency-Key') key: string,
    @Headers('X-Request-Id') requestId: string,
    @Body() body: PosTerminalCreateDto,
  ) {
    return this.service.createPosTerminal(
      request.auth!.organizationId,
      request.auth!.session.userId,
      body,
      key,
      requestId,
    );
  }

  @Get('payment-gateways')
  @RequirePermission('payment-gateway.view', 'listPaymentGateways', 'ONE_GRANT_RESOURCE')
  listPaymentGateways(
    @Req() request: TreasuryRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.listPaymentGateways(
      request.auth!.organizationId,
      request.auth!.session.userId,
      limit,
      cursor,
    );
  }

  @Post('payment-gateways')
  @RequirePermission('payment-gateway.manage', 'createPaymentGateway', 'ONE_GRANT_RESOURCE')
  createPaymentGateway(
    @Req() request: TreasuryRequest,
    @Headers('Idempotency-Key') key: string,
    @Headers('X-Request-Id') requestId: string,
    @Body() body: PaymentGatewayCreateDto,
  ) {
    return this.service.createPaymentGateway(
      request.auth!.organizationId,
      request.auth!.session.userId,
      body,
      key,
      requestId,
    );
  }
}
