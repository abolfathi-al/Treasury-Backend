import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { AccessAuthorizationService } from '../access-control/access-authorization.service';
import type { PaymentAuthorizationContext } from '../access-control/access-authorization.repository';
import { commandDigest } from '../common/http';
import { TreasuryProblem } from '../common/problem';
import { DatabaseService, type DatabaseTransaction } from '../database/database.service';
import { MethodBehaviorCategory } from '../master-data/master-data.dto';
import {
  PaymentCreateDto,
  PaymentLineInputDto,
  PaymentPage,
  PaymentRequestCreateDto,
  PaymentRequestView,
  PaymentView,
} from './payment.dto';
import {
  DerivedPaymentLine,
  PaymentCreateFacts,
  PaymentCursor,
  PaymentMethodFact,
  PaymentRepository,
  PaymentRequestFacts,
} from './payment.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

@Injectable()
export class PaymentService {
  constructor(
    @Inject(PaymentRepository) private readonly repository: PaymentRepository,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AccessAuthorizationService)
    private readonly authorization: AccessAuthorizationService,
  ) {}

  async createRequest(
    organizationId: string,
    actorUserId: string,
    dto: PaymentRequestCreateDto,
    rawKey: string,
    requestId: string,
  ): Promise<PaymentRequestView> {
    this.validateRequest(dto);
    this.requiredRequestId(requestId);
    const key = this.key(rawKey);
    const scope = `createPaymentRequest:${actorUserId}`;
    const digest = commandDigest('createPaymentRequest', { actorUserId, body: dto });
    return this.map(() => this.database.db.transaction(async (transaction) => {
      await this.repository.acquireIdempotencyLock(transaction, organizationId, scope, key);
      const replay = await this.repository.findIdempotency<PaymentRequestView>(
        transaction,
        organizationId,
        scope,
        key,
      );
      if (replay) {
        if (replay.requestDigest !== digest || !replay.response) throw new Error('IDEMPOTENCY_CONFLICT');
        const replayDto = this.requestDto(replay.response);
        const facts = await this.repository.requestFacts(transaction, organizationId, actorUserId, replayDto);
        const context = this.validateRequestFacts(replayDto, facts);
        await this.assertRequestAuthorized(transaction, organizationId, actorUserId, context);
        return replay.response;
      }

      await this.repository.insertIdempotency(
        transaction,
        organizationId,
        scope,
        key,
        digest,
      );
      const facts = await this.repository.requestFacts(transaction, organizationId, actorUserId, dto);
      const context = this.validateRequestFacts(dto, facts);
      await this.assertRequestAuthorized(transaction, organizationId, actorUserId, context);
      const response = await this.repository.insertRequest(transaction, {
        id: randomUUID(),
        organizationId,
        businessNumber: await this.repository.nextRequestNumber(transaction, organizationId),
        actorUserId,
        dto,
      });
      await this.repository.saveIdempotency(
        transaction,
        organizationId,
        scope,
        key,
        response,
      );
      return response;
    }));
  }

  async create(
    organizationId: string,
    actorUserId: string,
    dto: PaymentCreateDto,
    rawKey: string,
    requestId: string,
  ): Promise<PaymentView> {
    this.validatePayment(dto);
    this.requiredRequestId(requestId);
    const key = this.key(rawKey);
    const scope = `createPayment:${actorUserId}`;
    const digest = commandDigest('createPayment', { actorUserId, body: dto });
    return this.map(() => this.database.db.transaction(async (transaction) => {
      await this.repository.acquireIdempotencyLock(transaction, organizationId, scope, key);
      const replay = await this.repository.findIdempotency<PaymentView>(
        transaction,
        organizationId,
        scope,
        key,
      );
      if (replay) {
        if (replay.requestDigest !== digest || !replay.response) throw new Error('IDEMPOTENCY_CONFLICT');
        const replayDto = this.paymentDto(replay.response);
        const facts = await this.repository.paymentFacts(transaction, organizationId, actorUserId, replayDto);
        this.derive(replayDto, facts, new Date());
        await this.assertPaymentAuthorized(
          transaction,
          organizationId,
          actorUserId,
          this.replayPaymentContext(replay.response, facts),
        );
        return replay.response;
      }

      await this.repository.insertIdempotency(
        transaction,
        organizationId,
        scope,
        key,
        digest,
      );
      const facts = await this.repository.paymentFacts(transaction, organizationId, actorUserId, dto);
      const derived = this.derive(dto, facts, new Date());
      await this.assertPaymentAuthorized(
        transaction,
        organizationId,
        actorUserId,
        this.paymentContext(dto, facts, derived),
      );
      const response = await this.repository.insertPayment(transaction, {
        id: randomUUID(),
        organizationId,
        businessNumber: await this.repository.nextPaymentNumber(
          transaction,
          organizationId,
          dto.businessDate,
        ),
        actorUserId,
        dto,
        totalBaseAmount: derived.totalBaseAmount,
        lines: derived.lines,
      });
      await this.repository.saveIdempotency(
        transaction,
        organizationId,
        scope,
        key,
        response,
      );
      return response;
    }));
  }

  async list(
    organizationId: string,
    actorUserId: string,
    rawLimit?: string,
    rawCursor?: string,
    businessDateFrom?: string,
    businessDateTo?: string,
  ): Promise<PaymentPage> {
    const limit = this.limit(rawLimit);
    const from = this.dateFilter(businessDateFrom);
    const to = this.dateFilter(businessDateTo);
    if (from && to && from > to) this.validation('businessDateFrom must not exceed businessDateTo.');
    return this.map(() => this.database.db.transaction(async (transaction) => {
      const ids = await this.authorization.listVisiblePaymentIds(
        transaction,
        organizationId,
        actorUserId,
        limit + 1,
        this.cursor(rawCursor),
        from,
        to,
      );
      const visibleIds = ids.slice(0, limit);
      const items = await this.repository.paymentViews(transaction, organizationId, visibleIds);
      const last = items.at(-1);
      return {
        items,
        page: {
          limit,
          hasMore: ids.length > limit,
          ...(ids.length > limit && last
            ? { nextCursor: this.encodeCursor({ businessDate: last.businessDate, id: last.id }) }
            : {}),
          asOf: new Date().toISOString(),
        },
      };
    }));
  }

  private validateRequest(dto: PaymentRequestCreateDto): void {
    if (containsNull(dto)) this.validation('Optional Payment Request fields must be omitted, not null.');
    if (!dto.purpose.trim()) this.validation('Payment Request purpose must contain visible characters.');
  }

  private validatePayment(dto: PaymentCreateDto): void {
    if (containsNull(dto)) this.validation('Optional Payment fields must be omitted, not null.');
    if (!dto.purpose.trim()) this.validation('Payment purpose must contain visible characters.');
    const lineNumbers = dto.lines.map(({ lineNumber }) => lineNumber);
    if (new Set(lineNumbers).size !== lineNumbers.length) {
      this.validation('Payment line numbers must be unique.');
    }
  }

  private validateRequestFacts(
    dto: PaymentRequestCreateDto,
    facts: PaymentRequestFacts,
  ): PaymentAuthorizationContext {
    if (!facts.organization || !facts.requester || !facts.beneficiary || !facts.currency) {
      throw new Error('RESOURCE_HIDDEN');
    }
    if ([facts.requester.state, facts.beneficiary.state, facts.currency.state]
      .some((state) => state !== 'ACTIVE')) throw new Error('INACTIVE_REFERENCE');
    if (decimalPlaces(dto.requestedMoney.amount) > facts.currency.decimalPlaces) {
      throw new Error('VALIDATION');
    }
    if (dto.branchId && !facts.branch) throw new Error('RESOURCE_HIDDEN');
    if (facts.branch?.state !== undefined && facts.branch.state !== 'ACTIVE') {
      throw new Error('INACTIVE_REFERENCE');
    }
    if (dto.treasuryUnitId && !facts.treasuryUnit) throw new Error('RESOURCE_HIDDEN');
    if (facts.treasuryUnit?.state !== undefined && facts.treasuryUnit.state !== 'ACTIVE') {
      throw new Error('INACTIVE_REFERENCE');
    }
    if (
      dto.branchId
      && facts.treasuryUnit
      && facts.treasuryUnit.branchId !== dto.branchId
    ) throw new Error('VALIDATION');
    this.validateEvidence(dto.attachments ?? [], facts.attachments);
    return {
      branchId: dto.branchId ?? facts.treasuryUnit?.branchId ?? null,
      treasuryUnitId: dto.treasuryUnitId ?? null,
      cashboxIds: [],
      bankAccountIds: [],
      currencies: [dto.requestedMoney.currency],
      methodCategories: [],
      documentType: 'PAYMENT_REQUEST',
      amount: dto.requestedMoney.amount,
      amountCurrency: dto.requestedMoney.currency,
    };
  }

  private derive(
    dto: PaymentCreateDto,
    facts: PaymentCreateFacts,
    commandAt: Date,
  ): { lines: DerivedPaymentLine[]; totalBaseAmount: string } {
    if (!facts.organization || !facts.beneficiary || !facts.creator || !facts.treasuryUnit) {
      throw new Error('RESOURCE_HIDDEN');
    }
    if (facts.organization.baseCurrency !== dto.baseCurrency) throw new Error('METHOD_INVALID');
    if ([facts.beneficiary.state, facts.creator.state, facts.treasuryUnit.state]
      .some((state) => state !== 'ACTIVE')) throw new Error('INACTIVE_REFERENCE');
    if (dto.branchId && !facts.branch) throw new Error('RESOURCE_HIDDEN');
    if (facts.branch?.state !== undefined && facts.branch.state !== 'ACTIVE') {
      throw new Error('INACTIVE_REFERENCE');
    }
    if (dto.branchId && facts.treasuryUnit.branchId !== dto.branchId) throw new Error('VALIDATION');

    const currencyMap = new Map(facts.currencies.map((currency) => [currency.code, currency]));
    const expectedCurrencies = new Set([dto.baseCurrency, ...dto.lines.map((line) => line.money.currency)]);
    if ([...expectedCurrencies].some((currency) => !currencyMap.has(currency))) {
      throw new Error('RESOURCE_HIDDEN');
    }
    if ([...expectedCurrencies].some((currency) => currencyMap.get(currency)!.state !== 'ACTIVE')) {
      throw new Error('INACTIVE_REFERENCE');
    }
    const base = currencyMap.get(dto.baseCurrency)!;
    if (!base.baseCurrency) throw new Error('METHOD_INVALID');
    if (facts.parties.length !== new Set([
      dto.beneficiaryPartyId,
      ...dto.lines.map((line) => line.beneficiaryPartyId),
    ]).size) throw new Error('RESOURCE_HIDDEN');
    if (facts.parties.some(({ state }) => state !== 'ACTIVE')) throw new Error('INACTIVE_REFERENCE');
    if (facts.methods.length !== new Set(dto.lines.map(({ methodId }) => methodId)).size) {
      throw new Error('RESOURCE_HIDDEN');
    }
    this.validateEvidence(
      dto.lines.flatMap((line) => line.attachments ?? []),
      facts.attachments,
    );

    let total = 0n;
    const lines: DerivedPaymentLine[] = [];
    for (const line of dto.lines) {
      const method = facts.methods.find(({ id }) => id === line.methodId)!;
      this.validateMethod(dto, line, method, facts);
      const source = currencyMap.get(line.money.currency)!;
      if (decimalPlaces(line.money.amount) > source.decimalPlaces) throw new Error('VALIDATION');
      const rate = line.money.currency === dto.baseCurrency
        ? {
          sourceCurrency: dto.baseCurrency,
          targetCurrency: dto.baseCurrency,
          rate: '1',
          rateType: 'IDENTITY',
          rateSource: 'IDENTITY' as const,
          ratedAt: commandAt,
          roundingDifference: '0',
        }
        : this.tableRate(line.money.currency, dto.baseCurrency, line.money.amount, base.decimalPlaces, facts);
      const baseAmount = rate.rateSource === 'IDENTITY'
        ? line.money.amount
        : deriveTarget(line.money.amount, rate.rate, base.decimalPlaces).targetAmount;
      total += scaled(baseAmount, base.decimalPlaces);
      lines.push({ id: randomUUID(), input: line, method, baseAmount, rate });
    }
    return { lines, totalBaseAmount: formatScaled(total, base.decimalPlaces) };
  }

  private validateMethod(
    dto: PaymentCreateDto,
    line: PaymentLineInputDto,
    method: PaymentMethodFact,
    facts: PaymentCreateFacts,
  ): void {
    if (method.state !== 'ACTIVE') throw new Error('INACTIVE_REFERENCE');
    if (!['PAYMENT', 'BOTH'].includes(method.direction)) throw new Error('METHOD_INVALID');
    if (!method.allowedCurrencies.includes(line.money.currency)) throw new Error('METHOD_INVALID');
    const amountLimit = method.amountLimits.find(({ currency }) => currency === line.money.currency);
    if (amountLimit && compareDecimal(line.money.amount, amountLimit.amount) > 0) {
      throw new Error('METHOD_INVALID');
    }
    if (method.category === MethodBehaviorCategory.CHEQUE) throw new Error('PAYMENT_INCOMPLETE');
    const sourceCount = [line.cashboxId, line.bankAccountId].filter(Boolean).length;
    const cashRequired = method.category === MethodBehaviorCategory.CASH;
    const bankRequired = [
      MethodBehaviorCategory.BANK_TRANSFER,
      MethodBehaviorCategory.DIRECT_DEPOSIT,
      MethodBehaviorCategory.CARD_TRANSFER,
      MethodBehaviorCategory.FOREIGN_REMITTANCE,
    ].includes(method.category as MethodBehaviorCategory);
    if (
      (cashRequired && (sourceCount !== 1 || !line.cashboxId))
      || (bankRequired && (sourceCount !== 1 || !line.bankAccountId))
      || (!cashRequired && !bankRequired && sourceCount > 0)
      || ([MethodBehaviorCategory.POS, MethodBehaviorCategory.GATEWAY]
        .includes(method.category as MethodBehaviorCategory))
      || (method.category === MethodBehaviorCategory.OTHER_CONTROLLED
        && (method.mappingCount !== 5 || !method.requiresApproval))
    ) throw new Error('METHOD_INVALID');

    const present: Record<string, boolean> = {
      CASHBOX: Boolean(line.cashboxId),
      BANK_ACCOUNT: Boolean(line.bankAccountId),
      CHEQUE: false,
      POS: false,
      GATEWAY: false,
      TRACKING_NUMBER: Boolean(line.trackingNumber?.trim()),
      DUE_DATE: Boolean(line.dueDate),
      PARTY: Boolean(line.beneficiaryPartyId),
      EVIDENCE: Boolean(line.attachments?.length),
    };
    if (method.requiredReferences.some((reference) => !present[reference])) {
      throw new Error('PAYMENT_INCOMPLETE');
    }
    if (line.cashboxId) {
      const cashbox = facts.cashboxes.find(({ id }) => id === line.cashboxId);
      if (!cashbox) throw new Error('RESOURCE_HIDDEN');
      if (cashbox.state !== 'ACTIVE') throw new Error('INACTIVE_REFERENCE');
      if (!cashbox.canPay || cashbox.treasuryUnitId !== dto.treasuryUnitId
        || !cashbox.currencies.includes(line.money.currency)) throw new Error('METHOD_INVALID');
    }
    if (line.bankAccountId) {
      const account = facts.bankAccounts.find(({ id }) => id === line.bankAccountId);
      if (!account) throw new Error('RESOURCE_HIDDEN');
      if (account.state !== 'ACTIVE') throw new Error('INACTIVE_REFERENCE');
      if (!account.canPay || account.currency !== line.money.currency
        || (account.treasuryUnitId && account.treasuryUnitId !== dto.treasuryUnitId)) {
        throw new Error('METHOD_INVALID');
      }
    }
  }

  private tableRate(
    sourceCurrency: string,
    targetCurrency: string,
    amount: string,
    targetScale: number,
    facts: PaymentCreateFacts,
  ): DerivedPaymentLine['rate'] {
    const rates = facts.rates.filter((rate) =>
      rate.sourceCurrency === sourceCurrency && rate.targetCurrency === targetCurrency);
    const latestAt = rates.reduce<Date | undefined>((latest, rate) =>
      !latest || rate.validAt > latest ? rate.validAt : latest, undefined);
    const selected = latestAt
      ? rates.filter(({ validAt }) => validAt.getTime() === latestAt.getTime())
      : [];
    if (selected.length !== 1) throw new Error('RATE_INVALID');
    const row = selected[0]!;
    return {
      sourceCurrency,
      targetCurrency,
      rate: row.rate,
      rateType: row.rateType,
      rateSource: 'TABLE',
      ratedAt: row.validAt,
      rateRecordId: row.id,
      roundingDifference: deriveTarget(amount, row.rate, targetScale).roundingDifference,
    };
  }

  private paymentContext(
    dto: PaymentCreateDto,
    facts: PaymentCreateFacts,
    derived: { lines: DerivedPaymentLine[]; totalBaseAmount: string },
  ): PaymentAuthorizationContext {
    return {
      branchId: dto.branchId ?? facts.treasuryUnit?.branchId ?? null,
      treasuryUnitId: dto.treasuryUnitId,
      cashboxIds: [...new Set(dto.lines.flatMap((line) => line.cashboxId ? [line.cashboxId] : []))],
      bankAccountIds: [...new Set(dto.lines.flatMap((line) => line.bankAccountId ? [line.bankAccountId] : []))],
      currencies: [...new Set([dto.baseCurrency, ...dto.lines.map((line) => line.money.currency)])],
      methodCategories: [...new Set(derived.lines.map(({ method }) => method.category))],
      documentType: 'PAYMENT',
      amount: derived.totalBaseAmount,
      amountCurrency: dto.baseCurrency,
    };
  }

  private replayPaymentContext(
    view: PaymentView,
    facts: PaymentCreateFacts,
  ): PaymentAuthorizationContext {
    return {
      branchId: view.branchId ?? facts.treasuryUnit?.branchId ?? null,
      treasuryUnitId: view.treasuryUnitId,
      cashboxIds: [...new Set(view.lines.flatMap((line) => line.cashboxId ? [line.cashboxId] : []))],
      bankAccountIds: [...new Set(view.lines.flatMap((line) => line.bankAccountId ? [line.bankAccountId] : []))],
      currencies: [...new Set([view.baseCurrency, ...view.lines.map((line) => line.money.currency)])],
      methodCategories: [...new Set(view.lines.map((line) => line.methodBehaviorCategory))],
      documentType: 'PAYMENT',
      amount: view.totalBaseAmount.amount,
      amountCurrency: view.baseCurrency,
    };
  }

  private validateEvidence(
    inputs: Array<{ id: string; contentDigest: string }>,
    facts: Array<{ id: string; contentDigest: string; state: string }>,
  ): void {
    const unique = new Map(facts.map((fact) => [`${fact.id}:${fact.contentDigest}`, fact]));
    for (const input of inputs) {
      const evidence = unique.get(`${input.id}:${input.contentDigest}`);
      if (!evidence) throw new Error('PAYMENT_INCOMPLETE');
      if (evidence.state !== 'ACTIVE') throw new Error('INACTIVE_REFERENCE');
    }
  }

  private async assertRequestAuthorized(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    context: PaymentAuthorizationContext,
  ): Promise<void> {
    if (!await this.authorization.canCreatePaymentRequest(
      transaction,
      organizationId,
      actorUserId,
      context,
    )) throw new Error('SCOPE_DENIED');
  }

  private async assertPaymentAuthorized(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    context: PaymentAuthorizationContext,
  ): Promise<void> {
    if (!await this.authorization.canCreatePayment(
      transaction,
      organizationId,
      actorUserId,
      context,
    )) throw new Error('SCOPE_DENIED');
  }

  private requestDto(view: PaymentRequestView): PaymentRequestCreateDto {
    return {
      beneficiaryPartyId: view.beneficiaryPartyId,
      requestedMoney: view.requestedMoney,
      branchId: view.branchId,
      treasuryUnitId: view.treasuryUnitId,
      dueDate: view.dueDate,
      purpose: view.purpose,
      contractRef: view.contractRef,
      invoiceRef: view.invoiceRef,
      accountingDimensions: view.accountingDimensions,
      attachments: view.attachments?.map(({ id, contentDigest, purpose }) => ({ id, contentDigest, purpose })),
    };
  }

  private paymentDto(view: PaymentView): PaymentCreateDto {
    return {
      businessDate: view.businessDate,
      beneficiaryPartyId: view.beneficiaryPartyId,
      branchId: view.branchId,
      treasuryUnitId: view.treasuryUnitId,
      baseCurrency: view.baseCurrency,
      purpose: view.purpose,
      dueDate: view.dueDate,
      lines: view.lines.map((line) => ({
        lineNumber: line.lineNumber,
        methodId: line.methodId,
        money: line.money,
        cashboxId: line.cashboxId,
        bankAccountId: line.bankAccountId,
        beneficiaryPartyId: line.beneficiaryPartyId,
        beneficiaryAccountReference: line.beneficiaryAccountReference,
        trackingNumber: line.trackingNumber,
        dueDate: line.dueDate,
        description: line.description,
        accountingDimensions: line.accountingDimensions,
        attachments: line.attachments?.map(({ id, contentDigest, purpose }) => ({ id, contentDigest, purpose })),
      })),
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

  private cursor(value?: string): PaymentCursor | undefined {
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

  private encodeCursor(cursor: PaymentCursor): string {
    return Buffer.from(JSON.stringify([cursor.businessDate, cursor.id])).toString('base64url');
  }

  private dateFilter(value?: string): string | undefined {
    if (!value) return undefined;
    if (!DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
      this.validation('Business-date filters must use YYYY-MM-DD.');
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

  private validation(detail: string): never {
    throw new TreasuryProblem('TRS-GEN-001', 422, detail);
  }

  private async map<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof TreasuryProblem) throw error;
      const mapped = {
        IDEMPOTENCY_CONFLICT: ['TRS-GEN-007', 409],
        SCOPE_DENIED: ['TRS-GEN-003', 403],
        RESOURCE_HIDDEN: ['TRS-GEN-003', 403],
        INACTIVE_REFERENCE: ['TRS-MST-001', 409],
        METHOD_INVALID: ['TRS-MST-004', 422],
        RATE_INVALID: ['TRS-MST-003', 422],
        PAYMENT_INCOMPLETE: ['TRS-PAY-002', 422],
        VALIDATION: ['TRS-GEN-001', 422],
      } as const;
      const message = error instanceof Error ? error.message : '';
      const problem = mapped[message as keyof typeof mapped];
      if (problem) throw new TreasuryProblem(problem[0], problem[1]);
      const databaseError = error as { code?: string };
      if (databaseError.code === '23503') throw new TreasuryProblem('TRS-GEN-003', 403);
      if (databaseError.code === '23505') throw new TreasuryProblem('TRS-GEN-005', 409);
      if (['22003', '22P02', '23514'].includes(databaseError.code ?? '')) {
        throw new TreasuryProblem('TRS-GEN-001', 422);
      }
      throw error;
    }
  }
}

export function deriveTarget(
  amount: string,
  rate: string,
  targetScale: number,
): { targetAmount: string; roundingDifference: string } {
  const source = decimalParts(amount);
  const multiplier = decimalParts(rate);
  const numerator = source.value * multiplier.value;
  const denominator = 10n ** BigInt(source.scale + multiplier.scale);
  const targetValue = roundDivision(numerator * 10n ** BigInt(targetScale), denominator);
  const difference = roundSignedDivision(
    numerator * 100_000_000n
      - targetValue * denominator * 10n ** BigInt(8 - targetScale),
    denominator,
  );
  return {
    targetAmount: formatScaled(targetValue, targetScale),
    roundingDifference: formatScaled(difference, 8),
  };
}

function containsNull(value: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.some(containsNull);
  return Boolean(value && typeof value === 'object'
    && Object.values(value as Record<string, unknown>).some(containsNull));
}

function compareDecimal(left: string, right: string): number {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const scale = Math.max(a.scale, b.scale);
  const av = a.value * 10n ** BigInt(scale - a.scale);
  const bv = b.value * 10n ** BigInt(scale - b.scale);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

function scaled(value: string, scale: number): bigint {
  const parsed = decimalParts(value);
  if (parsed.scale > scale) throw new Error('VALIDATION');
  return parsed.value * 10n ** BigInt(scale - parsed.scale);
}

function decimalPlaces(value: string): number {
  return decimalParts(value).scale;
}

function decimalParts(value: string): { value: bigint; scale: number } {
  const [whole, rawFraction = ''] = value.split('.');
  const fraction = rawFraction.replace(/0+$/u, '');
  return { value: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function roundDivision(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

function roundSignedDivision(numerator: bigint, denominator: bigint): bigint {
  return numerator < 0n
    ? -roundDivision(-numerator, denominator)
    : roundDivision(numerator, denominator);
}

function formatScaled(value: bigint, scale: number): string {
  const negative = value < 0n;
  const raw = (negative ? -value : value).toString().padStart(scale + 1, '0');
  const output = scale === 0 ? raw : `${raw.slice(0, -scale)}.${raw.slice(-scale)}`;
  return `${negative ? '-' : ''}${output}`;
}
