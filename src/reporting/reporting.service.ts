import { Inject, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

import { commandDigest, stableJson } from '../common/http';
import { TreasuryProblem } from '../common/problem';
import {
  COLLECTION_ITEM_CHANNEL_TYPES,
  COLLECTION_ITEM_STATES,
} from '../collection-and-settlement/collection-items.dto';
import {
  AppliedReportFilters,
  OperationalReportPage,
  REPORT_CURRENCY_MODES,
  REPORT_KEYS,
  ReportCurrencyMode,
  ReportKey,
  ReportQuery,
  ReportScopeDimension,
  ReportSemanticRef,
} from './reporting.dto';
import {
  NormalizedReportFilters,
  ReportContext,
  ReportingRepository,
  ReportKeyset,
  ReportScopeSnapshot,
} from './reporting.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CURRENCY = /^[A-Z0-9]{3,8}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const ORDER = 'businessDate:desc,sourceId:desc';
const CURSOR_TTL_MS = 15 * 60_000;
const ACCOUNTING_STATES = [
  'NOT_READY',
  'MAPPING_REQUIRED',
  'READY',
  'QUEUED',
  'SENDING',
  'SENDING_UNKNOWN',
  'ACCEPTED',
  'FAILED',
  'RETURNED',
  'CORRECTED',
] as const;
const REPORT_STATES: Record<ReportKey, ReadonlySet<string>> = {
  receipts: new Set([
    'DRAFT',
    'SUBMITTED',
    'APPROVAL_PENDING',
    'APPROVED',
    'REJECTED',
    'EXECUTED',
    'ACCOUNTING_READY',
    'ACCOUNTING_POSTED',
    'CANCELLED',
    'REVERSED',
  ]),
  'received-cheques': new Set([
    'RECEIVED',
    'IN_CUSTODY',
    'DEPOSITED',
    'IN_COLLECTION',
    'CLEARED',
    'RETURNED',
    'RETURNED_AFTER_CLEARANCE',
    'RETURNED_TO_PARTY',
    'ASSIGNED',
    'LOST',
    'CANCELLED',
  ]),
  'issued-cheques': new Set([
    'AVAILABLE',
    'RESERVED',
    'ISSUED',
    'DELIVERED',
    'CLEARED',
    'RETURNED',
    'VOID',
    'LOST',
    'STOPPED',
  ]),
  'funds-in-transit': new Set(COLLECTION_ITEM_STATES),
};
const SUPPORTED_FILTERS: Record<ReportKey, ReadonlySet<keyof ReportQuery>> = {
  receipts: new Set([
    'businessDateFrom',
    'businessDateTo',
    'branchId',
    'treasuryUnitId',
    'cashboxId',
    'bankAccountId',
    'userId',
    'partyId',
    'methodId',
    'currency',
    'state',
    'projectRef',
    'costCenterRef',
    'accountingState',
    'currencyMode',
    'limit',
    'cursor',
    'format',
  ]),
  'received-cheques': new Set([
    'businessDateFrom',
    'businessDateTo',
    'dueDateFrom',
    'dueDateTo',
    'branchId',
    'treasuryUnitId',
    'cashboxId',
    'bankAccountId',
    'userId',
    'partyId',
    'currency',
    'state',
    'currencyMode',
    'limit',
    'cursor',
    'format',
  ]),
  'issued-cheques': new Set([
    'businessDateFrom',
    'businessDateTo',
    'dueDateFrom',
    'dueDateTo',
    'branchId',
    'treasuryUnitId',
    'bankAccountId',
    'userId',
    'partyId',
    'currency',
    'state',
    'currencyMode',
    'limit',
    'cursor',
    'format',
  ]),
  'funds-in-transit': new Set([
    'businessDateFrom',
    'businessDateTo',
    'branchId',
    'treasuryUnitId',
    'bankAccountId',
    'partyId',
    'currency',
    'state',
    'channelType',
    'currencyMode',
    'limit',
    'cursor',
    'format',
  ]),
};

interface ReportCursorPayload {
  version: 1;
  organizationId: string;
  actorUserId: string;
  scopeFingerprint: string;
  reportKey: ReportKey;
  filters: NormalizedReportFilters;
  currencyMode: ReportCurrencyMode;
  order: typeof ORDER;
  limit: number;
  asOf: string;
  sourceWatermark: string;
  after: ReportKeyset;
  issuedAt: string;
  expiresAt: string;
}

interface SignedReportCursor {
  payload: ReportCursorPayload;
  signature: string;
}

@Injectable()
export class ReportingService {
  constructor(
    @Inject(ReportingRepository)
    private readonly repository: ReportingRepository,
  ) {}

  async run(
    organizationId: string,
    actorUserId: string,
    rawReportKey: string,
    query: ReportQuery,
  ): Promise<OperationalReportPage> {
    const reportKey = this.reportKey(rawReportKey);
    this.supportedQuery(reportKey, query);
    const filters = this.filters(reportKey, query);
    const currencyMode = this.currencyMode(query.currencyMode);
    const limit = this.limit(query.limit);
    const cursorValue = this.scalar(query.cursor, 'cursor');
    const scope = await this.repository.currentScope(organizationId, actorUserId);
    if (scope.length === 0) throw new TreasuryProblem('TRS-GEN-003', 403);
    const scopeFingerprint = commandDigest('runOperationalReport.scope', scope);
    const cursor = cursorValue ? this.cursor(cursorValue) : undefined;

    if (cursor) {
      const expected = {
        organizationId,
        actorUserId,
        scopeFingerprint,
        reportKey,
        filters,
        currencyMode,
        order: ORDER,
        limit,
      };
      const actual = {
        organizationId: cursor.organizationId,
        actorUserId: cursor.actorUserId,
        scopeFingerprint: cursor.scopeFingerprint,
        reportKey: cursor.reportKey,
        filters: cursor.filters,
        currencyMode: cursor.currencyMode,
        order: cursor.order,
        limit: cursor.limit,
      };
      if (stableJson(actual) !== stableJson(expected)) {
        this.validation(
          'cursor does not match the current caller, scope, report, filters, currency mode, order, or limit.',
        );
      }
    }

    const asOf = cursor?.asOf ?? new Date().toISOString();
    const context = await this.repository.context(organizationId, filters);
    if (!context) throw new TreasuryProblem('TRS-GEN-003', 403);
    this.contextMatches(filters, context);
    const businessDate = this.businessDate(asOf, context.timezone);
    const sourceWatermark = await this.repository.sourceWatermark(
      reportKey,
      organizationId,
    );
    if (cursor && cursor.sourceWatermark !== sourceWatermark) {
      throw new TreasuryProblem(
        'TRS-RPT-002',
        503,
        'Owner facts changed after the report snapshot was selected.',
      );
    }
    const result = await this.repository.list(reportKey, {
      organizationId,
      actorUserId,
      authorizedGrantIds: scope.map(({ grantId }) => grantId),
      filters,
      currencyMode,
      businessDate,
      limit,
      asOf,
      after: cursor?.after,
    });
    if (
      await this.repository.sourceWatermark(reportKey, organizationId)
      !== sourceWatermark
    ) {
      throw new TreasuryProblem(
        'TRS-RPT-002',
        503,
        'Owner facts changed while the report page was being read.',
      );
    }
    const last = result.keys.at(-1);
    const nextCursor = result.hasMore && last
      ? this.encode({
        version: 1,
        organizationId,
        actorUserId,
        scopeFingerprint,
        reportKey,
        filters,
        currencyMode,
        order: ORDER,
        limit,
        asOf,
        sourceWatermark,
        after: last,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + CURSOR_TTL_MS).toISOString(),
      })
      : undefined;

    return {
      reportKey,
      organization: context.organization,
      currencyMode,
      appliedFilters: this.appliedFilters(filters, context),
      appliedAuthorizationScope: this.appliedScope(scope, context.organization),
      freshness: 'READ_AFTER_WRITE',
      sourceWatermark,
      items: result.items,
      page: {
        limit,
        hasMore: result.hasMore,
        asOf,
        ...(nextCursor ? { nextCursor } : {}),
      },
    };
  }

  private reportKey(value: string): ReportKey {
    if (!REPORT_KEYS.includes(value as ReportKey)) {
      throw new TreasuryProblem('TRS-RPT-001', 400, 'reportKey is unsupported.');
    }
    return value as ReportKey;
  }

  private supportedQuery(reportKey: ReportKey, query: ReportQuery): void {
    const allowed = SUPPORTED_FILTERS[reportKey];
    const unsupported = Object.keys(query).filter(
      (key) => !allowed.has(key as keyof ReportQuery),
    );
    const format = query.format as unknown;
    if (unsupported.length > 0 || (format !== undefined && format !== 'JSON')) {
      throw new TreasuryProblem(
        'TRS-RPT-001',
        400,
        unsupported.length > 0
          ? `Unsupported ${reportKey} filter: ${unsupported.sort().join(', ')}.`
          : 'Only JSON format is authorized.',
      );
    }
  }

  private filters(
    reportKey: ReportKey,
    query: ReportQuery,
  ): NormalizedReportFilters {
    const businessDateFrom = this.optionalDate(query.businessDateFrom, 'businessDateFrom');
    const businessDateTo = this.optionalDate(query.businessDateTo, 'businessDateTo');
    const dueDateFrom = this.optionalDate(query.dueDateFrom, 'dueDateFrom');
    const dueDateTo = this.optionalDate(query.dueDateTo, 'dueDateTo');
    this.range(businessDateFrom, businessDateTo, 'business date');
    this.range(dueDateFrom, dueDateTo, 'due date');

    const branchId = this.optionalUuid(query.branchId, 'branchId');
    const treasuryUnitId = this.optionalUuid(query.treasuryUnitId, 'treasuryUnitId');
    const cashboxId = this.optionalUuid(query.cashboxId, 'cashboxId');
    const bankAccountId = this.optionalUuid(query.bankAccountId, 'bankAccountId');
    const userId = this.optionalUuid(query.userId, 'userId');
    const partyId = this.optionalUuid(query.partyId, 'partyId');
    const methodId = this.optionalUuid(query.methodId, 'methodId');
    const currency = this.scalar(query.currency, 'currency')?.toUpperCase();
    if (currency && !CURRENCY.test(currency)) this.validation('currency is malformed.');
    const projectRef = this.reference(query.projectRef, 'projectRef');
    const costCenterRef = this.reference(query.costCenterRef, 'costCenterRef');
    const states = this.values(query.state, 'state');
    if (states.some((state) => !REPORT_STATES[reportKey].has(state))) {
      throw new TreasuryProblem('TRS-RPT-001', 400, 'state is unsupported.');
    }
    const accountingStates = this.values(query.accountingState, 'accountingState');
    if (accountingStates.some(
      (state) => !ACCOUNTING_STATES.includes(state as typeof ACCOUNTING_STATES[number]),
    )) this.validation('accountingState contains an unsupported value.');
    const channelType = this.scalar(query.channelType, 'channelType');
    if (
      channelType
      && !COLLECTION_ITEM_CHANNEL_TYPES.includes(
        channelType as typeof COLLECTION_ITEM_CHANNEL_TYPES[number],
      )
    ) this.validation('channelType is unsupported.');

    return {
      states,
      accountingStates,
      ...(businessDateFrom ? { businessDateFrom } : {}),
      ...(businessDateTo ? { businessDateTo } : {}),
      ...(dueDateFrom ? { dueDateFrom } : {}),
      ...(dueDateTo ? { dueDateTo } : {}),
      ...(branchId ? { branchId } : {}),
      ...(treasuryUnitId ? { treasuryUnitId } : {}),
      ...(cashboxId ? { cashboxId } : {}),
      ...(bankAccountId ? { bankAccountId } : {}),
      ...(userId ? { userId } : {}),
      ...(partyId ? { partyId } : {}),
      ...(methodId ? { methodId } : {}),
      ...(currency ? { currency } : {}),
      ...(projectRef ? { projectRef } : {}),
      ...(costCenterRef ? { costCenterRef } : {}),
      ...(channelType ? { channelType } : {}),
    };
  }

  private contextMatches(filters: NormalizedReportFilters, context: ReportContext): void {
    const references: Array<[string, string | undefined, ReportSemanticRef | null]> = [
      ['branchId', filters.branchId, context.branch],
      ['treasuryUnitId', filters.treasuryUnitId, context.treasuryUnit],
      ['cashboxId', filters.cashboxId, context.cashbox],
      ['bankAccountId', filters.bankAccountId, context.bankAccount],
      ['userId', filters.userId, context.user],
      ['partyId', filters.partyId, context.party],
      ['methodId', filters.methodId, context.method],
      ['currency', filters.currency, context.currency],
    ];
    const missing = references.find(([, supplied, resolved]) => supplied && !resolved);
    if (missing) this.validation(`${missing[0]} does not belong to the organization.`);
  }

  private appliedFilters(
    filters: NormalizedReportFilters,
    context: ReportContext,
  ): AppliedReportFilters {
    return {
      ...(filters.businessDateFrom ? { businessDateFrom: filters.businessDateFrom } : {}),
      ...(filters.businessDateTo ? { businessDateTo: filters.businessDateTo } : {}),
      ...(filters.dueDateFrom ? { dueDateFrom: filters.dueDateFrom } : {}),
      ...(filters.dueDateTo ? { dueDateTo: filters.dueDateTo } : {}),
      ...(context.branch ? { branch: context.branch } : {}),
      ...(context.treasuryUnit ? { treasuryUnit: context.treasuryUnit } : {}),
      ...(context.cashbox ? { cashbox: context.cashbox } : {}),
      ...(context.bankAccount ? { bankAccount: context.bankAccount } : {}),
      ...(context.user ? { user: context.user } : {}),
      ...(context.party ? { party: context.party } : {}),
      ...(context.method ? { method: context.method } : {}),
      ...(context.currency ? { currency: context.currency } : {}),
      ...(filters.states.length > 0 ? { state: filters.states } : {}),
      ...(filters.projectRef
        ? { project: { id: filters.projectRef, label: filters.projectRef } }
        : {}),
      ...(filters.costCenterRef
        ? { costCenter: { id: filters.costCenterRef, label: filters.costCenterRef } }
        : {}),
      ...(filters.accountingStates.length > 0
        ? { accountingState: filters.accountingStates }
        : {}),
      ...(filters.channelType ? { channelType: filters.channelType } : {}),
    };
  }

  private appliedScope(
    scope: ReportScopeSnapshot[],
    organization: ReportSemanticRef,
  ): ReportScopeDimension[] {
    const result: ReportScopeDimension[] = [{
      dimension: 'organization',
      values: [organization],
    }];
    if (scope.some(({ organizationWide }) => organizationWide)) return result;
    const dimensions = [
      ['branch', 'branches'],
      ['treasury_unit', 'treasuryUnits'],
      ['cashbox', 'cashboxes'],
      ['bank_account', 'bankAccounts'],
      ['currency', 'currencies'],
    ] as const;
    for (const [dimension, property] of dimensions) {
      const values = this.unique(scope.flatMap((grant) => grant[property]));
      if (values.length > 0) result.push({ dimension, values });
    }
    return result;
  }

  private unique(values: ReportSemanticRef[]): ReportSemanticRef[] {
    return [...new Map(values.map((value) => [value.id, value])).values()]
      .sort((left, right) => left.label.localeCompare(right.label));
  }

  private currencyMode(raw?: string): ReportCurrencyMode {
    const value: unknown = raw ?? 'ORIGINAL';
    if (!REPORT_CURRENCY_MODES.includes(value as ReportCurrencyMode)) {
      throw new TreasuryProblem('TRS-RPT-001', 400, 'currencyMode is unsupported.');
    }
    return value as ReportCurrencyMode;
  }

  private limit(raw?: string): number {
    const normalized = this.scalar(raw, 'limit');
    if (!normalized) return 50;
    const value = Number(normalized);
    if (!Number.isInteger(value) || value < 1 || value > 500) {
      this.validation('limit must be an integer from 1 through 500.');
    }
    return value;
  }

  private values(raw: unknown, field: string): string[] {
    if (raw === undefined) return [];
    const values = Array.isArray(raw) ? raw : [raw];
    if (
      values.length === 0
      || values.some(
        (value) => typeof value !== 'string' || value.length === 0 || value.length > 64,
      )
      || new Set(values).size !== values.length
    ) this.validation(`${field} must contain unique values from 1 through 64 characters.`);
    return [...values].sort();
  }

  private optionalUuid(raw: unknown, field: string): string | undefined {
    const value = this.scalar(raw, field);
    if (value && !UUID.test(value)) this.validation(`${field} is malformed.`);
    return value;
  }

  private reference(raw: unknown, field: string): string | undefined {
    const value = this.scalar(raw, field);
    if (value && value.length > 128) this.validation(`${field} is too long.`);
    return value;
  }

  private optionalDate(raw: unknown, field: string): string | undefined {
    const value = this.scalar(raw, field);
    return value ? this.date(value, field) : undefined;
  }

  private range(from: string | undefined, to: string | undefined, label: string): void {
    if (from && to && from > to) this.validation(`${label} lower bound follows upper bound.`);
  }

  private scalar(value: unknown, field: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length === 0) {
      this.validation(`${field} must be provided exactly once as a string.`);
    }
    return value;
  }

  private date(value: string, field: string): string {
    if (!DATE.test(value)) this.validation(`${field} must be a calendar date.`);
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      this.validation(`${field} is invalid.`);
    }
    return value;
  }

  private businessDate(asOf: string, timezone: string): string {
    try {
      const parts = new Intl.DateTimeFormat('en', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(new Date(asOf));
      const value = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
      return `${value.year}-${value.month}-${value.day}`;
    } catch {
      throw new TreasuryProblem('TRS-RPT-002', 503, 'Organization timezone is invalid.');
    }
  }

  private cursor(value: string): ReportCursorPayload {
    try {
      if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length > 16_384) throw new Error();
      const decoded = JSON.parse(
        Buffer.from(value, 'base64url').toString('utf8'),
      ) as SignedReportCursor;
      if (
        !decoded
        || typeof decoded !== 'object'
        || !decoded.payload
        || decoded.payload.version !== 1
        || decoded.payload.order !== ORDER
        || !REPORT_KEYS.includes(decoded.payload.reportKey)
        || !REPORT_CURRENCY_MODES.includes(decoded.payload.currencyMode)
        || !UUID.test(decoded.payload.organizationId)
        || !UUID.test(decoded.payload.actorUserId)
        || !UUID.test(decoded.payload.after?.id ?? '')
        || !DATE.test(decoded.payload.after?.businessDate ?? '')
        || !INSTANT.test(decoded.payload.asOf)
        || !INSTANT.test(decoded.payload.issuedAt)
        || !INSTANT.test(decoded.payload.expiresAt)
        || typeof decoded.payload.sourceWatermark !== 'string'
        || decoded.payload.sourceWatermark.length < 1
        || decoded.payload.sourceWatermark.length > 512
        || !Number.isInteger(decoded.payload.limit)
        || decoded.payload.limit < 1
        || decoded.payload.limit > 500
        || typeof decoded.payload.scopeFingerprint !== 'string'
        || decoded.payload.scopeFingerprint.length !== 64
        || typeof decoded.signature !== 'string'
        || decoded.signature.length !== 64
      ) throw new Error();
      const expected = commandDigest('runOperationalReport.cursor', decoded.payload);
      const suppliedBytes = Buffer.from(decoded.signature, 'hex');
      const expectedBytes = Buffer.from(expected, 'hex');
      if (
        suppliedBytes.length !== expectedBytes.length
        || !timingSafeEqual(suppliedBytes, expectedBytes)
      ) throw new Error();
      const now = Date.now();
      const issuedAt = new Date(decoded.payload.issuedAt).getTime();
      const expiresAt = new Date(decoded.payload.expiresAt).getTime();
      if (
        !Number.isFinite(issuedAt)
        || !Number.isFinite(expiresAt)
        || issuedAt > now + 30_000
        || expiresAt <= now
        || expiresAt - issuedAt !== CURSOR_TTL_MS
      ) throw new Error();
      return decoded.payload;
    } catch {
      this.validation('cursor is malformed, mismatched, or expired.');
    }
  }

  private encode(payload: ReportCursorPayload): string {
    const cursor: SignedReportCursor = {
      payload,
      signature: commandDigest('runOperationalReport.cursor', payload),
    };
    return Buffer.from(JSON.stringify(cursor)).toString('base64url');
  }

  private validation(detail: string): never {
    throw new TreasuryProblem('TRS-GEN-001', 422, detail);
  }
}
