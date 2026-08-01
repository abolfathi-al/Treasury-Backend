import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import type { PaymentAuthorizationContext } from '../access-control/access-authorization.repository';
import type { DatabaseTransaction } from '../database/database.service';
import {
  attachments,
  bankAccounts,
  bankInstructionOutcomeEvents,
  bankInstructions,
  banks,
  bankTypes,
  idempotencyRecords,
  paymentDocuments,
  paymentLines,
  treasuryUnits,
  userRefs,
} from '../database/schema';
import {
  BankInstructionOutcome,
  type BankInstructionOutcomeDto,
  type BankInstructionView,
} from './banking.dto';

export interface LockedBankInstruction extends Record<string, unknown> {
  id: string;
  organizationId: string;
  paymentLineId: string;
  paymentLineLabel: string;
  paymentId: string;
  bankAccountId: string;
  amount: string;
  currency: string;
  beneficiaryAccountReference: string;
  localReference: string;
  state: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  branchId: string | null;
  treasuryUnitId: string;
  baseCurrency: string;
  totalBaseAmount: string;
  paymentExecutedByUserId: string;
  cashboxIds: string[];
  bankAccountIds: string[];
  currencies: string[];
  methodCategories: string[];
}

@Injectable()
export class BankInstructionOutcomeRepository {
  async acquireIdempotencyLock(
    transaction: DatabaseTransaction,
    organizationId: string,
    scope: string,
    key: string,
  ): Promise<void> {
    await transaction.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtext(${organizationId}), hashtext(${scope + ':' + key})
      )
    `);
  }

  async findIdempotency(
    transaction: DatabaseTransaction,
    organizationId: string,
    scope: string,
    key: string,
  ): Promise<{ requestDigest: string; response: BankInstructionView | null } | undefined> {
    const [row] = await transaction.select({
      requestDigest: idempotencyRecords.requestDigest,
      response: idempotencyRecords.responseBody,
    }).from(idempotencyRecords).where(and(
      eq(idempotencyRecords.organizationId, organizationId),
      eq(idempotencyRecords.scope, scope),
      eq(idempotencyRecords.idempotencyKey, key),
    )).limit(1);
    return row
      ? { requestDigest: row.requestDigest, response: row.response as BankInstructionView | null }
      : undefined;
  }

  async startIdempotency(
    transaction: DatabaseTransaction,
    organizationId: string,
    scope: string,
    key: string,
    requestDigest: string,
  ): Promise<void> {
    await transaction.insert(idempotencyRecords).values({
      organizationId,
      scope,
      idempotencyKey: key,
      requestDigest,
    });
  }

  async finishIdempotency(
    transaction: DatabaseTransaction,
    organizationId: string,
    scope: string,
    key: string,
    response: BankInstructionView,
  ): Promise<void> {
    await transaction.update(idempotencyRecords).set({
      responseStatus: 200,
      responseBody: { ...response },
    }).where(and(
      eq(idempotencyRecords.organizationId, organizationId),
      eq(idempotencyRecords.scope, scope),
      eq(idempotencyRecords.idempotencyKey, key),
    ));
  }

  async lockInstruction(
    transaction: DatabaseTransaction,
    organizationId: string,
    instructionId: string,
  ): Promise<LockedBankInstruction | undefined> {
    const result = await transaction.execute<LockedBankInstruction>(sql`
      SELECT instruction.id,
             instruction.organization_id AS "organizationId",
             instruction.payment_line_id AS "paymentLineId",
             payment.business_number || ' · ' || line.line_number AS "paymentLineLabel",
             payment.id AS "paymentId",
             instruction.bank_account_id AS "bankAccountId",
             instruction.amount::text,
             instruction.currency,
             instruction.beneficiary_account_reference AS "beneficiaryAccountReference",
             instruction.local_reference AS "localReference",
             instruction.state,
             instruction.version::int,
             instruction.created_at AS "createdAt",
             instruction.updated_at AS "updatedAt",
             COALESCE(payment.branch_id, unit.branch_id) AS "branchId",
             payment.treasury_unit_id AS "treasuryUnitId",
             payment.base_currency AS "baseCurrency",
             payment.total_base_amount::text AS "totalBaseAmount",
             payment.executed_by_user_id AS "paymentExecutedByUserId",
             ARRAY(SELECT DISTINCT child.cashbox_id::text FROM payment_lines child
                   WHERE child.organization_id = payment.organization_id
                     AND child.payment_document_id = payment.id
                     AND child.cashbox_id IS NOT NULL) AS "cashboxIds",
             ARRAY(SELECT DISTINCT child.bank_account_id::text FROM payment_lines child
                   WHERE child.organization_id = payment.organization_id
                     AND child.payment_document_id = payment.id
                     AND child.bank_account_id IS NOT NULL) AS "bankAccountIds",
             ARRAY(SELECT DISTINCT child.currency FROM payment_lines child
                   WHERE child.organization_id = payment.organization_id
                     AND child.payment_document_id = payment.id) AS currencies,
             ARRAY(SELECT DISTINCT child.method_category FROM payment_lines child
                   WHERE child.organization_id = payment.organization_id
                     AND child.payment_document_id = payment.id) AS "methodCategories"
      FROM bank_instructions instruction
      JOIN payment_lines line
        ON line.organization_id = instruction.organization_id
       AND line.id = instruction.payment_line_id
      JOIN payment_documents payment
        ON payment.organization_id = line.organization_id
       AND payment.id = line.payment_document_id
      JOIN treasury_units unit
        ON unit.organization_id = payment.organization_id
       AND unit.id = payment.treasury_unit_id
      WHERE instruction.organization_id = ${organizationId}
        AND instruction.id = ${instructionId}
      FOR UPDATE OF instruction
    `);
    return result.rows[0];
  }

  authorizationContext(instruction: LockedBankInstruction): PaymentAuthorizationContext {
    return {
      branchId: instruction.branchId,
      treasuryUnitId: instruction.treasuryUnitId,
      cashboxIds: instruction.cashboxIds,
      bankAccountIds: instruction.bankAccountIds,
      currencies: [...new Set([instruction.baseCurrency, ...instruction.currencies])],
      methodCategories: instruction.methodCategories,
      documentType: 'PAYMENT',
      amount: instruction.totalBaseAmount,
      amountCurrency: instruction.baseCurrency,
    };
  }

  async activeEvidence(
    transaction: DatabaseTransaction,
    organizationId: string,
    input: NonNullable<BankInstructionOutcomeDto['attachments']>,
  ): Promise<Array<{ id: string; label: string; contentDigest: string; purpose?: string }>> {
    const ids = [...new Set(input.map(({ id }) => id))];
    const rows = ids.length ? await transaction.select({
      id: attachments.id,
      label: attachments.fileName,
      contentDigest: attachments.contentDigest,
      state: attachments.state,
    }).from(attachments).where(and(
      eq(attachments.organizationId, organizationId),
      inArray(attachments.id, ids),
    )).for('share') : [];
    return input.flatMap((item) => {
      const row = rows.find(({ id }) => id === item.id);
      return row?.state === 'ACTIVE' && row.contentDigest === item.contentDigest
        ? [{
          id: row.id,
          label: row.label,
          contentDigest: row.contentDigest,
          ...(item.purpose ? { purpose: item.purpose } : {}),
        }]
        : [];
    });
  }

  async correctionValid(
    transaction: DatabaseTransaction,
    organizationId: string,
    paymentId: string,
    correctionPaymentId: string,
  ): Promise<boolean> {
    const [row] = await transaction.select({ id: paymentDocuments.id })
      .from(paymentDocuments)
      .where(and(
        eq(paymentDocuments.organizationId, organizationId),
        eq(paymentDocuments.id, paymentId),
        eq(paymentDocuments.reversedPaymentId, correctionPaymentId),
      )).limit(1).for('share');
    const [correction] = await transaction.select({ executionState: paymentDocuments.executionState })
      .from(paymentDocuments).where(and(
        eq(paymentDocuments.organizationId, organizationId),
        eq(paymentDocuments.id, correctionPaymentId),
      )).limit(1).for('share');
    return !!row && correction?.executionState === 'EXECUTED';
  }

  async record(
    transaction: DatabaseTransaction,
    input: {
      instruction: LockedBankInstruction;
      dto: BankInstructionOutcomeDto;
      actorUserId: string;
      evidence: Record<string, unknown>;
    },
  ): Promise<number> {
    const version = input.instruction.version + 1;
    await transaction.update(bankInstructions).set({
      state: input.dto.outcome,
      statementLineId: input.dto.statementLineId,
      correctionPaymentId: input.dto.correctionPaymentId,
      outcomeReason: input.dto.reason?.trim(),
      outcomeEvidence: input.evidence,
      version,
      updatedAt: new Date(),
    }).where(and(
      eq(bankInstructions.organizationId, input.instruction.organizationId),
      eq(bankInstructions.id, input.instruction.id),
    ));
    await transaction.insert(bankInstructionOutcomeEvents).values({
      id: randomUUID(),
      organizationId: input.instruction.organizationId,
      bankInstructionId: input.instruction.id,
      sequenceNo: version,
      outcome: input.dto.outcome,
      effectiveAt: new Date(input.dto.effectiveAt),
      actorUserId: input.actorUserId,
      statementLineId: input.dto.statementLineId,
      correctionPaymentId: input.dto.correctionPaymentId,
      reason: input.dto.reason?.trim(),
      evidence: input.evidence,
      sourceVersion: version,
    });
    return version;
  }

  async view(
    transaction: DatabaseTransaction,
    organizationId: string,
    instructionId: string,
  ): Promise<BankInstructionView | undefined> {
    const [row] = await transaction.select({
      instruction: bankInstructions,
      lineNumber: paymentLines.lineNumber,
      paymentNumber: paymentDocuments.businessNumber,
      accountNumber: bankAccounts.accountNumber,
      iban: bankAccounts.iban,
      legalOwnerName: bankAccounts.legalOwnerName,
      bankId: banks.id,
      bankCode: banks.code,
      bankName: banks.displayName,
    }).from(bankInstructions)
      .innerJoin(paymentLines, and(
        eq(paymentLines.organizationId, bankInstructions.organizationId),
        eq(paymentLines.id, bankInstructions.paymentLineId),
      ))
      .innerJoin(paymentDocuments, and(
        eq(paymentDocuments.organizationId, paymentLines.organizationId),
        eq(paymentDocuments.id, paymentLines.paymentDocumentId),
      ))
      .innerJoin(bankAccounts, and(
        eq(bankAccounts.organizationId, bankInstructions.organizationId),
        eq(bankAccounts.id, bankInstructions.bankAccountId),
      ))
      .innerJoin(banks, and(
        eq(banks.organizationId, bankAccounts.organizationId),
        eq(banks.id, bankAccounts.bankId),
      ))
      .innerJoin(bankTypes, eq(bankTypes.id, banks.bankTypeId))
      .where(and(
        eq(bankInstructions.organizationId, organizationId),
        eq(bankInstructions.id, instructionId),
      )).limit(1);
    if (!row) return undefined;
    const events = await transaction.select({
      event: bankInstructionOutcomeEvents,
      actorLabel: userRefs.displayName,
    }).from(bankInstructionOutcomeEvents).innerJoin(userRefs, and(
      eq(userRefs.organizationId, bankInstructionOutcomeEvents.organizationId),
      eq(userRefs.id, bankInstructionOutcomeEvents.actorUserId),
    )).where(and(
      eq(bankInstructionOutcomeEvents.organizationId, organizationId),
      eq(bankInstructionOutcomeEvents.bankInstructionId, instructionId),
    )).orderBy(asc(bankInstructionOutcomeEvents.sequenceNo));
    const correctionIds = [...new Set([
      ...(row.instruction.correctionPaymentId ? [row.instruction.correctionPaymentId] : []),
      ...events.flatMap(({ event }) => event.correctionPaymentId
        ? [event.correctionPaymentId]
        : []),
    ])];
    const corrections = correctionIds.length
      ? await transaction.select({ id: paymentDocuments.id, label: paymentDocuments.businessNumber })
        .from(paymentDocuments).where(and(
          eq(paymentDocuments.organizationId, organizationId),
          inArray(paymentDocuments.id, correctionIds),
        ))
      : [];
    const evidence = row.instruction.outcomeEvidence as {
      attachments?: Array<{ id: string; label: string; contentDigest: string; purpose?: string }>;
    } | null;
    return compact({
      id: row.instruction.id,
      paymentLineId: row.instruction.paymentLineId,
      paymentLineLabel: `${row.paymentNumber} · ${row.lineNumber}`,
      bankAccountId: row.instruction.bankAccountId,
      bankAccount: compact({
        id: row.instruction.bankAccountId,
        bank: { id: row.bankId, code: row.bankCode, displayName: row.bankName },
        accountNumber: row.accountNumber,
        iban: row.iban ?? undefined,
        currency: row.instruction.currency,
        legalOwnerName: row.legalOwnerName,
      }),
      money: { amount: row.instruction.amount, currency: row.instruction.currency },
      beneficiaryAccountReference: row.instruction.beneficiaryAccountReference,
      localReference: row.instruction.localReference,
      state: row.instruction.state,
      outcomeEffectiveAt: events.at(-1)?.event.effectiveAt.toISOString(),
      statementLineId: row.instruction.statementLineId ?? undefined,
      correctionPaymentId: row.instruction.correctionPaymentId ?? undefined,
      correctionPaymentLabel: row.instruction.correctionPaymentId
        ? corrections.find(({ id }) => id === row.instruction.correctionPaymentId)?.label
        : undefined,
      outcomeReason: row.instruction.outcomeReason ?? undefined,
      attachments: evidence?.attachments,
      outcomes: events.map(({ event, actorLabel }) => {
        const eventEvidence = event.evidence as typeof evidence;
        return compact({
          id: event.id,
          sequenceNo: event.sequenceNo,
          outcome: event.outcome as BankInstructionOutcome,
          effectiveAt: event.effectiveAt.toISOString(),
          recordedByUserId: event.actorUserId,
          recordedBy: actorLabel,
          statementLineId: event.statementLineId ?? undefined,
          correctionPaymentId: event.correctionPaymentId ?? undefined,
          correctionPaymentLabel: event.correctionPaymentId
            ? corrections.find(({ id }) => id === event.correctionPaymentId)?.label
            : undefined,
          reason: event.reason ?? undefined,
          attachments: eventEvidence?.attachments,
          sourceVersion: event.sourceVersion,
        });
      }),
      version: row.instruction.version,
      createdAt: row.instruction.createdAt.toISOString(),
      updatedAt: row.instruction.updatedAt.toISOString(),
    }) as BankInstructionView;
  }
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)) as T;
}
