import { Inject, Injectable } from '@nestjs/common';

import { commandDigest, digest } from '../common/http';
import { TreasuryProblem } from '../common/problem';
import {
  AccessGrantCreateDto,
  CANON_PERMISSIONS,
  CanonicalGrantScope,
  GrantAuthorization,
  GrantScopeDto,
  METHOD_CATEGORIES,
  RoleCreateDto,
  SessionRevokeDto,
  SessionRevokeScope,
} from './access-admin.dto';
import {
  AccessAdminRepository,
  PreparedAccessGrant,
  ProtectedCommandContext,
  TreasuryAuthorizationError,
} from './access-admin.repository';
import { AuthService, SessionContext } from './auth.service';

interface StepUpContext {
  proofId: string;
  command: {
    operationId: string;
    method: string;
    path: string;
    bodyDigest: string;
    idempotencyKey: string;
  };
}

@Injectable()
export class AccessAdminService {
  constructor(
    @Inject(AccessAdminRepository) private readonly repository: AccessAdminRepository,
    @Inject(AuthService) private readonly authService: AuthService,
  ) {}

  listIdentityAccounts(organizationId: string, rawLimit?: string, cursor?: string) {
    return this.repository.listIdentityAccounts(
      organizationId,
      this.limit(rawLimit),
      this.uuid(cursor, 'cursor'),
    );
  }

  listIdentityAccountSessions(
    organizationId: string,
    identityAccountId: string,
    currentLogicalSessionId: string,
    rawLimit?: string,
    cursor?: string,
  ) {
    return this.map(() => this.repository.listIdentityAccountSessions(
      organizationId,
      this.uuid(identityAccountId, 'resourceId')!,
      currentLogicalSessionId,
      this.limit(rawLimit),
      this.uuid(cursor, 'cursor'),
    ));
  }

  listRoles(organizationId: string, rawLimit?: string, cursor?: string) {
    return this.repository.listRoles(
      organizationId,
      this.limit(rawLimit),
      this.uuid(cursor, 'cursor'),
    );
  }

  async createRole(
    organizationId: string,
    dto: RoleCreateDto,
    key: string,
    requestId: string,
    context: SessionContext,
    stepUp: StepUpContext,
  ) {
    if (
      !dto.permissions?.length
      || new Set(dto.permissions).size !== dto.permissions.length
      || dto.permissions.some((permission) => !CANON_PERMISSIONS.includes(
        permission as typeof CANON_PERMISSIONS[number],
      ))
    ) {
      throw new TreasuryProblem('TRS-GEN-001', 422);
    }
    return this.protected(
      'createRole',
      organizationId,
      dto,
      key,
      requestId,
      context,
      stepUp,
      (command) => this.repository.createRole(dto, command),
    );
  }

  async listAccessGrants(
    organizationId: string,
    actorUserId: string,
    rawLimit?: string,
    cursor?: string,
  ) {
    const limit = this.limit(rawLimit);
    const visibleFrom = this.uuid(cursor, 'cursor');
    const [authority, grants] = await Promise.all([
      this.repository.listPermissionGrants(
        organizationId,
        actorUserId,
        'access-control.view',
      ),
      this.repository.findAccessGrants(organizationId, visibleFrom),
    ]);
    const visible = grants.filter((grant) => authority.some((source) => grantContains(
      source,
      {
        scope: canonicalScope(grant.scope as GrantScopeDto | undefined),
        validFrom: new Date(grant.validFrom as string | Date),
        validTo: grant.validTo ? new Date(grant.validTo as string | Date) : null,
      },
    )));
    const hasMore = visible.length > limit;
    const items = visible.slice(0, limit);
    return {
      items,
      page: {
        limit,
        hasMore,
        ...(hasMore ? { nextCursor: items.at(-1)!.id } : {}),
        asOf: new Date().toISOString(),
      },
    };
  }

  async createAccessGrant(
    organizationId: string,
    dto: AccessGrantCreateDto,
    key: string,
    requestId: string,
    context: SessionContext,
    stepUp: StepUpContext,
  ) {
    this.key(key);
    const prepared = prepareGrant(dto);
    const authority = await this.repository.listPermissionGrants(
      organizationId,
      context.session.userId,
      'access-grant.manage',
    );
    if (!authority.some((source) => grantContains(source, prepared))) {
      throw new TreasuryProblem('TRS-GEN-003', 403);
    }
    return this.protected(
      'createAccessGrant',
      organizationId,
      dto,
      key,
      requestId,
      context,
      stepUp,
      (command) => this.repository.createAccessGrant(prepared, command),
    );
  }

  revokeIdentitySessions(
    organizationId: string,
    identityAccountId: string,
    dto: SessionRevokeDto,
    key: string,
    requestId: string,
    context: SessionContext,
    stepUp: StepUpContext,
  ) {
    const targetId = this.uuid(identityAccountId, 'resourceId')!;
    if (
      (dto.scope === SessionRevokeScope.ONE_SESSION) !== Boolean(dto.sessionId)
      || (dto.sessionId && !this.uuid(dto.sessionId, 'sessionId'))
    ) {
      throw new TreasuryProblem('TRS-GEN-001', 422);
    }
    return this.protected(
      'revokeIdentitySessions',
      organizationId,
      dto,
      key,
      requestId,
      context,
      stepUp,
      (command) => this.repository.revokeIdentitySessions(
        targetId,
        dto,
        context.session.sessionId,
        command,
      ),
    );
  }

  private async protected<T>(
    operationId: string,
    organizationId: string,
    body: unknown,
    rawKey: string,
    requestId: string,
    context: SessionContext,
    stepUp: StepUpContext,
    work: (command: ProtectedCommandContext) => Promise<T>,
  ): Promise<T> {
    const idempotencyKey = this.key(rawKey);
    const expected = {
      ...stepUp.command,
      operationId,
      bodyDigest: commandDigest(operationId, body),
      idempotencyKey,
    };
    try {
      return await this.map(() => work({
        ...expected,
        operationId,
        organizationId,
        actorAccountId: context.accountId,
        physicalSessionId: context.physicalSessionId,
        requestId,
        proofDigest: digest(stepUp.proofId),
      }));
    } catch (error) {
      if (error instanceof RangeError && error.message === 'STEP_UP_INVALID') {
        return this.authService.issueStepUpChallenge(context, expected);
      }
      throw error;
    }
  }

  private limit(raw?: string): number {
    if (!raw) return 50;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 500) {
      throw new TreasuryProblem('TRS-GEN-001', 422);
    }
    return value;
  }

  private key(value: string | undefined): string {
    if (!value || value.length < 8 || value.length > 128) {
      throw new TreasuryProblem(
        'TRS-GEN-001',
        422,
        'Idempotency-Key must contain 8 through 128 characters.',
      );
    }
    return value;
  }

  private uuid(value: string | undefined, field: string): string | undefined {
    if (value && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
      throw new TreasuryProblem('TRS-GEN-001', 422, `${field} is malformed.`);
    }
    return value;
  }

  private async map<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof TreasuryProblem) throw error;
      if (error instanceof TreasuryAuthorizationError) {
        throw new TreasuryProblem('TRS-GEN-003', 403);
      }
      if (error instanceof SyntaxError) throw new TreasuryProblem('TRS-GEN-007', 409);
      if (error instanceof URIError) throw new TreasuryProblem('TRS-AUT-012', 409);
      if (error instanceof ReferenceError) throw new TreasuryProblem('TRS-GEN-004', 404);
      if (error instanceof RangeError) {
        if (error.message === 'STEP_UP_INVALID') throw error;
        if (error.message === 'AMOUNT_SCALE_INVALID') {
          throw new TreasuryProblem('TRS-GEN-001', 422);
        }
        throw new TreasuryProblem('TRS-GEN-005', 409);
      }
      if ((error as { code?: string }).code === '23505') {
        throw new TreasuryProblem('TRS-AUT-012', 409);
      }
      throw error;
    }
  }
}

export function canonicalScope(scope?: GrantScopeDto): CanonicalGrantScope {
  if (scope && Object.keys(scope).length === 0) {
    throw new TreasuryProblem('TRS-GEN-001', 422);
  }
  const arrays = {
    branchIds: sorted(scope?.branchIds),
    treasuryUnitIds: sorted(scope?.treasuryUnitIds),
    cashboxIds: sorted(scope?.cashboxIds),
    bankAccountIds: sorted(scope?.bankAccountIds),
    documentTypes: sorted(scope?.documentTypes),
    methodCategories: sorted(scope?.methodCategories),
    currencies: sorted(scope?.currencies),
  };
  for (const [name, values] of Object.entries(arrays)) {
    const supplied = scope?.[name as keyof GrantScopeDto];
    if (Array.isArray(supplied) && (
      !supplied.length || new Set(supplied).size !== supplied.length
    )) {
      throw new TreasuryProblem('TRS-GEN-001', 422);
    }
    if (name === 'methodCategories' && values.some((value) => (
      !METHOD_CATEGORIES.includes(value as typeof METHOD_CATEGORIES[number])
    ))) {
      throw new TreasuryProblem('TRS-GEN-001', 422);
    }
  }
  if (
    scope?.amountCeiling
    && (
      !representableAmount(scope.amountCeiling.amount)
      || !/^[A-Z0-9]{3,8}$/u.test(scope.amountCeiling.currency)
    )
  ) {
    throw new TreasuryProblem('TRS-GEN-001', 422);
  }
  if (
    scope?.amountCeiling
    && scope.currencies
    && !scope.currencies.includes(scope.amountCeiling.currency)
  ) {
    throw new TreasuryProblem('TRS-GEN-001', 422);
  }
  return {
    ...arrays,
    ...(scope?.amountCeiling ? {
      amountCeiling: {
        amount: normalizeDecimal(scope.amountCeiling.amount),
        currency: scope.amountCeiling.currency,
      },
    } : {}),
  };
}

function representableAmount(value: string): boolean {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/u.exec(value);
  if (!match) return false;
  const integer = match[1]!;
  const fraction = match[2] ?? '';
  return integer.length <= 30
    && fraction.length <= 8
    && /[1-9]/u.test(`${integer}${fraction}`);
}

export function prepareGrant(dto: AccessGrantCreateDto): PreparedAccessGrant {
  const scope = canonicalScope(dto.scope);
  if (scope.bankAccountIds.length) {
    throw new TreasuryProblem('TRS-GEN-004', 404);
  }
  const validFrom = dto.validFrom ? new Date(dto.validFrom) : new Date();
  const validTo = dto.validTo ? new Date(dto.validTo) : null;
  if (
    Number.isNaN(validFrom.getTime())
    || (validTo && (Number.isNaN(validTo.getTime()) || validTo <= validFrom))
  ) {
    throw new TreasuryProblem('TRS-GEN-001', 422);
  }
  return {
    userId: dto.userId,
    roleId: dto.roleId,
    scope,
    validFrom,
    validTo,
    ...(dto.reason ? { reason: dto.reason } : {}),
  };
}

export function grantContains(
  source: GrantAuthorization,
  target: GrantAuthorization,
): boolean {
  if (target.validFrom < source.validFrom) return false;
  if (source.validTo && (!target.validTo || target.validTo > source.validTo)) return false;
  for (const dimension of [
    'branchIds',
    'treasuryUnitIds',
    'cashboxIds',
    'bankAccountIds',
    'documentTypes',
    'methodCategories',
  ] as const) {
    if (!containsValues(source.scope[dimension], target.scope[dimension])) return false;
  }
  if (!containsValues(effectiveCurrencies(source.scope), effectiveCurrencies(target.scope))) {
    return false;
  }
  if (source.scope.amountCeiling) {
    if (
      !target.scope.amountCeiling
      || target.scope.amountCeiling.currency !== source.scope.amountCeiling.currency
      || compareDecimal(
        target.scope.amountCeiling.amount,
        source.scope.amountCeiling.amount,
      ) > 0
    ) {
      return false;
    }
  }
  return true;
}

function containsValues(source: string[], target: string[]): boolean {
  if (!source.length) return true;
  if (!target.length) return false;
  const allowed = new Set(source);
  return target.every((value) => allowed.has(value));
}

function effectiveCurrencies(scope: CanonicalGrantScope): string[] {
  return scope.currencies.length
    ? scope.currencies
    : scope.amountCeiling
      ? [scope.amountCeiling.currency]
      : [];
}

function compareDecimal(left: string, right: string): number {
  const [leftInteger, leftFraction = ''] = left.split('.');
  const [rightInteger, rightFraction = ''] = right.split('.');
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const leftValue = BigInt(`${leftInteger}${leftFraction.padEnd(scale, '0')}`);
  const rightValue = BigInt(`${rightInteger}${rightFraction.padEnd(scale, '0')}`);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function sorted(values?: string[]): string[] {
  return values ? [...values].sort() : [];
}

function normalizeDecimal(value: string): string {
  return value.includes('.') ? value.replace(/0+$/u, '').replace(/\.$/u, '') : value;
}
