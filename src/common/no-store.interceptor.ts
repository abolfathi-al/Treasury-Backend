import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';

const secretBearingPaths = new Set([
  '/v1/auth/sessions',
  '/v1/auth/totp-verifications',
  '/v1/auth/totp-enrollments',
  '/v1/auth/totp-enrollment-completions',
  '/v1/auth/password-recoveries',
]);

@Injectable()
export class NoStoreInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    if (secretBearingPaths.has(request.path)) {
      context.switchToHttp().getResponse<Response>().setHeader('Cache-Control', 'no-store');
    }
    return next.handle();
  }
}
