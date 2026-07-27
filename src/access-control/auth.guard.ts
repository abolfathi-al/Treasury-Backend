import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';

import {
  commandDigest,
  digest,
  parseCookies,
  SESSION_COOKIE,
  setSessionCookies,
  XSRF_COOKIE,
} from '../common/http';
import { TreasuryProblem } from '../common/problem';
import {
  AUTHORIZATION_OPERATION,
  PermissionScopeMode,
  PERMISSION_SCOPE_MODE,
  PUBLIC_OPERATION,
  REQUIRED_PERMISSION,
  STEP_UP_REQUIRED,
} from './auth.decorators';
import { AuthService, SessionContext } from './auth.service';

export interface TreasuryRequest extends Request {
  auth?: SessionContext;
  stepUp?: {
    proofId: string;
    command: {
      operationId: string;
      method: string;
      path: string;
      bodyDigest: string;
      idempotencyKey: string;
    };
  };
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_OPERATION, [
      context.getHandler(),
      context.getClass(),
    ])) return true;

    const request = context.switchToHttp().getRequest<TreasuryRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    const cookies = parseCookies(request.header('cookie'));
    const sessionToken = cookies[SESSION_COOKIE];
    if (!sessionToken) {
      throw new TreasuryProblem(
        request.path === '/v1/auth/sessions/current' ? 'TRS-AUT-003' : 'TRS-GEN-002',
        401,
      );
    }
    const auth = await this.authService.authenticateSession(sessionToken);
    request.auth = auth;
    if (auth.rotatedSessionToken && auth.refreshedXsrfToken) {
      setSessionCookies(response, auth.rotatedSessionToken, auth.refreshedXsrfToken);
    }

    const permission = this.reflector.getAllAndOverride<string>(REQUIRED_PERMISSION, [
      context.getHandler(),
      context.getClass(),
    ]);
    const operationId = this.reflector.getAllAndOverride<string>(AUTHORIZATION_OPERATION, [
      context.getHandler(),
      context.getClass(),
    ]);
    const scopeMode = this.reflector.getAllAndOverride<PermissionScopeMode>(
      PERMISSION_SCOPE_MODE,
      [context.getHandler(), context.getClass()],
    );
    if (permission && !operationPermissionGranted(auth, operationId, permission, scopeMode)) {
      throw new TreasuryProblem('TRS-GEN-003', 403);
    }

    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      this.assertCsrf(request, auth, cookies);
    }

    const stepUpOperationId = this.reflector.getAllAndOverride<string>(STEP_UP_REQUIRED, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (stepUpOperationId) {
      const idempotencyKey = request.header('Idempotency-Key');
      if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
        throw new TreasuryProblem('TRS-GEN-001', 422, 'Idempotency-Key must contain 8 through 128 characters.');
      }
      const command = {
        operationId: stepUpOperationId,
        method: request.method,
        path: request.path,
        bodyDigest: commandDigest(stepUpOperationId, request.body),
        idempotencyKey,
      };
      const proofId = request.header('X-Step-Up-Proof');
      if (!proofId || !await this.authService.validateStepUpProof(proofId, auth, command)) {
        return this.authService.issueStepUpChallenge(auth, command);
      }
      request.stepUp = { proofId, command };
    }
    return true;
  }

  private assertCsrf(
    request: TreasuryRequest,
    auth: SessionContext,
    cookies: Record<string, string>,
  ): void {
    const expectedOrigin = process.env.APP_ORIGIN;
    const origin = request.header('Origin');
    const cookie = cookies[XSRF_COOKIE];
    const header = request.header('X-XSRF-TOKEN');
    if (!csrfValid(expectedOrigin, origin, cookie, header, auth.xsrfDigest)) {
      throw new TreasuryProblem('TRS-AUT-009', 403);
    }
  }
}

export function operationPermissionGranted(
  auth: SessionContext,
  operationId: string | undefined,
  permission: string,
  scopeMode: PermissionScopeMode | undefined,
): boolean {
  if (!operationId || !scopeMode) return false;
  const permissions = scopeMode === 'ORGANIZATION_WIDE'
    ? auth.organizationPermissions
    : auth.session.effectivePermissions;
  return permissions.includes(permission);
}

export function csrfValid(
  expectedOrigin: string | undefined,
  origin: string | undefined,
  cookie: string | undefined,
  header: string | undefined,
  sessionXsrfDigest: string,
): boolean {
  return Boolean(
    expectedOrigin
    && origin === expectedOrigin
    && cookie
    && header
    && cookie === header
    && digest(header) === sessionXsrfDigest,
  );
}
