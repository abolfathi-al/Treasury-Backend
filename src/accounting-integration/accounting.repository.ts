import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, gte, inArray, lte, or, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';

import type { PaymentAuthorizationContext } from '../access-control/access-authorization.repository';
import type { DatabaseTransaction } from '../database/database.service';
import {
  accountingAcknowledgements,
  accountingExportArtifacts,
  accountingExportAttempts,
  accountingExportRowResults,
  accountingExports,
  accountingMappings,
  accountingSystems,
  branches,
  fiscalPeriods,
  idempotencyRecords,
  organizations,
  paymentDocuments,
  paymentLines,
  postingLocks,
  treasuryUnits,
} from '../database/schema';
import type { BuiltArtifact, FrozenAccountingPayload } from './accounting-artifacts';
import type {
  AccountingAcknowledgementOutcome,
  AccountingAcknowledgementResult,
  AccountingDownload,
  AccountingExportView,
  AccountingRepresentation,
  AccountingSystemView,
  ExportAcknowledgementDto,
} from './accounting.dto';

export type AccountingExportRow = InferSelectModel<typeof accountingExports>;
export type AccountingMappingRow = InferSelectModel<typeof accountingMappings>;
export type FiscalPeriodRow = InferSelectModel<typeof fiscalPeriods>;

export interface PaymentExportFacts {
  document: InferSelectModel<typeof paymentDocuments>;
  organization: { id: string; code: string; label: string };
  branch?: { id: string; label: string };
  treasuryUnit: { id: string; label: string };
  lines: Array<InferSelectModel<typeof paymentLines>>;
}

@Injectable()
export class AccountingRepository {
  async listSystems(
    transaction: DatabaseTransaction,
    organizationId: string,
    limit: number,
    cursor?: { code: string; id: string },
  ): Promise<AccountingSystemView[]> {
    const rows = await transaction.select().from(accountingSystems).where(and(
      eq(accountingSystems.organizationId, organizationId),
      eq(accountingSystems.state, 'ACTIVE'),
      sql`${accountingSystems.supportedSourceTypes} @> ARRAY['PAYMENT']::varchar[]`,
      cursor ? or(
        gt(accountingSystems.code, cursor.code),
        and(eq(accountingSystems.code, cursor.code), gt(accountingSystems.id, cursor.id)),
      ) : undefined,
    )).orderBy(asc(accountingSystems.code), asc(accountingSystems.id)).limit(limit);
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      transportProfile: row.transportProfile as AccountingRepresentation,
      contractVersion: row.contractVersion,
      supportedSourceTypes: row.supportedSourceTypes as ['PAYMENT'],
    }));
  }

  async system(
    transaction: DatabaseTransaction,
    organizationId: string,
    accountingSystemId: string,
  ): Promise<InferSelectModel<typeof accountingSystems> | undefined> {
    const [row] = await transaction.select().from(accountingSystems).where(and(
      eq(accountingSystems.organizationId, organizationId),
      eq(accountingSystems.id, accountingSystemId),
      eq(accountingSystems.state, 'ACTIVE'),
      sql`${accountingSystems.supportedSourceTypes} @> ARRAY['PAYMENT']::varchar[]`,
    )).limit(1);
    return row;
  }

  async payment(
    transaction: DatabaseTransaction,
    organizationId: string,
    paymentId: string,
    lock = false,
  ): Promise<PaymentExportFacts | undefined> {
    const query = transaction.select({
      document: paymentDocuments,
      organizationId: organizations.id,
      organizationCode: organizations.code,
      organizationLabel: organizations.legalName,
      branchId: branches.id,
      branchLabel: branches.name,
      treasuryUnitId: treasuryUnits.id,
      treasuryUnitLabel: treasuryUnits.name,
    }).from(paymentDocuments)
      .innerJoin(organizations, eq(organizations.id, paymentDocuments.organizationId))
      .innerJoin(treasuryUnits, and(
        eq(treasuryUnits.organizationId, paymentDocuments.organizationId),
        eq(treasuryUnits.id, paymentDocuments.treasuryUnitId),
      ))
      .leftJoin(branches, and(
        eq(branches.organizationId, paymentDocuments.organizationId),
        eq(branches.id, paymentDocuments.branchId),
      ))
      .where(and(
        eq(paymentDocuments.organizationId, organizationId),
        eq(paymentDocuments.id, paymentId),
      )).limit(1);
    const [row] = lock
      ? await query.for('update', { of: paymentDocuments })
      : await query;
    if (!row) return undefined;
    const lines = await transaction.select().from(paymentLines).where(and(
      eq(paymentLines.organizationId, organizationId),
      eq(paymentLines.paymentDocumentId, paymentId),
    )).orderBy(asc(paymentLines.lineNumber));
    return {
      document: row.document,
      organization: {
        id: row.organizationId,
        code: row.organizationCode,
        label: row.organizationLabel,
      },
      branch: row.branchId && row.branchLabel
        ? { id: row.branchId, label: row.branchLabel }
        : undefined,
      treasuryUnit: { id: row.treasuryUnitId, label: row.treasuryUnitLabel },
      lines,
    };
  }

  async mappings(
    transaction: DatabaseTransaction,
    organizationId: string,
    accountingSystemId: string,
    localIds: string[],
  ): Promise<AccountingMappingRow[]> {
    return transaction.select().from(accountingMappings).where(and(
      eq(accountingMappings.organizationId, organizationId),
      eq(accountingMappings.accountingSystemId, accountingSystemId),
      inArray(accountingMappings.localId, localIds),
    )).orderBy(
      asc(accountingMappings.localType),
      asc(accountingMappings.localId),
      asc(accountingMappings.mappingType),
    );
  }

  async periods(
    transaction: DatabaseTransaction,
    organizationId: string,
    accountingSystemId: string,
    businessDate: string,
  ): Promise<FiscalPeriodRow[]> {
    return transaction.select().from(fiscalPeriods).where(and(
      eq(fiscalPeriods.organizationId, organizationId),
      eq(fiscalPeriods.accountingSystemId, accountingSystemId),
      lte(fiscalPeriods.periodStart, businessDate),
      gte(fiscalPeriods.periodEnd, businessDate),
    )).orderBy(asc(fiscalPeriods.externalKey));
  }

  async acquireIdempotencyLock(
    transaction: DatabaseTransaction,
    organizationId: string,
    scope: string,
    key: string,
  ): Promise<void> {
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(
      hashtext(${organizationId}), hashtext(${scope + ':' + key})
    )`);
  }

  async idempotency<T extends AccountingExportView>(
    transaction: DatabaseTransaction,
    organizationId: string,
    scope: string,
    key: string,
  ): Promise<{ requestDigest: string; response: T | null } | undefined> {
    const [row] = await transaction.select({
      requestDigest: idempotencyRecords.requestDigest,
      responseBody: idempotencyRecords.responseBody,
    }).from(idempotencyRecords).where(and(
      eq(idempotencyRecords.organizationId, organizationId),
      eq(idempotencyRecords.scope, scope),
      eq(idempotencyRecords.idempotencyKey, key),
    )).limit(1);
    return row ? { requestDigest: row.requestDigest, response: row.responseBody as T | null } : undefined;
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
    response: AccountingExportView,
  ): Promise<void> {
    await transaction.update(idempotencyRecords).set({
      responseStatus: 202,
      responseBody: { ...response },
    }).where(and(
      eq(idempotencyRecords.organizationId, organizationId),
      eq(idempotencyRecords.scope, scope),
      eq(idempotencyRecords.idempotencyKey, key),
    ));
  }

  async duplicateExport(
    transaction: DatabaseTransaction,
    organizationId: string,
    accountingSystemId: string,
    sourceId: string,
    sourceVersion: number,
    exportKind: string,
  ): Promise<AccountingExportRow | undefined> {
    const [row] = await transaction.select().from(accountingExports).where(and(
      eq(accountingExports.organizationId, organizationId),
      eq(accountingExports.accountingSystemId, accountingSystemId),
      eq(accountingExports.sourceType, 'PAYMENT'),
      eq(accountingExports.sourceId, sourceId),
      eq(accountingExports.sourceVersion, sourceVersion),
      eq(accountingExports.exportKind, exportKind),
    )).limit(1);
    return row;
  }

  async acceptedSourceExport(
    transaction: DatabaseTransaction,
    organizationId: string,
    sourceId: string,
    sourceVersion: number,
  ): Promise<AccountingExportRow | undefined> {
    const [row] = await transaction.select().from(accountingExports).where(and(
      eq(accountingExports.organizationId, organizationId),
      eq(accountingExports.sourceType, 'PAYMENT'),
      eq(accountingExports.sourceId, sourceId),
      eq(accountingExports.sourceVersion, sourceVersion),
      eq(accountingExports.state, 'ACCEPTED'),
    )).limit(1);
    return row;
  }

  async createExport(
    transaction: DatabaseTransaction,
    input: {
      organizationId: string;
      actorUserId: string;
      key: string;
      system: InferSelectModel<typeof accountingSystems>;
      payment: PaymentExportFacts;
      payload: FrozenAccountingPayload;
      payloadDigest: string;
      mappingSnapshotDigest: string;
      fiscalSnapshotDigest: string;
      requestDigest: string;
      artifacts: BuiltArtifact[];
    },
  ): Promise<AccountingExportView> {
    const exportId = randomUUID();
    await transaction.insert(accountingExports).values({
      id: exportId,
      organizationId: input.organizationId,
      accountingSystemId: input.system.id,
      branchId: input.payment.document.branchId,
      treasuryUnitId: input.payment.document.treasuryUnitId,
      sourceType: 'PAYMENT',
      sourceId: input.payment.document.id,
      sourceVersion: input.payment.document.version,
      documentType: 'PAYMENT',
      baseCurrency: input.payment.document.baseCurrency,
      aggregateBaseAmount: input.payment.document.totalBaseAmount,
      exportKind: input.payload.exportKind,
      contractVersion: input.system.contractVersion,
      idempotencyKey: input.key,
      payloadDigest: input.payloadDigest,
      mappingSnapshotDigest: input.mappingSnapshotDigest,
      fiscalSnapshotDigest: input.fiscalSnapshotDigest,
      exportedBy: input.actorUserId,
      state: 'QUEUED',
      version: 1,
      createdAt: new Date(input.payload.createdAt),
    });
    await transaction.insert(accountingExportAttempts).values({
      organizationId: input.organizationId,
      accountingExportId: exportId,
      attemptNumber: 1,
      requestSnapshot: { ...input.payload },
      requestDigest: input.requestDigest,
      outcome: 'QUEUED',
      actorId: input.actorUserId,
    });
    for (const artifact of input.artifacts) {
      const artifactId = randomUUID();
      await transaction.insert(accountingExportArtifacts).values({
        id: artifactId,
        organizationId: input.organizationId,
        accountingExportId: exportId,
        representation: artifact.representation,
        contractVersion: input.system.contractVersion,
        manifestVersion: '1',
        mediaType: artifact.mediaType,
        fileName: artifact.fileName,
        contentAddress: `sha256:${artifact.payloadDigest}`,
        content: artifact.bytes,
        byteSize: artifact.bytes.length,
        payloadDigest: artifact.payloadDigest,
        rowCount: artifact.rowDigests.length,
        createdAt: new Date(input.payload.createdAt),
      });
      await transaction.insert(accountingExportRowResults).values(
        artifact.rowDigests.map((payloadDigest, index) => ({
          organizationId: input.organizationId,
          accountingExportArtifactId: artifactId,
          rowNumber: index + 1,
          sourceType: 'PAYMENT',
          sourceId: input.payment.document.id,
          sourceVersion: input.payment.document.version,
          payloadDigest,
          outcome: 'ACCEPTED',
        })),
      );
    }
    await transaction.update(paymentDocuments).set({
      accountingState: 'QUEUED',
      updatedAt: new Date(),
    }).where(and(
      eq(paymentDocuments.organizationId, input.organizationId),
      eq(paymentDocuments.id, input.payment.document.id),
    ));
    return (await this.exportView(transaction, input.organizationId, exportId))!;
  }

  async lockExport(
    transaction: DatabaseTransaction,
    organizationId: string,
    exportId: string,
  ): Promise<AccountingExportRow | undefined> {
    const [row] = await transaction.select().from(accountingExports).where(and(
      eq(accountingExports.organizationId, organizationId),
      eq(accountingExports.id, exportId),
    )).for('update').limit(1);
    return row;
  }

  async acknowledgementReplay(
    transaction: DatabaseTransaction,
    organizationId: string,
    exportId: string,
    key: string,
  ): Promise<{ requestDigest: string; response: AccountingAcknowledgementResult } | undefined> {
    const [row] = await transaction.select({
      requestDigest: accountingAcknowledgements.requestDigest,
      responseBody: accountingAcknowledgements.responseBody,
    }).from(accountingAcknowledgements).where(and(
      eq(accountingAcknowledgements.organizationId, organizationId),
      eq(accountingAcknowledgements.accountingExportId, exportId),
      eq(accountingAcknowledgements.idempotencyKey, key),
    )).limit(1);
    return row ? {
      requestDigest: row.requestDigest,
      response: row.responseBody as unknown as AccountingAcknowledgementResult,
    } : undefined;
  }

  async acknowledge(
    transaction: DatabaseTransaction,
    input: {
      export: AccountingExportRow;
      actorUserId: string;
      key: string;
      requestDigest: string;
      targetState: AccountingExportRow['state'];
      body: ExportAcknowledgementDto;
      requestId: string;
    },
  ): Promise<AccountingAcknowledgementResult> {
    const acknowledgementId = randomUUID();
    const postingLockId = input.body.outcome === 'ACCEPTED' ? randomUUID() : undefined;
    const nextVersion = input.export.version + 1;
    const [latestAttempt] = await transaction.select({
      attemptNumber: accountingExportAttempts.attemptNumber,
    }).from(accountingExportAttempts).where(and(
      eq(accountingExportAttempts.organizationId, input.export.organizationId),
      eq(accountingExportAttempts.accountingExportId, input.export.id),
    )).orderBy(desc(accountingExportAttempts.attemptNumber)).limit(1);
    await transaction.update(accountingExports).set({
      state: input.targetState,
      version: nextVersion,
      externalDocumentId: input.body.externalDocumentId,
      externalDocumentNumber: input.body.outcome === 'RETURNED'
        ? input.body.externalDocumentNumber ?? input.export.externalDocumentNumber
        : input.body.externalDocumentNumber,
      acceptedAt: input.body.outcome === 'ACCEPTED'
        ? new Date(input.body.acknowledgedAt)
        : input.export.acceptedAt,
    }).where(and(
      eq(accountingExports.organizationId, input.export.organizationId),
      eq(accountingExports.id, input.export.id),
      eq(accountingExports.version, input.export.version),
    ));
    if (postingLockId) {
      await transaction.insert(postingLocks).values({
        id: postingLockId,
        organizationId: input.export.organizationId,
        accountingExportId: input.export.id,
        accountingSystemId: input.export.accountingSystemId,
        sourceType: 'PAYMENT',
        sourceId: input.export.sourceId,
        sourceVersion: input.export.sourceVersion,
        lockedDigest: input.export.payloadDigest,
        lockedAt: new Date(input.body.acknowledgedAt),
        state: 'ACTIVE',
      });
    } else if (input.body.outcome === 'RETURNED') {
      await transaction.update(postingLocks).set({ state: 'RETURNED' }).where(and(
        eq(postingLocks.organizationId, input.export.organizationId),
        eq(postingLocks.accountingExportId, input.export.id),
      ));
    }
    const accountingState = input.targetState === 'SENDING_UNKNOWN'
      ? 'SENDING_UNKNOWN'
      : input.targetState;
    await transaction.update(paymentDocuments).set({
      accountingState,
      updatedAt: new Date(),
    }).where(and(
      eq(paymentDocuments.organizationId, input.export.organizationId),
      eq(paymentDocuments.id, input.export.sourceId),
    ));
    await transaction.insert(accountingExportAttempts).values({
      organizationId: input.export.organizationId,
      accountingExportId: input.export.id,
      attemptNumber: (latestAttempt?.attemptNumber ?? 0) + 1,
      requestSnapshot: { outcome: input.body.outcome },
      requestDigest: input.requestDigest,
      responseSnapshot: { ...input.body },
      responseDigest: input.body.responseDigest,
      outcome: attemptOutcome(input.body.outcome),
      errorCode: input.body.errorCode,
      actorId: input.actorUserId,
      externalDocumentId: input.body.externalDocumentId,
      externalDocumentNumber: input.body.externalDocumentNumber,
      attemptedAt: new Date(input.body.acknowledgedAt),
    });
    const view = (await this.exportView(
      transaction, input.export.organizationId, input.export.id,
    ))!;
    const result: AccountingAcknowledgementResult = {
      acknowledgementId,
      outcome: input.body.outcome,
      export: view,
      ...(postingLockId ? { postingLock: { id: postingLockId, label: view.source.label } } : {}),
    };
    await transaction.insert(accountingAcknowledgements).values({
      id: acknowledgementId,
      organizationId: input.export.organizationId,
      accountingExportId: input.export.id,
      idempotencyKey: input.key,
      requestDigest: input.requestDigest,
      outcome: input.body.outcome,
      responseDigest: input.body.responseDigest,
      externalDocumentId: input.body.externalDocumentId,
      externalDocumentNumber: input.body.externalDocumentNumber,
      externalReturnId: input.body.externalReturnId,
      errorCode: input.body.errorCode,
      errorDetail: input.body.errorDetail,
      acknowledgedBy: input.actorUserId,
      acknowledgedAt: new Date(input.body.acknowledgedAt),
      exportVersion: nextVersion,
      responseBody: { ...result },
    });
    return result;
  }

  async exportView(
    transaction: DatabaseTransaction,
    organizationId: string,
    exportId: string,
  ): Promise<AccountingExportView | undefined> {
    const [row] = await transaction.select({
      export: accountingExports,
      organizationLabel: organizations.legalName,
      systemName: accountingSystems.name,
      sourceLabel: paymentDocuments.businessNumber,
      branchLabel: branches.name,
      unitLabel: treasuryUnits.name,
    }).from(accountingExports)
      .innerJoin(organizations, eq(organizations.id, accountingExports.organizationId))
      .innerJoin(accountingSystems, and(
        eq(accountingSystems.organizationId, accountingExports.organizationId),
        eq(accountingSystems.id, accountingExports.accountingSystemId),
      ))
      .innerJoin(paymentDocuments, and(
        eq(paymentDocuments.organizationId, accountingExports.organizationId),
        eq(paymentDocuments.id, accountingExports.sourceId),
      ))
      .leftJoin(branches, and(
        eq(branches.organizationId, accountingExports.organizationId),
        eq(branches.id, accountingExports.branchId),
      ))
      .leftJoin(treasuryUnits, and(
        eq(treasuryUnits.organizationId, accountingExports.organizationId),
        eq(treasuryUnits.id, accountingExports.treasuryUnitId),
      ))
      .where(and(
        eq(accountingExports.organizationId, organizationId),
        eq(accountingExports.id, exportId),
      )).limit(1);
    if (!row) return undefined;
    const artifacts = await transaction.select().from(accountingExportArtifacts).where(and(
      eq(accountingExportArtifacts.organizationId, organizationId),
      eq(accountingExportArtifacts.accountingExportId, exportId),
    )).orderBy(asc(accountingExportArtifacts.representation));
    const ids = artifacts.map(({ id }) => id);
    const rowResults = ids.length ? await transaction.select().from(accountingExportRowResults)
      .where(and(
        eq(accountingExportRowResults.organizationId, organizationId),
        inArray(accountingExportRowResults.accountingExportArtifactId, ids),
      )).orderBy(
        asc(accountingExportRowResults.accountingExportArtifactId),
        asc(accountingExportRowResults.rowNumber),
      ) : [];
    return {
      id: row.export.id,
      organization: { id: organizationId, label: row.organizationLabel },
      accountingSystem: { id: row.export.accountingSystemId, label: row.systemName },
      ...(row.export.branchId && row.branchLabel
        ? { branch: { id: row.export.branchId, label: row.branchLabel } }
        : {}),
      ...(row.export.treasuryUnitId && row.unitLabel
        ? { treasuryUnit: { id: row.export.treasuryUnitId, label: row.unitLabel } }
        : {}),
      sourceType: 'PAYMENT',
      source: { id: row.export.sourceId, label: row.sourceLabel },
      sourceVersion: row.export.sourceVersion,
      exportKind: row.export.exportKind,
      contractVersion: row.export.contractVersion,
      payloadDigest: row.export.payloadDigest,
      state: row.export.state as AccountingExportView['state'],
      version: row.export.version,
      createdAt: row.export.createdAt.toISOString(),
      ...(row.export.acceptedAt ? { acceptedAt: row.export.acceptedAt.toISOString() } : {}),
      ...(row.export.externalDocumentId
        ? { externalDocumentId: row.export.externalDocumentId }
        : {}),
      ...(row.export.externalDocumentNumber
        ? { externalDocumentNumber: row.export.externalDocumentNumber }
        : {}),
      artifacts: artifacts.map((artifact) => ({
        id: artifact.id,
        representation: artifact.representation as AccountingRepresentation,
        contractVersion: artifact.contractVersion,
        manifestVersion: artifact.manifestVersion,
        mediaType: artifact.mediaType as AccountingExportView['artifacts'][number]['mediaType'],
        fileName: artifact.fileName,
        byteSize: artifact.byteSize,
        payloadDigest: artifact.payloadDigest,
        rowCount: artifact.rowCount,
        createdAt: artifact.createdAt.toISOString(),
        rowResults: rowResults.filter(({ accountingExportArtifactId }) =>
          accountingExportArtifactId === artifact.id).map((result) => ({
          rowNumber: result.rowNumber,
          sourceType: 'PAYMENT',
          sourceId: result.sourceId,
          sourceVersion: result.sourceVersion,
          payloadDigest: result.payloadDigest,
          outcome: 'ACCEPTED',
        })),
      })),
    };
  }

  async exportViews(
    transaction: DatabaseTransaction,
    organizationId: string,
    exportIds: string[],
  ): Promise<AccountingExportView[]> {
    const views: AccountingExportView[] = [];
    for (const exportId of exportIds) {
      const view = await this.exportView(transaction, organizationId, exportId);
      if (view) views.push(view);
    }
    return views;
  }

  async download(
    transaction: DatabaseTransaction,
    organizationId: string,
    exportId: string,
    representation: AccountingRepresentation,
  ): Promise<(AccountingDownload & { export: AccountingExportRow }) | undefined> {
    const [row] = await transaction.select({
      export: accountingExports,
      content: accountingExportArtifacts.content,
      mediaType: accountingExportArtifacts.mediaType,
      fileName: accountingExportArtifacts.fileName,
      payloadDigest: accountingExportArtifacts.payloadDigest,
    }).from(accountingExportArtifacts).innerJoin(accountingExports, and(
      eq(accountingExports.organizationId, accountingExportArtifacts.organizationId),
      eq(accountingExports.id, accountingExportArtifacts.accountingExportId),
    )).where(and(
      eq(accountingExportArtifacts.organizationId, organizationId),
      eq(accountingExportArtifacts.accountingExportId, exportId),
      eq(accountingExportArtifacts.representation, representation),
    )).limit(1);
    return row ? {
      export: row.export,
      bytes: row.content,
      mediaType: row.mediaType,
      fileName: row.fileName,
      etag: `"${row.payloadDigest}"`,
    } : undefined;
  }
}

export function paymentAuthorizationContext(payment: PaymentExportFacts): PaymentAuthorizationContext {
  return {
    branchId: payment.document.branchId,
    treasuryUnitId: payment.document.treasuryUnitId,
    cashboxIds: [...new Set(payment.lines.flatMap(({ cashboxId }) => cashboxId ? [cashboxId] : []))],
    bankAccountIds: [...new Set(payment.lines.flatMap(({ bankAccountId }) => bankAccountId ? [bankAccountId] : []))],
    currencies: [...new Set(payment.lines.map(({ currency }) => currency))],
    methodCategories: [...new Set(payment.lines.map(({ methodCategory }) => methodCategory))],
    documentType: 'PAYMENT',
    amount: payment.document.totalBaseAmount,
    amountCurrency: payment.document.baseCurrency,
  };
}

export function exportAuthorizationContext(
  accountingExport: AccountingExportRow,
): PaymentAuthorizationContext {
  return {
    branchId: accountingExport.branchId,
    treasuryUnitId: accountingExport.treasuryUnitId,
    cashboxIds: [],
    bankAccountIds: [],
    currencies: [],
    methodCategories: [],
    documentType: 'PAYMENT',
    amount: accountingExport.aggregateBaseAmount,
    amountCurrency: accountingExport.baseCurrency,
  };
}

function attemptOutcome(outcome: AccountingAcknowledgementOutcome): 'ACCEPTED' | 'FAILED' | 'SENDING_UNKNOWN' {
  if (outcome === 'ACCEPTED') return 'ACCEPTED';
  if (outcome === 'OUTCOME_UNKNOWN') return 'SENDING_UNKNOWN';
  return 'FAILED';
}
