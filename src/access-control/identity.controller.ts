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

import {
  RequirePermission,
  RequireStepUp,
} from './auth.decorators';
import { TreasuryRequest } from './auth.guard';
import { IdentityAccountCreateDto, UserRefCreateDto } from './identity.dto';
import { IdentityService } from './identity.service';

@Controller('v1')
export class IdentityController {
  constructor(@Inject(IdentityService) private readonly service: IdentityService) {}

  @Get('user-refs')
  @RequirePermission('access-control.view')
  list(
    @Req() request: TreasuryRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.list(request.auth!.organizationId, limit, cursor);
  }

  @Post('user-refs')
  @RequirePermission('identity-account.manage')
  createUser(
    @Req() request: TreasuryRequest,
    @Headers('Idempotency-Key') key: string,
    @Body() body: UserRefCreateDto,
  ) {
    return this.service.createUser(request.auth!.organizationId, body, key);
  }

  @Post('identity-accounts')
  @RequirePermission('identity-account.manage')
  @RequireStepUp()
  createIdentity(
    @Req() request: TreasuryRequest,
    @Headers('Idempotency-Key') key: string,
    @Body() body: IdentityAccountCreateDto,
  ) {
    return this.service.createIdentity(
      request.auth!.organizationId,
      body,
      key,
      request.auth!,
      request.stepUp!,
    );
  }
}
