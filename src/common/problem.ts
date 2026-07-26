import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { requestId as safeRequestId } from './http';

const titles = {
  'TRS-GEN-001': 'Validation failed',
  'TRS-GEN-002': 'Authentication required',
  'TRS-GEN-003': 'Permission denied',
  'TRS-GEN-004': 'Resource not found',
  'TRS-GEN-005': 'State conflict',
  'TRS-GEN-006': 'Stale version',
  'TRS-GEN-007': 'Idempotency key conflict',
  'TRS-AUT-001': 'Authentication failed',
  'TRS-AUT-002': 'TOTP required or invalid',
  'TRS-AUT-003': 'Session invalid',
  'TRS-AUT-005': 'Authentication challenge invalid',
  'TRS-AUT-006': 'Recovery proof failed',
  'TRS-AUT-007': 'Password rejected',
  'TRS-AUT-008': 'Authentication throttled',
  'TRS-AUT-009': 'CSRF verification failed',
  'TRS-AUT-010': 'Fresh step-up required',
  'TRS-AUT-012': 'Access-control identity conflict',
  'TRS-MST-001': 'Inactive reference',
  'TRS-MST-002': 'Duplicate master identity',
  'TRS-MST-004': 'Method configuration invalid',
  'TRS-MST-005': 'Base currency locked',
  'TRS-BNK-001': 'Bank account unavailable',
  'TRS-CSH-002': 'Cashbox custody conflict',
} as const;

export type ProblemCode = keyof typeof titles;

const retryable = new Set<ProblemCode>([
  'TRS-GEN-006',
  'TRS-AUT-008',
  'TRS-AUT-010',
  'TRS-CSH-002',
]);

export class TreasuryProblem extends HttpException {
  constructor(
    code: ProblemCode,
    status: number,
    detail?: string,
    extensions: Record<string, unknown> = {},
  ) {
    super({ code, detail, extensions }, status);
  }
}

@Catch(HttpException)
export class ProblemFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<Request>();
    const response = host.switchToHttp().getResponse<Response>();
    const requestId = safeRequestId(request.header('X-Request-Id'));

    let code: ProblemCode = 'TRS-GEN-005';
    let status = HttpStatus.CONFLICT;
    let detail: string | undefined;
    let extensions: Record<string, unknown> = {};

    if (exception instanceof TreasuryProblem) {
      status = exception.getStatus();
      const body = exception.getResponse() as {
        code: ProblemCode;
        detail?: string;
        extensions?: Record<string, unknown>;
      };
      code = body.code;
      detail = body.detail;
      extensions = body.extensions ?? {};
    } else {
      const exceptionStatus = exception.getStatus();
      status = exceptionStatus === 400 ? 422 : exceptionStatus;
      code = status === 422
        ? 'TRS-GEN-001'
        : status === 401
          ? 'TRS-GEN-002'
          : status === 403
            ? 'TRS-GEN-003'
            : status === 404
              ? 'TRS-GEN-004'
              : 'TRS-GEN-005';
      const body = exception.getResponse();
      detail = typeof body === 'string' ? body : undefined;
    }

    const { retryAfter, ...publicExtensions } = extensions;
    const body = {
      type: `urn:treasury:problem:${code}`,
      title: titles[code],
      status,
      code,
      ...(detail ? { detail } : {}),
      requestId,
      retryable: retryable.has(code),
      ...publicExtensions,
    };

    if (code.startsWith('TRS-AUT-') || request.path.startsWith('/v1/auth/')) {
      response.setHeader('Cache-Control', 'no-store');
    }
    if (code === 'TRS-AUT-008' && typeof retryAfter === 'number') {
      response.setHeader('Retry-After', Math.max(1, Math.ceil(retryAfter)));
    }
    response.status(status).type('application/problem+json').send(body);
  }
}
