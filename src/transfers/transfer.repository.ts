import { Injectable } from '@nestjs/common';
import { and, desc, eq, gt, inArray, InferSelectModel, isNull, lte, or, sql } from 'drizzle-orm';

import type { DatabaseTransaction } from '../database/database.service';
import {
  attachments,
  bankAccounts,
  cashboxAssignments,
  cashboxCurrencyControls,
  cashboxDays,
  cashboxes,
  currencies,
  exchangeRates,
  idempotencyRecords,
  movementFacts,
  organizations,
  paymentReservations,
  receivedCheques,
  roles,
  transferApprovalActions,
  transferApprovalSnapshots,
  transferApprovalSnapshotSteps,
  transferAssetItems,
  transferAttachmentLinks,
  transferDocuments,
  transferTransitObligations,
  userRefs,
} from '../database/schema';
import {
  TransferApprovalActionView,
  TransferAttachmentDto,
  TransferApprovalSnapshotView,
  TransferApprovalStepView,
  TransferAssetType,
  TransferCreateDto,
  TransferEndpointType,
  TransferEndpointView,
  TransferEvidenceRef,
  TransferRateSnapshot,
  TransferRoute,
  TransferSemanticRef,
  TransferView,
} from './transfer.dto';

type TransferRow = InferSelectModel<typeof transferDocuments>;

export interface TransferEndpointFact {
  id: string;
  type: TransferEndpointType;
  label: string;
  state: string;
  branchId: string | null;
  treasuryUnitId: string | null;
  canTransfer: boolean;
  currencies: string[];
}

export interface TransferFacts {
  organization?: TransferSemanticRef;
  creator?: TransferSemanticRef & { state: string };
  source?: TransferEndpointFact;
  destination?: TransferEndpointFact;
  currencies: Array<{ code: string; label: string; decimalPlaces: number; state: string }>;
  rates: Array<{ id: string; label: string; rate: string; rateType: string; validAt: Date }>;
  attachments: Array<{ id: string; label: string; contentDigest: string; state: string }>;
  assets: Array<{ id: string; type: TransferAssetType; label: string; state: string }>;
}

export interface TransferPolicyStep {
  id: string;
  order: number;
  roleId: string | null;
  roleName: string | null;
  roleState: string | null;
  approverUserId: string | null;
  approverName: string | null;
  approverState: string | null;
  approvalsRequired: number;
  separationRules: string[];
}

export interface TransferPolicy {
  id: string;
  code: string;
  name: string;
  branchId: string | null;
  treasuryUnitId: string | null;
  currency: string | null;
  amountMinimum: string | null;
  amountMaximum: string | null;
  version: number;
  steps: TransferPolicyStep[];
}

export interface CurrentTransferStep {
  [key: string]: unknown;
  id: string;
  order: number;
  roleId: string | null;
  approverUserId: string | null;
  approvalsRequired: number;
  approvalsRecorded: number;
  separationRules: string[];
}

export interface TransferSourceAvailability {
  state: string;
  canTransfer: boolean;
  active: boolean;
  transactionCeiling: string | null;
  minimumPosition: string | null;
  position: string;
  reserved: string;
}

@Injectable()
export class TransferRepository {
  async acquireIdempotencyLock(
    transaction: DatabaseTransaction,
    organizationId: string,
    scope: string,
    key: string,
  ): Promise<void> {
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${organizationId}:${scope}:${key}`}, 0))`);
  }

  async findIdempotency<T>(
    transaction: DatabaseTransaction,
    organizationId: string,
    scope: string,
    key: string,
  ): Promise<{ requestDigest: string; response?: T } | undefined> {
    const [row] = await transaction.select({
      requestDigest: idempotencyRecords.requestDigest,
      response: idempotencyRecords.responseBody,
    }).from(idempotencyRecords).where(and(
      eq(idempotencyRecords.organizationId, organizationId),
      eq(idempotencyRecords.scope, scope),
      eq(idempotencyRecords.idempotencyKey, key),
    ));
    return row ? { requestDigest: row.requestDigest, response: row.response as T | undefined } : undefined;
  }

  async startIdempotency(
    transaction: DatabaseTransaction,
    organizationId: string,
    scope: string,
    key: string,
    requestDigest: string,
  ): Promise<void> {
    await transaction.insert(idempotencyRecords).values({ organizationId, scope, idempotencyKey: key, requestDigest });
  }

  async finishIdempotency<T>(
    transaction: DatabaseTransaction,
    organizationId: string,
    scope: string,
    key: string,
    response: T,
  ): Promise<void> {
    await transaction.update(idempotencyRecords).set({ responseStatus: 200, responseBody: response as Record<string, unknown> }).where(and(
      eq(idempotencyRecords.organizationId, organizationId),
      eq(idempotencyRecords.scope, scope),
      eq(idempotencyRecords.idempotencyKey, key),
    ));
  }

  async facts(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    dto: TransferCreateDto,
    commandAt: Date,
  ): Promise<TransferFacts> {
    const [organization] = await transaction.select({ id: organizations.id, label: organizations.legalName })
      .from(organizations).where(eq(organizations.id, organizationId));
    const [creator] = await transaction.select({ id: userRefs.id, label: userRefs.displayName, state: userRefs.state })
      .from(userRefs).where(and(eq(userRefs.organizationId, organizationId), eq(userRefs.id, actorUserId)));
    const requestedCurrencies = [...new Set([dto.sourceMoney.currency, dto.destinationCurrency])];
    const currencyRows = await transaction.select({
      code: currencies.code,
      label: currencies.name,
      decimalPlaces: currencies.decimalPlaces,
      state: currencies.state,
    }).from(currencies).where(and(eq(currencies.organizationId, organizationId), inArray(currencies.code, requestedCurrencies)));
    const rateRows = dto.sourceMoney.currency === dto.destinationCurrency ? [] : await transaction.select({
      id: exchangeRates.id,
      label: exchangeRates.sourceName,
      rate: exchangeRates.rate,
      rateType: exchangeRates.rateType,
      validAt: exchangeRates.validAt,
    }).from(exchangeRates).where(and(
      eq(exchangeRates.sourceCurrency, dto.sourceMoney.currency),
      eq(exchangeRates.targetCurrency, dto.destinationCurrency),
      eq(exchangeRates.rateType, 'TABLE'),
      eq(exchangeRates.state, 'APPROVED'),
      lte(exchangeRates.validAt, commandAt),
    )).orderBy(desc(exchangeRates.validAt));
    const attachmentIds = dto.attachments?.map(({ id }) => id) ?? [];
    const attachmentRows = attachmentIds.length ? await transaction.select({
      id: attachments.id,
      label: attachments.fileName,
      contentDigest: attachments.contentDigest,
      state: attachments.state,
    }).from(attachments).where(and(
      eq(attachments.organizationId, organizationId),
      inArray(attachments.id, attachmentIds),
    )) : [];
    return {
      organization,
      creator,
      source: await this.endpoint(transaction, organizationId, dto.source.type, dto.source.id),
      destination: await this.endpoint(transaction, organizationId, dto.destination.type, dto.destination.id),
      currencies: currencyRows,
      rates: rateRows,
      attachments: attachmentRows,
      assets: await this.assetFacts(transaction, organizationId, dto),
    };
  }

  async insert(
    transaction: DatabaseTransaction,
    input: {
      id: string;
      organizationId: string;
      businessNumber: string;
      actorUserId: string;
      dto: TransferCreateDto;
      destinationAmount: string;
      rate: TransferRateSnapshot;
      assets: TransferFacts['assets'];
    },
  ): Promise<TransferView> {
    await transaction.insert(transferDocuments).values({
      id: input.id,
      organizationId: input.organizationId,
      businessNumber: input.businessNumber,
      businessDate: input.dto.businessDate,
      route: input.dto.route,
      sourceType: input.dto.source.type,
      sourceId: input.dto.source.id,
      destinationType: input.dto.destination.type,
      destinationId: input.dto.destination.id,
      sourceAmount: input.dto.sourceMoney.amount,
      sourceCurrency: input.dto.sourceMoney.currency,
      destinationAmount: input.destinationAmount,
      destinationCurrency: input.dto.destinationCurrency,
      exchangeRate: input.rate.rate,
      rateType: input.rate.rateType,
      rateSource: input.rate.rateSource,
      rateRecordId: input.rate.rateRecordId,
      ratedAt: new Date(input.rate.ratedAt),
      roundingDifference: input.rate.roundingDifference,
      expectedReceiptAt: input.dto.expectedReceiptAt ? new Date(input.dto.expectedReceiptAt) : undefined,
      purpose: input.dto.purpose.trim(),
      accountingDimensions: input.dto.accountingDimensions,
      creatorUserId: input.actorUserId,
    });
    if (input.dto.assets?.length) await transaction.insert(transferAssetItems).values(input.dto.assets.map((asset) => ({
      organizationId: input.organizationId,
      transferDocumentId: input.id,
      assetType: asset.type,
      assetId: asset.id,
      assetLabel: input.assets.find((fact) => fact.id === asset.id && fact.type === asset.type)!.label,
      quantity: asset.quantity ?? '1',
    })));
    if (input.dto.attachments?.length) await transaction.insert(transferAttachmentLinks).values(input.dto.attachments.map((attachment) => ({
      organizationId: input.organizationId,
      transferDocumentId: input.id,
      attachmentId: attachment.id,
      contentDigest: attachment.contentDigest,
      purpose: attachment.purpose,
    })));
    return (await this.views(transaction, input.organizationId, [input.id]))[0]!;
  }

  async nextNumber(transaction: DatabaseTransaction, organizationId: string): Promise<string> {
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${organizationId}:transfer-number`}, 0))`);
    const result = await transaction.execute<{ value: number }>(sql`
      SELECT COALESCE(MAX(NULLIF(regexp_replace(business_number, '^TRF-', ''), '')::bigint), 0) + 1 AS value
      FROM transfer_documents WHERE organization_id = ${organizationId}
    `);
    return `TRF-${String(result.rows[0]!.value).padStart(8, '0')}`;
  }

  async visibleIds(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    limit: number,
    cursor?: { businessDate: string; id: string },
  ): Promise<string[]> {
    const result = await transaction.execute<{ id: string }>(sql`
      WITH scoped_transfers AS (
        SELECT td.*,
          array_remove(ARRAY[
            CASE td.source_type
              WHEN 'CASHBOX' THEN (SELECT c.branch_id FROM cashboxes c WHERE c.organization_id = td.organization_id AND c.id = td.source_id)
              WHEN 'BANK_ACCOUNT' THEN (SELECT ba.organization_branch_id FROM bank_accounts ba WHERE ba.organization_id = td.organization_id AND ba.id = td.source_id)
            END,
            CASE td.destination_type
              WHEN 'CASHBOX' THEN (SELECT c.branch_id FROM cashboxes c WHERE c.organization_id = td.organization_id AND c.id = td.destination_id)
              WHEN 'BANK_ACCOUNT' THEN (SELECT ba.organization_branch_id FROM bank_accounts ba WHERE ba.organization_id = td.organization_id AND ba.id = td.destination_id)
            END
          ], NULL) AS endpoint_branch_ids,
          array_remove(ARRAY[
            CASE td.source_type
              WHEN 'CASHBOX' THEN (SELECT c.treasury_unit_id FROM cashboxes c WHERE c.organization_id = td.organization_id AND c.id = td.source_id)
              WHEN 'BANK_ACCOUNT' THEN (SELECT ba.treasury_unit_id FROM bank_accounts ba WHERE ba.organization_id = td.organization_id AND ba.id = td.source_id)
            END,
            CASE td.destination_type
              WHEN 'CASHBOX' THEN (SELECT c.treasury_unit_id FROM cashboxes c WHERE c.organization_id = td.organization_id AND c.id = td.destination_id)
              WHEN 'BANK_ACCOUNT' THEN (SELECT ba.treasury_unit_id FROM bank_accounts ba WHERE ba.organization_id = td.organization_id AND ba.id = td.destination_id)
            END
          ], NULL) AS endpoint_treasury_unit_ids
        FROM transfer_documents td
        WHERE td.organization_id = ${organizationId}
      )
      SELECT td.id
      FROM scoped_transfers td
      WHERE true
        AND (${cursor?.businessDate ?? null}::date IS NULL OR (td.business_date, td.id) < (${cursor?.businessDate ?? null}::date, ${cursor?.id ?? null}::uuid))
        AND EXISTS (
          SELECT 1 FROM access_grants ag
          JOIN roles r ON r.id = ag.role_id AND r.state = 'ACTIVE'
          JOIN role_permissions rp ON rp.role_id = r.id AND rp.permission = 'transfer.view'
          WHERE ag.organization_id = td.organization_id
            AND (
              ag.user_ref_id = ${actorUserId}
              OR EXISTS (
                SELECT 1 FROM delegations d
                WHERE d.organization_id = ag.organization_id
                  AND d.access_grant_id = ag.id
                  AND delegation_is_current(d.id, ag.id, ${actorUserId})
                  AND (
                    d.branch_id IS NULL
                    OR (
                      cardinality(td.endpoint_branch_ids) > 0
                      AND NOT EXISTS (
                        SELECT 1 FROM unnest(td.endpoint_branch_ids) endpoint(id)
                        WHERE endpoint.id <> d.branch_id
                      )
                    )
                  )
                  AND (
                    d.treasury_unit_id IS NULL
                    OR (
                      cardinality(td.endpoint_treasury_unit_ids) > 0
                      AND NOT EXISTS (
                        SELECT 1 FROM unnest(td.endpoint_treasury_unit_ids) endpoint(id)
                        WHERE endpoint.id <> d.treasury_unit_id
                      )
                    )
                  )
                  AND (d.document_type IS NULL OR d.document_type = 'TRANSFER')
                  AND d.method_category IS NULL
                  AND (
                    d.currency IS NULL
                    OR (d.currency = td.source_currency AND d.currency = td.destination_currency)
                  )
                  AND (
                    d.amount_ceiling IS NULL
                    OR (
                      d.amount_ceiling_currency = td.source_currency
                      AND td.source_amount <= d.amount_ceiling
                    )
                  )
              )
            )
            AND ag.state = 'ACTIVE' AND ag.valid_from <= now() AND (ag.valid_to IS NULL OR ag.valid_to > now())
            AND (ag.amount_ceiling IS NULL OR (ag.amount_ceiling_currency = td.source_currency AND ag.amount_ceiling >= td.source_amount))
            AND (
              NOT EXISTS (SELECT 1 FROM access_grant_branch_scopes s WHERE s.access_grant_id = ag.id)
              OR (
                cardinality(td.endpoint_branch_ids) > 0
                AND NOT EXISTS (
                  SELECT 1 FROM unnest(td.endpoint_branch_ids) endpoint(id)
                  WHERE NOT EXISTS (
                    SELECT 1 FROM access_grant_branch_scopes s
                    WHERE s.access_grant_id = ag.id AND s.branch_id = endpoint.id
                  )
                )
              )
            )
            AND (
              NOT EXISTS (SELECT 1 FROM access_grant_treasury_unit_scopes s WHERE s.access_grant_id = ag.id)
              OR (
                cardinality(td.endpoint_treasury_unit_ids) > 0
                AND NOT EXISTS (
                  SELECT 1 FROM unnest(td.endpoint_treasury_unit_ids) endpoint(id)
                  WHERE NOT EXISTS (
                    SELECT 1 FROM access_grant_treasury_unit_scopes s
                    WHERE s.access_grant_id = ag.id AND s.treasury_unit_id = endpoint.id
                  )
                )
              )
            )
            AND (NOT EXISTS (SELECT 1 FROM access_grant_document_type_scopes s WHERE s.access_grant_id = ag.id)
              OR EXISTS (SELECT 1 FROM access_grant_document_type_scopes s WHERE s.access_grant_id = ag.id AND s.document_type = 'TRANSFER'))
            AND (NOT EXISTS (SELECT 1 FROM access_grant_currency_scopes s WHERE s.access_grant_id = ag.id)
              OR NOT EXISTS (SELECT 1 FROM (VALUES (td.source_currency), (td.destination_currency)) v(currency)
                WHERE NOT EXISTS (SELECT 1 FROM access_grant_currency_scopes s WHERE s.access_grant_id = ag.id AND s.currency = v.currency)))
            AND (NOT EXISTS (SELECT 1 FROM access_grant_cashbox_scopes s WHERE s.access_grant_id = ag.id)
              OR (EXISTS (SELECT 1 FROM (VALUES (td.source_type), (td.destination_type)) v(kind) WHERE v.kind = 'CASHBOX')
                AND NOT EXISTS (SELECT 1 FROM (VALUES (td.source_type, td.source_id), (td.destination_type, td.destination_id)) v(kind, id)
                  WHERE v.kind = 'CASHBOX' AND NOT EXISTS (SELECT 1 FROM access_grant_cashbox_scopes s WHERE s.access_grant_id = ag.id AND s.cashbox_id = v.id))))
            AND (NOT EXISTS (SELECT 1 FROM access_grant_bank_account_scopes s WHERE s.access_grant_id = ag.id)
              OR (EXISTS (SELECT 1 FROM (VALUES (td.source_type), (td.destination_type)) v(kind) WHERE v.kind = 'BANK_ACCOUNT')
                AND NOT EXISTS (SELECT 1 FROM (VALUES (td.source_type, td.source_id), (td.destination_type, td.destination_id)) v(kind, id)
                  WHERE v.kind = 'BANK_ACCOUNT' AND NOT EXISTS (SELECT 1 FROM access_grant_bank_account_scopes s WHERE s.access_grant_id = ag.id AND s.bank_account_id = v.id))))
        )
      ORDER BY td.business_date DESC, td.id DESC LIMIT ${limit}
    `);
    return result.rows.map(({ id }) => id);
  }

  async views(transaction: DatabaseTransaction, organizationId: string, ids: string[]): Promise<TransferView[]> {
    if (!ids.length) return [];
    const rows = await transaction.select().from(transferDocuments).where(and(
      eq(transferDocuments.organizationId, organizationId),
      inArray(transferDocuments.id, ids),
    )).orderBy(desc(transferDocuments.businessDate), desc(transferDocuments.id));
    const snapshots = await this.snapshotViews(transaction, organizationId, ids);
    const views: TransferView[] = [];
    for (const row of rows) views.push(await this.mapView(transaction, row, snapshots.get(row.id)));
    return views;
  }

  async lock(transaction: DatabaseTransaction, organizationId: string, id: string): Promise<TransferRow | undefined> {
    const [row] = await transaction.select().from(transferDocuments).where(and(
      eq(transferDocuments.organizationId, organizationId),
      eq(transferDocuments.id, id),
    )).for('update');
    return row;
  }

  async sourceAvailability(
    transaction: DatabaseTransaction,
    view: TransferView,
  ): Promise<TransferSourceAvailability | undefined> {
    let state = 'ACTIVE';
    let canTransfer = true;
    let active = true;
    let transactionCeiling: string | null = null;
    let minimumPosition: string | null = '0';
    if (view.source.type === TransferEndpointType.CASHBOX) {
      const [source] = await transaction.select({
        state: cashboxes.state,
        canTransfer: cashboxes.canTransfer,
        activeFrom: cashboxes.activeFrom,
        activeTo: cashboxes.activeTo,
        transactionCeiling: cashboxCurrencyControls.transactionCeiling,
        minimumPosition: cashboxCurrencyControls.minimumPosition,
        allowNegative: cashboxCurrencyControls.allowNegative,
      }).from(cashboxes).innerJoin(cashboxCurrencyControls, and(
        eq(cashboxCurrencyControls.organizationId, cashboxes.organizationId),
        eq(cashboxCurrencyControls.cashboxId, cashboxes.id),
        eq(cashboxCurrencyControls.currency, view.sourceMoney.currency),
      )).where(and(
        eq(cashboxes.organizationId, view.organizationId),
        eq(cashboxes.id, view.source.id),
      )).for('update', { of: cashboxes });
      if (!source) return undefined;
      const at = new Date(`${view.businessDate}T00:00:00.000Z`);
      const [day] = await transaction.select({ state: cashboxDays.state }).from(cashboxDays).where(and(
        eq(cashboxDays.organizationId, view.organizationId),
        eq(cashboxDays.cashboxId, view.source.id),
        eq(cashboxDays.businessDate, view.businessDate),
      )).orderBy(desc(cashboxDays.closeCycle)).limit(1).for('update');
      state = source.state;
      canTransfer = source.canTransfer;
      active = source.activeFrom <= at
        && (source.activeTo === null || source.activeTo > at)
        && (!day || day.state === 'OPEN');
      transactionCeiling = source.transactionCeiling;
      minimumPosition = source.minimumPosition ?? (source.allowNegative ? null : '0');
    } else if (view.source.type === TransferEndpointType.BANK_ACCOUNT) {
      const [source] = await transaction.select({
        state: bankAccounts.state,
        canTransfer: bankAccounts.canTransfer,
        openingDate: bankAccounts.openingDate,
        closingDate: bankAccounts.closingDate,
        transactionCeiling: bankAccounts.withdrawalCeiling,
      }).from(bankAccounts).where(and(
        eq(bankAccounts.organizationId, view.organizationId),
        eq(bankAccounts.id, view.source.id),
        eq(bankAccounts.currency, view.sourceMoney.currency),
      )).for('update');
      if (!source) return undefined;
      state = source.state;
      canTransfer = source.canTransfer;
      active = source.openingDate <= view.businessDate && (source.closingDate === null || source.closingDate >= view.businessDate);
      transactionCeiling = source.transactionCeiling;
    } else {
      const [source] = await transaction.select({ state: userRefs.state }).from(userRefs).where(and(
        eq(userRefs.organizationId, view.organizationId), eq(userRefs.id, view.source.id),
      )).for('update');
      if (!source) return undefined;
      state = source.state;
    }
    const [position] = await transaction.select({
      balance: sql<string>`COALESCE(SUM(CASE WHEN ${movementFacts.direction} = 'CREDIT' THEN ${movementFacts.amount} ELSE -${movementFacts.amount} END), 0)::text`,
    }).from(movementFacts).where(and(
      eq(movementFacts.organizationId, view.organizationId),
      eq(movementFacts.endpointType, view.source.type),
      eq(movementFacts.endpointId, view.source.id),
      eq(movementFacts.currency, view.sourceMoney.currency),
    ));
    const [reservations] = await transaction.select({
      amount: sql<string>`COALESCE(SUM(${paymentReservations.amount}), 0)::text`,
    }).from(paymentReservations).where(and(
      eq(paymentReservations.organizationId, view.organizationId),
      eq(paymentReservations.sourceType, view.source.type),
      eq(paymentReservations.sourceId, view.source.id),
      eq(paymentReservations.currency, view.sourceMoney.currency),
      inArray(paymentReservations.state, ['ACTIVE', 'REVIEW_REQUIRED']),
    ));
    return {
      state,
      canTransfer,
      active,
      transactionCeiling,
      minimumPosition,
      position: position?.balance ?? '0',
      reserved: reservations?.amount ?? '0',
    };
  }

  async evidence(
    transaction: DatabaseTransaction,
    organizationId: string,
    inputs: TransferAttachmentDto[],
  ): Promise<Array<{ id: string; contentDigest: string; state: string }>> {
    if (!inputs.length) return [];
    return transaction.select({ id: attachments.id, contentDigest: attachments.contentDigest, state: attachments.state })
      .from(attachments).where(and(eq(attachments.organizationId, organizationId), inArray(attachments.id, inputs.map(({ id }) => id))));
  }

  async recordRelease(
    transaction: DatabaseTransaction,
    input: { organizationId: string; transferId: string; actorUserId: string; releasedAt: Date; sourceMovementFactId: string; view: TransferView },
  ): Promise<void> {
    await transaction.insert(transferTransitObligations).values({
      organizationId: input.organizationId,
      transferDocumentId: input.transferId,
      sourceAmount: input.view.sourceMoney.amount,
      sourceCurrency: input.view.sourceMoney.currency,
      destinationAmount: input.view.destinationMoney.amount,
      destinationCurrency: input.view.destinationMoney.currency,
      sourceMovementFactId: input.sourceMovementFactId,
      state: 'OPEN',
      createdAt: input.releasedAt,
      updatedAt: input.releasedAt,
    });
    await transaction.update(transferAssetItems).set({ state: 'RELEASED' }).where(and(
      eq(transferAssetItems.organizationId, input.organizationId),
      eq(transferAssetItems.transferDocumentId, input.transferId),
      eq(transferAssetItems.state, 'PLANNED'),
    ));
    await transaction.update(transferDocuments).set({
      state: 'IN_TRANSIT',
      releasedByUserId: input.actorUserId,
      releasedAt: input.releasedAt,
      version: sql`${transferDocuments.version} + 1`,
      updatedAt: input.releasedAt,
    }).where(and(eq(transferDocuments.organizationId, input.organizationId), eq(transferDocuments.id, input.transferId)));
  }

  async recordAcknowledgement(
    transaction: DatabaseTransaction,
    input: {
      organizationId: string; transferId: string; actorUserId: string; recordedAt: Date; receivedAt: Date;
      receivedAmount: string; receivedCurrency: string; receivedAssetIds: string[]; discrepancyAmount: string;
      discrepancyReason?: string; attachments: TransferAttachmentDto[]; destinationMovementFactId?: string;
    },
  ): Promise<void> {
    if (input.receivedAssetIds.length) await transaction.update(transferAssetItems).set({ state: 'RECEIVED' }).where(and(
      eq(transferAssetItems.organizationId, input.organizationId),
      eq(transferAssetItems.transferDocumentId, input.transferId),
      inArray(transferAssetItems.assetId, input.receivedAssetIds),
      eq(transferAssetItems.state, 'RELEASED'),
    ));
    if (input.attachments.length) await transaction.insert(transferAttachmentLinks).values(input.attachments.map((attachment) => ({
      organizationId: input.organizationId,
      transferDocumentId: input.transferId,
      attachmentId: attachment.id,
      contentDigest: attachment.contentDigest,
      purpose: attachment.purpose,
    }))).onConflictDoNothing();
    const completed = !!input.destinationMovementFactId;
    await transaction.update(transferTransitObligations).set({
      state: completed ? 'CLOSED' : 'DISCREPANCY',
      destinationMovementFactId: input.destinationMovementFactId,
      receivedAmount: input.receivedAmount,
      receivedCurrency: input.receivedCurrency,
      updatedAt: input.recordedAt,
    }).where(and(
      eq(transferTransitObligations.organizationId, input.organizationId),
      eq(transferTransitObligations.transferDocumentId, input.transferId),
      eq(transferTransitObligations.state, 'OPEN'),
    ));
    await transaction.update(transferDocuments).set({
      state: completed ? 'COMPLETED' : 'DISCREPANCY',
      receivedByUserId: input.actorUserId,
      receivedAt: input.receivedAt,
      receiptRecordedAt: input.recordedAt,
      discrepancyAmount: input.discrepancyAmount,
      discrepancyReason: input.discrepancyReason,
      version: sql`${transferDocuments.version} + 1`,
      updatedAt: input.recordedAt,
    }).where(and(eq(transferDocuments.organizationId, input.organizationId), eq(transferDocuments.id, input.transferId)));
  }

  async policies(
    transaction: DatabaseTransaction,
    organizationId: string,
    branchId: string | null,
    treasuryUnitId: string | null,
    currency: string,
    amount: string,
  ): Promise<TransferPolicy[]> {
    const result = await transaction.execute<{
      id: string; code: string; name: string; branchId: string | null; treasuryUnitId: string | null; currency: string | null; amountMinimum: string | null;
      amountMaximum: string | null; version: number; stepId: string | null; stepOrder: number | null;
      roleId: string | null; roleName: string | null; roleState: string | null; approverUserId: string | null;
      approverName: string | null; approverState: string | null; approvalsRequired: number | null; separationRules: string[] | null;
    }>(sql`
      SELECT p.id, p.code, p.name, p.branch_id AS "branchId", p.treasury_unit_id AS "treasuryUnitId", p.currency, p.minimum_base_amount AS "amountMinimum", p.maximum_base_amount AS "amountMaximum", p.policy_version AS version,
        s.id AS "stepId", s.step_order AS "stepOrder", s.required_role_id AS "roleId", r.name AS "roleName", r.state AS "roleState",
        s.named_approver_id AS "approverUserId", u.display_name AS "approverName", u.state AS "approverState",
        s.approvals_required AS "approvalsRequired", s.separation_rules AS "separationRules"
      FROM approval_policies p
      LEFT JOIN approval_steps s ON s.organization_id = p.organization_id AND s.approval_policy_id = p.id
      LEFT JOIN roles r ON r.organization_id = s.organization_id AND r.id = s.required_role_id
      LEFT JOIN user_refs u ON u.organization_id = s.organization_id AND u.id = s.named_approver_id
      WHERE p.organization_id = ${organizationId} AND p.document_type = 'TRANSFER' AND p.state = 'ACTIVE'
        AND (p.branch_id IS NULL OR p.branch_id = ${branchId})
        AND (p.treasury_unit_id IS NULL OR p.treasury_unit_id = ${treasuryUnitId})
        AND (p.currency IS NULL OR p.currency = ${currency})
        AND (p.minimum_base_amount IS NULL OR p.minimum_base_amount <= ${amount})
        AND (p.maximum_base_amount IS NULL OR p.maximum_base_amount >= ${amount})
      ORDER BY p.id, s.step_order
    `);
    const policies = new Map<string, TransferPolicy>();
    for (const row of result.rows) {
      const policy = policies.get(row.id) ?? { id: row.id, code: row.code, name: row.name, branchId: row.branchId, treasuryUnitId: row.treasuryUnitId, currency: row.currency, amountMinimum: row.amountMinimum, amountMaximum: row.amountMaximum, version: row.version, steps: [] };
      if (row.stepId) policy.steps.push({ id: row.stepId, order: row.stepOrder!, roleId: row.roleId, roleName: row.roleName, roleState: row.roleState, approverUserId: row.approverUserId, approverName: row.approverName, approverState: row.approverState, approvalsRequired: row.approvalsRequired!, separationRules: row.separationRules ?? [] });
      policies.set(row.id, policy);
    }
    return [...policies.values()];
  }

  async insertSnapshot(
    transaction: DatabaseTransaction,
    input: { id: string; organizationId: string; transferId: string; documentVersion: number; amount: string; currency: string; policy: TransferPolicy; evaluatedAt: Date },
  ): Promise<void> {
    await transaction.insert(transferApprovalSnapshots).values({
      id: input.id, organizationId: input.organizationId, transferDocumentId: input.transferId,
      documentVersion: input.documentVersion, amountBasis: input.amount, currency: input.currency,
      evaluatedAt: input.evaluatedAt, policyId: input.policy.id, policyCode: input.policy.code,
      policyName: input.policy.name, policyVersion: input.policy.version,
    });
    if (input.policy.steps.length) await transaction.insert(transferApprovalSnapshotSteps).values(input.policy.steps.map((step) => ({
      organizationId: input.organizationId, approvalSnapshotId: input.id, stepOrder: step.order,
      roleId: step.roleId, roleName: step.roleName, approverUserId: step.approverUserId,
      approverName: step.approverName, approvalsRequired: step.approvalsRequired,
      separationRules: [...new Set(step.separationRules)].sort(),
    })));
  }

  async completeSubmission(
    transaction: DatabaseTransaction,
    organizationId: string,
    id: string,
    snapshotId: string,
    state: 'REQUESTED' | 'APPROVED',
    custodians?: { source: string; destination: string },
  ): Promise<void> {
    await transaction.update(transferDocuments).set({
      currentApprovalSnapshotId: snapshotId,
      state,
      sourceCustodianUserId: custodians?.source,
      destinationCustodianUserId: custodians?.destination,
      version: sql`${transferDocuments.version} + 1`,
      updatedAt: new Date(),
    }).where(and(eq(transferDocuments.organizationId, organizationId), eq(transferDocuments.id, id)));
  }

  async currentSteps(transaction: DatabaseTransaction, organizationId: string, snapshotId: string): Promise<CurrentTransferStep[]> {
    const result = await transaction.execute<CurrentTransferStep>(sql`
      SELECT s.id, s.step_order AS "order", s.role_id AS "roleId", s.approver_user_id AS "approverUserId",
        s.approvals_required AS "approvalsRequired", s.separation_rules AS "separationRules",
        COUNT(a.id) FILTER (WHERE a.action = 'APPROVED')::int AS "approvalsRecorded"
      FROM transfer_approval_snapshot_steps s
      LEFT JOIN transfer_approval_actions a ON a.organization_id = s.organization_id AND a.approval_snapshot_id = s.approval_snapshot_id AND a.approval_snapshot_step_id = s.id
      WHERE s.organization_id = ${organizationId} AND s.approval_snapshot_id = ${snapshotId}
      GROUP BY s.id ORDER BY s.step_order
    `);
    return result.rows;
  }

  async insertAction(
    transaction: DatabaseTransaction,
    organizationId: string,
    snapshotId: string,
    step: CurrentTransferStep,
    actorUserId: string,
    delegatedFromUserId: string | undefined,
    action: 'APPROVED' | 'REJECTED',
    reason?: string,
  ): Promise<void> {
    await transaction.insert(transferApprovalActions).values({
      organizationId, approvalSnapshotId: snapshotId, approvalSnapshotStepId: step.id,
      stepOrder: step.order, actorUserId, delegatedFromUserId, action, reason,
    });
  }

  async completeAction(
    transaction: DatabaseTransaction,
    organizationId: string,
    id: string,
    state: 'REQUESTED' | 'APPROVED' | 'REJECTED',
    custodians?: { source: string; destination: string },
  ): Promise<void> {
    await transaction.update(transferDocuments).set({
      state,
      sourceCustodianUserId: custodians?.source,
      destinationCustodianUserId: custodians?.destination,
      version: sql`${transferDocuments.version} + 1`,
      updatedAt: new Date(),
    }).where(and(eq(transferDocuments.organizationId, organizationId), eq(transferDocuments.id, id)));
  }

  async custodians(
    transaction: DatabaseTransaction,
    organizationId: string,
    source: { type: string; id: string },
    destination: { type: string; id: string },
  ): Promise<{ source: string; destination: string } | undefined> {
    const cashboxIds = [...new Set([source, destination]
      .filter(({ type }) => type === 'CASHBOX')
      .map(({ id }) => id))].sort();
    if (cashboxIds.length) {
      const locked = await transaction.select({ id: cashboxes.id }).from(cashboxes).where(and(
        eq(cashboxes.organizationId, organizationId),
        inArray(cashboxes.id, cashboxIds),
      )).orderBy(cashboxes.id).for('update');
      if (locked.length !== cashboxIds.length) return undefined;
    }
    const sourceUser = await this.custodian(transaction, organizationId, source);
    const destinationUser = await this.custodian(transaction, organizationId, destination);
    return sourceUser && destinationUser && sourceUser !== destinationUser
      ? { source: sourceUser, destination: destinationUser }
      : undefined;
  }

  async custodian(
    transaction: DatabaseTransaction,
    organizationId: string,
    endpoint: { type: string; id: string },
  ): Promise<string | undefined> {
    if (endpoint.type === 'USER') {
      const [user] = await transaction.select({ id: userRefs.id }).from(userRefs).where(and(
        eq(userRefs.organizationId, organizationId), eq(userRefs.id, endpoint.id), eq(userRefs.state, 'ACTIVE'),
      )).for('share');
      return user?.id;
    }
    if (endpoint.type !== 'CASHBOX') return undefined;
    const rows = await transaction.select({ id: cashboxAssignments.userId }).from(cashboxAssignments).where(and(
      eq(cashboxAssignments.organizationId, organizationId), eq(cashboxAssignments.cashboxId, endpoint.id),
      eq(cashboxAssignments.assignmentType, 'PRIMARY'), eq(cashboxAssignments.state, 'ACTIVE'),
      lte(cashboxAssignments.effectiveFrom, new Date()),
      or(isNull(cashboxAssignments.effectiveTo), gt(cashboxAssignments.effectiveTo, new Date())),
    ));
    return rows.length === 1 ? rows[0]!.id : undefined;
  }

  private async endpoint(
    transaction: DatabaseTransaction,
    organizationId: string,
    type: TransferEndpointType,
    id: string,
  ): Promise<TransferEndpointFact | undefined> {
    if (type === TransferEndpointType.CASHBOX) {
      const [row] = await transaction.select({ id: cashboxes.id, label: cashboxes.name, state: cashboxes.state, branchId: cashboxes.branchId, treasuryUnitId: cashboxes.treasuryUnitId, canTransfer: cashboxes.canTransfer })
        .from(cashboxes).where(and(eq(cashboxes.organizationId, organizationId), eq(cashboxes.id, id)));
      if (!row) return undefined;
      const controls = await transaction.select({ currency: cashboxCurrencyControls.currency }).from(cashboxCurrencyControls).where(and(eq(cashboxCurrencyControls.organizationId, organizationId), eq(cashboxCurrencyControls.cashboxId, id)));
      return { ...row, type, currencies: controls.map(({ currency }) => currency) };
    }
    if (type === TransferEndpointType.BANK_ACCOUNT) {
      const [row] = await transaction.select({ id: bankAccounts.id, owner: bankAccounts.legalOwnerName, number: bankAccounts.accountNumber, state: bankAccounts.state, branchId: bankAccounts.organizationBranchId, treasuryUnitId: bankAccounts.treasuryUnitId, canTransfer: bankAccounts.canTransfer, currency: bankAccounts.currency })
        .from(bankAccounts).where(and(eq(bankAccounts.organizationId, organizationId), eq(bankAccounts.id, id)));
      return row ? { id: row.id, type, label: `${row.owner} · ${row.number}`, state: row.state, branchId: row.branchId, treasuryUnitId: row.treasuryUnitId, canTransfer: row.canTransfer, currencies: [row.currency] } : undefined;
    }
    const [row] = await transaction.select({ id: userRefs.id, label: userRefs.displayName, state: userRefs.state }).from(userRefs).where(and(eq(userRefs.organizationId, organizationId), eq(userRefs.id, id)));
    return row ? { ...row, type, branchId: null, treasuryUnitId: null, canTransfer: true, currencies: [] } : undefined;
  }

  private async assetFacts(transaction: DatabaseTransaction, organizationId: string, dto: TransferCreateDto): Promise<TransferFacts['assets']> {
    const facts: TransferFacts['assets'] = [];
    for (const asset of dto.assets ?? []) {
      if (asset.type === TransferAssetType.RECEIVED_CHEQUE) {
        const [row] = await transaction.select({ id: receivedCheques.id, number: receivedCheques.chequeNumber, state: receivedCheques.state }).from(receivedCheques).where(and(eq(receivedCheques.organizationId, organizationId), eq(receivedCheques.id, asset.id)));
        if (row) facts.push({ id: row.id, type: asset.type, label: row.number, state: row.state });
      } else if (asset.type === TransferAssetType.DOCUMENT) {
        const [row] = await transaction.select({ id: attachments.id, label: attachments.fileName, state: attachments.state }).from(attachments).where(and(eq(attachments.organizationId, organizationId), eq(attachments.id, asset.id)));
        if (row) facts.push({ id: row.id, type: asset.type, label: row.label, state: row.state });
      }
    }
    return facts;
  }

  private async mapView(
    transaction: DatabaseTransaction,
    row: TransferRow,
    approvalSnapshot?: TransferApprovalSnapshotView,
  ): Promise<TransferView> {
    const [organization] = await transaction.select({ id: organizations.id, label: organizations.legalName }).from(organizations).where(eq(organizations.id, row.organizationId));
    const [creator] = await transaction.select({ id: userRefs.id, label: userRefs.displayName }).from(userRefs).where(and(eq(userRefs.organizationId, row.organizationId), eq(userRefs.id, row.creatorUserId)));
    const source = await this.endpoint(transaction, row.organizationId, row.sourceType as TransferEndpointType, row.sourceId);
    const destination = await this.endpoint(transaction, row.organizationId, row.destinationType as TransferEndpointType, row.destinationId);
    const assetRows = await transaction.select().from(transferAssetItems).where(and(eq(transferAssetItems.organizationId, row.organizationId), eq(transferAssetItems.transferDocumentId, row.id)));
    const attachmentRows = await transaction.select({ id: transferAttachmentLinks.attachmentId, label: attachments.fileName, digest: transferAttachmentLinks.contentDigest, purpose: transferAttachmentLinks.purpose }).from(transferAttachmentLinks).innerJoin(attachments, and(eq(attachments.organizationId, transferAttachmentLinks.organizationId), eq(attachments.id, transferAttachmentLinks.attachmentId))).where(and(eq(transferAttachmentLinks.organizationId, row.organizationId), eq(transferAttachmentLinks.transferDocumentId, row.id)));
    const [rateRecord] = row.rateRecordId ? await transaction.select({ id: exchangeRates.id, label: exchangeRates.sourceName }).from(exchangeRates).where(eq(exchangeRates.id, row.rateRecordId)) : [];
    const custodians = row.sourceCustodianUserId && row.destinationCustodianUserId ? await transaction.select({ id: userRefs.id, label: userRefs.displayName }).from(userRefs).where(and(eq(userRefs.organizationId, row.organizationId), inArray(userRefs.id, [row.sourceCustodianUserId, row.destinationCustodianUserId]))) : [];
    const [obligation] = await transaction.select().from(transferTransitObligations).where(and(
      eq(transferTransitObligations.organizationId, row.organizationId),
      eq(transferTransitObligations.transferDocumentId, row.id),
    ));
    const semanticEndpoint = (fact: TransferEndpointFact): TransferEndpointView => ({ type: fact.type, id: fact.id, resource: { id: fact.id, label: fact.label } });
    return {
      id: row.id, organizationId: row.organizationId, organization: organization!, businessNumber: row.businessNumber,
      businessDate: row.businessDate, route: row.route as TransferRoute, source: semanticEndpoint(source!), destination: semanticEndpoint(destination!),
      sourceMoney: { amount: row.sourceAmount, currency: row.sourceCurrency },
      destinationMoney: { amount: row.destinationAmount, currency: row.destinationCurrency },
      rateSnapshot: { sourceCurrency: row.sourceCurrency, targetCurrency: row.destinationCurrency, rate: row.exchangeRate, rateType: row.rateType, rateSource: row.rateSource as 'IDENTITY' | 'TABLE', ratedAt: row.ratedAt.toISOString(), ...(row.rateRecordId ? { rateRecordId: row.rateRecordId } : {}), targetAmount: row.destinationAmount, roundingDifference: row.roundingDifference },
      ...(rateRecord ? { rateRecord } : {}),
      ...(row.expectedReceiptAt ? { expectedReceiptAt: row.expectedReceiptAt.toISOString() } : {}),
      purpose: row.purpose, ...(row.accountingDimensions ? { accountingDimensions: row.accountingDimensions } : {}),
      creatorUserId: row.creatorUserId, creator: creator!,
      ...(row.sourceCustodianUserId ? { sourceCustodianUserId: row.sourceCustodianUserId, sourceCustodian: custodians.find(({ id }) => id === row.sourceCustodianUserId)! } : {}),
      ...(row.destinationCustodianUserId ? { destinationCustodianUserId: row.destinationCustodianUserId, destinationCustodian: custodians.find(({ id }) => id === row.destinationCustodianUserId)! } : {}),
      ...(approvalSnapshot ? { approvalSnapshot } : {}),
      assets: assetRows.map((asset) => ({ type: asset.assetType as TransferAssetType, id: asset.assetId, asset: { id: asset.assetId, label: asset.assetLabel }, quantity: asset.quantity, state: asset.state as 'PLANNED' | 'RELEASED' | 'RECEIVED' | 'RETURNED' })),
      attachments: attachmentRows.map(({ id, label, digest, purpose }) => ({ attachmentId: id, attachment: { id, label }, digest, ...(purpose ? { purpose } : {}) } as TransferEvidenceRef)),
      ...(row.releasedByUserId && row.releasedAt ? { release: {
        releasedByUserId: row.releasedByUserId,
        releasedBy: custodians.find(({ id }) => id === row.releasedByUserId)!,
        releasedAt: row.releasedAt.toISOString(),
      } } : {}),
      ...(row.receivedByUserId && row.receivedAt && row.receiptRecordedAt && obligation?.receivedAmount !== null && obligation?.receivedCurrency ? { receipt: {
        receivedByUserId: row.receivedByUserId,
        receivedBy: custodians.find(({ id }) => id === row.receivedByUserId)!,
        receivedMoney: { amount: obligation.receivedAmount, currency: obligation.receivedCurrency },
        receivedAt: row.receivedAt.toISOString(),
        recordedAt: row.receiptRecordedAt.toISOString(),
        receivedAssetIds: assetRows.filter(({ state }) => state === 'RECEIVED').map(({ assetId }) => assetId),
        discrepancyMoney: { amount: row.discrepancyAmount, currency: row.destinationCurrency },
        ...(row.discrepancyReason ? { discrepancyReason: row.discrepancyReason } : {}),
        attachments: attachmentRows.map(({ id, label, digest, purpose }) => ({ attachmentId: id, attachment: { id, label }, digest, ...(purpose ? { purpose } : {}) } as TransferEvidenceRef)),
      } } : {}),
      ...(obligation ? { transitObligation: {
        id: obligation.id,
        state: obligation.state as 'OPEN' | 'DISCREPANCY' | 'CLOSED' | 'RETURNED',
        sourceMoney: { amount: obligation.sourceAmount, currency: obligation.sourceCurrency },
        destinationMoney: { amount: obligation.destinationAmount, currency: obligation.destinationCurrency },
        sourceMovementFactId: obligation.sourceMovementFactId,
        ...(obligation.destinationMovementFactId ? { destinationMovementFactId: obligation.destinationMovementFactId } : {}),
      } } : {}),
      state: row.state as TransferView['state'], version: row.version, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async snapshotViews(transaction: DatabaseTransaction, organizationId: string, transferIds: string[]): Promise<Map<string, TransferApprovalSnapshotView>> {
    const snapshots = await transaction.select().from(transferApprovalSnapshots).where(and(eq(transferApprovalSnapshots.organizationId, organizationId), inArray(transferApprovalSnapshots.transferDocumentId, transferIds)));
    const result = new Map<string, TransferApprovalSnapshotView>();
    for (const snapshot of snapshots) {
      const steps = await transaction.select().from(transferApprovalSnapshotSteps).where(and(eq(transferApprovalSnapshotSteps.organizationId, organizationId), eq(transferApprovalSnapshotSteps.approvalSnapshotId, snapshot.id))).orderBy(transferApprovalSnapshotSteps.stepOrder);
      const actions = await transaction.select().from(transferApprovalActions).where(and(eq(transferApprovalActions.organizationId, organizationId), eq(transferApprovalActions.approvalSnapshotId, snapshot.id))).orderBy(transferApprovalActions.actedAt);
      const userIds = [...new Set(actions.flatMap(({ actorUserId, delegatedFromUserId }) => [actorUserId, ...(delegatedFromUserId ? [delegatedFromUserId] : [])]))];
      const labels = new Map((userIds.length ? await transaction.select({ id: userRefs.id, label: userRefs.displayName }).from(userRefs).where(and(eq(userRefs.organizationId, organizationId), inArray(userRefs.id, userIds))) : []).map(({ id, label }) => [id, label]));
      const approvalActions: TransferApprovalActionView[] = actions.map((action) => ({ id: action.id, approvalSnapshotId: snapshot.id, approvalSnapshotStepId: action.approvalSnapshotStepId, stepOrder: action.stepOrder, actorUserId: action.actorUserId, actor: { id: action.actorUserId, label: labels.get(action.actorUserId)! }, ...(action.delegatedFromUserId ? { delegatedFromUserId: action.delegatedFromUserId, delegatedFrom: { id: action.delegatedFromUserId, label: labels.get(action.delegatedFromUserId)! } } : {}), action: action.action as 'APPROVED' | 'REJECTED', ...(action.reason ? { reason: action.reason } : {}), actedAt: action.actedAt.toISOString() }));
      let blocked = false;
      const stepViews: TransferApprovalStepView[] = steps.map((step) => {
        const recorded = approvalActions.filter(({ stepOrder, action }) => stepOrder === step.stepOrder && action === 'APPROVED').length;
        const rejected = approvalActions.some(({ stepOrder, action }) => stepOrder === step.stepOrder && action === 'REJECTED');
        const complete = recorded >= step.approvalsRequired;
        const state = rejected ? 'REJECTED' : complete ? 'APPROVED' : blocked ? 'WAITING' : 'CURRENT';
        if (!complete) blocked = true;
        return { order: step.stepOrder, ...(step.roleId ? { roleId: step.roleId, role: { id: step.roleId, label: step.roleName! } } : {}), ...(step.approverUserId ? { approverUserId: step.approverUserId, approver: { id: step.approverUserId, label: step.approverName! } } : {}), approvalsRequired: step.approvalsRequired, approvalsRecorded: recorded, separationRules: step.separationRules, sourceContextOrders: [1], state };
      });
      const state = approvalActions.some(({ action }) => action === 'REJECTED') ? 'REJECTED' : stepViews.every(({ state }) => state === 'APPROVED') ? 'APPROVED' : 'PENDING';
      result.set(snapshot.transferDocumentId, { id: snapshot.id, documentVersion: snapshot.documentVersion, amountBasis: { amount: snapshot.amountBasis, currency: snapshot.currency }, evaluatedAt: snapshot.evaluatedAt.toISOString(), policyContexts: [{ order: 1, currency: snapshot.currency, policyId: snapshot.policyId, policy: { id: snapshot.policyId, label: snapshot.policyName }, policyVersion: snapshot.policyVersion }], steps: stepViews, actions: approvalActions, state });
    }
    return result;
  }
}
