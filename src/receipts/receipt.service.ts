import { Inject, Injectable } from '@nestjs/common';

import { commandDigest } from '../common/http';
import { TreasuryProblem } from '../common/problem';
import {
  ReceiptCreateDto,
  ReceiptPage,
  ReceiptView,
} from './receipt.dto';
import { ReceiptCursor, ReceiptRepository } from './receipt.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

@Injectable()
export class ReceiptService {
  constructor(@Inject(ReceiptRepository) private readonly repository: ReceiptRepository) {}

  async list(
    organizationId: string,
    actorUserId: string,
    rawLimit?: string,
    rawCursor?: string,
    businessDateFrom?: string,
    businessDateTo?: string,
  ): Promise<ReceiptPage> {
    const limit = this.limit(rawLimit);
    const from = this.dateFilter(businessDateFrom);
    const to = this.dateFilter(businessDateTo);
    if (from && to && from > to) this.validation('businessDateFrom must not exceed businessDateTo.');
    const result = await this.repository.list(
      organizationId,
      actorUserId,
      limit,
      this.cursor(rawCursor),
      from,
      to,
    );
    const last = result.items.at(-1);
    return {
      items: result.items,
      page: {
        limit,
        hasMore: result.hasMore,
        ...(result.hasMore && last
          ? { nextCursor: this.encodeCursor({ businessDate: last.businessDate, id: last.id }) }
          : {}),
        asOf: new Date().toISOString(),
      },
    };
  }

  get(
    organizationId: string,
    actorUserId: string,
    resourceId: string,
  ): Promise<ReceiptView> {
    this.uuid(resourceId, 'resourceId');
    return this.map(() => this.repository.get(organizationId, actorUserId, resourceId));
  }

  async create(
    organizationId: string,
    actorUserId: string,
    dto: ReceiptCreateDto,
    rawKey: string,
    requestId: string,
  ): Promise<ReceiptView> {
    this.validateDraft(dto);
    this.requiredRequestId(requestId);
    const key = this.key(rawKey);
    return this.map(() => this.repository.create(
      organizationId,
      actorUserId,
      dto,
      key,
      commandDigest('createReceipt', { actorUserId, body: dto }),
      new Date(),
    ));
  }

  async replace(
    organizationId: string,
    actorUserId: string,
    resourceId: string,
    dto: ReceiptCreateDto,
    rawKey: string,
    rawIfMatch: string,
    requestId: string,
  ): Promise<ReceiptView> {
    this.uuid(resourceId, 'resourceId');
    this.validateDraft(dto);
    this.requiredRequestId(requestId);
    const key = this.key(rawKey);
    const expectedVersion = this.ifMatch(rawIfMatch);
    return this.map(() => this.repository.replace(
      organizationId,
      actorUserId,
      resourceId,
      dto,
      key,
      commandDigest('replaceReceiptDraft', {
        actorUserId,
        resourceId,
        ifMatch: rawIfMatch,
        body: dto,
      }),
      expectedVersion,
    ));
  }

  private validateDraft(dto: ReceiptCreateDto): void {
    if (containsNull(dto)) this.validation('Optional Receipt fields must be omitted, not null.');
    const lineNumbers = dto.lines.map(({ lineNumber }) => lineNumber);
    if (new Set(lineNumbers).size !== lineNumbers.length) {
      this.validation('Receipt line numbers must be unique.');
    }
    for (const line of dto.lines) {
      if (
        (line.allocations ?? []).some(({ baseMoney }) => baseMoney.currency !== dto.baseCurrency)
      ) {
        this.validation('Allocation currency must equal the Receipt base currency.');
      }
      const allocationKeys = (line.allocations ?? []).map(
        ({ externalObjectType, externalObjectId }) => `${externalObjectType}:${externalObjectId}`,
      );
      if (new Set(allocationKeys).size !== allocationKeys.length) {
        this.validation('Receipt allocation identities must be unique within each line.');
      }
      if (line.cheque && line.cheque.dueDate < line.cheque.receiptDate) {
        this.validation('Cheque dueDate must not precede receiptDate.');
      }
    }
  }

  private limit(raw?: string): number {
    if (!raw) return 50;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 500) {
      this.validation('limit must be an integer from 1 through 500.');
    }
    return value;
  }

  private cursor(value?: string): ReceiptCursor | undefined {
    if (!value) return undefined;
    try {
      if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error();
      const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
      if (
        !Array.isArray(decoded)
        || decoded.length !== 2
        || typeof decoded[0] !== 'string'
        || !DATE.test(decoded[0])
        || typeof decoded[1] !== 'string'
        || !UUID.test(decoded[1])
      ) throw new Error();
      return { businessDate: decoded[0], id: decoded[1] };
    } catch {
      this.validation('cursor is malformed.');
    }
  }

  private encodeCursor(cursor: ReceiptCursor): string {
    return Buffer.from(JSON.stringify([cursor.businessDate, cursor.id])).toString('base64url');
  }

  private dateFilter(value?: string): string | undefined {
    if (!value) return undefined;
    if (!DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
      this.validation('Business-date filters must use YYYY-MM-DD.');
    }
    return value;
  }

  private uuid(value: string, field: string): void {
    if (!UUID.test(value)) this.validation(`${field} is malformed.`);
  }

  private key(value: string | undefined): string {
    if (!value || value.length < 8 || value.length > 128) {
      this.validation('Idempotency-Key must contain 8 through 128 characters.');
    }
    return value;
  }

  private requiredRequestId(value: string | undefined): string {
    if (!value || value.length > 128) {
      this.validation('X-Request-Id must contain 1 through 128 characters.');
    }
    return value;
  }

  private ifMatch(value: string | undefined): number {
    const match = value?.match(/^"([0-9]+)"$/u);
    const version = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(version)) {
      this.validation('If-Match must be one strong numeric version tag.');
    }
    return version;
  }

  private validation(detail: string): never {
    throw new TreasuryProblem('TRS-GEN-001', 422, detail);
  }

  private async map<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof TreasuryProblem) throw error;
      const message = error instanceof Error ? error.message : '';
      const mapped = {
        IDEMPOTENCY_CONFLICT: ['TRS-GEN-007', 409],
        SCOPE_DENIED: ['TRS-GEN-003', 403],
        RESOURCE_HIDDEN: ['TRS-GEN-004', 404],
        INACTIVE_REFERENCE: ['TRS-MST-001', 409],
        METHOD_INVALID: ['TRS-MST-004', 422],
        RATE_INVALID: ['TRS-MST-003', 422],
        RECEIPT_INCOMPLETE: ['TRS-RCP-002', 422],
        ALLOCATION_EXCEEDED: ['TRS-RCP-003', 422],
        STATE_CONFLICT: ['TRS-GEN-005', 409],
        STALE_VERSION: ['TRS-GEN-006', 409],
        VALIDATION: ['TRS-GEN-001', 422],
      } as const;
      const problem = mapped[message as keyof typeof mapped];
      if (problem) throw new TreasuryProblem(problem[0], problem[1]);
      const databaseError = error as { code?: string; constraint?: string };
      if (databaseError.code === '23505') {
        throw new TreasuryProblem('TRS-MST-002', 409);
      }
      if (databaseError.code === '23503') {
        throw new TreasuryProblem('TRS-GEN-004', 404);
      }
      if (
        databaseError.code === '22003'
        || databaseError.code === '23514'
        || databaseError.code === '22P02'
      ) {
        throw new TreasuryProblem('TRS-GEN-001', 422);
      }
      throw error;
    }
  }
}

function containsNull(value: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.some(containsNull);
  if (typeof value === 'object' && value) {
    return Object.values(value).some(containsNull);
  }
  return false;
}
