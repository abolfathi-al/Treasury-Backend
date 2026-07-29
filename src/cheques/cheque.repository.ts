import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';

import { DatabaseService } from '../database/database.service';
import {
  ChequeBookCreateDto,
  ChequeBookView,
  ChequeLeafCommand,
  ChequeLeafSummary,
  ChequeLeafTransitionDto,
} from './cheque.dto';

interface LeafTarget {
  id: string;
  bankAccountId: string;
  state: string;
  version: string;
}

@Injectable()
export class ChequeRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  createChequeBook(
    organizationId: string,
    actorUserId: string,
    dto: ChequeBookCreateDto,
    idempotencyKey: string,
    requestDigest: string,
  ): Promise<ChequeBookView> {
    const authorize = async (client: PoolClient): Promise<void> => {
      await this.assertScopedPermission(
        client,
        organizationId,
        actorUserId,
        'cheque-book.manage',
        dto.bankAccountId,
      );
      await this.assertCreateReferences(client, organizationId, dto);
    };

    return this.idempotent(
      organizationId,
      `createChequeBook:${actorUserId}`,
      idempotencyKey,
      requestDigest,
      201,
      authorize,
      async (client) => {
        await authorize(client);
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`${organizationId}:${dto.bankAccountId}:${dto.series}`],
        );
        const overlap = await client.query(`
          SELECT 1
          FROM cheque_books
          WHERE organization_id = $1
            AND bank_account_id = $2
            AND series = $3
            AND int8range(first_leaf, last_leaf, '[]')
                && int8range($4::bigint, $5::bigint, '[]')
        `, [
          organizationId,
          dto.bankAccountId,
          dto.series,
          dto.firstLeaf,
          dto.lastLeaf,
        ]);
        if (overlap.rowCount) throw new RangeError('RANGE_OVERLAP');

        const chequeBookId = randomUUID();
        await client.query(`
          INSERT INTO cheque_books (
            id, organization_id, bank_account_id, series, first_leaf, last_leaf,
            received_date, custodian_user_id, notes, state
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ACTIVE')
        `, [
          chequeBookId,
          organizationId,
          dto.bankAccountId,
          dto.series,
          dto.firstLeaf,
          dto.lastLeaf,
          dto.receivedDate,
          dto.custodianUserId ?? null,
          dto.notes ?? null,
        ]);
        await client.query(`
          INSERT INTO cheque_leaves (
            organization_id, cheque_book_id, bank_account_id, series, leaf_number
          )
          SELECT $1, $2, $3, $4, leaf_number
          FROM generate_series($5::bigint, $6::bigint) AS leaf_number
        `, [
          organizationId,
          chequeBookId,
          dto.bankAccountId,
          dto.series,
          dto.firstLeaf,
          dto.lastLeaf,
        ]);
        return this.chequeBookView(client, organizationId, chequeBookId);
      },
    );
  }

  transitionCheque(
    organizationId: string,
    actorUserId: string,
    chequeBookId: string,
    leafNumber: number,
    dto: ChequeLeafTransitionDto,
    idempotencyKey: string,
    requestDigest: string,
    expectedVersion: number,
  ): Promise<ChequeLeafSummary> {
    const authorize = async (client: PoolClient): Promise<void> => {
      await this.leafTarget(
        client,
        organizationId,
        actorUserId,
        chequeBookId,
        leafNumber,
        false,
      );
    };
    return this.idempotent(
      organizationId,
      `transitionCheque:${actorUserId}`,
      idempotencyKey,
      requestDigest,
      200,
      authorize,
      async (client) => {
        const leaf = await this.leafTarget(
          client,
          organizationId,
          actorUserId,
          chequeBookId,
          leafNumber,
          true,
        );
        if (Number(leaf.version) !== expectedVersion) {
          throw new RangeError('STALE_VERSION');
        }
        if (leaf.state !== 'AVAILABLE') throw new Error('ILLEGAL_TRANSITION');
        const nextState = dto.command === ChequeLeafCommand.VOID ? 'VOID' : 'LOST';
        await client.query(`
          UPDATE cheque_leaves
          SET state = $1, version = version + 1, updated_at = now()
          WHERE id = $2
        `, [nextState, leaf.id]);
        const sequence = await client.query<{ sequence_no: string }>(`
          SELECT (COALESCE(MAX(sequence_no), 0) + 1)::text AS sequence_no
          FROM cheque_events
          WHERE cheque_type = 'LEAF' AND cheque_id = $1
        `, [leaf.id]);
        await client.query(`
          INSERT INTO cheque_events (
            cheque_type, cheque_id, sequence_no, from_state, to_state,
            actor_user_id, reason, idempotency_key
          ) VALUES ('LEAF',$1,$2,'AVAILABLE',$3,$4,$5,$6)
        `, [
          leaf.id,
          sequence.rows[0]!.sequence_no,
          nextState,
          actorUserId,
          dto.reason,
          idempotencyKey,
        ]);
        return this.chequeLeafView(client, leaf.id);
      },
    );
  }

  private async assertCreateReferences(
    client: PoolClient,
    organizationId: string,
    dto: ChequeBookCreateDto,
  ): Promise<void> {
    const account = await client.query<{
      state: string;
      account_type: string;
      cheque_enabled: boolean;
    }>(`
      SELECT state, account_type, cheque_enabled
      FROM bank_accounts
      WHERE organization_id = $1 AND id = $2
      FOR SHARE
    `, [organizationId, dto.bankAccountId]);
    if (!account.rowCount) throw new ReferenceError('RESOURCE_HIDDEN');
    const row = account.rows[0]!;
    if (
      row.state !== 'ACTIVE'
      || row.account_type !== 'CURRENT'
      || !row.cheque_enabled
    ) throw new ReferenceError('BANK_ACCOUNT_UNAVAILABLE');

    if (dto.custodianUserId) {
      const custodian = await client.query<{ state: string }>(`
        SELECT state
        FROM user_refs
        WHERE organization_id = $1 AND id = $2
        FOR SHARE
      `, [organizationId, dto.custodianUserId]);
      if (!custodian.rowCount) throw new ReferenceError('RESOURCE_HIDDEN');
      if (custodian.rows[0]!.state !== 'ACTIVE') {
        throw new ReferenceError('INACTIVE_REFERENCE');
      }
    }
  }

  private async leafTarget(
    client: PoolClient,
    organizationId: string,
    actorUserId: string,
    chequeBookId: string,
    leafNumber: number,
    lock: boolean,
  ): Promise<LeafTarget> {
    const book = await client.query<{
      bank_account_id: string;
      first_leaf: string;
      last_leaf: string;
      state: string;
    }>(`
      SELECT bank_account_id, first_leaf::text, last_leaf::text, state
      FROM cheque_books
      WHERE organization_id = $1 AND id = $2
      FOR SHARE
    `, [organizationId, chequeBookId]);
    if (!book.rowCount) throw new ReferenceError('RESOURCE_HIDDEN');
    await this.assertScopedPermission(
      client,
      organizationId,
      actorUserId,
      'cheque.transition',
      book.rows[0]!.bank_account_id,
    );
    const targetBook = book.rows[0]!;
    if (
      targetBook.state !== 'ACTIVE'
      || leafNumber < Number(targetBook.first_leaf)
      || leafNumber > Number(targetBook.last_leaf)
    ) throw new RangeError('LEAF_UNAVAILABLE');

    const leaf = await client.query<LeafTarget>(`
      SELECT id, bank_account_id AS "bankAccountId", state, version::text
      FROM cheque_leaves
      WHERE organization_id = $1
        AND cheque_book_id = $2
        AND leaf_number = $3
      ${lock ? 'FOR UPDATE' : 'FOR SHARE'}
    `, [organizationId, chequeBookId, leafNumber]);
    if (!leaf.rowCount) throw new RangeError('LEAF_UNAVAILABLE');
    return leaf.rows[0]!;
  }

  private async assertScopedPermission(
    client: PoolClient,
    organizationId: string,
    actorUserId: string,
    permission: 'cheque-book.manage' | 'cheque.transition',
    bankAccountId: string,
  ): Promise<void> {
    const result = await client.query<{ allowed: boolean }>(`
      SELECT EXISTS (
        SELECT 1
        FROM access_grants ag
        JOIN roles r ON r.id = ag.role_id AND r.state = 'ACTIVE'
        JOIN role_permissions rp ON rp.role_id = r.id AND rp.permission = $3
        WHERE ag.organization_id = $1
          AND ag.user_ref_id = $2
          AND ag.state = 'ACTIVE'
          AND ag.valid_from <= now()
          AND (ag.valid_to IS NULL OR ag.valid_to > now())
          AND ag.amount_ceiling IS NULL
          AND ${CHEQUE_ONLY_SCOPE}
          AND (
            NOT EXISTS (
              SELECT 1 FROM access_grant_bank_account_scopes s
              WHERE s.access_grant_id = ag.id
            )
            OR EXISTS (
              SELECT 1 FROM access_grant_bank_account_scopes s
              WHERE s.access_grant_id = ag.id AND s.bank_account_id = $4
            )
          )
      ) AS allowed
    `, [organizationId, actorUserId, permission, bankAccountId]);
    if (!result.rows[0]!.allowed) throw new Error('SCOPE_DENIED');
  }

  private async chequeBookView(
    client: PoolClient,
    organizationId: string,
    chequeBookId: string,
  ): Promise<ChequeBookView> {
    const result = await client.query<ChequeBookView>(`
      SELECT cb.id, cb.organization_id AS "organizationId",
             cb.bank_account_id AS "bankAccountId",
             jsonb_build_object(
               'id', ba.id,
               'label', left(b.display_name || ' · ' || ba.account_number, 240)
             ) AS "bankAccount",
             cb.series, cb.first_leaf::float8 AS "firstLeaf",
             cb.last_leaf::float8 AS "lastLeaf",
             (cb.last_leaf - cb.first_leaf + 1)::int AS "leafCount",
             to_char(cb.received_date, 'YYYY-MM-DD') AS "receivedDate",
             cb.custodian_user_id AS "custodianUserId",
             CASE WHEN u.id IS NULL THEN NULL ELSE jsonb_build_object(
               'id', u.id, 'label', u.display_name
             ) END AS custodian,
             cb.notes, cb.state, cb.version::int AS version,
             leaves.value AS leaves,
             to_char(
               cb.created_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
             ) AS "createdAt",
             to_char(
               cb.updated_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
             ) AS "updatedAt"
      FROM cheque_books cb
      JOIN bank_accounts ba
        ON ba.organization_id = cb.organization_id AND ba.id = cb.bank_account_id
      JOIN banks b
        ON b.organization_id = ba.organization_id AND b.id = ba.bank_id
      LEFT JOIN user_refs u
        ON u.organization_id = cb.organization_id AND u.id = cb.custodian_user_id
      JOIN LATERAL (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', cl.id,
            'chequeBookId', cl.cheque_book_id,
            'series', cl.series,
            'leafNumber', cl.leaf_number,
            'label', cl.series || '-' || cl.leaf_number::text,
            'state', cl.state,
            'version', cl.version
          )
          ORDER BY cl.leaf_number
        ) AS value
        FROM cheque_leaves cl
        WHERE cl.organization_id = cb.organization_id
          AND cl.cheque_book_id = cb.id
      ) leaves ON true
      WHERE cb.organization_id = $1 AND cb.id = $2
    `, [organizationId, chequeBookId]);
    if (!result.rowCount) throw new ReferenceError('RESOURCE_HIDDEN');
    return compact(result.rows[0]!) as ChequeBookView;
  }

  private async chequeLeafView(
    client: PoolClient,
    chequeLeafId: string,
  ): Promise<ChequeLeafSummary> {
    const result = await client.query<ChequeLeafSummary>(`
      SELECT id, cheque_book_id AS "chequeBookId", series,
             leaf_number::float8 AS "leafNumber",
             series || '-' || leaf_number::text AS label,
             state, version::int AS version
      FROM cheque_leaves
      WHERE id = $1
    `, [chequeLeafId]);
    if (!result.rowCount) throw new ReferenceError('RESOURCE_HIDDEN');
    return result.rows[0]!;
  }

  private async idempotent<T extends object>(
    organizationId: string,
    scope: string,
    idempotencyKey: string,
    requestDigest: string,
    responseStatus: 200 | 201,
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
      const existing = await client.query<{
        request_digest: string;
        response_body: T | null;
      }>(`
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
        INSERT INTO idempotency_records (
          organization_id, scope, idempotency_key, request_digest
        ) VALUES ($1,$2,$3,$4)
      `, [organizationId, scope, idempotencyKey, requestDigest]);
      const response = compact(await work(client)) as T;
      await client.query(`
        UPDATE idempotency_records
        SET response_status = $1, response_body = $2
        WHERE organization_id = $3 AND scope = $4 AND idempotency_key = $5
      `, [responseStatus, response, organizationId, scope, idempotencyKey]);
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

const CHEQUE_ONLY_SCOPE = `
  NOT EXISTS (
    SELECT 1 FROM access_grant_branch_scopes s WHERE s.access_grant_id = ag.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM access_grant_treasury_unit_scopes s WHERE s.access_grant_id = ag.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM access_grant_cashbox_scopes s WHERE s.access_grant_id = ag.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM access_grant_document_type_scopes s WHERE s.access_grant_id = ag.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM access_grant_method_category_scopes s
    WHERE s.access_grant_id = ag.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM access_grant_currency_scopes s WHERE s.access_grant_id = ag.id
  )
`;

function compact<T extends object>(record: T): T {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== null),
  ) as T;
}
