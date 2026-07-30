import { timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';

import { commandDigest, digest } from '../common/http';
import { TreasuryProblem } from '../common/problem';
import {
  AccessGrantCreateDto,
  APPROVAL_AGGREGATION_KEYS,
  APPROVAL_SEPARATION_RULES,
  ApprovalPolicyCreateDto,
  CANON_PERMISSIONS,
  CanonicalGrantScope,
  DelegationCreateDto,
  GrantAuthorization,
  GrantScopeDto,
  METHOD_CATEGORIES,
  RoleCreateDto,
  SessionRevokeDto,
  SessionRevokeScope,
} from './access-admin.dto';
import {
  AccessAdminRepository,
  ApprovalPolicyConflictError,
  DelegationConflictError,
  PreparedAccessGrant,
  PreparedApprovalPolicy,
  PreparedDelegation,
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
        organizationWide: grant.organizationWide === true,
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

  async listApprovalPolicies(
    organizationId: string,
    actorUserId: string,
    rawLimit?: string,
    rawCursor?: string,
  ) {
    const limit = this.limit(rawLimit);
    const [authority, baseCurrency] = await Promise.all([
      this.repository.listPermissionGrants(organizationId, actorUserId, 'access-control.view'),
      this.repository.organizationBaseCurrency(organizationId),
    ]);
    const scopeDigest = digest(stableAuthority(authority));
    const cursor = this.scopedCursor(
      rawCursor,
      'approval-policies',
      organizationId,
      actorUserId,
      limit,
      scopeDigest,
    );
    const policies = await this.repository.findApprovalPolicies(
      organizationId,
      cursor ? new Date(cursor.createdAt) : undefined,
      cursor?.id,
      cursor ? new Date(cursor.cutoff) : new Date(),
    );
    const visible = policies.filter((policy) => authority.some((source) => grantContains(
      source,
      policyAuthorization(policy, baseCurrency, source.validTo),
    )));
    return scopedPage(
      visible,
      'approval-policies',
      limit,
      organizationId,
      actorUserId,
      scopeDigest,
      cursor?.cutoff,
    );
  }

  async createApprovalPolicy(
    organizationId: string,
    dto: ApprovalPolicyCreateDto,
    key: string,
    requestId: string,
    context: SessionContext,
    stepUp: StepUpContext,
  ) {
    this.key(key);
    const [prepared, authority, baseCurrency] = await Promise.all([
      Promise.resolve(prepareApprovalPolicy(dto)),
      this.repository.listPermissionGrants(
        organizationId,
        context.session.userId,
        'approval-policy.manage',
      ),
      this.repository.organizationBaseCurrency(organizationId),
    ]);
    if (!authority.some((source) => grantContains(
      source,
      policyAuthorization(prepared, baseCurrency, source.validTo),
    ))) {
      throw new TreasuryProblem('TRS-GEN-003', 403);
    }
    return this.protected(
      'createApprovalPolicy',
      organizationId,
      dto,
      key,
      requestId,
      context,
      stepUp,
      (command) => this.repository.createApprovalPolicy(
        prepared,
        context.session.userId,
        command,
      ),
    );
  }

  async listDelegations(
    organizationId: string,
    actorUserId: string,
    rawLimit?: string,
    rawCursor?: string,
  ) {
    const limit = this.limit(rawLimit);
    const authority = await this.repository.listPermissionGrants(
      organizationId,
      actorUserId,
      'access-control.view',
    );
    const scopeDigest = digest(stableAuthority(authority));
    const cursor = this.scopedCursor(
      rawCursor,
      'delegations',
      organizationId,
      actorUserId,
      limit,
      scopeDigest,
    );
    const delegations = await this.repository.findDelegations(
      organizationId,
      cursor ? new Date(cursor.createdAt) : undefined,
      cursor?.id,
      cursor ? new Date(cursor.cutoff) : new Date(),
    );
    const visible = delegations
      .filter(({ view, authorizationScope }) => authority.some((source) => grantContains(
        source,
        delegationAuthorization(view, authorizationScope),
      )))
      .map(({ view }) => view);
    return scopedPage(
      visible,
      'delegations',
      limit,
      organizationId,
      actorUserId,
      scopeDigest,
      cursor?.cutoff,
    );
  }

  createDelegation(
    organizationId: string,
    dto: DelegationCreateDto,
    key: string,
    requestId: string,
    context: SessionContext,
    stepUp: StepUpContext,
  ) {
    const prepared = prepareDelegation(dto);
    return this.protected(
      'createDelegation',
      organizationId,
      dto,
      key,
      requestId,
      context,
      stepUp,
      (command) => this.repository.createDelegation(
        prepared,
        context.session.userId,
        command,
      ),
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
      if (error instanceof ApprovalPolicyConflictError) {
        throw new TreasuryProblem('TRS-AUT-013', 409);
      }
      if (error instanceof DelegationConflictError) {
        throw new TreasuryProblem('TRS-AUT-014', 409);
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

  private scopedCursor(
    raw: string | undefined,
    resource: ScopedCursorResource,
    organizationId: string,
    actorUserId: string,
    limit: number,
    scopeDigest: string,
  ): ScopedCursor | undefined {
    if (!raw) return undefined;
    try {
      if (!/^[A-Za-z0-9_-]+$/u.test(raw) || raw.length > 16_384) throw new Error();
      const signed = JSON.parse(Buffer.from(raw, 'base64url').toString()) as SignedScopedCursor;
      const parsed = signed.payload;
      if (
        !parsed
        || parsed.version !== 1
        || parsed.resource !== resource
        || parsed.order !== SCOPED_CURSOR_ORDER
        || parsed.organizationId !== organizationId
        || parsed.actorUserId !== actorUserId
        || parsed.limit !== limit
        || parsed.scopeDigest !== scopeDigest
        || !this.uuid(parsed.id, 'cursor')
        || typeof signed.signature !== 'string'
        || signed.signature.length !== 64
      ) throw new Error('CURSOR_CONTEXT_MISMATCH');
      const expected = commandDigest('accessAdmin.scopedList.cursor', parsed);
      const suppliedBytes = Buffer.from(signed.signature, 'hex');
      const expectedBytes = Buffer.from(expected, 'hex');
      if (
        suppliedBytes.length !== expectedBytes.length
        || !timingSafeEqual(suppliedBytes, expectedBytes)
      ) throw new Error('CURSOR_SIGNATURE_MISMATCH');
      const createdAt = new Date(parsed.createdAt);
      const cutoff = new Date(parsed.cutoff);
      if (Number.isNaN(createdAt.getTime()) || Number.isNaN(cutoff.getTime())) throw new Error();
      return { ...parsed, createdAt, cutoff };
    } catch {
      throw new TreasuryProblem('TRS-GEN-001', 422, 'cursor is malformed.');
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
  if (typeof dto.organizationWide !== 'boolean') {
    throw new TreasuryProblem('TRS-GEN-001', 422);
  }
  if (dto.organizationWide === (dto.scope !== undefined)) {
    throw new TreasuryProblem('TRS-GEN-001', 422);
  }
  const scope = canonicalScope(dto.scope);
  if (!dto.organizationWide && !hasScope(scope)) {
    throw new TreasuryProblem('TRS-GEN-001', 422);
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
    organizationWide: dto.organizationWide,
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
  if (source.organizationWide) return true;
  if (target.organizationWide) return false;
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

function hasScope(scope: CanonicalGrantScope): boolean {
  return Object.values(scope).some((value) => (
    Array.isArray(value) ? value.length > 0 : Boolean(value)
  ));
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

const SCOPED_CURSOR_ORDER = 'createdAt:desc,id:desc' as const;
type ScopedCursorResource = 'approval-policies' | 'delegations';

interface ScopedCursor {
  version: 1;
  resource: ScopedCursorResource;
  order: typeof SCOPED_CURSOR_ORDER;
  organizationId: string;
  actorUserId: string;
  limit: number;
  scopeDigest: string;
  cutoff: Date | string;
  createdAt: Date | string;
  id: string;
}

interface SignedScopedCursor {
  payload: ScopedCursor;
  signature: string;
}

export function prepareApprovalPolicy(dto: ApprovalPolicyCreateDto): PreparedApprovalPolicy {
  if (typeof dto.organizationWide !== 'boolean' || dto.organizationWide === (dto.scope !== undefined)) {
    throw new TreasuryProblem('TRS-GEN-001', 422);
  }
  const scope = dto.scope ? { ...dto.scope } : undefined;
  if (scope && Object.keys(scope).length === 0) throw new TreasuryProblem('TRS-GEN-001', 422);
  if (scope?.minimumBaseAmount !== undefined) {
    scope.minimumBaseAmount = normalizeNonNegativeDecimal(scope.minimumBaseAmount);
  }
  if (scope?.maximumBaseAmount !== undefined) {
    scope.maximumBaseAmount = normalizeNonNegativeDecimal(scope.maximumBaseAmount);
  }
  if (
    scope?.minimumBaseAmount !== undefined
    && scope.maximumBaseAmount !== undefined
    && compareDecimal(scope.maximumBaseAmount, scope.minimumBaseAmount) < 0
  ) throw new TreasuryProblem('TRS-GEN-001', 422);
  const steps = [...(dto.steps ?? [])].sort((left, right) => left.order - right.order);
  if (steps.some((step, index) => (
    step.order !== index + 1
    || (Boolean(step.roleId) === Boolean(step.approverUserId))
    || !Number.isInteger(step.approvalsRequired)
    || step.approvalsRequired < 1
  ))) throw new TreasuryProblem('TRS-GEN-001', 422);
  const separationRules = [...(dto.separationRules ?? [])].sort();
  if (
    new Set(separationRules).size !== separationRules.length
    || separationRules.some((rule) => !APPROVAL_SEPARATION_RULES.includes(
      rule as typeof APPROVAL_SEPARATION_RULES[number],
    ))
  ) throw new TreasuryProblem('TRS-GEN-001', 422);
  const paymentAggregation = dto.paymentAggregation ? {
    windowKind: dto.paymentAggregation.windowKind,
    keys: [...dto.paymentAggregation.keys].sort(),
    overrideRequiresSecondApproval: dto.paymentAggregation.overrideRequiresSecondApproval,
  } : undefined;
  if (paymentAggregation && (
    dto.documentType !== 'PAYMENT'
    || paymentAggregation.windowKind !== 'BUSINESS_DATE'
    || paymentAggregation.overrideRequiresSecondApproval !== true
    || !paymentAggregation.keys.length
    || new Set(paymentAggregation.keys).size !== paymentAggregation.keys.length
    || paymentAggregation.keys.some((key) => !APPROVAL_AGGREGATION_KEYS.includes(
      key as typeof APPROVAL_AGGREGATION_KEYS[number],
    ))
  )) throw new TreasuryProblem('TRS-GEN-001', 422);
  return { ...dto, scope, steps, separationRules, paymentAggregation };
}

export function prepareDelegation(dto: DelegationCreateDto): PreparedDelegation {
  const validFrom = new Date(dto.validFrom);
  const validTo = new Date(dto.validTo);
  const reason = dto.reason.trim();
  if (
    !dto.scope
    || Object.keys(dto.scope).length === 0
    || !reason
    || Number.isNaN(validFrom.getTime())
    || Number.isNaN(validTo.getTime())
    || validTo <= validFrom
    || validTo <= new Date()
  ) throw new TreasuryProblem('TRS-GEN-001', 422);
  if (
    dto.scope.amountCeiling
    && dto.scope.currency
    && dto.scope.amountCeiling.currency !== dto.scope.currency
  ) throw new TreasuryProblem('TRS-GEN-001', 422);
  const amountCeiling = dto.scope.amountCeiling ? {
    amount: normalizePositiveDecimal(dto.scope.amountCeiling.amount),
    currency: dto.scope.amountCeiling.currency,
  } : undefined;
  return {
    ...dto,
    reason,
    scope: { ...dto.scope, ...(amountCeiling ? { amountCeiling } : {}) },
    validFrom,
    validTo,
  };
}

function policyAuthorization(
  policy: PreparedApprovalPolicy | Record<string, unknown>,
  baseCurrency: string,
  validTo: Date | null,
): GrantAuthorization {
  const scope = (policy.scope ?? {}) as Record<string, string | undefined>;
  return {
    organizationWide: false,
    scope: {
      branchIds: scope.branchId ? [scope.branchId] : [],
      treasuryUnitIds: scope.treasuryUnitId ? [scope.treasuryUnitId] : [],
      cashboxIds: [],
      bankAccountIds: [],
      documentTypes: [String(policy.documentType)],
      methodCategories: scope.methodCategory ? [scope.methodCategory] : [],
      currencies: scope.currency ? [scope.currency] : [],
      ...(scope.maximumBaseAmount ? {
        amountCeiling: { amount: scope.maximumBaseAmount, currency: baseCurrency },
      } : {}),
    },
    validFrom: new Date(),
    validTo,
  };
}

function delegationAuthorization(
  delegation: Record<string, unknown>,
  scope: CanonicalGrantScope,
): GrantAuthorization {
  return {
    organizationWide: false,
    scope,
    validFrom: new Date(delegation.validFrom as string | Date),
    validTo: new Date(delegation.validTo as string | Date),
  };
}

function stableAuthority(authority: GrantAuthorization[]): string {
  return JSON.stringify(authority.map((grant) => ({
    ...grant,
    validFrom: grant.validFrom.toISOString(),
    validTo: grant.validTo?.toISOString() ?? null,
  })));
}

function scopedPage<T extends { id: string; createdAt: Date | string }>(
  visible: T[],
  resource: ScopedCursorResource,
  limit: number,
  organizationId: string,
  actorUserId: string,
  scopeDigest: string,
  rawCutoff?: Date | string,
) {
  const hasMore = visible.length > limit;
  const items = visible.slice(0, limit);
  const cutoff = rawCutoff ? new Date(rawCutoff) : new Date();
  const last = items.at(-1);
  const payload: ScopedCursor | undefined = hasMore && last ? {
    version: 1,
    resource,
    order: SCOPED_CURSOR_ORDER,
    organizationId,
    actorUserId,
    limit,
    scopeDigest,
    cutoff: cutoff.toISOString(),
    createdAt: new Date(last.createdAt).toISOString(),
    id: last.id,
  } : undefined;
  const nextCursor = payload ? Buffer.from(JSON.stringify({
    payload,
    signature: commandDigest('accessAdmin.scopedList.cursor', payload),
  } satisfies SignedScopedCursor)).toString('base64url') : undefined;
  return {
    items,
    page: {
      limit,
      hasMore,
      ...(nextCursor ? { nextCursor } : {}),
      asOf: cutoff.toISOString(),
    },
  };
}

function normalizeNonNegativeDecimal(value: string): string {
  if (!/^(0|[1-9][0-9]{0,29})(?:\.([0-9]{1,8}))?$/u.test(value)) {
    throw new TreasuryProblem('TRS-GEN-001', 422);
  }
  return normalizeDecimal(value);
}

function normalizePositiveDecimal(value: string): string {
  if (!representableAmount(value)) throw new TreasuryProblem('TRS-GEN-001', 422);
  return normalizeDecimal(value);
}
