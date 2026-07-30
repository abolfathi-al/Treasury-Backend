import { Inject, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

import { commandDigest, stableJson } from '../common/http';
import { TreasuryProblem } from '../common/problem';
import {
  COLLECTION_ITEM_CHANNEL_TYPES,
  COLLECTION_ITEM_STATES,
  CollectionItemChannelType,
  CollectionItemPage,
  CollectionItemQuery,
  CollectionItemState,
} from './collection-items.dto';
import {
  CollectionItemKeyset,
  CollectionItemsRepository,
  NormalizedCollectionItemFilters,
} from './collection-items.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CURRENCY = /^[A-Z0-9]{3,8}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const ORDER = 'collectedAt:desc,id:desc';
const CURSOR_TTL_MS = 15 * 60_000;

interface CollectionCursorPayload {
  version: 1;
  organizationId: string;
  actorUserId: string;
  scopeFingerprint: string;
  filters: NormalizedCollectionItemFilters;
  order: typeof ORDER;
  limit: number;
  asOf: string;
  after: CollectionItemKeyset;
  issuedAt: string;
  expiresAt: string;
}

interface SignedCollectionCursor {
  payload: CollectionCursorPayload;
  signature: string;
}

@Injectable()
export class CollectionItemsService {
  constructor(
    @Inject(CollectionItemsRepository)
    private readonly repository: CollectionItemsRepository,
  ) {}

  async list(
    organizationId: string,
    actorUserId: string,
    query: CollectionItemQuery,
  ): Promise<CollectionItemPage> {
    const filters = this.filters(query);
    const limit = this.limit(query.limit);
    const scope = await this.repository.currentScope(organizationId, actorUserId);
    if (scope.length === 0) throw new TreasuryProblem('TRS-GEN-003', 403);
    const scopeFingerprint = commandDigest('listCollectionItems.scope', scope);
    const cursor = query.cursor ? this.cursor(query.cursor) : undefined;

    if (cursor) {
      const expected = {
        organizationId,
        actorUserId,
        scopeFingerprint,
        filters,
        order: ORDER,
        limit,
      };
      const actual = {
        organizationId: cursor.organizationId,
        actorUserId: cursor.actorUserId,
        scopeFingerprint: cursor.scopeFingerprint,
        filters: cursor.filters,
        order: cursor.order,
        limit: cursor.limit,
      };
      if (stableJson(actual) !== stableJson(expected)) {
        this.validation('cursor does not match the current caller, scope, filters, order, or limit.');
      }
    }

    const asOf = cursor?.asOf ?? new Date().toISOString();
    const result = await this.repository.list({
      organizationId,
      actorUserId,
      authorizedGrantIds: scope.map(({ grantId }) => grantId),
      filters,
      limit,
      asOf,
      after: cursor?.after,
    });
    const last = result.items.at(-1);
    const nextCursor = result.hasMore && last
      ? this.encode({
        version: 1,
        organizationId,
        actorUserId,
        scopeFingerprint,
        filters,
        order: ORDER,
        limit,
        asOf,
        after: { collectedAt: last.collectedAt, id: last.id },
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + CURSOR_TTL_MS).toISOString(),
      })
      : undefined;

    return {
      items: result.items,
      page: {
        limit,
        hasMore: result.hasMore,
        asOf,
        ...(nextCursor ? { nextCursor } : {}),
      },
    };
  }

  private filters(query: CollectionItemQuery): NormalizedCollectionItemFilters {
    const rawStates = query.state === undefined
      ? []
      : Array.isArray(query.state) ? query.state : [query.state];
    if (
      rawStates.some((state) => !COLLECTION_ITEM_STATES.includes(state as CollectionItemState))
      || new Set(rawStates).size !== rawStates.length
    ) this.validation('state must contain unique supported Collection Item states.');
    const states = [...rawStates].sort() as CollectionItemState[];

    const collectedAtFrom = query.collectedAtFrom
      ? this.instant(query.collectedAtFrom, 'collectedAtFrom')
      : undefined;
    const collectedAtTo = query.collectedAtTo
      ? this.instant(query.collectedAtTo, 'collectedAtTo')
      : undefined;
    if (
      collectedAtFrom
      && collectedAtTo
      && new Date(collectedAtFrom).getTime() >= new Date(collectedAtTo).getTime()
    ) this.validation('collectedAtFrom must be strictly earlier than collectedAtTo.');

    const expectedSettlementDateFrom = query.expectedSettlementDateFrom
      ? this.date(query.expectedSettlementDateFrom, 'expectedSettlementDateFrom')
      : undefined;
    const expectedSettlementDateTo = query.expectedSettlementDateTo
      ? this.date(query.expectedSettlementDateTo, 'expectedSettlementDateTo')
      : undefined;
    if (
      expectedSettlementDateFrom
      && expectedSettlementDateTo
      && expectedSettlementDateFrom > expectedSettlementDateTo
    ) {
      this.validation(
        'expectedSettlementDateFrom must not follow expectedSettlementDateTo.',
      );
    }

    const destinationBankAccountId = query.destinationBankAccountId;
    if (destinationBankAccountId && !UUID.test(destinationBankAccountId)) {
      this.validation('destinationBankAccountId is malformed.');
    }
    const currency = query.currency?.toUpperCase();
    if (currency && !CURRENCY.test(currency)) this.validation('currency is malformed.');
    const channelType = query.channelType;
    if (
      channelType
      && !COLLECTION_ITEM_CHANNEL_TYPES.includes(channelType as CollectionItemChannelType)
    ) this.validation('channelType is unsupported.');

    return {
      states,
      ...(collectedAtFrom ? { collectedAtFrom } : {}),
      ...(collectedAtTo ? { collectedAtTo } : {}),
      ...(expectedSettlementDateFrom ? { expectedSettlementDateFrom } : {}),
      ...(expectedSettlementDateTo ? { expectedSettlementDateTo } : {}),
      ...(destinationBankAccountId ? { destinationBankAccountId } : {}),
      ...(currency ? { currency } : {}),
      ...(channelType ? { channelType: channelType as CollectionItemChannelType } : {}),
    };
  }

  private limit(raw?: string): number {
    if (!raw) return 50;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 500) {
      this.validation('limit must be an integer from 1 through 500.');
    }
    return value;
  }

  private instant(value: string, field: string): string {
    if (!INSTANT.test(value)) this.validation(`${field} must be an RFC 3339 instant.`);
    const instant = new Date(value);
    if (!Number.isFinite(instant.getTime())) this.validation(`${field} is invalid.`);
    return instant.toISOString();
  }

  private date(value: string, field: string): string {
    if (!DATE.test(value)) this.validation(`${field} must be a calendar date.`);
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      this.validation(`${field} is invalid.`);
    }
    return value;
  }

  private cursor(value: string): CollectionCursorPayload {
    try {
      if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length > 16_384) throw new Error();
      const decoded = JSON.parse(
        Buffer.from(value, 'base64url').toString('utf8'),
      ) as SignedCollectionCursor;
      if (
        !decoded
        || typeof decoded !== 'object'
        || !decoded.payload
        || decoded.payload.version !== 1
        || decoded.payload.order !== ORDER
        || !UUID.test(decoded.payload.organizationId)
        || !UUID.test(decoded.payload.actorUserId)
        || !UUID.test(decoded.payload.after?.id ?? '')
        || !INSTANT.test(decoded.payload.after?.collectedAt ?? '')
        || !INSTANT.test(decoded.payload.asOf)
        || !INSTANT.test(decoded.payload.issuedAt)
        || !INSTANT.test(decoded.payload.expiresAt)
        || !Number.isInteger(decoded.payload.limit)
        || decoded.payload.limit < 1
        || decoded.payload.limit > 500
        || typeof decoded.payload.scopeFingerprint !== 'string'
        || decoded.payload.scopeFingerprint.length !== 64
        || typeof decoded.signature !== 'string'
        || decoded.signature.length !== 64
      ) throw new Error();
      const expected = commandDigest('listCollectionItems.cursor', decoded.payload);
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

  private encode(payload: CollectionCursorPayload): string {
    const cursor: SignedCollectionCursor = {
      payload,
      signature: commandDigest('listCollectionItems.cursor', payload),
    };
    return Buffer.from(JSON.stringify(cursor)).toString('base64url');
  }

  private validation(detail: string): never {
    throw new TreasuryProblem('TRS-GEN-001', 422, detail);
  }
}
