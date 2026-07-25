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
} from '@nestjs/common';

import { requestId } from '../common/http';
import {
  AccessGrantCreateDto,
  RoleCreateDto,
  SessionRevokeDto,
} from './access-admin.dto';
import { AccessAdminService } from './access-admin.service';
import { RequirePermission, RequireStepUp } from './auth.decorators';
import { TreasuryRequest } from './auth.guard';

@Controller('v1')
export class AccessAdminController {
  constructor(@Inject(AccessAdminService) private readonly service: AccessAdminService) {}

  @Get('identity-accounts')
  @RequirePermission('identity-account.manage')
  listIdentityAccounts(
    @Req() request: TreasuryRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.listIdentityAccounts(request.auth!.organizationId, limit, cursor);
  }

  @Get('identity-accounts/:resourceId/sessions')
  @RequirePermission('identity-account.manage')
  listIdentityAccountSessions(
    @Req() request: TreasuryRequest,
    @Param('resourceId') resourceId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.listIdentityAccountSessions(
      request.auth!.organizationId,
      resourceId,
      request.auth!.session.sessionId,
      limit,
      cursor,
    );
  }

  @Post('identity-accounts/:resourceId/session-revocations')
  @RequirePermission('identity-account.manage')
  @RequireStepUp('revokeIdentitySessions')
  @HttpCode(200)
  revokeIdentitySessions(
    @Req() request: TreasuryRequest,
    @Param('resourceId') resourceId: string,
    @Headers('Idempotency-Key') key: string,
    @Body() body: SessionRevokeDto,
  ) {
    return this.service.revokeIdentitySessions(
      request.auth!.organizationId,
      resourceId,
      body,
      key,
      requestId(request.header('X-Request-Id')),
      request.auth!,
      request.stepUp!,
    );
  }

  @Get('roles')
  @RequirePermission('access-control.view')
  listRoles(
    @Req() request: TreasuryRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.listRoles(request.auth!.organizationId, limit, cursor);
  }

  @Post('roles')
  @RequirePermission('role.manage')
  @RequireStepUp('createRole')
  createRole(
    @Req() request: TreasuryRequest,
    @Headers('Idempotency-Key') key: string,
    @Body() body: RoleCreateDto,
  ) {
    return this.service.createRole(
      request.auth!.organizationId,
      body,
      key,
      requestId(request.header('X-Request-Id')),
      request.auth!,
      request.stepUp!,
    );
  }

  @Get('access-grants')
  @RequirePermission('access-control.view')
  listAccessGrants(
    @Req() request: TreasuryRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.service.listAccessGrants(
      request.auth!.organizationId,
      request.auth!.session.userId,
      limit,
      cursor,
    );
  }

  @Post('access-grants')
  @RequirePermission('access-grant.manage')
  @RequireStepUp('createAccessGrant')
  createAccessGrant(
    @Req() request: TreasuryRequest,
    @Headers('Idempotency-Key') key: string,
    @Body() body: AccessGrantCreateDto,
  ) {
    return this.service.createAccessGrant(
      request.auth!.organizationId,
      body,
      key,
      requestId(request.header('X-Request-Id')),
      request.auth!,
      request.stepUp!,
    );
  }
}
