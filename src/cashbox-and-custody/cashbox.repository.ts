import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { digest, stableJson } from '../common/http';
import { DatabaseService } from '../database/database.service';
import {
  CashboxCreateDto,
  CashboxHandoverView,
  CashboxView,
  HandoverCreateDto,
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

  createHandover(
    organizationId: string,
    actorUserId: string,
    cashboxId: string,
    dto: HandoverCreateDto,
    idempotencyKey: string,
    requestDigest: string,
    expectedVersion: number,
    requestId: string,
  ): Promise<CashboxHandoverView> {
    return this.idempotent(
      organizationId,
      'createCashboxHandover',
      idempotencyKey,
      requestDigest,
      (client) => this.assertHandoverReplayAuthorized(
        client,
        organizationId,
        actorUserId,
        cashboxId,
      ),
      async (client) => {
        if (!await this.handoverScopeAllowed(
          client,
          organizationId,
          actorUserId,
          cashboxId,
        )) throw new Error('SCOPE_DENIED');

        const cashbox = await client.query<{ state: string; version: string }>(`
          SELECT state, version::text
          FROM cashboxes
          WHERE organization_id = $1 AND id = $2
          FOR UPDATE
        `, [organizationId, cashboxId]);
        if (!cashbox.rowCount) throw new ReferenceError('RESOURCE_HIDDEN');
        if (cashbox.rows[0]!.state !== 'ACTIVE') throw new Error('STATE_CONFLICT');
        if (Number(cashbox.rows[0]!.version) !== expectedVersion) {
          throw new RangeError('STALE_VERSION');
        }

        const assignment = await client.query<{ id: string; user_id: string }>(`
          SELECT id, user_id
          FROM cashbox_assignments
          WHERE organization_id = $1
            AND cashbox_id = $2
            AND assignment_type = 'PRIMARY'
            AND state = 'ACTIVE'
            AND effective_from <= now()
            AND (effective_to IS NULL OR effective_to > now())
          FOR UPDATE
        `, [organizationId, cashboxId]);
        if (!assignment.rowCount || assignment.rows[0]!.user_id !== actorUserId) {
          throw new RangeError('CUSTODY_CONFLICT');
        }
        const open = await client.query(`
          SELECT 1
          FROM cashbox_handovers
          WHERE cashbox_id = $1
            AND state NOT IN ('COMPLETED', 'REJECTED', 'CANCELLED')
        `, [cashboxId]);
        if (open.rowCount) throw new Error('STATE_CONFLICT');

        const incoming = await client.query<{ state: string }>(`
          SELECT state FROM user_refs WHERE organization_id = $1 AND id = $2
          FOR SHARE
        `, [organizationId, dto.incomingUserId]);
        if (!incoming.rowCount) throw new ReferenceError('RESOURCE_HIDDEN');
        if (incoming.rows[0]!.state !== 'ACTIVE') {
          throw new ReferenceError('INACTIVE_REFERENCE');
        }

        const allowed = await client.query<{ currency: string; decimal_places: number }>(`
          SELECT cc.currency, c.decimal_places
          FROM cashbox_currency_controls cc
          JOIN currencies c
            ON c.organization_id = cc.organization_id AND c.code = cc.currency
          WHERE cc.cashbox_id = $1
          ORDER BY cc.currency
        `, [cashboxId]);
        const submitted = [...dto.moneyCounts].sort((a, b) => a.currency.localeCompare(b.currency));
        if (
          stableJson(submitted.map(({ currency }) => currency))
          !== stableJson(allowed.rows.map(({ currency }) => currency))
          || submitted.some(({ currency, countedAmount }) => (
            (countedAmount.split('.')[1]?.length ?? 0)
            > (allowed.rows.find((row) => row.currency === currency)?.decimal_places ?? -1)
          ))
          || dto.observedInstrumentIds.length > 0
        ) throw new Error('VALIDATION');

        const discrepancyCurrencies = submitted
          .filter(({ countedAmount }) => !decimalIsZero(countedAmount))
          .map(({ currency }) => currency);
        const hasDiscrepancy = discrepancyCurrencies.length > 0;
        if (hasDiscrepancy && !dto.reason?.trim()) throw new Error('VALIDATION');

        const handoverId = randomUUID();
        const snapshot = submitted.map(({ currency }) => ({ currency, bookAmount: '0' }));
        const created = await client.query<{
          id: string;
          countedAt: string;
          createdAt: string;
          updatedAt: string;
          version: number;
        }>(`
          INSERT INTO cashbox_handovers (
            id, organization_id, cashbox_id, current_assignment_id, handover_number,
            outgoing_user_id, incoming_user_id, book_snapshot_digest,
            has_discrepancy, reason, state, created_by_user_id, request_id, counted_at
          ) VALUES (
            $1::uuid,$2,$3,$4,($1::uuid)::text,$5,$6,$7,$8,$9,'DRAFT',$5,$10,now()
          )
          RETURNING id
        `, [
          handoverId,
          organizationId,
          cashboxId,
          assignment.rows[0]!.id,
          actorUserId,
          dto.incomingUserId,
          digest(stableJson({ money: snapshot, instruments: [] })),
          hasDiscrepancy,
          dto.reason ?? null,
          requestId,
        ]);
        for (const count of submitted) {
          await client.query(`
            INSERT INTO cashbox_handover_money (
              handover_id, organization_id, currency,
              book_amount, counted_amount, variance_amount
            ) VALUES ($1,$2,$3,0,$4,$4)
          `, [handoverId, organizationId, count.currency, count.countedAmount]);
        }
        const transition = await client.query<{
          countedAt: string;
          createdAt: string;
          updatedAt: string;
          version: number;
        }>(`
          UPDATE cashbox_handovers
          SET state = 'COUNTED', version = version + 1, updated_at = now()
          WHERE id = $1 AND state = 'DRAFT'
          RETURNING
            to_char(counted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "countedAt",
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
            to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
            version::int
        `, [created.rows[0]!.id]);
        const money = await client.query<{
          currency: string;
          bookAmount: string;
          countedAmount: string;
          varianceAmount: string;
        }>(`
          SELECT currency, book_amount::text AS "bookAmount",
                 counted_amount::text AS "countedAmount",
                 variance_amount::text AS "varianceAmount"
          FROM cashbox_handover_money
          WHERE handover_id = $1
          ORDER BY currency
        `, [handoverId]);
        const times = transition.rows[0]!;
        return {
          id: handoverId,
          cashboxId,
          currentAssignmentId: assignment.rows[0]!.id,
          outgoingUserId: actorUserId,
          incomingUserId: dto.incomingUserId,
          moneyCounts: money.rows,
          heldInstrumentSnapshot: [],
          observedInstrumentIds: [],
          discrepancy: {
            hasDiscrepancy,
            moneyCurrencies: discrepancyCurrencies,
            missingInstrumentIds: [],
          },
          ...(dto.reason ? { reason: dto.reason } : {}),
          state: 'COUNTED',
          version: times.version,
          createdByUserId: actorUserId,
          requestId,
          countedAt: times.countedAt,
          createdAt: times.createdAt,
          updatedAt: times.updatedAt,
        };
      },
    );
  }

  private async assertHandoverReplayAuthorized(
    client: PoolClient,
    organizationId: string,
    actorUserId: string,
    cashboxId: string,
  ): Promise<void> {
    if (!await this.handoverScopeAllowed(
      client,
      organizationId,
      actorUserId,
      cashboxId,
    )) throw new Error('SCOPE_DENIED');
    const assignment = await client.query<{ user_id: string }>(`
      SELECT user_id
      FROM cashbox_assignments
      WHERE organization_id = $1
        AND cashbox_id = $2
        AND assignment_type = 'PRIMARY'
        AND state = 'ACTIVE'
        AND effective_from <= now()
        AND (effective_to IS NULL OR effective_to > now())
      FOR SHARE
    `, [organizationId, cashboxId]);
    if (!assignment.rowCount || assignment.rows[0]!.user_id !== actorUserId) {
      throw new RangeError('CUSTODY_CONFLICT');
    }
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

  private async handoverScopeAllowed(
    client: PoolClient,
    organizationId: string,
    actorUserId: string,
    cashboxId: string,
  ): Promise<boolean> {
    const result = await client.query<{ allowed: boolean }>(`
      SELECT EXISTS (
        SELECT 1
        FROM access_grants ag
        JOIN roles r ON r.id = ag.role_id AND r.state = 'ACTIVE'
        JOIN role_permissions rp ON rp.role_id = r.id AND rp.permission = 'cashbox.handover'
        WHERE ag.organization_id = $1
          AND ag.user_ref_id = $2
          AND ag.state = 'ACTIVE'
          AND ag.valid_from <= now()
          AND (ag.valid_to IS NULL OR ag.valid_to > now())
          AND (
            NOT EXISTS (
              SELECT 1 FROM access_grant_cashbox_scopes s
              WHERE s.access_grant_id = ag.id
            )
            OR EXISTS (
              SELECT 1 FROM access_grant_cashbox_scopes s
              WHERE s.access_grant_id = ag.id AND s.cashbox_id = $3
            )
          )
          AND (
            NOT EXISTS (
              SELECT 1 FROM access_grant_branch_scopes s
              WHERE s.access_grant_id = ag.id
            )
            OR EXISTS (
              SELECT 1
              FROM cashboxes c
              JOIN access_grant_branch_scopes s
                ON s.access_grant_id = ag.id AND s.branch_id = c.branch_id
              WHERE c.organization_id = $1 AND c.id = $3
            )
          )
          AND (
            NOT EXISTS (
              SELECT 1 FROM access_grant_treasury_unit_scopes s
              WHERE s.access_grant_id = ag.id
            )
            OR EXISTS (
              SELECT 1
              FROM cashboxes c
              JOIN access_grant_treasury_unit_scopes s
                ON s.access_grant_id = ag.id AND s.treasury_unit_id = c.treasury_unit_id
              WHERE c.organization_id = $1 AND c.id = $3
            )
          )
      ) AS allowed
    `, [organizationId, actorUserId, cashboxId]);
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

function decimalIsZero(value: string): boolean {
  return /^-?0(?:\.0+)?$/u.test(value);
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== null),
  ) as T;
}
