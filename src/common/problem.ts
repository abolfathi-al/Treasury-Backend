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
  'TRS-GEN-009': 'Business date closed',
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
  'TRS-AUT-013': 'Approval policy conflict',
  'TRS-AUT-014': 'Delegation conflict',
  'TRS-MST-001': 'Inactive reference',
  'TRS-MST-002': 'Duplicate master identity',
  'TRS-MST-003': 'Exchange rate missing or ambiguous',
  'TRS-MST-004': 'Method configuration invalid',
  'TRS-MST-005': 'Base currency locked',
  'TRS-MST-006': 'Numbering rule unavailable',
  'TRS-BNK-001': 'Bank account unavailable',
  'TRS-CHQ-001': 'Cheque leaf unavailable',
  'TRS-CHQ-002': 'Cheque-book range overlap',
  'TRS-CHQ-003': 'Illegal cheque transition',
  'TRS-CHQ-005': 'Possible duplicate received cheque',
  'TRS-CSH-002': 'Cashbox custody conflict',
  'TRS-CSH-003': 'Cashbox approval required',
  'TRS-CSH-004': 'Cashbox day already closed',
  'TRS-CSH-005': 'Petty cash ceiling exceeded',
  'TRS-RCP-001': 'Receipt total mismatch',
  'TRS-RCP-002': 'Receipt line incomplete',
  'TRS-RCP-003': 'Receipt allocation exceeds line',
  'TRS-RCP-004': 'Receipt effect mapping unavailable',
  'TRS-RCP-005': 'Receipt approval policy unavailable',
  'TRS-RCP-006': 'Receipt reversal blocked',
  'TRS-PAY-001': 'Payment total mismatch',
  'TRS-PAY-002': 'Payment evidence incomplete',
  'TRS-PAY-003': 'Payment approval incomplete',
  'TRS-PAY-004': 'Payment source unavailable',
  'TRS-PAY-005': 'Payment not executable',
  'TRS-PAY-006': 'External obligation allocation conflict',
  'TRS-PAY-007': 'Approval aggregate stale',
  'TRS-PAY-008': 'Payment approval policy unresolved',
  'TRS-PAY-009': 'Payment reversal blocked',
  'TRS-TRF-001': 'Transfer endpoints invalid',
  'TRS-TRF-002': 'Transfer source unavailable',
  'TRS-TRF-003': 'Transfer receipt discrepancy',
  'TRS-TRF-004': 'Transfer already acknowledged',
  'TRS-TRF-005': 'Transfer custody separation violated',
  'TRS-TRF-006': 'Transfer approval policy unresolved',
  'TRS-COL-001': 'Collection allocation conflict',
  'TRS-COL-002': 'Settlement arithmetic mismatch',
  'TRS-COL-003': 'Settlement discrepancy unresolved',
  'TRS-COL-004': 'Settlement confirmation unknown',
  'TRS-COL-005': 'Settlement reversal conflict',
  'TRS-COL-006': 'Settlement evidence invalid',
  'TRS-BNK-005': 'Bank instruction outcome conflict',
  'TRS-ACT-001': 'Accounting mapping required',
  'TRS-ACT-002': 'Accounting export duplicate',
  'TRS-ACT-004': 'Accounting outcome unknown',
  'TRS-ACT-005': 'Accounting posting lock active',
  'TRS-ACT-006': 'Accounting export period unavailable',
  'TRS-RPT-001': 'Unsupported report request',
  'TRS-RPT-002': 'Projection stale',
} as const;

export type ProblemCode = keyof typeof titles;

const retryable = new Set<ProblemCode>([
  'TRS-GEN-006',
  'TRS-AUT-008',
  'TRS-AUT-010',
  'TRS-CSH-002',
  'TRS-PAY-006',
  'TRS-PAY-007',
  'TRS-COL-001',
  'TRS-COL-004',
  'TRS-ACT-004',
  'TRS-RPT-002',
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
      const validation = exceptionStatus === 400
        ? authValidationProblem(request, exception)
        : null;
      status = validation?.status ?? (exceptionStatus === 400 ? 422 : exceptionStatus);
      code = validation?.code ?? (status === 422
        ? 'TRS-GEN-001'
        : status === 401
          ? 'TRS-GEN-002'
          : status === 403
            ? 'TRS-GEN-003'
            : status === 404
              ? 'TRS-GEN-004'
              : 'TRS-GEN-005');
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

function authValidationProblem(
  request: Request,
  exception: HttpException,
): { code: ProblemCode; status: number } | null {
  if (request.method !== 'POST') return null;
  const response = exception.getResponse();
  const messages = typeof response === 'object'
    && response !== null
    && 'message' in response
    && Array.isArray(response.message)
    ? response.message.filter((message): message is string => typeof message === 'string')
    : [];

  if (request.path === '/v1/auth/totp-enrollments') {
    return messages.some((message) => message.includes('newPassword'))
      ? { code: 'TRS-AUT-007', status: 422 }
      : { code: 'TRS-AUT-001', status: 401 };
  }
  if (request.path === '/v1/auth/totp-enrollment-completions') {
    return messages.some((message) => message.includes('enrollmentId'))
      ? { code: 'TRS-AUT-005', status: 401 }
      : { code: 'TRS-AUT-002', status: 401 };
  }
  if (request.path === '/v1/auth/totp-verifications') {
    return messages.some((message) => message.includes('challengeId'))
      ? { code: 'TRS-AUT-005', status: 401 }
      : { code: 'TRS-AUT-002', status: 401 };
  }
  if (request.path === '/v1/auth/password-recoveries') {
    return messages.some((message) => message.includes('newPassword'))
      ? { code: 'TRS-AUT-007', status: 422 }
      : { code: 'TRS-AUT-006', status: 401 };
  }
  return null;
}
