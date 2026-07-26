import { Inject, Injectable } from '@nestjs/common';

import { commandDigest } from '../common/http';
import { TreasuryProblem } from '../common/problem';
import {
  CashboxCreateDto,
  CashboxHandoverView,
  CashboxPage,
  CashboxView,
  HandoverCreateDto,
} from './cashbox.dto';
import { CashboxCursor, CashboxRepository } from './cashbox.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DECIMAL = /^-?(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,8})?$/u;

@Injectable()
export class CashboxService {
  constructor(@Inject(CashboxRepository) private readonly repository: CashboxRepository) {}

  async list(
    organizationId: string,
    actorUserId: string,
    rawLimit?: string,
    rawCursor?: string,
  ): Promise<CashboxPage> {
    const limit = this.limit(rawLimit);
    const result = await this.repository.list(
      organizationId,
      actorUserId,
      limit,
      this.cursor(rawCursor),
    );
    const last = result.items.at(-1);
    return {
      items: result.items,
      page: {
        limit,
        hasMore: result.hasMore,
        ...(result.hasMore && last
          ? { nextCursor: this.encodeCursor({ code: last.code, id: last.id }) }
          : {}),
        asOf: new Date().toISOString(),
      },
    };
  }

  create(
    organizationId: string,
    actorUserId: string,
    dto: CashboxCreateDto,
    key: string,
    requestId: string,
  ): Promise<CashboxView> {
    const commandAt = new Date();
    this.validateCreate(dto, commandAt);
    this.requiredRequestId(requestId);
    return this.mapCreate(() => this.repository.create(
      organizationId,
      actorUserId,
      dto,
      this.key(key),
      commandDigest('createCashbox', { actorUserId, body: dto }),
      commandAt,
    ));
  }

  createHandover(
    organizationId: string,
    actorUserId: string,
    cashboxId: string,
    dto: HandoverCreateDto,
    key: string,
    ifMatch: string,
    requestId: string,
  ): Promise<CashboxHandoverView> {
    if (!UUID.test(cashboxId)) this.validation('cashboxId is malformed.');
    if (!UUID.test(dto.incomingUserId) || dto.incomingUserId === actorUserId) {
      this.validation('incomingUserId must identify a distinct User Ref.');
    }
    if (
      (dto as unknown as Record<string, unknown>).reason === null
      ||
      dto.moneyCounts.length === 0
      || new Set(dto.moneyCounts.map(({ currency }) => currency)).size !== dto.moneyCounts.length
      || dto.moneyCounts.some(({ countedAmount }) => !DECIMAL.test(countedAmount))
      || new Set(dto.observedInstrumentIds).size !== dto.observedInstrumentIds.length
    ) {
      this.validation('Handover counts must be non-empty and unique.');
    }
    const version = this.ifMatch(ifMatch);
    const safeRequestId = this.requiredRequestId(requestId);
    return this.mapCreate(() => this.repository.createHandover(
      organizationId,
      actorUserId,
      cashboxId,
      dto,
      this.key(key),
      commandDigest('createCashboxHandover', {
        actorUserId,
        cashboxId,
        ifMatch,
        body: dto,
      }),
      version,
      safeRequestId,
    ));
  }

  private validateCreate(dto: CashboxCreateDto, commandAt: Date): void {
    const raw = dto as unknown as Record<string, unknown>;
    const currencies = dto.currencyControls.map(({ currency }) => currency);
    if (
      ['branchId', 'substituteCustodianId', 'accountingDimensions', 'activeTo']
        .some((field) => raw[field] === null)
      || !dto.capabilities
      || currencies.length === 0
      || new Set(currencies).size !== currencies.length
      || currencies.filter((currency) => currency === dto.mainCurrency).length !== 1
      || dto.primaryCustodianId === dto.substituteCustodianId
      || (
        dto.accountingDimensions
        && Object.values(dto.accountingDimensions).some((value) => value === null)
      )
    ) {
      this.validation('Currency controls and custodians violate Cashbox invariants.');
    }
    for (const control of dto.currencyControls) {
      if (
        ['transactionCeiling', 'minimumPosition', 'maximumHolding', 'allowNegative']
          .some((field) => (
            (control as unknown as Record<string, unknown>)[field] === null
          ))
      ) this.validation('Currency control limits are invalid.');
      if (
        (control.transactionCeiling !== undefined
          && !/^(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,8})?$/u.test(control.transactionCeiling))
        || (control.maximumHolding !== undefined
          && !/^(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,8})?$/u.test(control.maximumHolding))
      ) this.validation('Currency control limits are invalid.');
      const minimum = control.minimumPosition === undefined
        ? undefined
        : this.decimal(control.minimumPosition);
      const maximum = control.maximumHolding === undefined
        ? undefined
        : this.decimal(control.maximumHolding);
      if (
        (minimum !== undefined && maximum !== undefined && minimum > maximum)
        || (minimum !== undefined && minimum < 0n && !control.allowNegative)
      ) {
        this.validation('Currency control limits conflict.');
      }
    }
    if (dto.activeTo) {
      const activeTo = new Date(dto.activeTo).getTime();
      if (!Number.isFinite(activeTo) || activeTo <= commandAt.getTime()) {
        this.validation('activeTo must be later than activeFrom.');
      }
    }
  }

  private decimal(value: string): bigint {
    if (!DECIMAL.test(value)) this.validation('Decimal value is invalid.');
    const negative = value.startsWith('-');
    const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
    const scaled = BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
    return negative ? -scaled : scaled;
  }

  private limit(raw?: string): number {
    if (!raw) return 50;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 500) {
      this.validation('limit must be an integer from 1 through 500.');
    }
    return value;
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

  private cursor(value?: string): CashboxCursor | undefined {
    if (!value) return undefined;
    try {
      if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error();
      const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
      if (
        !Array.isArray(decoded)
        || decoded.length !== 2
        || typeof decoded[0] !== 'string'
        || decoded[0].length < 1
        || decoded[0].length > 64
        || typeof decoded[1] !== 'string'
        || !UUID.test(decoded[1])
      ) throw new Error();
      return { code: decoded[0], id: decoded[1] };
    } catch {
      this.validation('cursor is malformed.');
    }
  }

  private encodeCursor(cursor: CashboxCursor): string {
    return Buffer.from(JSON.stringify([cursor.code, cursor.id])).toString('base64url');
  }

  private validation(detail: string): never {
    throw new TreasuryProblem('TRS-GEN-001', 422, detail);
  }

  private async mapCreate<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof TreasuryProblem) throw error;
      const message = error instanceof Error ? error.message : '';
      if (message === 'IDEMPOTENCY_CONFLICT') {
        throw new TreasuryProblem('TRS-GEN-007', 409);
      }
      if (message === 'VALIDATION') throw new TreasuryProblem('TRS-GEN-001', 422);
      if (message === 'SCOPE_DENIED') throw new TreasuryProblem('TRS-GEN-003', 403);
      if (message === 'RESOURCE_HIDDEN') throw new TreasuryProblem('TRS-GEN-004', 404);
      if (message === 'INACTIVE_REFERENCE') throw new TreasuryProblem('TRS-MST-001', 409);
      if (message === 'STATE_CONFLICT') throw new TreasuryProblem('TRS-GEN-005', 409);
      if (message === 'STALE_VERSION') throw new TreasuryProblem('TRS-GEN-006', 409);
      if (message === 'CUSTODY_CONFLICT') throw new TreasuryProblem('TRS-CSH-002', 409);
      const databaseError = error as { code?: string; constraint?: string };
      if (
        databaseError.constraint === 'cashbox_nonterminal_handover_unique'
        || databaseError.constraint === 'cashbox_current_primary_assignment_unique'
      ) {
        throw new TreasuryProblem('TRS-GEN-005', 409);
      }
      if (databaseError.code === '23505') throw new TreasuryProblem('TRS-MST-002', 409);
      if (databaseError.code === '23514' || databaseError.code === '22P02') {
        throw new TreasuryProblem('TRS-GEN-001', 422);
      }
      throw error;
    }
  }
}
