import { Inject, Injectable } from '@nestjs/common';
import { and, eq, notInArray, sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';

import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';
import {
  cashboxAssignments,
  cashboxCurrencyControls,
  cashboxHandoverMoney,
  cashboxHandovers,
  cashboxes,
  idempotencyRecords,
} from '../database/schema';
import {
  CashboxCreateDto,
  CashboxHandoverView,
  CashboxView,
} from './cashbox.dto';

export interface CashboxCursor {
  code: string;
  id: string;
}

@Injectable()
export class CashboxRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async list(
    organizationId: string,
    actorUserId: string,
    limit: number,
    cursor?: CashboxCursor,
  ): Promise<{ items: CashboxView[]; hasMore: boolean }> {
    const result = await this.database.pool.query<CashboxView>(`
      ${CASHBOX_VIEW_SELECT}
      WHERE c.organization_id = $1
        AND EXISTS (
          SELECT 1
          FROM access_grants ag
          JOIN roles r ON r.id = ag.role_id AND r.state = 'ACTIVE'
          JOIN role_permissions rp ON rp.role_id = r.id AND rp.permission = 'cashbox.view'
          WHERE ag.organization_id = $1
            AND ag.user_ref_id = $2
            AND ag.state = 'ACTIVE'
            AND ag.valid_from <= now()
            AND (ag.valid_to IS NULL OR ag.valid_to > now())
            AND (
              NOT EXISTS (
                SELECT 1 FROM access_grant_branch_scopes s
                WHERE s.access_grant_id = ag.id
              )
              OR EXISTS (
                SELECT 1 FROM access_grant_branch_scopes s
                WHERE s.access_grant_id = ag.id AND s.branch_id = c.branch_id
              )
            )
            AND (
              NOT EXISTS (
                SELECT 1 FROM access_grant_treasury_unit_scopes s
                WHERE s.access_grant_id = ag.id
              )
              OR EXISTS (
                SELECT 1 FROM access_grant_treasury_unit_scopes s
                WHERE s.access_grant_id = ag.id AND s.treasury_unit_id = c.treasury_unit_id
              )
            )
            AND (
              NOT EXISTS (
                SELECT 1 FROM access_grant_cashbox_scopes s
                WHERE s.access_grant_id = ag.id
              )
              OR EXISTS (
                SELECT 1 FROM access_grant_cashbox_scopes s
                WHERE s.access_grant_id = ag.id AND s.cashbox_id = c.id
              )
            )
            AND (
              NOT EXISTS (
                SELECT 1 FROM access_grant_currency_scopes s
                WHERE s.access_grant_id = ag.id
              )
              OR NOT EXISTS (
                SELECT 1
                FROM cashbox_currency_controls cc
                WHERE cc.cashbox_id = c.id
                  AND NOT EXISTS (
                    SELECT 1 FROM access_grant_currency_scopes s
                    WHERE s.access_grant_id = ag.id AND s.currency = cc.currency
                  )
              )
            )
        )
        AND (
          $3::varchar IS NULL
          OR (c.code, c.id) > ($3::varchar, $4::uuid)
        )
      ORDER BY c.code, c.id
      LIMIT $5
    `, [organizationId, actorUserId, cursor?.code ?? null, cursor?.id ?? null, limit + 1]);
    return {
      items: result.rows.slice(0, limit).map(compact) as CashboxView[],
      hasMore: result.rows.length > limit,
    };
  }

  create(
    organizationId: string,
    actorUserId: string,
    dto: CashboxCreateDto,
    idempotencyKey: string,
    requestDigest: string,
    commandAt: Date,
  ): Promise<CashboxView> {
    return this.idempotent(
      organizationId,
      'createCashbox',
      idempotencyKey,
      requestDigest,
      async (client) => {
        if (!await this.createScopeAllowed(
          client,
          organizationId,
          actorUserId,
          dto,
        )) throw new Error('SCOPE_DENIED');
      },
      async (client) => {
        if (!await this.createScopeAllowed(client, organizationId, actorUserId, dto)) {
          throw new Error('SCOPE_DENIED');
        }

        const unit = await client.query<{ branch_id: string | null; state: string }>(`
          SELECT branch_id, state
          FROM treasury_units
          WHERE organization_id = $1 AND id = $2
          FOR SHARE
        `, [organizationId, dto.treasuryUnitId]);
        if (!unit.rowCount) throw new ReferenceError('RESOURCE_HIDDEN');
        if (unit.rows[0]!.state !== 'ACTIVE') throw new ReferenceError('INACTIVE_REFERENCE');
        if (unit.rows[0]!.branch_id !== (dto.branchId ?? null)) throw new Error('VALIDATION');

        if (dto.branchId) {
          const branch = await client.query<{ state: string }>(`
            SELECT state FROM branches WHERE organization_id = $1 AND id = $2
            FOR SHARE
          `, [organizationId, dto.branchId]);
          if (!branch.rowCount) throw new ReferenceError('RESOURCE_HIDDEN');
          if (branch.rows[0]!.state !== 'ACTIVE') throw new ReferenceError('INACTIVE_REFERENCE');
        }

        const controls = await client.query<{ code: string; decimal_places: number; state: string }>(`
          SELECT code, decimal_places, state
          FROM currencies
          WHERE organization_id = $1 AND code = ANY($2::varchar[])
          FOR SHARE
        `, [organizationId, dto.currencyControls.map(({ currency }) => currency)]);
        if (controls.rowCount !== dto.currencyControls.length) {
          throw new ReferenceError('RESOURCE_HIDDEN');
        }
        if (controls.rows.some(({ state }) => state !== 'ACTIVE')) {
          throw new ReferenceError('INACTIVE_REFERENCE');
        }
        const scales = new Map(controls.rows.map((row) => [row.code, row.decimal_places]));
        for (const control of dto.currencyControls) {
          for (const amount of [
            control.transactionCeiling,
            control.minimumPosition,
            control.maximumHolding,
          ]) {
            if (
              amount !== undefined
              && (amount.split('.')[1]?.length ?? 0) > (scales.get(control.currency) ?? -1)
            ) throw new Error('VALIDATION');
          }
        }

        const custodianIds = [
          dto.primaryCustodianId,
          ...(dto.substituteCustodianId ? [dto.substituteCustodianId] : []),
        ];
        const custodians = await client.query<{ state: string }>(`
          SELECT state
          FROM user_refs
          WHERE organization_id = $1 AND id = ANY($2::uuid[])
          FOR SHARE
        `, [organizationId, custodianIds]);
        if (custodians.rowCount !== custodianIds.length) {
          throw new ReferenceError('RESOURCE_HIDDEN');
        }
        if (custodians.rows.some(({ state }) => state !== 'ACTIVE')) {
          throw new ReferenceError('INACTIVE_REFERENCE');
        }

        const cashbox = await client.query<{ id: string }>(`
          INSERT INTO cashboxes (
            organization_id, branch_id, treasury_unit_id, code, name, cashbox_type,
            main_currency, can_receive, can_pay, can_transfer, requires_approval,
            accounting_dimensions, active_from, active_to
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          RETURNING id
        `, [
          organizationId,
          dto.branchId ?? null,
          dto.treasuryUnitId,
          dto.code,
          dto.name,
          dto.type,
          dto.mainCurrency,
          dto.capabilities.receive,
          dto.capabilities.pay,
          dto.capabilities.transfer,
          dto.requiresApproval,
          dto.accountingDimensions ?? null,
          commandAt,
          dto.activeTo ?? null,
        ]);
        const cashboxId = cashbox.rows[0]!.id;
        for (const control of dto.currencyControls) {
          await client.query(`
            INSERT INTO cashbox_currency_controls (
              cashbox_id, organization_id, currency, transaction_ceiling,
              minimum_position, maximum_holding, allow_negative
            ) VALUES ($1,$2,$3,$4,$5,$6,$7)
          `, [
            cashboxId,
            organizationId,
            control.currency,
            control.transactionCeiling ?? null,
            control.minimumPosition ?? null,
            control.maximumHolding ?? null,
            control.allowNegative ?? false,
          ]);
        }
        await client.query(`
          INSERT INTO cashbox_assignments (
            organization_id, cashbox_id, user_id, assignment_type,
            effective_from, effective_to, state
          ) VALUES ($1,$2,$3,'PRIMARY',$4,$5,'ACTIVE')
        `, [
          organizationId,
          cashboxId,
          dto.primaryCustodianId,
          commandAt,
          dto.activeTo ?? null,
        ]);
        if (dto.substituteCustodianId) {
          await client.query(`
            INSERT INTO cashbox_assignments (
              organization_id, cashbox_id, user_id, assignment_type,
              effective_from, effective_to, state
            ) VALUES ($1,$2,$3,'SUBSTITUTE',$4,$5,'ACTIVE')
          `, [
            organizationId,
            cashboxId,
            dto.substituteCustodianId,
            commandAt,
            dto.activeTo ?? null,
          ]);
        }
        return this.view(client, organizationId, cashboxId);
      },
    );
  }

  async acquireHandoverIdempotencyLock(
    transaction: DatabaseTransaction,
    organizationId: string,
    idempotencyKey: string,
  ): Promise<void> {
    await transaction.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtext(${organizationId}),
        hashtext(${'createCashboxHandover:' + idempotencyKey})
      )
    `);
  }

  async findHandoverIdempotencyRecord(
    transaction: DatabaseTransaction,
    organizationId: string,
    idempotencyKey: string,
  ): Promise<{
      requestDigest: string;
      responseBody: CashboxHandoverView | null;
    } | undefined> {
    const rows = await transaction
      .select({
        requestDigest: idempotencyRecords.requestDigest,
        responseBody: idempotencyRecords.responseBody,
      })
      .from(idempotencyRecords)
      .where(and(
        eq(idempotencyRecords.organizationId, organizationId),
        eq(idempotencyRecords.scope, 'createCashboxHandover'),
        eq(idempotencyRecords.idempotencyKey, idempotencyKey),
      ))
      .limit(1);
    const row = rows[0];
    return row
      ? {
        requestDigest: row.requestDigest,
        responseBody: row.responseBody as CashboxHandoverView | null,
      }
      : undefined;
  }

  async insertHandoverIdempotencyRecord(
    transaction: DatabaseTransaction,
    organizationId: string,
    idempotencyKey: string,
    requestDigest: string,
  ): Promise<void> {
    await transaction.insert(idempotencyRecords).values({
      organizationId,
      scope: 'createCashboxHandover',
      idempotencyKey,
      requestDigest,
    });
  }

  async saveHandoverIdempotencyResponse(
    transaction: DatabaseTransaction,
    organizationId: string,
    idempotencyKey: string,
    response: CashboxHandoverView,
  ): Promise<void> {
    await transaction
      .update(idempotencyRecords)
      .set({ responseStatus: 201, responseBody: { ...response } })
      .where(and(
        eq(idempotencyRecords.organizationId, organizationId),
        eq(idempotencyRecords.scope, 'createCashboxHandover'),
        eq(idempotencyRecords.idempotencyKey, idempotencyKey),
      ));
  }

  async findCashboxForHandover(
    transaction: DatabaseTransaction,
    organizationId: string,
    cashboxId: string,
  ): Promise<{ state: string; version: number } | undefined> {
    const rows = await transaction
      .select({
        state: sql<string>`${cashboxes.state}`.as('state'),
        version: sql<number>`${cashboxes.version}`.mapWith(Number).as('version'),
      })
      .from(cashboxes)
      .where(and(
        eq(cashboxes.organizationId, organizationId),
        eq(cashboxes.id, cashboxId),
      ))
      .for('update');
    return rows[0];
  }

  async findHandoverAuthorizationContext(
    transaction: DatabaseTransaction,
    organizationId: string,
    cashboxId: string,
  ): Promise<{
      cashboxId: string;
      branchId: string | null;
      treasuryUnitId: string | null;
    }> {
    const rows = await transaction
      .select({
        branchId: sql<string | null>`${cashboxes.branchId}`.as('branchId'),
        treasuryUnitId: sql<string>`${cashboxes.treasuryUnitId}`.as('treasuryUnitId'),
      })
      .from(cashboxes)
      .where(and(
        eq(cashboxes.organizationId, organizationId),
        eq(cashboxes.id, cashboxId),
      ))
      .limit(1);
    const row = rows[0];
    return {
      cashboxId,
      branchId: row?.branchId ?? null,
      treasuryUnitId: row?.treasuryUnitId ?? null,
    };
  }

  findPrimaryAssignmentForHandover(
    transaction: DatabaseTransaction,
    organizationId: string,
    cashboxId: string,
  ): Promise<{ id: string; userId: string } | undefined> {
    return this.findPrimaryAssignment(transaction, organizationId, cashboxId, 'update');
  }

  findPrimaryAssignmentForReplay(
    transaction: DatabaseTransaction,
    organizationId: string,
    cashboxId: string,
  ): Promise<{ id: string; userId: string } | undefined> {
    return this.findPrimaryAssignment(transaction, organizationId, cashboxId, 'share');
  }

  async hasNonterminalHandover(
    transaction: DatabaseTransaction,
    cashboxId: string,
  ): Promise<boolean> {
    const rows = await transaction
      .select({ id: cashboxHandovers.id })
      .from(cashboxHandovers)
      .where(and(
        eq(cashboxHandovers.cashboxId, cashboxId),
        notInArray(cashboxHandovers.state, ['COMPLETED', 'REJECTED', 'CANCELLED']),
      ))
      .limit(1);
    return rows.length > 0;
  }

  async listHandoverControlledCurrencies(
    transaction: DatabaseTransaction,
    cashboxId: string,
  ): Promise<string[]> {
    const rows = await transaction
      .select({
        currency: sql<string>`${cashboxCurrencyControls.currency}`.as('currency'),
      })
      .from(cashboxCurrencyControls)
      .where(eq(cashboxCurrencyControls.cashboxId, cashboxId))
      .orderBy(cashboxCurrencyControls.currency);
    return rows.map(({ currency }) => currency);
  }

  async insertCountedHandover(
    transaction: DatabaseTransaction,
    values: {
      id: string;
      organizationId: string;
      cashboxId: string;
      currentAssignmentId: string;
      actorUserId: string;
      incomingUserId: string;
      bookSnapshotDigest: string;
      hasDiscrepancy: boolean;
      discrepancyCurrencies: string[];
      reason?: string;
      requestId: string;
      moneyCounts: Array<{ currency: string; countedAmount: string }>;
    },
  ): Promise<CashboxHandoverView> {
    await transaction.insert(cashboxHandovers).values({
      id: values.id,
      organizationId: values.organizationId,
      cashboxId: values.cashboxId,
      currentAssignmentId: values.currentAssignmentId,
      handoverNumber: values.id,
      outgoingUserId: values.actorUserId,
      incomingUserId: values.incomingUserId,
      bookSnapshotDigest: values.bookSnapshotDigest,
      hasDiscrepancy: values.hasDiscrepancy,
      reason: values.reason,
      state: 'DRAFT',
      createdByUserId: values.actorUserId,
      requestId: values.requestId,
      countedAt: sql`now()`,
    });
    await transaction.insert(cashboxHandoverMoney).values(
      values.moneyCounts.map(({ currency, countedAmount }) => ({
        handoverId: values.id,
        organizationId: values.organizationId,
        currency,
        bookAmount: '0',
        countedAmount,
        varianceAmount: countedAmount,
      })),
    );
    const transitioned = await transaction
      .update(cashboxHandovers)
      .set({
        state: 'COUNTED',
        version: sql`${cashboxHandovers.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(and(
        eq(cashboxHandovers.id, values.id),
        eq(cashboxHandovers.state, 'DRAFT'),
      ))
      .returning({
        countedAt: cashboxHandovers.countedAt,
        createdAt: cashboxHandovers.createdAt,
        updatedAt: cashboxHandovers.updatedAt,
        version: cashboxHandovers.version,
      });
    const moneyCounts = await transaction
      .select({
        currency: cashboxHandoverMoney.currency,
        bookAmount: cashboxHandoverMoney.bookAmount,
        countedAmount: cashboxHandoverMoney.countedAmount,
        varianceAmount: cashboxHandoverMoney.varianceAmount,
      })
      .from(cashboxHandoverMoney)
      .where(eq(cashboxHandoverMoney.handoverId, values.id))
      .orderBy(cashboxHandoverMoney.currency);
    const times = transitioned[0]!;
    return {
      id: values.id,
      cashboxId: values.cashboxId,
      currentAssignmentId: values.currentAssignmentId,
      outgoingUserId: values.actorUserId,
      incomingUserId: values.incomingUserId,
      moneyCounts,
      heldInstrumentSnapshot: [],
      observedInstrumentIds: [],
      discrepancy: {
        hasDiscrepancy: values.hasDiscrepancy,
        moneyCurrencies: values.discrepancyCurrencies,
        missingInstrumentIds: [],
      },
      ...(values.reason ? { reason: values.reason } : {}),
      state: 'COUNTED',
      version: times.version,
      createdByUserId: values.actorUserId,
      requestId: values.requestId,
      countedAt: times.countedAt.toISOString(),
      createdAt: times.createdAt.toISOString(),
      updatedAt: times.updatedAt.toISOString(),
    };
  }

  private async findPrimaryAssignment(
    transaction: DatabaseTransaction,
    organizationId: string,
    cashboxId: string,
    lock: 'share' | 'update',
  ): Promise<{ id: string; userId: string } | undefined> {
    const rows = await transaction
      .select({ id: cashboxAssignments.id, userId: cashboxAssignments.userId })
      .from(cashboxAssignments)
      .where(and(
        eq(cashboxAssignments.organizationId, organizationId),
        eq(cashboxAssignments.cashboxId, cashboxId),
        eq(cashboxAssignments.assignmentType, 'PRIMARY'),
        eq(cashboxAssignments.state, 'ACTIVE'),
        sql`${cashboxAssignments.effectiveFrom} <= now()`,
        sql`(${cashboxAssignments.effectiveTo} IS NULL
          OR ${cashboxAssignments.effectiveTo} > now())`,
      ))
      .for(lock);
    return rows[0];
  }

  private async createScopeAllowed(
    client: PoolClient,
    organizationId: string,
    actorUserId: string,
    dto: CashboxCreateDto,
  ): Promise<boolean> {
    const result = await client.query<{ allowed: boolean }>(`
      SELECT EXISTS (
        SELECT 1
        FROM access_grants ag
        JOIN roles r ON r.id = ag.role_id AND r.state = 'ACTIVE'
        JOIN role_permissions rp ON rp.role_id = r.id AND rp.permission = 'cashbox.manage'
        WHERE ag.organization_id = $1
          AND ag.user_ref_id = $2
          AND ag.state = 'ACTIVE'
          AND ag.valid_from <= now()
          AND (ag.valid_to IS NULL OR ag.valid_to > now())
          AND (
            NOT EXISTS (
              SELECT 1 FROM access_grant_branch_scopes s
              WHERE s.access_grant_id = ag.id
            )
            OR (
              $3::uuid IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM access_grant_branch_scopes s
                WHERE s.access_grant_id = ag.id AND s.branch_id = $3
              )
            )
          )
          AND (
            NOT EXISTS (
              SELECT 1 FROM access_grant_treasury_unit_scopes s
              WHERE s.access_grant_id = ag.id
            )
            OR EXISTS (
              SELECT 1 FROM access_grant_treasury_unit_scopes s
              WHERE s.access_grant_id = ag.id AND s.treasury_unit_id = $4
            )
          )
          AND (
            NOT EXISTS (
              SELECT 1 FROM access_grant_currency_scopes s
              WHERE s.access_grant_id = ag.id
            )
            OR NOT EXISTS (
              SELECT requested
              FROM unnest($5::varchar[]) requested
              WHERE NOT EXISTS (
                SELECT 1 FROM access_grant_currency_scopes s
                WHERE s.access_grant_id = ag.id AND s.currency = requested
              )
            )
          )
      ) AS allowed
    `, [
      organizationId,
      actorUserId,
      dto.branchId ?? null,
      dto.treasuryUnitId,
      dto.currencyControls.map(({ currency }) => currency),
    ]);
    return result.rows[0]!.allowed;
  }

  private async view(
    client: PoolClient,
    organizationId: string,
    cashboxId: string,
  ): Promise<CashboxView> {
    const result = await client.query<CashboxView>(`
      ${CASHBOX_VIEW_SELECT}
      WHERE c.organization_id = $1 AND c.id = $2
    `, [organizationId, cashboxId]);
    return compact(result.rows[0]!) as CashboxView;
  }

  private async idempotent<T extends object>(
    organizationId: string,
    scope: string,
    idempotencyKey: string,
    requestDigest: string,
    authorizeReplay: (client: PoolClient) => Promise<void>,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [organizationId, `${scope}:${idempotencyKey}`],
      );
      const existing = await client.query<{ request_digest: string; response_body: T | null }>(`
        SELECT request_digest, response_body
        FROM idempotency_records
        WHERE organization_id = $1 AND scope = $2 AND idempotency_key = $3
      `, [organizationId, scope, idempotencyKey]);
      const replay = existing.rows[0];
      if (replay) {
        await authorizeReplay(client);
        if (replay.request_digest !== requestDigest || !replay.response_body) {
          throw new SyntaxError('IDEMPOTENCY_CONFLICT');
        }
        await client.query('COMMIT');
        return replay.response_body;
      }
      await client.query(`
        INSERT INTO idempotency_records (organization_id, scope, idempotency_key, request_digest)
        VALUES ($1,$2,$3,$4)
      `, [organizationId, scope, idempotencyKey, requestDigest]);
      const response = compact(await work(client)) as T;
      await client.query(`
        UPDATE idempotency_records
        SET response_status = 201, response_body = $1
        WHERE organization_id = $2 AND scope = $3 AND idempotency_key = $4
      `, [response, organizationId, scope, idempotencyKey]);
      await client.query('COMMIT');
      return response;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

const CASHBOX_VIEW_SELECT = `
  SELECT c.id, c.organization_id AS "organizationId", c.code, c.name,
         c.cashbox_type AS type, c.branch_id AS "branchId",
         c.treasury_unit_id AS "treasuryUnitId", c.main_currency AS "mainCurrency",
         controls.value AS "currencyControls",
         primary_assignment.user_id AS "primaryCustodianId",
         substitute_assignment.user_id AS "substituteCustodianId",
         jsonb_build_object(
           'receive', c.can_receive, 'pay', c.can_pay, 'transfer', c.can_transfer
         ) AS capabilities,
         c.requires_approval AS "requiresApproval",
         c.accounting_dimensions AS "accountingDimensions",
         '[]'::jsonb AS "heldInstrumentOptions",
         to_char(c.active_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "activeFrom",
         to_char(c.active_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "activeTo",
         c.state, c.version::int,
         to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
         to_char(c.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"
  FROM cashboxes c
  JOIN LATERAL (
    SELECT a.user_id
    FROM cashbox_assignments a
    WHERE a.cashbox_id = c.id
      AND a.assignment_type = 'PRIMARY'
      AND a.state = 'ACTIVE'
      AND a.effective_from <= now()
      AND (a.effective_to IS NULL OR a.effective_to > now())
    LIMIT 1
  ) primary_assignment ON true
  LEFT JOIN LATERAL (
    SELECT a.user_id
    FROM cashbox_assignments a
    WHERE a.cashbox_id = c.id
      AND a.assignment_type = 'SUBSTITUTE'
      AND a.state = 'ACTIVE'
      AND a.effective_from <= now()
      AND (a.effective_to IS NULL OR a.effective_to > now())
    ORDER BY a.created_at DESC
    LIMIT 1
  ) substitute_assignment ON true
  CROSS JOIN LATERAL (
    SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'currency', cc.currency,
      'transactionCeiling', cc.transaction_ceiling::text,
      'minimumPosition', cc.minimum_position::text,
      'maximumHolding', cc.maximum_holding::text,
      'allowNegative', cc.allow_negative
    )) ORDER BY cc.currency) AS value
    FROM cashbox_currency_controls cc
    WHERE cc.cashbox_id = c.id
  ) controls
`;

function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== null),
  ) as T;
}
