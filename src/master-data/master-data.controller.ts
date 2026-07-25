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
  BranchCreateDto,
  CurrencyCreateDto,
  MethodCreateDto,
  TreasuryUnitCreateDto,
} from './master-data.dto';
import { MasterDataService } from './master-data.service';

@Controller('v1')
export class MasterDataController {
  constructor(@Inject(MasterDataService) private readonly service: MasterDataService) {}

  @Get('organization')
  @RequirePermission('master-data.view', 'getOrganization', 'ORGANIZATION_WIDE')
  organization(@Req() request: TreasuryRequest) {
    return this.service.organization(request.auth!.organizationId);
  }

  @Get('branches')
  @RequirePermission(
    [
      { permission: 'master-data.view', scopeMode: 'ORGANIZATION_WIDE' },
      { permission: 'access-grant.manage', scopeMode: 'ONE_GRANT_RESOURCE' },
    ],
    'listBranches',
  )
  branches(
    @Req() request: TreasuryRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.listBranches(request.auth!.organizationId, limit, cursor);
  }

  @Post('branches')
  @RequirePermission('master-data.manage', 'createBranch', 'ORGANIZATION_WIDE')
  createBranch(
    @Req() request: TreasuryRequest,
    @Headers('Idempotency-Key') key: string,
    @Body() body: BranchCreateDto,
  ) {
    return this.service.createBranch(request.auth!.organizationId, body, key);
  }

  @Get('treasury-units')
  @RequirePermission(
    [
      { permission: 'master-data.view', scopeMode: 'ORGANIZATION_WIDE' },
      { permission: 'access-grant.manage', scopeMode: 'ONE_GRANT_RESOURCE' },
    ],
    'listTreasuryUnits',
  )
  treasuryUnits(
    @Req() request: TreasuryRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.listTreasuryUnits(request.auth!.organizationId, limit, cursor);
  }

  @Post('treasury-units')
  @RequirePermission('master-data.manage', 'createTreasuryUnit', 'ORGANIZATION_WIDE')
  createTreasuryUnit(
    @Req() request: TreasuryRequest,
    @Headers('Idempotency-Key') key: string,
    @Body() body: TreasuryUnitCreateDto,
  ) {
    return this.service.createTreasuryUnit(request.auth!.organizationId, body, key);
  }

  @Get('currencies')
  @RequirePermission(
    [
      { permission: 'master-data.view', scopeMode: 'ORGANIZATION_WIDE' },
      { permission: 'access-grant.manage', scopeMode: 'ONE_GRANT_RESOURCE' },
    ],
    'listCurrencies',
  )
  currencies(
    @Req() request: TreasuryRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.listCurrencies(request.auth!.organizationId, limit, cursor);
  }

  @Post('currencies')
  @RequirePermission('master-data.manage', 'createCurrency', 'ORGANIZATION_WIDE')
  createCurrency(
    @Req() request: TreasuryRequest,
    @Headers('Idempotency-Key') key: string,
    @Body() body: CurrencyCreateDto,
  ) {
    return this.service.createCurrency(request.auth!.organizationId, body, key);
  }

  @Get('method-definitions')
  @RequirePermission('master-data.view', 'listMethodDefinitions', 'ORGANIZATION_WIDE')
  methods(
    @Req() request: TreasuryRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.listMethods(request.auth!.organizationId, limit, cursor);
  }

  @Post('method-definitions')
  @RequirePermission('master-data.manage', 'createMethodDefinition', 'ORGANIZATION_WIDE')
  createMethod(
    @Req() request: TreasuryRequest,
    @Headers('Idempotency-Key') key: string,
    @Body() body: MethodCreateDto,
  ) {
    return this.service.createMethod(request.auth!.organizationId, body, key);
  }
}
