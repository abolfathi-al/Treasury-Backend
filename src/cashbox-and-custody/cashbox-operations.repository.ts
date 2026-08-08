import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import type { DatabaseTransaction } from '../database/database.service';
import {
  bankAccounts,
  cashboxAssignments,
  cashboxCurrencyControls,
  cashboxDayApprovalActions,
  cashboxDayApprovalRequests,
  cashboxDayCounts,
  cashboxDays,
  cashboxes,
  idempotencyRecords,
  pettyCashProfiles,
  receivedCheques,
  userRefs,
} from '../database/schema';
import {
  CashboxDayApprovalCommandKind,
  CashboxDayApprovalRequestView,
  CashboxDayApprovalState,
  CashboxDayCountView,
  CashboxDayView,
  CloseDayCountDto,
  PettyCashFundView,
  ReplenishmentSourceType,
} from './cashbox-operations.dto';

export interface CashboxOperationFacts {
  id: string;
  code: string;
  name: string;
  branchId: string | null;
  treasuryUnitId: string;
  mainCurrency: string;
  cashboxType: string;
  state: string;
  canTransfer: boolean;
  version: number;
  primaryCustodianId: string;
  primaryCustodianLabel: string;
  currencies: Array<{
    currency: string;
    maximumHolding: string | null;
    bookAmount: string;
  }>;
  heldInstruments: Array<{
    id: string;
    instrumentType: 'CHEQUE';
    reference: string;
  }>;
}

export interface ApprovalCandidate {
  id: string;
  requestedByUserId: string;
  commandKind: CashboxDayApprovalCommandKind;
  state: CashboxDayApprovalState;
  createdAt: Date;
  cashbox: CashboxOperationFacts;
  commandBody: Record<string, unknown>;
}

@Injectable()
export class CashboxOperationsRepository {
  async acquireIdempotencyLock(
    transaction: DatabaseTransaction,
    organizationId: string,
    scope: string,
    key: string,
  ): Promise<void> {
    await transaction.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtext(${organizationId}),
        hashtext(${scope + ':' + key})
      )
    `);
  }

  async findIdempotency<T>(
    transaction: DatabaseTransaction,
    organizationId: string,
    scope: string,
    key: string,
  ): Promise<{ requestDigest: string; response?: T } | undefined> {
    const rows = await transaction
      .select({
        requestDigest: idempotencyRecords.requestDigest,
        responseBody: idempotencyRecords.responseBody,
      })
      .from(idempotencyRecords)
      .where(and(
        eq(idempotencyRecords.organizationId, organizationId),
        eq(idempotencyRecords.scope, scope),
        eq(idempotencyRecords.idempotencyKey, key),
      ))
      .limit(1);
    const row = rows[0];
    return row
      ? { requestDigest: row.requestDigest, ...(row.responseBody ? { response: row.responseBody as T } : {}) }
      : undefined;
  }

  async insertIdempotency(
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

  async saveIdempotency(
    transaction: DatabaseTransaction,
    organizationId: string,
    scope: string,
    key: string,
    response: object,
    status: number,
  ): Promise<void> {
    await transaction
      .update(idempotencyRecords)
      .set({ responseStatus: status, responseBody: { ...response } })
      .where(and(
        eq(idempotencyRecords.organizationId, organizationId),
        eq(idempotencyRecords.scope, scope),
        eq(idempotencyRecords.idempotencyKey, key),
      ));
  }

  async cashboxFacts(
    transaction: DatabaseTransaction,
    organizationId: string,
    cashboxId: string,
    lock: 'share' | 'update' = 'share',
  ): Promise<CashboxOperationFacts | undefined> {
    const rows = await transaction
      .select({
        id: cashboxes.id,
        code: cashboxes.code,
        name: cashboxes.name,
        branchId: cashboxes.branchId,
        treasuryUnitId: cashboxes.treasuryUnitId,
        mainCurrency: cashboxes.mainCurrency,
        cashboxType: cashboxes.cashboxType,
        state: cashboxes.state,
        canTransfer: cashboxes.canTransfer,
        version: cashboxes.version,
      })
      .from(cashboxes)
      .where(and(
        eq(cashboxes.organizationId, organizationId),
        eq(cashboxes.id, cashboxId),
      ))
      .for(lock)
      .limit(1);
    const cashbox = rows[0];
    if (!cashbox) return undefined;
    const assignments = await transaction
      .select({
        userId: cashboxAssignments.userId,
        displayName: userRefs.displayName,
      })
      .from(cashboxAssignments)
      .innerJoin(userRefs, and(
        eq(userRefs.organizationId, cashboxAssignments.organizationId),
        eq(userRefs.id, cashboxAssignments.userId),
      ))
      .where(and(
        eq(cashboxAssignments.organizationId, organizationId),
        eq(cashboxAssignments.cashboxId, cashboxId),
        eq(cashboxAssignments.assignmentType, 'PRIMARY'),
        eq(cashboxAssignments.state, 'ACTIVE'),
        sql`${cashboxAssignments.effectiveFrom} <= now()`,
        sql`(${cashboxAssignments.effectiveTo} IS NULL OR ${cashboxAssignments.effectiveTo} > now())`,
      ))
      .for(lock, { of: cashboxAssignments })
      .limit(1);
    const primary = assignments[0];
    if (!primary) return undefined;
    const positions = await transaction.execute<{
      currency: string;
      maximumHolding: string | null;
      bookAmount: string;
    }>(sql`
      SELECT cc.currency,
             cc.maximum_holding::text AS "maximumHolding",
             COALESCE(SUM(CASE
               WHEN mf.direction = 'CREDIT' THEN mf.amount
               WHEN mf.direction = 'DEBIT' THEN -mf.amount
               ELSE 0
             END), 0)::text AS "bookAmount"
      FROM cashbox_currency_controls cc
      LEFT JOIN movement_facts mf
        ON mf.organization_id = cc.organization_id
       AND mf.endpoint_type = 'CASHBOX'
       AND mf.endpoint_id = cc.cashbox_id
       AND mf.currency = cc.currency
       AND mf.state IN ('POSTED', 'REVERSED')
      WHERE cc.organization_id = ${organizationId}
        AND cc.cashbox_id = ${cashboxId}
      GROUP BY cc.currency, cc.maximum_holding
      ORDER BY cc.currency
    `);
    const instruments = await transaction
      .select({
        id: receivedCheques.id,
        reference: receivedCheques.chequeNumber,
      })
      .from(receivedCheques)
      .where(and(
        eq(receivedCheques.organizationId, organizationId),
        eq(receivedCheques.custodianType, 'CASHBOX'),
        eq(receivedCheques.custodianId, cashboxId),
        sql`${receivedCheques.state} IN ('RECEIVED', 'IN_CUSTODY', 'ASSIGNED')`,
      ))
      .orderBy(receivedCheques.id);
    return {
      ...cashbox,
      version: Number(cashbox.version),
      primaryCustodianId: primary.userId,
      primaryCustodianLabel: primary.displayName,
      currencies: positions.rows,
      heldInstruments: instruments.map((instrument) => ({
        ...instrument,
        instrumentType: 'CHEQUE' as const,
      })),
    };
  }

  async replenishmentSource(
    transaction: DatabaseTransaction,
    organizationId: string,
    type: ReplenishmentSourceType,
    id: string,
  ): Promise<{
      id: string;
      label: string;
      state: string;
      currency: string;
      canTransfer: boolean;
      branchId: string | null;
      treasuryUnitId: string | null;
    } | undefined> {
    if (type === ReplenishmentSourceType.CASHBOX) {
      const rows = await transaction
        .select({
          id: cashboxes.id,
          code: cashboxes.code,
          name: cashboxes.name,
          state: cashboxes.state,
          currency: cashboxes.mainCurrency,
          canTransfer: cashboxes.canTransfer,
          branchId: cashboxes.branchId,
          treasuryUnitId: cashboxes.treasuryUnitId,
        })
        .from(cashboxes)
        .innerJoin(cashboxCurrencyControls, and(
          eq(cashboxCurrencyControls.organizationId, cashboxes.organizationId),
          eq(cashboxCurrencyControls.cashboxId, cashboxes.id),
          eq(cashboxCurrencyControls.currency, cashboxes.mainCurrency),
        ))
        .where(and(eq(cashboxes.organizationId, organizationId), eq(cashboxes.id, id)))
        .for('share', { of: cashboxes })
        .limit(1);
      const row = rows[0];
      return row ? { ...row, label: `${row.code} · ${row.name}` } : undefined;
    }
    const rows = await transaction
      .select({
        id: bankAccounts.id,
        legalOwnerName: bankAccounts.legalOwnerName,
        accountNumber: bankAccounts.accountNumber,
        state: bankAccounts.state,
        currency: bankAccounts.currency,
        canTransfer: bankAccounts.canTransfer,
        branchId: bankAccounts.organizationBranchId,
        treasuryUnitId: bankAccounts.treasuryUnitId,
      })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.organizationId, organizationId), eq(bankAccounts.id, id)))
      .for('share')
      .limit(1);
    const row = rows[0];
    return row
      ? { ...row, label: `${row.legalOwnerName} · ${row.accountNumber.slice(-4)}` }
      : undefined;
  }

  async profileExists(
    transaction: DatabaseTransaction,
    organizationId: string,
    cashboxId: string,
  ): Promise<boolean> {
    return (await transaction
      .select({ id: pettyCashProfiles.id })
      .from(pettyCashProfiles)
      .where(and(
        eq(pettyCashProfiles.organizationId, organizationId),
        eq(pettyCashProfiles.cashboxId, cashboxId),
      ))
      .limit(1)).length > 0;
  }

  async insertProfile(
    transaction: DatabaseTransaction,
    values: {
      organizationId: string;
      cashboxId: string;
      ceiling: string;
      expenseCategoryCodes: string[];
      evidenceThreshold?: string;
      settlementDays: number;
      replenishmentSourceType: ReplenishmentSourceType;
      replenishmentSourceId: string;
    },
  ): Promise<string> {
    const rows = await transaction.insert(pettyCashProfiles).values(values).returning({
      id: pettyCashProfiles.id,
    });
    return rows[0]!.id;
  }

  async profileIds(
    transaction: DatabaseTransaction,
    organizationId: string,
    cashboxId?: string,
    state?: string,
  ): Promise<string[]> {
    const filters = [eq(pettyCashProfiles.organizationId, organizationId)];
    if (cashboxId) filters.push(eq(pettyCashProfiles.cashboxId, cashboxId));
    if (state) filters.push(eq(pettyCashProfiles.state, state));
    const rows = await transaction
      .select({ id: pettyCashProfiles.id })
      .from(pettyCashProfiles)
      .innerJoin(cashboxes, and(
        eq(cashboxes.organizationId, pettyCashProfiles.organizationId),
        eq(cashboxes.id, pettyCashProfiles.cashboxId),
      ))
      .where(and(...filters))
      .orderBy(cashboxes.code, pettyCashProfiles.id);
    return rows.map(({ id }) => id);
  }

  async profileView(
    transaction: DatabaseTransaction,
    organizationId: string,
    profileId: string,
  ): Promise<PettyCashFundView | undefined> {
    const rows = await transaction
      .select({
        id: pettyCashProfiles.id,
        organizationId: pettyCashProfiles.organizationId,
        cashboxId: pettyCashProfiles.cashboxId,
        cashboxCode: cashboxes.code,
        cashboxName: cashboxes.name,
        branchId: cashboxes.branchId,
        treasuryUnitId: cashboxes.treasuryUnitId,
        currency: cashboxes.mainCurrency,
        ceiling: pettyCashProfiles.ceiling,
        expenseCategoryCodes: pettyCashProfiles.expenseCategoryCodes,
        evidenceThreshold: pettyCashProfiles.evidenceThreshold,
        settlementDays: pettyCashProfiles.settlementDays,
        sourceType: pettyCashProfiles.replenishmentSourceType,
        sourceId: pettyCashProfiles.replenishmentSourceId,
        state: pettyCashProfiles.state,
        version: pettyCashProfiles.version,
        createdAt: pettyCashProfiles.createdAt,
        updatedAt: pettyCashProfiles.updatedAt,
        custodianUserId: cashboxAssignments.userId,
        custodianLabel: userRefs.displayName,
      })
      .from(pettyCashProfiles)
      .innerJoin(cashboxes, and(
        eq(cashboxes.organizationId, pettyCashProfiles.organizationId),
        eq(cashboxes.id, pettyCashProfiles.cashboxId),
      ))
      .innerJoin(cashboxAssignments, and(
        eq(cashboxAssignments.organizationId, pettyCashProfiles.organizationId),
        eq(cashboxAssignments.cashboxId, pettyCashProfiles.cashboxId),
        eq(cashboxAssignments.assignmentType, 'PRIMARY'),
        eq(cashboxAssignments.state, 'ACTIVE'),
        sql`${cashboxAssignments.effectiveFrom} <= now()`,
        sql`(${cashboxAssignments.effectiveTo} IS NULL OR ${cashboxAssignments.effectiveTo} > now())`,
      ))
      .innerJoin(userRefs, and(
        eq(userRefs.organizationId, pettyCashProfiles.organizationId),
        eq(userRefs.id, cashboxAssignments.userId),
      ))
      .where(and(
        eq(pettyCashProfiles.organizationId, organizationId),
        eq(pettyCashProfiles.id, profileId),
      ))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    const sourceType = row.sourceType as ReplenishmentSourceType;
    const source = await this.replenishmentSource(transaction, organizationId, sourceType, row.sourceId);
    if (!source) return undefined;
    return compact({
      id: row.id,
      organizationId: row.organizationId,
      cashboxId: row.cashboxId,
      cashbox: { id: row.cashboxId, label: `${row.cashboxCode} · ${row.cashboxName}` },
      branchId: row.branchId,
      treasuryUnitId: row.treasuryUnitId,
      currency: row.currency,
      custodianUserId: row.custodianUserId,
      custodian: { id: row.custodianUserId, label: row.custodianLabel },
      ceiling: { amount: row.ceiling, currency: row.currency },
      expenseCategoryCodes: row.expenseCategoryCodes,
      evidenceThreshold: row.evidenceThreshold === null
        ? undefined
        : { amount: row.evidenceThreshold, currency: row.currency },
      settlementDays: row.settlementDays,
      replenishmentSource: {
        type: sourceType,
        id: row.sourceId,
        resource: { id: row.sourceId, label: source.label },
      },
      state: row.state as PettyCashFundView['state'],
      version: Number(row.version),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  }

  async latestDay(
    transaction: DatabaseTransaction,
    organizationId: string,
    cashboxId: string,
    businessDate: string,
    lock: 'share' | 'update' = 'share',
  ) {
    const rows = await transaction
      .select()
      .from(cashboxDays)
      .where(and(
        eq(cashboxDays.organizationId, organizationId),
        eq(cashboxDays.cashboxId, cashboxId),
        eq(cashboxDays.businessDate, businessDate),
      ))
      .orderBy(desc(cashboxDays.closeCycle))
      .for(lock)
      .limit(1);
    return rows[0];
  }

  async insertApprovalRequest(
    transaction: DatabaseTransaction,
    values: {
      organizationId: string;
      cashboxId: string;
      businessDate: string;
      commandKind: CashboxDayApprovalCommandKind;
      commandBody: Record<string, unknown>;
      commandDigest: string;
      sourceDayId?: string;
      sourceDayVersion: number;
      requestedByUserId: string;
    },
  ): Promise<string> {
    const rows = await transaction.insert(cashboxDayApprovalRequests).values(values).returning({
      id: cashboxDayApprovalRequests.id,
    });
    return rows[0]!.id;
  }

  async approvalCandidateIds(
    transaction: DatabaseTransaction,
    organizationId: string,
    filters: {
      requestedByUserId?: string;
      commandKind?: CashboxDayApprovalCommandKind;
      state?: CashboxDayApprovalState;
      cashboxId?: string;
      from?: string;
      to?: string;
      pendingOnly?: boolean;
    },
  ): Promise<string[]> {
    const predicates = [eq(cashboxDayApprovalRequests.organizationId, organizationId)];
    if (filters.requestedByUserId) predicates.push(eq(cashboxDayApprovalRequests.requestedByUserId, filters.requestedByUserId));
    if (filters.commandKind) predicates.push(eq(cashboxDayApprovalRequests.commandKind, filters.commandKind));
    if (filters.state) predicates.push(eq(cashboxDayApprovalRequests.state, filters.state));
    if (filters.cashboxId) predicates.push(eq(cashboxDayApprovalRequests.cashboxId, filters.cashboxId));
    if (filters.from) predicates.push(sql`${cashboxDayApprovalRequests.businessDate} >= ${filters.from}`);
    if (filters.to) predicates.push(sql`${cashboxDayApprovalRequests.businessDate} <= ${filters.to}`);
    if (filters.pendingOnly) predicates.push(eq(cashboxDayApprovalRequests.state, 'PENDING'));
    const rows = await transaction
      .select({ id: cashboxDayApprovalRequests.id })
      .from(cashboxDayApprovalRequests)
      .where(and(...predicates))
      .orderBy(desc(cashboxDayApprovalRequests.createdAt), desc(cashboxDayApprovalRequests.id));
    return rows.map(({ id }) => id);
  }

  async lockApprovalRequest(
    transaction: DatabaseTransaction,
    organizationId: string,
    requestId: string,
  ) {
    const rows = await transaction
      .select()
      .from(cashboxDayApprovalRequests)
      .where(and(
        eq(cashboxDayApprovalRequests.organizationId, organizationId),
        eq(cashboxDayApprovalRequests.id, requestId),
      ))
      .for('update')
      .limit(1);
    return rows[0];
  }

  async approvalView(
    transaction: DatabaseTransaction,
    organizationId: string,
    requestId: string,
  ): Promise<CashboxDayApprovalRequestView | undefined> {
    const rows = await transaction
      .select({
        request: cashboxDayApprovalRequests,
        cashboxCode: cashboxes.code,
        cashboxName: cashboxes.name,
        requesterLabel: userRefs.displayName,
      })
      .from(cashboxDayApprovalRequests)
      .innerJoin(cashboxes, and(
        eq(cashboxes.organizationId, cashboxDayApprovalRequests.organizationId),
        eq(cashboxes.id, cashboxDayApprovalRequests.cashboxId),
      ))
      .innerJoin(userRefs, and(
        eq(userRefs.organizationId, cashboxDayApprovalRequests.organizationId),
        eq(userRefs.id, cashboxDayApprovalRequests.requestedByUserId),
      ))
      .where(and(
        eq(cashboxDayApprovalRequests.organizationId, organizationId),
        eq(cashboxDayApprovalRequests.id, requestId),
      ))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    const actions = await transaction
      .select({
        id: cashboxDayApprovalActions.id,
        actorUserId: cashboxDayApprovalActions.actorUserId,
        actorLabel: userRefs.displayName,
        action: cashboxDayApprovalActions.action,
        reason: cashboxDayApprovalActions.reason,
        actedAt: cashboxDayApprovalActions.actedAt,
      })
      .from(cashboxDayApprovalActions)
      .innerJoin(userRefs, and(
        eq(userRefs.organizationId, cashboxDayApprovalActions.organizationId),
        eq(userRefs.id, cashboxDayApprovalActions.actorUserId),
      ))
      .where(and(
        eq(cashboxDayApprovalActions.organizationId, organizationId),
        eq(cashboxDayApprovalActions.approvalRequestId, requestId),
      ))
      .limit(1);
    const action = actions[0];
    let sourceDay: { id: string; label: string } | undefined;
    if (row.request.sourceDayId) {
      const source = await transaction
        .select({
          id: cashboxDays.id,
          businessNumber: cashboxDays.businessNumber,
          businessDate: cashboxDays.businessDate,
          closeCycle: cashboxDays.closeCycle,
        })
        .from(cashboxDays)
        .where(and(
          eq(cashboxDays.organizationId, organizationId),
          eq(cashboxDays.id, row.request.sourceDayId),
        ))
        .limit(1);
      if (source[0]) sourceDay = {
        id: source[0].id,
        label: source[0].businessNumber ?? `${source[0].businessDate} · cycle ${source[0].closeCycle}`,
      };
    }
    const commandKind = row.request.commandKind as CashboxDayApprovalCommandKind;
    const commandBody = row.request.commandBody as { command?: Record<string, unknown> };
    const command = commandBody.command ?? row.request.commandBody;
    return compact({
      id: row.request.id,
      organizationId: row.request.organizationId,
      cashboxId: row.request.cashboxId,
      cashbox: { id: row.request.cashboxId, label: `${row.cashboxCode} · ${row.cashboxName}` },
      businessDate: row.request.businessDate,
      commandKind,
      commandDigest: row.request.commandDigest,
      sourceDayId: row.request.sourceDayId ?? undefined,
      sourceDay,
      sourceDayVersion: Number(row.request.sourceDayVersion),
      closeCommand: commandKind === CashboxDayApprovalCommandKind.CLOSE
        ? command
        : undefined,
      reopenCommand: commandKind === CashboxDayApprovalCommandKind.REOPEN
        ? command
        : undefined,
      requestedByUserId: row.request.requestedByUserId,
      requestedBy: { id: row.request.requestedByUserId, label: row.requesterLabel },
      state: row.request.state as CashboxDayApprovalState,
      action: action ? compact({
        id: action.id,
        approvalRequestId: row.request.id,
        actorUserId: action.actorUserId,
        actor: { id: action.actorUserId, label: action.actorLabel },
        action: action.action as 'APPROVED' | 'REJECTED',
        reason: action.reason ?? undefined,
        actedAt: action.actedAt.toISOString(),
      }) : undefined,
      version: Number(row.request.version),
      createdAt: row.request.createdAt.toISOString(),
      updatedAt: row.request.updatedAt.toISOString(),
    }) as CashboxDayApprovalRequestView;
  }

  async completeApprovalAction(
    transaction: DatabaseTransaction,
    values: {
      organizationId: string;
      requestId: string;
      expectedVersion: number;
      actorUserId: string;
      action: 'APPROVED' | 'REJECTED';
      reason?: string;
    },
  ): Promise<boolean> {
    await transaction.insert(cashboxDayApprovalActions).values({
      id: randomUUID(),
      organizationId: values.organizationId,
      approvalRequestId: values.requestId,
      actorUserId: values.actorUserId,
      action: values.action,
      reason: values.reason,
    });
    const updated = await transaction
      .update(cashboxDayApprovalRequests)
      .set({
        state: values.action,
        version: sql`${cashboxDayApprovalRequests.version} + 1`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(and(
        eq(cashboxDayApprovalRequests.organizationId, values.organizationId),
        eq(cashboxDayApprovalRequests.id, values.requestId),
        eq(cashboxDayApprovalRequests.state, 'PENDING'),
        eq(cashboxDayApprovalRequests.version, values.expectedVersion),
      ))
      .returning({ id: cashboxDayApprovalRequests.id });
    return updated.length === 1;
  }

  async approvedAction(
    transaction: DatabaseTransaction,
    organizationId: string,
    actionId: string,
  ) {
    const rows = await transaction
      .select({
        actionId: cashboxDayApprovalActions.id,
        action: cashboxDayApprovalActions.action,
        requestId: cashboxDayApprovalRequests.id,
        requestedByUserId: cashboxDayApprovalRequests.requestedByUserId,
        cashboxId: cashboxDayApprovalRequests.cashboxId,
        businessDate: cashboxDayApprovalRequests.businessDate,
        commandKind: cashboxDayApprovalRequests.commandKind,
        commandDigest: cashboxDayApprovalRequests.commandDigest,
        sourceDayId: cashboxDayApprovalRequests.sourceDayId,
        sourceDayVersion: cashboxDayApprovalRequests.sourceDayVersion,
      })
      .from(cashboxDayApprovalActions)
      .innerJoin(cashboxDayApprovalRequests, and(
        eq(cashboxDayApprovalRequests.organizationId, cashboxDayApprovalActions.organizationId),
        eq(cashboxDayApprovalRequests.id, cashboxDayApprovalActions.approvalRequestId),
      ))
      .where(and(
        eq(cashboxDayApprovalActions.organizationId, organizationId),
        eq(cashboxDayApprovalActions.id, actionId),
      ))
      .limit(1);
    return rows[0];
  }

  async reserveBusinessNumber(
    transaction: DatabaseTransaction,
    businessDate: string,
  ): Promise<string> {
    const result = await transaction.execute<{ value: string }>(sql`
      SELECT nextval('cashbox_day_close_business_number_seq')::text AS value
    `);
    return `CBD-${businessDate.slice(0, 4)}-${result.rows[0]!.value.padStart(10, '0')}`;
  }

  async closeDay(
    transaction: DatabaseTransaction,
    values: {
      organizationId: string;
      cashboxId: string;
      businessDate: string;
      actorUserId: string;
      businessNumber: string;
      bookSnapshotDigest: string;
      heldInstrumentSnapshot: CashboxOperationFacts['heldInstruments'];
      observedInstrumentIds: string[];
      approvalActionId?: string;
      latest?: typeof cashboxDays.$inferSelect;
      counts: CashboxDayCountView[];
    },
  ): Promise<string> {
    let id: string;
    if (values.latest) {
      const updated = await transaction
        .update(cashboxDays)
        .set({
          businessNumber: values.businessNumber,
          bookSnapshotDigest: values.bookSnapshotDigest,
          heldInstrumentSnapshot: values.heldInstrumentSnapshot,
          observedInstrumentIds: values.observedInstrumentIds,
          state: 'CLOSED',
          approvalActionId: values.approvalActionId,
          closedByUserId: values.actorUserId,
          closedAt: sql`now()`,
          version: sql`${cashboxDays.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(and(
          eq(cashboxDays.organizationId, values.organizationId),
          eq(cashboxDays.id, values.latest.id),
          eq(cashboxDays.version, values.latest.version),
          sql`${cashboxDays.state} IN ('OPEN', 'REOPENED')`,
        ))
        .returning({ id: cashboxDays.id });
      if (!updated[0]) throw new Error('DAY_ALREADY_CLOSED');
      id = updated[0].id;
    } else {
      const inserted = await transaction.insert(cashboxDays).values({
        organizationId: values.organizationId,
        cashboxId: values.cashboxId,
        businessDate: values.businessDate,
        closeCycle: 1,
        businessNumber: values.businessNumber,
        bookSnapshotDigest: values.bookSnapshotDigest,
        heldInstrumentSnapshot: values.heldInstrumentSnapshot,
        observedInstrumentIds: values.observedInstrumentIds,
        state: 'CLOSED',
        version: 1,
        approvalActionId: values.approvalActionId,
        closedByUserId: values.actorUserId,
        closedAt: sql`now()`,
      }).returning({ id: cashboxDays.id });
      id = inserted[0]!.id;
    }
    if (values.counts.length) {
      await transaction.insert(cashboxDayCounts).values(values.counts.map((count) => ({
        cashboxDayId: id,
        organizationId: values.organizationId,
        currency: count.currency,
        bookAmount: count.bookAmount,
        countedAmount: count.countedAmount,
        varianceAmount: count.varianceAmount,
        varianceReason: count.varianceReason,
      })));
    }
    return id;
  }

  async reopenDay(
    transaction: DatabaseTransaction,
    values: {
      organizationId: string;
      cashboxId: string;
      businessDate: string;
      priorCloseId: string;
      nextCycle: number;
      approvalActionId: string;
      reason: string;
      actorUserId: string;
    },
  ): Promise<string> {
    const rows = await transaction.insert(cashboxDays).values({
      organizationId: values.organizationId,
      cashboxId: values.cashboxId,
      businessDate: values.businessDate,
      closeCycle: values.nextCycle,
      priorCloseId: values.priorCloseId,
      state: 'REOPENED',
      version: 1,
      approvalActionId: values.approvalActionId,
      reopenReason: values.reason,
      reopenedByUserId: values.actorUserId,
      reopenedAt: sql`now()`,
      heldInstrumentSnapshot: [],
      observedInstrumentIds: [],
    }).returning({ id: cashboxDays.id });
    return rows[0]!.id;
  }

  async dayView(
    transaction: DatabaseTransaction,
    organizationId: string,
    dayId: string,
  ): Promise<CashboxDayView | undefined> {
    const rows = await transaction
      .select({
        day: cashboxDays,
        cashboxCode: cashboxes.code,
        cashboxName: cashboxes.name,
      })
      .from(cashboxDays)
      .innerJoin(cashboxes, and(
        eq(cashboxes.organizationId, cashboxDays.organizationId),
        eq(cashboxes.id, cashboxDays.cashboxId),
      ))
      .where(and(eq(cashboxDays.organizationId, organizationId), eq(cashboxDays.id, dayId)))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    const counts = await transaction
      .select({
        currency: cashboxDayCounts.currency,
        bookAmount: cashboxDayCounts.bookAmount,
        countedAmount: cashboxDayCounts.countedAmount,
        varianceAmount: cashboxDayCounts.varianceAmount,
        varianceReason: cashboxDayCounts.varianceReason,
      })
      .from(cashboxDayCounts)
      .where(eq(cashboxDayCounts.cashboxDayId, dayId))
      .orderBy(cashboxDayCounts.currency);
    const actorIds = [row.day.closedByUserId, row.day.reopenedByUserId].filter(
      (value): value is string => value !== null,
    );
    const actors = actorIds.length ? await transaction
      .select({ id: userRefs.id, label: userRefs.displayName })
      .from(userRefs)
      .where(and(eq(userRefs.organizationId, organizationId), inArray(userRefs.id, actorIds)))
      : [];
    const labels = new Map(actors.map((actor) => [actor.id, actor.label]));
    let approvalAction: { id: string; label: string } | undefined;
    if (row.day.approvalActionId) {
      const actions = await transaction
        .select({
          id: cashboxDayApprovalActions.id,
          action: cashboxDayApprovalActions.action,
          actorLabel: userRefs.displayName,
        })
        .from(cashboxDayApprovalActions)
        .innerJoin(userRefs, and(
          eq(userRefs.organizationId, cashboxDayApprovalActions.organizationId),
          eq(userRefs.id, cashboxDayApprovalActions.actorUserId),
        ))
        .where(and(
          eq(cashboxDayApprovalActions.organizationId, organizationId),
          eq(cashboxDayApprovalActions.id, row.day.approvalActionId),
        ))
        .limit(1);
      if (actions[0]) approvalAction = {
        id: actions[0].id,
        label: `${actions[0].action} · ${actions[0].actorLabel}`,
      };
    }
    return compact({
      id: row.day.id,
      organizationId: row.day.organizationId,
      cashboxId: row.day.cashboxId,
      cashbox: { id: row.day.cashboxId, label: `${row.cashboxCode} · ${row.cashboxName}` },
      businessDate: row.day.businessDate,
      closeCycle: row.day.closeCycle,
      businessNumber: row.day.businessNumber ?? undefined,
      state: row.day.state as 'CLOSED' | 'REOPENED',
      counts: counts.map((count) => compact({
        ...count,
        varianceReason: count.varianceReason ?? undefined,
      })),
      heldInstrumentSnapshot: row.day.heldInstrumentSnapshot,
      observedInstrumentIds: row.day.observedInstrumentIds,
      approvalActionId: row.day.approvalActionId ?? undefined,
      approvalAction,
      priorCloseId: row.day.priorCloseId ?? undefined,
      reopenReason: row.day.reopenReason ?? undefined,
      closedByUserId: row.day.closedByUserId ?? undefined,
      closedBy: row.day.closedByUserId
        ? { id: row.day.closedByUserId, label: labels.get(row.day.closedByUserId)! }
        : undefined,
      closedAt: row.day.closedAt?.toISOString(),
      reopenedByUserId: row.day.reopenedByUserId ?? undefined,
      reopenedBy: row.day.reopenedByUserId
        ? { id: row.day.reopenedByUserId, label: labels.get(row.day.reopenedByUserId)! }
        : undefined,
      reopenedAt: row.day.reopenedAt?.toISOString(),
      version: Number(row.day.version),
      createdAt: row.day.createdAt.toISOString(),
      updatedAt: row.day.updatedAt.toISOString(),
    }) as CashboxDayView;
  }
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined && child !== null),
  ) as T;
}
