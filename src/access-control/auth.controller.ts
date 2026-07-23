import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import {
  clearSessionCookies,
  requestId,
  setSessionCookies,
  setXsrfCookie,
} from '../common/http';
import { PublicOperation, RequirePermission } from './auth.decorators';
import { LoginDto, PasswordRecoveryDto, TotpProofDto } from './auth.dto';
import { TreasuryRequest } from './auth.guard';
import { AuthService } from './auth.service';

@Controller('v1/auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  @Post('sessions')
  @PublicOperation()
  async login(
    @Body() body: LoginDto,
    @Req() request: TreasuryRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.authService.login(body, this.requestId(request));
    response.status(result.status);
    if ('sessionToken' in result) setSessionCookies(response, result.sessionToken, result.xsrfToken);
    return result.body;
  }

  @Post('totp-verifications')
  @PublicOperation()
  async verifyTotp(
    @Body() body: TotpProofDto,
    @Req() request: TreasuryRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.authService.verifyTotp(body, this.requestId(request));
    response.status(result.status);
    if ('sessionToken' in result) setSessionCookies(response, result.sessionToken, result.xsrfToken);
    return result.body;
  }

  @Get('sessions/current')
  async current(
    @Req() request: TreasuryRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const xsrf = await this.authService.refreshXsrf(request.auth!);
    if (xsrf) setXsrfCookie(response, xsrf);
    return request.auth!.session;
  }

  @Delete('sessions/:resourceId')
  @RequirePermission('auth.logout')
  @HttpCode(204)
  async logout(
    @Param('resourceId') resourceId: string,
    @Req() request: TreasuryRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.authService.logout(request.auth!, resourceId);
    clearSessionCookies(response);
  }

  @Post('password-recoveries')
  @PublicOperation()
  @HttpCode(200)
  async recover(
    @Body() body: PasswordRecoveryDto,
    @Req() request: TreasuryRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    response.setHeader('Cache-Control', 'no-store');
    return this.authService.recoverPassword(body, this.requestId(request));
  }

  private requestId(request: TreasuryRequest): string {
    return requestId(request.header('X-Request-Id'));
  }
}
