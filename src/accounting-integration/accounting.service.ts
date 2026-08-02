import { Inject, Injectable } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';

import { AccessAuthorizationService } from '../access-control/access-authorization.service';
import { commandDigest, digest, stableJson } from '../common/http';
import { TreasuryProblem } from '../common/problem';
import { DatabaseService, type DatabaseTransaction } from '../database/database.service';
import { FoundationEffectsService } from '../foundation-effects/foundation-effects.service';
import { buildArtifacts, type FrozenAccountingPayload } from './accounting-artifacts';
import {
  AccountingRepository,
  exportAuthorizationContext,
  paymentAuthorizationContext,
  type AccountingExportRow,
  type AccountingMappingRow,
  type PaymentExportFacts,
} from './accounting.repository';
import type {
  AccountingAcknowledgementResult,
  AccountingDownload,
  AccountingExportPage,
  AccountingExportQuery,
  AccountingFileQuery,
  AccountingRepresentation,
  AccountingSystemPage,
  AccountingSystemQuery,
  ExportAcknowledgementDto,
  ExportRequestDto,
} from './accounting.dto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACCOUNTING_QUEUE_STATES = 'QUEUED,SENDING,SENDING_UNKNOWN,ACCEPTED';
const ACCOUNTING_QUEUE_ORDER = 'createdAt:desc,id:desc';

interface AccountingExportCursorPayload {
  version: 1;
  organizationId: string;
  actorUserId: string;
  scopeFingerprint: string;
  eligibleStates: typeof ACCOUNTING_QUEUE_STATES;
  order: typeof ACCOUNTING_QUEUE_ORDER;
  limit: number;
  after: { createdAt: string; id: string };
}

interface SignedAccountingExportCursor {
  payload: AccountingExportCursorPayload;
  signature: string;
}

@Injectable()
export class AccountingService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AccountingRepository) private readonly repository: AccountingRepository,
    @Inject(AccessAuthorizationService)
    private readonly authorization: AccessAuthorizationService,
    @Inject(FoundationEffectsService)
    private readonly foundation: FoundationEffectsService,
  ) {}

  listSystems(
    organizationId: string,
    actorUserId: string,
    query: AccountingSystemQuery,
  ): Promise<AccountingSystemPage> {
    return this.map(() => this.database.db.transaction(async (transaction) => {
      const limit = this.limit(query.limit);
      const cursor = this.systemCursor(query.cursor);
      if (!await this.authorization.hasOrganizationPermission(
        transaction, organizationId, actorUserId, 'accounting.export',
      )) throw new Error('SCOPE_DENIED');
      const rows = await this.repository.listSystems(
        transaction, organizationId, limit + 1, cursor,
      );
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return {
        items,
        page: {
          limit,
          hasMore,
          asOf: new Date().toISOString(),
          ...(hasMore && last
            ? { nextCursor: Buffer.from(JSON.stringify({ code: last.code, id: last.id })).toString('base64url') }
            : {}),
        },
      };
    }));
  }

  listExports(
    organizationId: string,
    actorUserId: string,
    query: AccountingExportQuery,
  ): Promise<AccountingExportPage> {
    return this.map(() => this.database.db.transaction(async (transaction) => {
      const limit = this.limit(query.limit);
      const scopeFingerprint = await this.authorization.accountingScopeFingerprint(
        transaction,
        organizationId,
        actorUserId,
        'accounting.acknowledge',
      );
      if (!scopeFingerprint) throw new Error('SCOPE_DENIED');
      const cursor = this.exportCursor(
        query.cursor,
        organizationId,
        actorUserId,
        scopeFingerprint,
        limit,
      );
      const ids = await this.authorization.listVisibleAccountingExportIds(
        transaction,
        organizationId,
        actorUserId,
        limit + 1,
        cursor,
      );
      const hasMore = ids.length > limit;
      const items = await this.repository.exportViews(
        transaction,
        organizationId,
        ids.slice(0, limit),
      );
      const last = items.at(-1);
      return {
        items,
        page: {
          limit,
          hasMore,
          asOf: new Date().toISOString(),
          ...(hasMore && last ? {
            nextCursor: this.encodeExportCursor({
              version: 1,
              organizationId,
              actorUserId,
              scopeFingerprint,
              eligibleStates: ACCOUNTING_QUEUE_STATES,
              order: ACCOUNTING_QUEUE_ORDER,
              limit,
              after: { createdAt: last.createdAt, id: last.id },
            }),
          } : {}),
        },
      };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' }));
  }

  createExport(
    organizationId: string,
    actorUserId: string,
    body: ExportRequestDto,
    key: string,
    requestId: string,
  ) {
    this.commandHeaders(key, requestId);
    if (body.sourceType !== 'PAYMENT') this.validation('sourceType is not supported.');
    if (!body.exportKind.trim()) this.validation('exportKind must not be blank.');
    const requestDigest = commandDigest('createAccountingExport', {
      actorUserId,
      body: { ...body, exportKind: body.exportKind.trim() },
    });
    return this.map(() => this.database.db.transaction(async (transaction) => {
      const scope = `createAccountingExport:${body.accountingSystemId}`;
      await this.repository.acquireIdempotencyLock(transaction, organizationId, scope, key);
      const payment = await this.repository.payment(
        transaction, organizationId, body.sourceId, true,
      );
      if (!payment) throw new Error('RESOURCE_HIDDEN');
      await this.assertAuthorized(transaction, organizationId, actorUserId, payment, 'accounting.export');
      const replay = await this.repository.idempotency(
        transaction, organizationId, scope, key,
      );
      if (replay) {
        if (replay.requestDigest !== requestDigest || !replay.response) {
          throw new Error('IDEMPOTENCY_CONFLICT');
        }
        return replay.response;
      }
      if (
        payment.document.version !== body.sourceVersion
        || payment.document.executionState !== 'EXECUTED'
        || payment.document.state === 'REVERSED'
        || !payment.lines.length
        || payment.lines.some(({ state }) => state !== 'EXECUTED')
      ) throw new Error('STATE_CONFLICT');
      const system = await this.repository.system(
        transaction, organizationId, body.accountingSystemId,
      );
      if (!system) throw new Error('RESOURCE_HIDDEN');
      if (system.forbidSourceExecutorExport
        && payment.document.executedByUserId === actorUserId) throw new Error('SCOPE_DENIED');
      if (await this.repository.acceptedSourceExport(
        transaction, organizationId, body.sourceId, body.sourceVersion,
      )) throw new Error('EXPORT_DUPLICATE');
      const duplicate = await this.repository.duplicateExport(
        transaction,
        organizationId,
        system.id,
        body.sourceId,
        body.sourceVersion,
        body.exportKind.trim(),
      );
      if (duplicate?.state === 'ACCEPTED') throw new Error('EXPORT_DUPLICATE');
      if (duplicate?.state === 'SENDING_UNKNOWN') throw new Error('OUTCOME_UNKNOWN');
      if (duplicate) throw new Error('STATE_CONFLICT');

      const required = requiredMappings(payment);
      const mappings = await this.repository.mappings(
        transaction, organizationId, system.id, required.map(({ localId }) => localId),
      );
      const frozenMappings = this.assertMappings(required, mappings);
      const periods = await this.repository.periods(
        transaction, organizationId, system.id, payment.document.businessDate,
      );
      if (periods.length !== 1 || periods[0]!.state !== 'OPEN') {
        throw new Error('PERIOD_UNAVAILABLE');
      }
      const period = periods[0]!;
      const payload: FrozenAccountingPayload = {
        createdAt: new Date().toISOString(),
        contractVersion: system.contractVersion,
        exportKind: body.exportKind.trim(),
        organization: {
          id: payment.organization.id,
          code: payment.organization.code,
          name: payment.organization.label,
        },
        accountingSystem: { id: system.id, code: system.code, name: system.name },
        source: {
          id: payment.document.id,
          version: payment.document.version,
          businessNumber: payment.document.businessNumber,
          businessDate: payment.document.businessDate,
          baseCurrency: payment.document.baseCurrency,
          totalBaseAmount: payment.document.totalBaseAmount,
        },
        fiscalPeriod: {
          externalKey: period.externalKey,
          sourceVersion: period.sourceVersion,
          sourceDigest: period.sourceDigest,
        },
        mappings: frozenMappings.map((mapping) => ({
          localType: mapping.localType,
          localId: mapping.localId,
          mappingType: mapping.mappingType,
          externalKey: mapping.externalKey,
          externalParentKey: mapping.externalParentKey,
          sourceVersion: mapping.sourceVersion,
        })),
        lines: payment.lines.map((line) => ({
          lineNumber: line.lineNumber,
          methodName: line.methodName,
          amount: line.amount,
          currency: line.currency,
          baseAmount: line.baseAmount,
          description: line.description,
        })),
      };
      const payloadDigest = digest(stableJson(payload));
      const mappingSnapshotDigest = digest(stableJson(payload.mappings));
      const fiscalSnapshotDigest = digest(stableJson(payload.fiscalPeriod));
      const artifacts = buildArtifacts(payload);
      await this.repository.startIdempotency(
        transaction, organizationId, scope, key, requestDigest,
      );
      const view = await this.repository.createExport(transaction, {
        organizationId,
        actorUserId,
        key,
        system,
        payment,
        payload,
        payloadDigest,
        mappingSnapshotDigest,
        fiscalSnapshotDigest,
        requestDigest,
        artifacts,
      });
      await this.foundation.appendAudit(transaction, {
        organizationId,
        requestId,
        actorUserId,
        entityType: 'AccountingExport',
        entityId: view.id,
        action: 'CREATE_ACCOUNTING_EXPORT',
      });
      await this.repository.finishIdempotency(
        transaction, organizationId, scope, key, view,
      );
      return view;
    }));
  }

  download(
    organizationId: string,
    actorUserId: string,
    exportId: string,
    query: AccountingFileQuery,
  ): Promise<AccountingDownload> {
    if (!UUID.test(exportId)) this.validation('resourceId is malformed.');
    if (query.representation !== 'CSV_ZIP_MANIFEST' && query.representation !== 'XLSX') {
      this.validation('representation is required.');
    }
    return this.map(() => this.database.db.transaction(async (transaction) => {
      const file = await this.repository.download(
        transaction,
        organizationId,
        exportId,
        query.representation as AccountingRepresentation,
      );
      if (!file) throw new Error('RESOURCE_HIDDEN');
      await this.assertExportAuthorized(
        transaction, organizationId, actorUserId, file.export, 'accounting.export',
      );
      const actual = createHash('sha256').update(file.bytes).digest('hex');
      if (file.etag !== `"${actual}"`) throw new Error('ARTIFACT_INTEGRITY');
      const { export: _export, ...download } = file;
      return download;
    }));
  }

  acknowledge(
    organizationId: string,
    actorUserId: string,
    exportId: string,
    body: ExportAcknowledgementDto,
    key: string,
    ifMatch: string,
    requestId: string,
  ): Promise<AccountingAcknowledgementResult> {
    this.commandHeaders(key, requestId);
    if (!UUID.test(exportId)) this.validation('resourceId is malformed.');
    const match = /^"([0-9]+)"$/u.exec(ifMatch);
    if (!match) this.validation('If-Match must be one strong numeric ETag.');
    const expectedVersion = Number(match![1]);
    const requestDigest = commandDigest('recordAccountingAcknowledgement', {
      actorUserId,
      exportId,
      ifMatch,
      body,
    });
    return this.map(() => this.database.db.transaction(async (transaction) => {
      const scope = `recordAccountingAcknowledgement:${exportId}`;
      await this.repository.acquireIdempotencyLock(transaction, organizationId, scope, key);
      const accountingExport = await this.repository.lockExport(transaction, organizationId, exportId);
      if (!accountingExport) throw new Error('RESOURCE_HIDDEN');
      await this.assertExportAuthorized(
        transaction,
        organizationId,
        actorUserId,
        accountingExport,
        'accounting.acknowledge',
      );
      if (accountingExport.exportedBy === actorUserId) throw new Error('SCOPE_DENIED');
      const replay = await this.repository.acknowledgementReplay(
        transaction, organizationId, exportId, key,
      );
      if (replay) {
        if (replay.requestDigest !== requestDigest) throw new Error('IDEMPOTENCY_CONFLICT');
        return replay.response;
      }
      if (accountingExport.version !== expectedVersion) throw new Error('STALE_VERSION');
      const targetState = this.targetState(accountingExport, body);
      const result = await this.repository.acknowledge(transaction, {
        export: accountingExport,
        actorUserId,
        key,
        requestDigest,
        targetState,
        body,
        requestId,
      });
      await this.foundation.appendAudit(transaction, {
        organizationId,
        requestId,
        actorUserId,
        entityType: 'AccountingExport',
        entityId: exportId,
        action: `ACCOUNTING_${body.outcome}`,
      });
      if (body.outcome === 'ACCEPTED') {
        await this.foundation.appendOutbox(transaction, {
          organizationId,
          aggregateType: 'AccountingExport',
          aggregateId: exportId,
          aggregateVersion: result.export.version,
          eventType: 'treasury.accounting.export-accepted.v1',
          payload: {
            sourceType: result.export.sourceType,
            sourceId: result.export.source.id,
            sourceVersion: result.export.sourceVersion,
            accountingSystemId: result.export.accountingSystem.id,
            exportId,
            exportVersion: result.export.version,
            payloadDigest: result.export.payloadDigest,
            responseDigest: body.responseDigest,
            externalDocumentId: result.export.externalDocumentId,
            ...(result.export.externalDocumentNumber
              ? { externalDocumentNumber: result.export.externalDocumentNumber }
              : {}),
            postingLockId: result.postingLock!.id,
            acceptedAt: result.export.acceptedAt,
          },
        });
      } else if (body.outcome === 'REJECTED' || body.outcome === 'OUTCOME_UNKNOWN') {
        await this.foundation.appendOutbox(transaction, {
          organizationId,
          aggregateType: 'AccountingExport',
          aggregateId: exportId,
          aggregateVersion: result.export.version,
          eventType: 'treasury.accounting.export-failed.v1',
          payload: {
            sourceType: result.export.sourceType,
            sourceId: result.export.source.id,
            sourceVersion: result.export.sourceVersion,
            accountingSystemId: result.export.accountingSystem.id,
            exportId,
            exportVersion: result.export.version,
            payloadDigest: result.export.payloadDigest,
            responseDigest: body.responseDigest,
            state: result.export.state,
            errorCode: body.errorCode ?? 'OUTCOME_UNKNOWN',
            ...(body.errorDetail ? { errorDetail: body.errorDetail } : {}),
          },
        });
      }
      return result;
    }));
  }

  private async assertAuthorized(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    payment: PaymentExportFacts,
    permission: 'accounting.export' | 'accounting.acknowledge',
  ): Promise<void> {
    if (!await this.authorization.canOperateAccounting(
      transaction,
      organizationId,
      actorUserId,
      paymentAuthorizationContext(payment),
      permission,
    )) throw new Error('SCOPE_DENIED');
  }

  private async assertExportAuthorized(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    accountingExport: AccountingExportRow,
    permission: 'accounting.export' | 'accounting.acknowledge',
  ): Promise<void> {
    if (!await this.authorization.canOperateAccounting(
      transaction,
      organizationId,
      actorUserId,
      exportAuthorizationContext(accountingExport),
      permission,
    )) throw new Error('SCOPE_DENIED');
  }

  private assertMappings(
    required: Array<{ localType: string; localId: string }>,
    mappings: AccountingMappingRow[],
  ): AccountingMappingRow[] {
    const relevant = mappings.filter((mapping) => required.some((item) =>
      item.localType === mapping.localType && item.localId === mapping.localId));
    if (required.some((item) => {
      const matches = relevant.filter((mapping) =>
        item.localType === mapping.localType && item.localId === mapping.localId);
      return matches.some(({ state }) => state === 'CONFLICT')
        || matches.filter(({ state }) => state === 'ACTIVE').length !== 1;
    })) throw new Error('MAPPING_REQUIRED');
    return relevant.filter(({ state }) => state === 'ACTIVE');
  }

  private targetState(
    accountingExport: AccountingExportRow,
    body: ExportAcknowledgementDto,
  ): AccountingExportRow['state'] {
    if (body.outcome === 'ACCEPTED') {
      if (!['QUEUED', 'SENDING', 'SENDING_UNKNOWN'].includes(accountingExport.state)) {
        throw new Error('STATE_CONFLICT');
      }
      return 'ACCEPTED';
    }
    if (body.outcome === 'REJECTED') {
      if (!['QUEUED', 'SENDING', 'SENDING_UNKNOWN'].includes(accountingExport.state)) {
        throw new Error('STATE_CONFLICT');
      }
      return 'FAILED';
    }
    if (body.outcome === 'OUTCOME_UNKNOWN') {
      if (!['QUEUED', 'SENDING'].includes(accountingExport.state)) throw new Error('STATE_CONFLICT');
      return 'SENDING_UNKNOWN';
    }
    if (
      accountingExport.state !== 'ACCEPTED'
      || !accountingExport.externalDocumentId
      || body.externalDocumentId !== accountingExport.externalDocumentId
    ) throw new Error('STATE_CONFLICT');
    return 'RETURNED';
  }

  private limit(raw?: string): number {
    const value = raw === undefined ? 50 : Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 500) {
      this.validation('limit must be an integer from 1 through 500.');
    }
    return value;
  }

  private systemCursor(raw?: string): { code: string; id: string } | undefined {
    if (!raw) return undefined;
    try {
      const value = JSON.parse(Buffer.from(raw, 'base64url').toString()) as unknown;
      if (
        !value
        || typeof value !== 'object'
        || typeof (value as { code?: unknown }).code !== 'string'
        || typeof (value as { id?: unknown }).id !== 'string'
        || !UUID.test((value as { id: string }).id)
      ) throw new Error('invalid');
      return value as { code: string; id: string };
    } catch {
      this.validation('cursor is malformed.');
    }
  }

  private exportCursor(
    raw: string | undefined,
    organizationId: string,
    actorUserId: string,
    scopeFingerprint: string,
    limit: number,
  ): { createdAt: string; id: string } | undefined {
    if (!raw) return undefined;
    try {
      if (!/^[A-Za-z0-9_-]+$/u.test(raw) || raw.length > 16_384) throw new Error('invalid');
      const value = JSON.parse(
        Buffer.from(raw, 'base64url').toString('utf8'),
      ) as SignedAccountingExportCursor;
      if (
        !value
        || typeof value !== 'object'
        || !value.payload
        || value.payload.version !== 1
        || typeof value.payload.after?.createdAt !== 'string'
        || Number.isNaN(Date.parse(value.payload.after.createdAt))
        || !UUID.test(value.payload.after?.id ?? '')
        || value.payload.organizationId !== organizationId
        || value.payload.actorUserId !== actorUserId
        || value.payload.scopeFingerprint !== scopeFingerprint
        || value.payload.eligibleStates !== ACCOUNTING_QUEUE_STATES
        || value.payload.order !== ACCOUNTING_QUEUE_ORDER
        || value.payload.limit !== limit
        || typeof value.signature !== 'string'
        || value.signature.length !== 64
      ) throw new Error('invalid');
      const expected = commandDigest('listAccountingExports.cursor', value.payload);
      const suppliedBytes = Buffer.from(value.signature, 'hex');
      const expectedBytes = Buffer.from(expected, 'hex');
      if (
        suppliedBytes.length !== expectedBytes.length
        || !timingSafeEqual(suppliedBytes, expectedBytes)
      ) throw new Error('invalid');
      return {
        createdAt: new Date(value.payload.after.createdAt).toISOString(),
        id: value.payload.after.id,
      };
    } catch {
      this.validation('cursor is malformed.');
    }
  }

  private encodeExportCursor(payload: AccountingExportCursorPayload): string {
    const value: SignedAccountingExportCursor = {
      payload,
      signature: commandDigest('listAccountingExports.cursor', payload),
    };
    return Buffer.from(JSON.stringify(value)).toString('base64url');
  }

  private commandHeaders(key: string, requestId: string): void {
    if (!requestId || requestId.length > 128) this.validation('X-Request-Id is required.');
    if (!key || key.length < 8 || key.length > 128) {
      this.validation('Idempotency-Key must contain 8 through 128 characters.');
    }
  }

  private async map<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof TreasuryProblem) throw error;
      const mapped = {
        RESOURCE_HIDDEN: ['TRS-GEN-004', 404],
        SCOPE_DENIED: ['TRS-GEN-003', 403],
        STATE_CONFLICT: ['TRS-GEN-005', 409],
        STALE_VERSION: ['TRS-GEN-006', 409],
        IDEMPOTENCY_CONFLICT: ['TRS-GEN-007', 409],
        MAPPING_REQUIRED: ['TRS-ACT-001', 422],
        EXPORT_DUPLICATE: ['TRS-ACT-002', 409],
        OUTCOME_UNKNOWN: ['TRS-ACT-004', 409],
        ARTIFACT_INTEGRITY: ['TRS-ACT-004', 409],
        PERIOD_UNAVAILABLE: ['TRS-ACT-006', 409],
      } as const;
      const value = error instanceof Error
        ? mapped[error.message as keyof typeof mapped]
        : undefined;
      if (value) throw new TreasuryProblem(value[0], value[1]);
      const wrapped = error as {
        code?: string;
        constraint?: string;
        cause?: { code?: string; constraint?: string };
      };
      const databaseError = wrapped.code ? wrapped : wrapped.cause ?? wrapped;
      if (databaseError.code === '23505'
        && databaseError.constraint === 'posting_locks_one_accepted_source') {
        throw new TreasuryProblem('TRS-ACT-002', 409);
      }
      if (databaseError.code === '23505') throw new TreasuryProblem('TRS-GEN-005', 409);
      if (databaseError.code === '23503') throw new TreasuryProblem('TRS-GEN-004', 404);
      if (['22003', '22P02', '23514'].includes(databaseError.code ?? '')) {
        throw new TreasuryProblem('TRS-GEN-005', 409);
      }
      throw error;
    }
  }

  private validation(detail: string): never {
    throw new TreasuryProblem('TRS-GEN-001', 422, detail);
  }
}

function requiredMappings(payment: PaymentExportFacts): Array<{ localType: string; localId: string }> {
  const values = payment.lines.flatMap((line) => [
    { localType: 'METHOD_DEFINITION', localId: line.methodId },
    { localType: 'PARTY', localId: line.beneficiaryPartyId },
    ...(line.cashboxId ? [{ localType: 'CASHBOX', localId: line.cashboxId }] : []),
    ...(line.bankAccountId ? [{ localType: 'BANK_ACCOUNT', localId: line.bankAccountId }] : []),
  ]);
  return values.filter((item, index) => values.findIndex((candidate) =>
    candidate.localType === item.localType && candidate.localId === item.localId) === index);
}
