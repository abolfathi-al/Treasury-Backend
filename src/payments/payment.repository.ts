import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  InferSelectModel,
  lte,
  sql,
} from 'drizzle-orm';

import { type DatabaseTransaction } from '../database/database.service';
import {
  attachments,
  bankAccounts,
  branches,
  cashboxCurrencyControls,
  cashboxes,
  currencies,
  exchangeRates,
  idempotencyRecords,
  methodAllowedCurrencies,
  methodAmountLimits,
  methodDefinitions,
  methodMappings,
  methodRequiredReferences,
  organizations,
  parties,
  paymentDocuments,
  paymentLineAttachmentLinks,
  paymentLines,
  paymentRequestAttachmentLinks,
  paymentRequests,
  treasuryUnits,
  userRefs,
} from '../database/schema';
import {
  PaymentAttachmentRefDto,
  PaymentCreateDto,
  PaymentEvidenceRef,
  PaymentLineView,
  PaymentRequestCreateDto,
  PaymentRequestView,
  PaymentSemanticRef,
  PaymentView,
} from './payment.dto';

type PaymentLineRow = InferSelectModel<typeof paymentLines>;

export interface PaymentCursor {
  businessDate: string;
  id: string;
}

export interface PaymentReference {
  id: string;
  label: string;
  state: string;
}

export interface PaymentCurrencyFact {
  code: string;
  label: string;
  decimalPlaces: number;
  baseCurrency: boolean;
  state: string;
}

export interface PaymentMethodFact {
  id: string;
  label: string;
  direction: string;
  category: string;
  requiredReferences: string[];
  allowedCurrencies: string[];
  amountLimits: Array<{ currency: string; amount: string }>;
  requiresApproval: boolean;
  mappingCount: number;
  state: string;
}

export interface PaymentCashboxFact extends PaymentReference {
  treasuryUnitId: string;
  canPay: boolean;
  currencies: string[];
}

export interface PaymentBankAccountFact extends PaymentReference {
  treasuryUnitId: string | null;
  currency: string;
  canPay: boolean;
}

export interface PaymentRateFact {
  id: string;
  sourceCurrency: string;
  targetCurrency: string;
  rate: string;
  rateType: string;
  validAt: Date;
}

export interface PaymentRequestFacts {
  organization?: { id: string; label: string };
  requester?: PaymentReference;
  beneficiary?: PaymentReference;
  branch?: PaymentReference;
  treasuryUnit?: PaymentReference & { branchId: string | null };
  currency?: PaymentCurrencyFact;
  attachments: Array<PaymentReference & { contentDigest: string }>;
}

export interface PaymentCreateFacts {
  organization?: { id: string; label: string; baseCurrency: string };
  beneficiary?: PaymentReference;
  branch?: PaymentReference;
  treasuryUnit?: PaymentReference & { branchId: string | null };
  creator?: PaymentReference;
  parties: PaymentReference[];
  currencies: PaymentCurrencyFact[];
  methods: PaymentMethodFact[];
  cashboxes: PaymentCashboxFact[];
  bankAccounts: PaymentBankAccountFact[];
  attachments: Array<PaymentReference & { contentDigest: string }>;
  rates: PaymentRateFact[];
}

export interface DerivedPaymentLine {
  id: string;
  input: PaymentCreateDto['lines'][number];
  method: PaymentMethodFact;
  baseAmount: string;
  rate: {
    sourceCurrency: string;
    targetCurrency: string;
    rate: string;
    rateType: string;
    rateSource: 'IDENTITY' | 'TABLE';
    ratedAt: Date;
    rateRecordId?: string;
    roundingDifference: string;
  };
}

@Injectable()
export class PaymentRepository {
  async acquireIdempotencyLock(
    transaction: DatabaseTransaction,
    organizationId: string,
    scope: string,
    idempotencyKey: string,
  ): Promise<void> {
    await transaction.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtext(${organizationId}),
        hashtext(${scope + ':' + idempotencyKey})
      )
    `);
  }

  async findIdempotency<T extends PaymentRequestView | PaymentView>(
    transaction: DatabaseTransaction,
    organizationId: string,
    scope: string,
    idempotencyKey: string,
  ): Promise<{ requestDigest: string; response: T | null } | undefined> {
    const rows = await transaction
      .select({
        requestDigest: idempotencyRecords.requestDigest,
        responseBody: idempotencyRecords.responseBody,
      })
      .from(idempotencyRecords)
      .where(and(
        eq(idempotencyRecords.organizationId, organizationId),
        eq(idempotencyRecords.scope, scope),
        eq(idempotencyRecords.idempotencyKey, idempotencyKey),
      ))
      .limit(1);
    const row = rows[0];
    return row
      ? { requestDigest: row.requestDigest, response: row.responseBody as T | null }
      : undefined;
  }

  async insertIdempotency(
    transaction: DatabaseTransaction,
    organizationId: string,
    scope: string,
    idempotencyKey: string,
    requestDigest: string,
  ): Promise<void> {
    await transaction.insert(idempotencyRecords).values({
      organizationId,
      scope,
      idempotencyKey,
      requestDigest,
    });
  }

  async saveIdempotency(
    transaction: DatabaseTransaction,
    organizationId: string,
    scope: string,
    idempotencyKey: string,
    response: PaymentRequestView | PaymentView,
  ): Promise<void> {
    await transaction
      .update(idempotencyRecords)
      .set({ responseStatus: 201, responseBody: { ...response } })
      .where(and(
        eq(idempotencyRecords.organizationId, organizationId),
        eq(idempotencyRecords.scope, scope),
        eq(idempotencyRecords.idempotencyKey, idempotencyKey),
      ));
  }

  async requestFacts(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    dto: PaymentRequestCreateDto,
  ): Promise<PaymentRequestFacts> {
    const organizationRows = await transaction.select({
        id: organizations.id,
        label: organizations.legalName,
      }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
    const requesterRows = await transaction.select({
        id: userRefs.id,
        label: userRefs.displayName,
        state: userRefs.state,
      }).from(userRefs).where(and(
        eq(userRefs.organizationId, organizationId),
        eq(userRefs.id, actorUserId),
      )).limit(1);
    const beneficiaryRows = await transaction.select({
        id: parties.id,
        label: parties.displayName,
        state: parties.state,
      }).from(parties).where(and(
        eq(parties.organizationId, organizationId),
        eq(parties.id, dto.beneficiaryPartyId),
      )).limit(1);
    const currencyRows = await transaction.select({
        code: currencies.code,
        label: currencies.name,
        decimalPlaces: currencies.decimalPlaces,
        baseCurrency: currencies.baseCurrency,
        state: currencies.state,
      }).from(currencies).where(and(
        eq(currencies.organizationId, organizationId),
        eq(currencies.code, dto.requestedMoney.currency),
      )).limit(1);
    const branchRows = dto.branchId
      ? await transaction.select({
          id: branches.id,
          label: branches.name,
          state: branches.state,
        }).from(branches).where(and(
          eq(branches.organizationId, organizationId),
          eq(branches.id, dto.branchId),
        )).limit(1)
      : [];
    const unitRows = dto.treasuryUnitId
      ? await transaction.select({
          id: treasuryUnits.id,
          label: treasuryUnits.name,
          state: treasuryUnits.state,
          branchId: treasuryUnits.branchId,
        }).from(treasuryUnits).where(and(
          eq(treasuryUnits.organizationId, organizationId),
          eq(treasuryUnits.id, dto.treasuryUnitId),
        )).limit(1)
      : [];
    const evidence = await this.evidenceFacts(transaction, organizationId, dto.attachments ?? []);
    return {
      organization: organizationRows[0],
      requester: requesterRows[0],
      beneficiary: beneficiaryRows[0],
      branch: branchRows[0],
      treasuryUnit: unitRows[0],
      currency: currencyRows[0],
      attachments: evidence,
    };
  }

  async paymentFacts(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    dto: PaymentCreateDto,
  ): Promise<PaymentCreateFacts> {
    const partyIds = [...new Set([dto.beneficiaryPartyId, ...dto.lines.map((line) => line.beneficiaryPartyId)])];
    const currencyCodes = [...new Set([dto.baseCurrency, ...dto.lines.map((line) => line.money.currency)])];
    const methodIds = [...new Set(dto.lines.map((line) => line.methodId))];
    const cashboxIds = [...new Set(dto.lines.flatMap((line) => line.cashboxId ? [line.cashboxId] : []))];
    const accountIds = [...new Set(dto.lines.flatMap((line) => line.bankAccountId ? [line.bankAccountId] : []))];
    const attachmentInputs = dto.lines.flatMap((line) => line.attachments ?? []);
    const effectiveAt = new Date(`${dto.businessDate}T23:59:59.999Z`);

    const organizationRows = await transaction.select({
        id: organizations.id,
        label: organizations.legalName,
        baseCurrency: organizations.baseCurrency,
      }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
    const partiesRows = await transaction
      .select({ id: parties.id, label: parties.displayName, state: parties.state })
        .from(parties)
        .where(and(eq(parties.organizationId, organizationId), inArray(parties.id, partyIds)));
    const currencyRows = await transaction.select({
        code: currencies.code,
        label: currencies.name,
        decimalPlaces: currencies.decimalPlaces,
        baseCurrency: currencies.baseCurrency,
        state: currencies.state,
      }).from(currencies).where(and(
        eq(currencies.organizationId, organizationId),
        inArray(currencies.code, currencyCodes),
      ));
    const methodsRows = await transaction.select({
        id: methodDefinitions.id,
        label: methodDefinitions.name,
        direction: methodDefinitions.direction,
        category: methodDefinitions.behaviorCategory,
        requiresApproval: methodDefinitions.requiresApproval,
        state: methodDefinitions.state,
      }).from(methodDefinitions).where(and(
        eq(methodDefinitions.organizationId, organizationId),
        inArray(methodDefinitions.id, methodIds),
      ));
    const creatorRows = await transaction
      .select({ id: userRefs.id, label: userRefs.displayName, state: userRefs.state })
        .from(userRefs)
        .where(and(eq(userRefs.organizationId, organizationId), eq(userRefs.id, actorUserId)))
        .limit(1);

    const branchRows = dto.branchId
      ? await transaction.select({ id: branches.id, label: branches.name, state: branches.state })
          .from(branches).where(and(
            eq(branches.organizationId, organizationId),
            eq(branches.id, dto.branchId),
          )).limit(1)
      : [];
    const unitRows = await transaction.select({
        id: treasuryUnits.id,
        label: treasuryUnits.name,
        state: treasuryUnits.state,
        branchId: treasuryUnits.branchId,
      }).from(treasuryUnits).where(and(
        eq(treasuryUnits.organizationId, organizationId),
        eq(treasuryUnits.id, dto.treasuryUnitId),
      )).limit(1);
    const references = await transaction.select({
        methodId: methodRequiredReferences.methodId,
        reference: methodRequiredReferences.reference,
      }).from(methodRequiredReferences).where(inArray(methodRequiredReferences.methodId, methodIds));
    const allowed = await transaction.select({
        methodId: methodAllowedCurrencies.methodId,
        currency: methodAllowedCurrencies.currencyCode,
      }).from(methodAllowedCurrencies).where(inArray(methodAllowedCurrencies.methodId, methodIds));
    const limits = await transaction.select({
        methodId: methodAmountLimits.methodId,
        currency: methodAmountLimits.currencyCode,
        amount: methodAmountLimits.amount,
      }).from(methodAmountLimits).where(inArray(methodAmountLimits.methodId, methodIds));
    const mappings = await transaction.select({ methodId: methodMappings.methodId })
      .from(methodMappings).where(inArray(methodMappings.methodId, methodIds));
    const cashboxRows = cashboxIds.length
      ? await transaction.select({
          id: cashboxes.id,
          label: cashboxes.name,
          state: cashboxes.state,
          treasuryUnitId: cashboxes.treasuryUnitId,
          canPay: cashboxes.canPay,
        }).from(cashboxes).where(and(
          eq(cashboxes.organizationId, organizationId),
          inArray(cashboxes.id, cashboxIds),
        ))
      : [];
    const cashboxCurrencies = cashboxIds.length
      ? await transaction.select({
          cashboxId: cashboxCurrencyControls.cashboxId,
          currency: cashboxCurrencyControls.currency,
        }).from(cashboxCurrencyControls).where(inArray(cashboxCurrencyControls.cashboxId, cashboxIds))
      : [];
    const accountRows = accountIds.length
      ? await transaction.select({
          id: bankAccounts.id,
          label: bankAccounts.accountNumber,
          state: bankAccounts.state,
          treasuryUnitId: bankAccounts.treasuryUnitId,
          currency: bankAccounts.currency,
          canPay: bankAccounts.canPay,
        }).from(bankAccounts).where(and(
          eq(bankAccounts.organizationId, organizationId),
          inArray(bankAccounts.id, accountIds),
        ))
      : [];
    const evidence = await this.evidenceFacts(transaction, organizationId, attachmentInputs);
    const rateRows = currencyCodes.some((currency) => currency !== dto.baseCurrency)
      ? await transaction.select({
          id: exchangeRates.id,
          sourceCurrency: exchangeRates.sourceCurrency,
          targetCurrency: exchangeRates.targetCurrency,
          rate: exchangeRates.rate,
          rateType: exchangeRates.rateType,
          validAt: exchangeRates.validAt,
        }).from(exchangeRates).where(and(
          inArray(exchangeRates.sourceCurrency, currencyCodes.filter((currency) => currency !== dto.baseCurrency)),
          eq(exchangeRates.targetCurrency, dto.baseCurrency),
          eq(exchangeRates.state, 'APPROVED'),
          lte(exchangeRates.validAt, effectiveAt),
        )).orderBy(desc(exchangeRates.validAt), asc(exchangeRates.id))
      : [];

    const methods: PaymentMethodFact[] = methodsRows.map((method) => ({
      ...method,
      requiredReferences: references
        .filter((row) => row.methodId === method.id)
        .map(({ reference }) => reference),
      allowedCurrencies: allowed
        .filter((row) => row.methodId === method.id)
        .map(({ currency }) => currency),
      amountLimits: limits
        .filter((row) => row.methodId === method.id)
        .map(({ currency, amount }) => ({ currency, amount })),
      mappingCount: mappings.filter((row) => row.methodId === method.id).length,
    }));

    return {
      organization: organizationRows[0],
      beneficiary: partiesRows.find(({ id }) => id === dto.beneficiaryPartyId),
      branch: branchRows[0],
      treasuryUnit: unitRows[0],
      creator: creatorRows[0],
      parties: partiesRows,
      currencies: currencyRows,
      methods,
      cashboxes: cashboxRows.map((cashbox) => ({
        ...cashbox,
        currencies: cashboxCurrencies
          .filter((row) => row.cashboxId === cashbox.id)
          .map(({ currency }) => currency),
      })),
      bankAccounts: accountRows,
      attachments: evidence,
      rates: rateRows,
    };
  }

  async nextRequestNumber(
    transaction: DatabaseTransaction,
    organizationId: string,
  ): Promise<string> {
    const result = await transaction.execute<{ value: number }>(sql`
      INSERT INTO payment_request_number_counters (organization_id, next_value)
      VALUES (${organizationId}, 2)
      ON CONFLICT (organization_id)
      DO UPDATE SET next_value = payment_request_number_counters.next_value + 1
      RETURNING next_value - 1 AS value
    `);
    return `PR-${String(Number(result.rows[0]!.value)).padStart(8, '0')}`;
  }

  async nextPaymentNumber(
    transaction: DatabaseTransaction,
    organizationId: string,
    businessDate: string,
  ): Promise<string> {
    const result = await transaction.execute<{ value: number }>(sql`
      INSERT INTO payment_number_counters (organization_id, business_date, next_value)
      VALUES (${organizationId}, ${businessDate}, 2)
      ON CONFLICT (organization_id, business_date)
      DO UPDATE SET next_value = payment_number_counters.next_value + 1
      RETURNING next_value - 1 AS value
    `);
    return `${businessDate.replaceAll('-', '')}-PAY-${String(Number(result.rows[0]!.value)).padStart(6, '0')}`;
  }

  async insertRequest(
    transaction: DatabaseTransaction,
    values: {
      id: string;
      organizationId: string;
      businessNumber: string;
      actorUserId: string;
      dto: PaymentRequestCreateDto;
    },
  ): Promise<PaymentRequestView> {
    await transaction.insert(paymentRequests).values({
      id: values.id,
      organizationId: values.organizationId,
      businessNumber: values.businessNumber,
      requesterUserId: values.actorUserId,
      beneficiaryPartyId: values.dto.beneficiaryPartyId,
      requestedAmount: values.dto.requestedMoney.amount,
      currency: values.dto.requestedMoney.currency,
      branchId: values.dto.branchId,
      treasuryUnitId: values.dto.treasuryUnitId,
      dueDate: values.dto.dueDate,
      purpose: values.dto.purpose,
      contractRef: values.dto.contractRef,
      invoiceRef: values.dto.invoiceRef,
      accountingDimensions: values.dto.accountingDimensions
        ? { ...values.dto.accountingDimensions }
        : undefined,
    });
    if (values.dto.attachments?.length) {
      await transaction.insert(paymentRequestAttachmentLinks).values(
        values.dto.attachments.map((attachment) => ({
          organizationId: values.organizationId,
          paymentRequestId: values.id,
          attachmentId: attachment.id,
          contentDigest: attachment.contentDigest,
          purpose: attachment.purpose ?? '',
        })),
      );
    }
    return this.requestView(transaction, values.organizationId, values.id);
  }

  async insertPayment(
    transaction: DatabaseTransaction,
    values: {
      id: string;
      organizationId: string;
      businessNumber: string;
      actorUserId: string;
      dto: PaymentCreateDto;
      totalBaseAmount: string;
      lines: DerivedPaymentLine[];
    },
  ): Promise<PaymentView> {
    await transaction.insert(paymentDocuments).values({
      id: values.id,
      organizationId: values.organizationId,
      businessNumber: values.businessNumber,
      businessDate: values.dto.businessDate,
      beneficiaryPartyId: values.dto.beneficiaryPartyId,
      branchId: values.dto.branchId,
      treasuryUnitId: values.dto.treasuryUnitId,
      baseCurrency: values.dto.baseCurrency,
      totalBaseAmount: values.totalBaseAmount,
      dueDate: values.dto.dueDate,
      purpose: values.dto.purpose,
      creatorUserId: values.actorUserId,
    });
    await transaction.insert(paymentLines).values(values.lines.map((line) => ({
      id: line.id,
      organizationId: values.organizationId,
      paymentDocumentId: values.id,
      lineNumber: line.input.lineNumber,
      methodId: line.input.methodId,
      methodName: line.method.label,
      methodCategory: line.method.category,
      methodRequiredReferences: line.method.requiredReferences,
      requiresApproval: line.method.requiresApproval,
      amount: line.input.money.amount,
      currency: line.input.money.currency,
      baseCurrency: values.dto.baseCurrency,
      exchangeRate: line.rate.rate,
      rateType: line.rate.rateType,
      rateSource: line.rate.rateSource,
      rateRecordId: line.rate.rateRecordId,
      rateAt: line.rate.ratedAt,
      baseAmount: line.baseAmount,
      roundingDifference: line.rate.roundingDifference,
      cashboxId: line.input.cashboxId,
      bankAccountId: line.input.bankAccountId,
      beneficiaryPartyId: line.input.beneficiaryPartyId,
      beneficiaryAccountReference: line.input.beneficiaryAccountReference,
      trackingNumber: line.input.trackingNumber,
      dueDate: line.input.dueDate,
      description: line.input.description,
      accountingDimensions: line.input.accountingDimensions
        ? { ...line.input.accountingDimensions }
        : undefined,
    })));
    const evidence = values.lines.flatMap((line) => (line.input.attachments ?? []).map((attachment) => ({
      organizationId: values.organizationId,
      paymentLineId: line.id,
      attachmentId: attachment.id,
      contentDigest: attachment.contentDigest,
      purpose: attachment.purpose ?? '',
    })));
    if (evidence.length) await transaction.insert(paymentLineAttachmentLinks).values(evidence);
    return (await this.paymentViews(transaction, values.organizationId, [values.id]))[0]!;
  }

  async requestView(
    transaction: DatabaseTransaction,
    organizationId: string,
    requestId: string,
  ): Promise<PaymentRequestView> {
    const rows = await transaction.select({
      request: paymentRequests,
      organizationLabel: organizations.legalName,
      requesterLabel: userRefs.displayName,
      beneficiaryLabel: parties.displayName,
      branchLabel: branches.name,
      unitLabel: treasuryUnits.name,
    }).from(paymentRequests)
      .innerJoin(organizations, eq(organizations.id, paymentRequests.organizationId))
      .innerJoin(userRefs, and(
        eq(userRefs.organizationId, paymentRequests.organizationId),
        eq(userRefs.id, paymentRequests.requesterUserId),
      ))
      .innerJoin(parties, and(
        eq(parties.organizationId, paymentRequests.organizationId),
        eq(parties.id, paymentRequests.beneficiaryPartyId),
      ))
      .leftJoin(branches, and(
        eq(branches.organizationId, paymentRequests.organizationId),
        eq(branches.id, paymentRequests.branchId),
      ))
      .leftJoin(treasuryUnits, and(
        eq(treasuryUnits.organizationId, paymentRequests.organizationId),
        eq(treasuryUnits.id, paymentRequests.treasuryUnitId),
      ))
      .where(and(eq(paymentRequests.organizationId, organizationId), eq(paymentRequests.id, requestId)))
      .limit(1);
    const row = rows[0]!;
    const evidence = await this.requestEvidence(transaction, organizationId, requestId);
    return compact({
      id: row.request.id,
      organizationId: row.request.organizationId,
      organization: { id: row.request.organizationId, label: row.organizationLabel },
      businessNumber: row.request.businessNumber,
      requesterUserId: row.request.requesterUserId,
      requester: { id: row.request.requesterUserId, label: row.requesterLabel },
      beneficiaryPartyId: row.request.beneficiaryPartyId,
      beneficiary: { id: row.request.beneficiaryPartyId, label: row.beneficiaryLabel },
      requestedMoney: { amount: row.request.requestedAmount, currency: row.request.currency },
      branchId: row.request.branchId ?? undefined,
      branch: row.request.branchId
        ? { id: row.request.branchId, label: row.branchLabel! }
        : undefined,
      treasuryUnitId: row.request.treasuryUnitId ?? undefined,
      treasuryUnit: row.request.treasuryUnitId
        ? { id: row.request.treasuryUnitId, label: row.unitLabel! }
        : undefined,
      dueDate: row.request.dueDate ?? undefined,
      purpose: row.request.purpose,
      contractRef: row.request.contractRef ?? undefined,
      invoiceRef: row.request.invoiceRef ?? undefined,
      accountingDimensions: row.request.accountingDimensions ?? undefined,
      attachments: evidence.length ? evidence : undefined,
      approvalProgress: row.request.approvalProgress,
      state: 'DRAFT',
      version: row.request.version,
      createdAt: row.request.createdAt.toISOString(),
      updatedAt: row.request.updatedAt.toISOString(),
    }) as PaymentRequestView;
  }

  async paymentViews(
    transaction: DatabaseTransaction,
    organizationId: string,
    ids: string[],
  ): Promise<PaymentView[]> {
    if (!ids.length) return [];
    const headers = await transaction.select({
      payment: paymentDocuments,
      organizationLabel: organizations.legalName,
      beneficiaryLabel: parties.displayName,
      requestNumber: paymentRequests.businessNumber,
      branchLabel: branches.name,
      unitLabel: treasuryUnits.name,
      currencyLabel: currencies.name,
      creatorLabel: userRefs.displayName,
    }).from(paymentDocuments)
      .innerJoin(organizations, eq(organizations.id, paymentDocuments.organizationId))
      .innerJoin(parties, and(
        eq(parties.organizationId, paymentDocuments.organizationId),
        eq(parties.id, paymentDocuments.beneficiaryPartyId),
      ))
      .leftJoin(paymentRequests, and(
        eq(paymentRequests.organizationId, paymentDocuments.organizationId),
        eq(paymentRequests.id, paymentDocuments.paymentRequestId),
      ))
      .leftJoin(branches, and(
        eq(branches.organizationId, paymentDocuments.organizationId),
        eq(branches.id, paymentDocuments.branchId),
      ))
      .innerJoin(treasuryUnits, and(
        eq(treasuryUnits.organizationId, paymentDocuments.organizationId),
        eq(treasuryUnits.id, paymentDocuments.treasuryUnitId),
      ))
      .innerJoin(currencies, and(
        eq(currencies.organizationId, paymentDocuments.organizationId),
        eq(currencies.code, paymentDocuments.baseCurrency),
      ))
      .innerJoin(userRefs, and(
        eq(userRefs.organizationId, paymentDocuments.organizationId),
        eq(userRefs.id, paymentDocuments.creatorUserId),
      ))
      .where(and(eq(paymentDocuments.organizationId, organizationId), inArray(paymentDocuments.id, ids)));

    const lineRows = await transaction.select({
      line: paymentLines,
      beneficiaryLabel: parties.displayName,
      cashboxLabel: cashboxes.name,
      accountLabel: bankAccounts.accountNumber,
      rateLabel: exchangeRates.sourceName,
    }).from(paymentLines)
      .innerJoin(parties, and(
        eq(parties.organizationId, paymentLines.organizationId),
        eq(parties.id, paymentLines.beneficiaryPartyId),
      ))
      .leftJoin(cashboxes, and(
        eq(cashboxes.organizationId, paymentLines.organizationId),
        eq(cashboxes.id, paymentLines.cashboxId),
      ))
      .leftJoin(bankAccounts, and(
        eq(bankAccounts.organizationId, paymentLines.organizationId),
        eq(bankAccounts.id, paymentLines.bankAccountId),
      ))
      .leftJoin(exchangeRates, eq(exchangeRates.id, paymentLines.rateRecordId))
      .where(and(
        eq(paymentLines.organizationId, organizationId),
        inArray(paymentLines.paymentDocumentId, ids),
      )).orderBy(asc(paymentLines.lineNumber));
    const evidence = await this.lineEvidence(transaction, organizationId, lineRows.map(({ line }) => line.id));

    const byId = new Map(headers.map((row) => [row.payment.id, row]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      if (!row) return [];
      const lines = lineRows
        .filter(({ line }) => line.paymentDocumentId === id)
        .map(({ line, beneficiaryLabel, cashboxLabel, accountLabel, rateLabel }) =>
          this.lineView(line, beneficiaryLabel, cashboxLabel, accountLabel, rateLabel, evidence));
      return [compact({
        id: row.payment.id,
        organizationId: row.payment.organizationId,
        organization: { id: row.payment.organizationId, label: row.organizationLabel },
        businessNumber: row.payment.businessNumber,
        businessDate: row.payment.businessDate,
        beneficiaryPartyId: row.payment.beneficiaryPartyId,
        beneficiary: { id: row.payment.beneficiaryPartyId, label: row.beneficiaryLabel },
        paymentRequestId: row.payment.paymentRequestId ?? undefined,
        paymentRequest: row.payment.paymentRequestId
          ? { id: row.payment.paymentRequestId, label: row.requestNumber! }
          : undefined,
        branchId: row.payment.branchId ?? undefined,
        branch: row.payment.branchId
          ? { id: row.payment.branchId, label: row.branchLabel! }
          : undefined,
        treasuryUnitId: row.payment.treasuryUnitId,
        treasuryUnit: { id: row.payment.treasuryUnitId, label: row.unitLabel },
        baseCurrency: row.payment.baseCurrency,
        baseCurrencyRef: { id: row.payment.baseCurrency, label: row.currencyLabel },
        purpose: row.payment.purpose,
        dueDate: row.payment.dueDate ?? undefined,
        creatorUserId: row.payment.creatorUserId,
        creator: { id: row.payment.creatorUserId, label: row.creatorLabel },
        totalBaseAmount: { amount: row.payment.totalBaseAmount, currency: row.payment.baseCurrency },
        lines,
        state: 'DRAFT',
        workflowState: 'DRAFT',
        executionState: 'NOT_EXECUTED',
        accountingState: 'NOT_READY',
        version: row.payment.version,
        createdAt: row.payment.createdAt.toISOString(),
        updatedAt: row.payment.updatedAt.toISOString(),
      }) as PaymentView];
    });
  }

  private async evidenceFacts(
    transaction: DatabaseTransaction,
    organizationId: string,
    inputs: PaymentAttachmentRefDto[],
  ): Promise<Array<PaymentReference & { contentDigest: string }>> {
    const ids = [...new Set(inputs.map(({ id }) => id))];
    if (!ids.length) return [];
    return transaction.select({
      id: attachments.id,
      label: attachments.fileName,
      state: attachments.state,
      contentDigest: attachments.contentDigest,
    }).from(attachments).where(and(
      eq(attachments.organizationId, organizationId),
      inArray(attachments.id, ids),
    ));
  }

  private async requestEvidence(
    transaction: DatabaseTransaction,
    organizationId: string,
    requestId: string,
  ): Promise<PaymentEvidenceRef[]> {
    const rows = await transaction.select({
      id: attachments.id,
      label: attachments.fileName,
      contentDigest: paymentRequestAttachmentLinks.contentDigest,
      purpose: paymentRequestAttachmentLinks.purpose,
    }).from(paymentRequestAttachmentLinks)
      .innerJoin(attachments, and(
        eq(attachments.organizationId, paymentRequestAttachmentLinks.organizationId),
        eq(attachments.id, paymentRequestAttachmentLinks.attachmentId),
      ))
      .where(and(
        eq(paymentRequestAttachmentLinks.organizationId, organizationId),
        eq(paymentRequestAttachmentLinks.paymentRequestId, requestId),
      ));
    return rows.map((row) => compact({ ...row, purpose: row.purpose || undefined }) as PaymentEvidenceRef);
  }

  private async lineEvidence(
    transaction: DatabaseTransaction,
    organizationId: string,
    lineIds: string[],
  ): Promise<Array<PaymentEvidenceRef & { paymentLineId: string }>> {
    if (!lineIds.length) return [];
    const rows = await transaction.select({
      paymentLineId: paymentLineAttachmentLinks.paymentLineId,
      id: attachments.id,
      label: attachments.fileName,
      contentDigest: paymentLineAttachmentLinks.contentDigest,
      purpose: paymentLineAttachmentLinks.purpose,
    }).from(paymentLineAttachmentLinks)
      .innerJoin(attachments, and(
        eq(attachments.organizationId, paymentLineAttachmentLinks.organizationId),
        eq(attachments.id, paymentLineAttachmentLinks.attachmentId),
      ))
      .where(and(
        eq(paymentLineAttachmentLinks.organizationId, organizationId),
        inArray(paymentLineAttachmentLinks.paymentLineId, lineIds),
      ));
    return rows.map((row): PaymentEvidenceRef & { paymentLineId: string } => compact({
      ...row,
      purpose: row.purpose || undefined,
    }));
  }

  private lineView(
    line: PaymentLineRow,
    beneficiaryLabel: string,
    cashboxLabel: string | null,
    accountLabel: string | null,
    rateLabel: string | null,
    evidence: Array<PaymentEvidenceRef & { paymentLineId: string }>,
  ): PaymentLineView {
    const attachmentsForLine = evidence
      .filter(({ paymentLineId }) => paymentLineId === line.id)
      .map(({ paymentLineId: _paymentLineId, ...item }) => item);
    return compact({
      id: line.id,
      lineNumber: line.lineNumber,
      methodId: line.methodId,
      method: { id: line.methodId, label: line.methodName },
      methodBehaviorCategory: line.methodCategory,
      methodRequiredReferences: line.methodRequiredReferences,
      requiresApproval: line.requiresApproval,
      money: { amount: line.amount, currency: line.currency },
      baseAmount: { amount: line.baseAmount, currency: line.baseCurrency },
      rateSnapshot: compact({
        sourceCurrency: line.currency,
        targetCurrency: line.baseCurrency,
        rate: line.exchangeRate,
        rateType: line.rateType,
        rateSource: line.rateSource,
        ratedAt: line.rateAt.toISOString(),
        rateRecordId: line.rateRecordId ?? undefined,
        targetAmount: line.baseAmount,
        roundingDifference: line.roundingDifference,
      }),
      rateRecord: line.rateRecordId ? { id: line.rateRecordId, label: rateLabel! } : undefined,
      cashboxId: line.cashboxId ?? undefined,
      cashbox: line.cashboxId ? { id: line.cashboxId, label: cashboxLabel! } : undefined,
      bankAccountId: line.bankAccountId ?? undefined,
      bankAccount: line.bankAccountId ? { id: line.bankAccountId, label: accountLabel! } : undefined,
      beneficiaryPartyId: line.beneficiaryPartyId,
      beneficiary: { id: line.beneficiaryPartyId, label: beneficiaryLabel },
      beneficiaryAccountReference: line.beneficiaryAccountReference ?? undefined,
      trackingNumber: line.trackingNumber ?? undefined,
      dueDate: line.dueDate ?? undefined,
      description: line.description ?? undefined,
      accountingDimensions: line.accountingDimensions ?? undefined,
      attachments: attachmentsForLine.length ? attachmentsForLine : undefined,
      state: 'DRAFT',
      version: line.version,
    }) as PaymentLineView;
  }
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)) as T;
}
