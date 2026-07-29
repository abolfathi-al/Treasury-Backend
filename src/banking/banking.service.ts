import { Inject, Injectable } from '@nestjs/common';

import { commandDigest } from '../common/http';
import { TreasuryProblem } from '../common/problem';
import {
  BankAccountCreateDto,
  BankAccountType,
  BankAccountView,
  BankBranchCreateDto,
  BankBranchView,
  BankCreateDto,
  BankTypeCreateDto,
  BankTypeView,
  BankView,
  Page,
  PaymentGatewayCreateDto,
  PaymentGatewayView,
  PosTerminalCreateDto,
  PosTerminalView,
} from './banking.dto';
import { BankingRepository, Cursor } from './banking.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CODE = /^[A-Z0-9][A-Z0-9_-]{1,31}$/u;
const BRANCH_CODE = /^[A-Z0-9][A-Z0-9_-]{0,31}$/u;
const PROVIDER_CODE = /^[A-Z0-9][A-Z0-9._-]{0,63}$/u;
const NONNEGATIVE_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,12})?$/u;
const MASKED_CARD = /^(?=.{5,32}$)[*Xx][*Xx -]*[0-9]{4}$/u;

@Injectable()
export class BankingService {
  constructor(@Inject(BankingRepository) private readonly repository: BankingRepository) {}

  listBankTypes(
    organizationId: string,
    actorUserId: string,
    limit?: string,
    cursor?: string,
  ): Promise<Page<BankTypeView>> {
    return this.list(
      this.repository.listBankTypes(
        organizationId,
        actorUserId,
        this.limit(limit),
        this.cursor(cursor, 2),
      ),
      this.limit(limit),
      (item) => [item.code, item.id],
    );
  }

  createBankType(
    organizationId: string,
    actorUserId: string,
    dto: BankTypeCreateDto,
    key: string,
    requestId: string,
  ): Promise<BankTypeView> {
    const normalized = { ...dto, code: this.code(dto.code, CODE) };
    this.noNulls(normalized, ['description']);
    this.requestId(requestId);
    return this.run(() => this.repository.createBankType(
      organizationId,
      actorUserId,
      normalized,
      this.key(key),
      commandDigest('createBankType', { actorUserId, body: normalized }),
    ));
  }

  listBanks(
    organizationId: string,
    actorUserId: string,
    limit?: string,
    cursor?: string,
  ): Promise<Page<BankView>> {
    return this.list(
      this.repository.listBanks(
        organizationId,
        actorUserId,
        this.limit(limit),
        this.cursor(cursor, 2),
      ),
      this.limit(limit),
      (item) => [item.code, item.id],
    );
  }

  createBank(
    organizationId: string,
    actorUserId: string,
    dto: BankCreateDto,
    key: string,
    requestId: string,
  ): Promise<BankView> {
    const normalized = {
      ...dto,
      code: this.code(dto.code, CODE),
      countryCode: this.upper(dto.countryCode),
      ...(dto.nationalBankCode === undefined
        ? {} : { nationalBankCode: this.upper(dto.nationalBankCode) }),
      ...(dto.swiftCode === undefined ? {} : { swiftCode: this.upper(dto.swiftCode) }),
    };
    this.noNulls(normalized, ['englishName', 'nationalBankCode', 'swiftCode', 'logoRef']);
    if (!UUID.test(dto.bankTypeId) || !/^[A-Z]{2}$/u.test(normalized.countryCode)) {
      this.validation('Bank reference or country code is malformed.');
    }
    this.requestId(requestId);
    return this.run(() => this.repository.createBank(
      organizationId,
      actorUserId,
      normalized,
      this.key(key),
      commandDigest('createBank', { actorUserId, body: normalized }),
    ));
  }

  listBankBranches(
    organizationId: string,
    actorUserId: string,
    limit?: string,
    cursor?: string,
  ): Promise<Page<BankBranchView>> {
    return this.list(
      this.repository.listBankBranches(
        organizationId,
        actorUserId,
        this.limit(limit),
        this.cursor(cursor, 3),
      ),
      this.limit(limit),
      (item) => [item.bank.code, item.code, item.id],
    );
  }

  createBankBranch(
    organizationId: string,
    actorUserId: string,
    dto: BankBranchCreateDto,
    key: string,
    requestId: string,
  ): Promise<BankBranchView> {
    const normalized = { ...dto, code: this.code(dto.code, BRANCH_CODE) };
    this.noNulls(normalized, ['city', 'address', 'contactReference']);
    if (!UUID.test(dto.bankId)) this.validation('bankId is malformed.');
    this.requestId(requestId);
    return this.run(() => this.repository.createBankBranch(
      organizationId,
      actorUserId,
      normalized,
      this.key(key),
      commandDigest('createBankBranch', { actorUserId, body: normalized }),
    ));
  }

  listBankAccounts(
    organizationId: string,
    actorUserId: string,
    limit?: string,
    cursor?: string,
  ): Promise<Page<BankAccountView>> {
    return this.list(
      this.repository.listBankAccounts(
        organizationId,
        actorUserId,
        this.limit(limit),
        this.cursor(cursor, 3),
      ),
      this.limit(limit),
      (item) => [item.bank.code, item.accountNumber, item.id],
    );
  }

  createBankAccount(
    organizationId: string,
    actorUserId: string,
    dto: BankAccountCreateDto,
    key: string,
    requestId: string,
  ): Promise<BankAccountView> {
    this.noNulls(dto, [
      'bankBranchId',
      'organizationBranchId',
      'treasuryUnitId',
      'iban',
      'maskedCardNumber',
      'chequeEnabled',
      'withdrawalCeiling',
      'accountingDimensions',
    ]);
    const identifiers = [
      dto.bankId,
      dto.bankBranchId,
      dto.organizationBranchId,
      dto.treasuryUnitId,
    ].filter((value): value is string => value !== undefined);
    if (identifiers.some((value) => !UUID.test(value))) {
      this.validation('Bank Account reference is malformed.');
    }
    if (
      !dto.capabilities
      || Object.values(dto.capabilities).some((value) => typeof value !== 'boolean')
      || (dto.chequeEnabled === true && dto.accountType !== BankAccountType.CURRENT)
      || !this.date(dto.openingDate)
      || (dto.maskedCardNumber !== undefined && !MASKED_CARD.test(dto.maskedCardNumber))
      || (
        dto.withdrawalCeiling !== undefined
        && (
          !this.representableAmount(dto.withdrawalCeiling.amount)
          || dto.withdrawalCeiling.currency !== dto.currency
        )
      )
      || (
        dto.accountingDimensions
        && Object.values(dto.accountingDimensions).some((value) => value === null)
      )
    ) this.validation('Bank Account activation guard is invalid.');
    const normalized = { ...dto, chequeEnabled: dto.chequeEnabled ?? false };
    this.requestId(requestId);
    return this.run(() => this.repository.createBankAccount(
      organizationId,
      actorUserId,
      normalized,
      this.key(key),
      commandDigest('createBankAccount', { actorUserId, body: normalized }),
    ));
  }

  listPosTerminals(
    organizationId: string,
    actorUserId: string,
    limit?: string,
    cursor?: string,
  ): Promise<Page<PosTerminalView>> {
    return this.list(
      this.repository.listPosTerminals(
        organizationId,
        actorUserId,
        this.limit(limit),
        this.cursor(cursor, 2),
      ),
      this.limit(limit),
      (item) => [item.terminalNumber, item.id],
    );
  }

  createPosTerminal(
    organizationId: string,
    actorUserId: string,
    dto: PosTerminalCreateDto,
    key: string,
    requestId: string,
  ): Promise<PosTerminalView> {
    this.endpoint(dto, ['feeRuleRef', 'providerLabel']);
    this.requestId(requestId);
    return this.run(() => this.repository.createPosTerminal(
      organizationId,
      actorUserId,
      dto,
      this.key(key),
      commandDigest('createPosTerminal', { actorUserId, body: dto }),
    ));
  }

  listPaymentGateways(
    organizationId: string,
    actorUserId: string,
    limit?: string,
    cursor?: string,
  ): Promise<Page<PaymentGatewayView>> {
    return this.list(
      this.repository.listPaymentGateways(
        organizationId,
        actorUserId,
        this.limit(limit),
        this.cursor(cursor, 4),
      ),
      this.limit(limit),
      (item) => [item.providerCode, item.merchantId, item.terminalId, item.id],
    );
  }

  createPaymentGateway(
    organizationId: string,
    actorUserId: string,
    dto: PaymentGatewayCreateDto,
    key: string,
    requestId: string,
  ): Promise<PaymentGatewayView> {
    const normalized = { ...dto, providerCode: this.code(dto.providerCode, PROVIDER_CODE) };
    this.endpoint(normalized, [
      'feeRuleRef',
      'fundsInTransitMappingRef',
      'feeMappingRef',
    ]);
    this.requestId(requestId);
    return this.run(() => this.repository.createPaymentGateway(
      organizationId,
      actorUserId,
      normalized,
      this.key(key),
      commandDigest('createPaymentGateway', { actorUserId, body: normalized }),
    ));
  }

  private async list<T>(
    work: Promise<{ items: T[]; hasMore: boolean }>,
    limit: number,
    cursor: (item: T) => Cursor,
  ): Promise<Page<T>> {
    const result = await this.run(() => work);
    const last = result.items.at(-1);
    return {
      items: result.items,
      page: {
        limit,
        hasMore: result.hasMore,
        ...(result.hasMore && last ? { nextCursor: this.encode(cursor(last)) } : {}),
        asOf: new Date().toISOString(),
      },
    };
  }

  private endpoint(
    dto: PosTerminalCreateDto | PaymentGatewayCreateDto,
    optional: string[],
  ): void {
    this.noNulls(dto, optional);
    if (!UUID.test(dto.bankAccountId) || !UUID.test(dto.treasuryUnitId)) {
      this.validation('Collection endpoint reference is malformed.');
    }
  }

  private code(value: string, pattern: RegExp): string {
    const normalized = this.upper(value);
    if (!pattern.test(normalized)) this.validation('Code is malformed.');
    return normalized;
  }

  private upper(value: string): string {
    return typeof value === 'string' ? value.trim().toUpperCase() : value;
  }

  private date(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }

  private representableAmount(value: string): boolean {
    return NONNEGATIVE_DECIMAL.test(value) && value.split('.')[0]!.length <= 30;
  }

  private limit(raw?: string): number {
    if (!raw) return 50;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 500) {
      this.validation('limit must be an integer from 1 through 500.');
    }
    return value;
  }

  private cursor(value: string | undefined, size: number): Cursor | undefined {
    if (!value) return undefined;
    try {
      if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error();
      const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
      if (
        !Array.isArray(decoded)
        || decoded.length !== size
        || decoded.some((part) => typeof part !== 'string' || part.length < 1 || part.length > 128)
        || !UUID.test(decoded.at(-1) as string)
      ) throw new Error();
      return decoded;
    } catch {
      this.validation('cursor is malformed.');
    }
  }

  private encode(cursor: Cursor): string {
    return Buffer.from(JSON.stringify(cursor)).toString('base64url');
  }

  private key(value: string | undefined): string {
    if (!value || value.length < 8 || value.length > 128) {
      this.validation('Idempotency-Key must contain 8 through 128 characters.');
    }
    return value;
  }

  private requestId(value: string | undefined): void {
    if (!value || value.length > 128) {
      this.validation('X-Request-Id must contain 1 through 128 characters.');
    }
  }

  private noNulls(dto: object, fields: string[]): void {
    const raw = dto as Record<string, unknown>;
    if (fields.some((field) => raw[field] === null)) {
      this.validation('Optional properties must be omitted instead of null.');
    }
  }

  private validation(detail: string): never {
    throw new TreasuryProblem('TRS-GEN-001', 422, detail);
  }

  private async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof TreasuryProblem) throw error;
      const message = error instanceof Error ? error.message : '';
      if (message === 'IDEMPOTENCY_CONFLICT') {
        throw new TreasuryProblem('TRS-GEN-007', 409);
      }
      if (message === 'SCOPE_DENIED') throw new TreasuryProblem('TRS-GEN-003', 403);
      if (message === 'RESOURCE_HIDDEN') throw new TreasuryProblem('TRS-GEN-004', 404);
      if (message === 'INACTIVE_REFERENCE') throw new TreasuryProblem('TRS-MST-001', 409);
      if (message === 'ACCOUNT_UNAVAILABLE') throw new TreasuryProblem('TRS-BNK-001', 409);
      if (message === 'VALIDATION') throw new TreasuryProblem('TRS-GEN-001', 422);
      const databaseError = error as { code?: string };
      if (databaseError.code === '23505') throw new TreasuryProblem('TRS-MST-002', 409);
      if (databaseError.code === '23503') throw new TreasuryProblem('TRS-GEN-004', 404);
      if (
        databaseError.code === '23514'
        || databaseError.code === '22P02'
        || databaseError.code === '22003'
      ) {
        throw new TreasuryProblem('TRS-GEN-001', 422);
      }
      throw error;
    }
  }
}
