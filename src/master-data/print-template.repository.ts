import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';

import { DatabaseService } from '../database/database.service';
import {
  PrintTemplateCreateDto,
  PrintTemplateView,
} from './print-template.dto';

export interface PrintTemplateCursor {
  code: string;
  templateVersion: number;
  id: string;
}

@Injectable()
export class PrintTemplateRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async list(
    organizationId: string,
    actorUserId: string,
    limit: number,
    cursor?: PrintTemplateCursor,
  ): Promise<{ items: PrintTemplateView[]; hasMore: boolean }> {
    const result = await this.database.pool.query<PrintTemplateView>(`
      ${PRINT_TEMPLATE_VIEW_SELECT}
      WHERE pt.organization_id = $1
        AND EXISTS (
          SELECT 1
          FROM access_grants ag
          JOIN roles r ON r.id = ag.role_id AND r.state = 'ACTIVE'
          JOIN role_permissions rp
            ON rp.role_id = r.id AND rp.permission = 'print-template.view'
          WHERE ag.organization_id = $1
            AND ag.user_ref_id = $2
            AND ag.state = 'ACTIVE'
            AND ag.valid_from <= now()
            AND (ag.valid_to IS NULL OR ag.valid_to > now())
            AND ag.amount_ceiling IS NULL
            AND ${PRINT_TEMPLATE_ONLY_SCOPE}
            AND (
              NOT EXISTS (
                SELECT 1 FROM access_grant_treasury_unit_scopes s
                WHERE s.access_grant_id = ag.id
              )
              OR pt.treasury_unit_id IS NULL
              OR EXISTS (
                SELECT 1 FROM access_grant_treasury_unit_scopes s
                WHERE s.access_grant_id = ag.id
                  AND s.treasury_unit_id = pt.treasury_unit_id
              )
            )
        )
        AND (
          $3::varchar IS NULL
          OR pt.code > $3::varchar
          OR (
            pt.code = $3::varchar
            AND pt.template_version < $4::bigint
          )
          OR (
            pt.code = $3::varchar
            AND pt.template_version = $4::bigint
            AND pt.id > $5::uuid
          )
        )
      ORDER BY pt.code ASC, pt.template_version DESC, pt.id ASC
      LIMIT $6
    `, [
      organizationId,
      actorUserId,
      cursor?.code ?? null,
      cursor?.templateVersion ?? null,
      cursor?.id ?? null,
      limit + 1,
    ]);
    return {
      items: result.rows.slice(0, limit).map(compact) as PrintTemplateView[],
      hasMore: result.rows.length > limit,
    };
  }

  create(
    organizationId: string,
    actorUserId: string,
    dto: PrintTemplateCreateDto,
    idempotencyKey: string,
    requestDigest: string,
  ): Promise<PrintTemplateView> {
    const authorize = async (client: PoolClient): Promise<void> => {
      await this.assertCreatePermission(
        client,
        organizationId,
        actorUserId,
        dto.treasuryUnitId,
      );
      await this.assertReferences(client, organizationId, dto);
    };

    return this.idempotent(
      organizationId,
      actorUserId,
      idempotencyKey,
      requestDigest,
      authorize,
      async (client) => {
        await authorize(client);
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
          [organizationId, `print-template-version:${dto.code}`],
        );
        const version = await client.query<{ next_version: string }>(`
          SELECT (COALESCE(MAX(template_version), 0) + 1)::text AS next_version
          FROM print_templates
          WHERE organization_id = $1 AND code = $2
        `, [organizationId, dto.code]);
        const created = await client.query<{ id: string }>(`
          INSERT INTO print_templates (
            organization_id, treasury_unit_id, bank_id, cheque_book_id,
            code, document_kind, language, direction, page_profile,
            calibration_x_mm, calibration_y_mm, template_body,
            template_digest, template_version
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
          )
          RETURNING id
        `, [
          organizationId,
          dto.treasuryUnitId ?? null,
          dto.bankId ?? null,
          dto.chequeBookId ?? null,
          dto.code,
          dto.documentKind,
          dto.language,
          dto.direction,
          dto.pageProfile,
          dto.calibrationXmm,
          dto.calibrationYmm,
          dto.templateBody,
          dto.templateDigest,
          version.rows[0]!.next_version,
        ]);
        return this.view(client, organizationId, created.rows[0]!.id);
      },
    );
  }

  private async assertCreatePermission(
    client: PoolClient,
    organizationId: string,
    actorUserId: string,
    treasuryUnitId?: string,
  ): Promise<void> {
    const result = await client.query<{ allowed: boolean }>(`
      SELECT EXISTS (
        SELECT 1
        FROM access_grants ag
        JOIN roles r ON r.id = ag.role_id AND r.state = 'ACTIVE'
        JOIN role_permissions rp
          ON rp.role_id = r.id AND rp.permission = 'print-template.manage'
        WHERE ag.organization_id = $1
          AND ag.user_ref_id = $2
          AND ag.state = 'ACTIVE'
          AND ag.valid_from <= now()
          AND (ag.valid_to IS NULL OR ag.valid_to > now())
          AND ag.amount_ceiling IS NULL
          AND ${PRINT_TEMPLATE_ONLY_SCOPE}
          AND (
            NOT EXISTS (
              SELECT 1 FROM access_grant_treasury_unit_scopes s
              WHERE s.access_grant_id = ag.id
            )
            OR (
              $3::uuid IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM access_grant_treasury_unit_scopes s
                WHERE s.access_grant_id = ag.id AND s.treasury_unit_id = $3
              )
            )
          )
      ) AS allowed
    `, [organizationId, actorUserId, treasuryUnitId ?? null]);
    if (!result.rows[0]!.allowed) throw new Error('SCOPE_DENIED');
  }

  private async assertReferences(
    client: PoolClient,
    organizationId: string,
    dto: PrintTemplateCreateDto,
  ): Promise<void> {
    if (dto.treasuryUnitId) {
      const unit = await client.query<{ state: string }>(`
        SELECT state
        FROM treasury_units
        WHERE organization_id = $1 AND id = $2
        FOR SHARE
      `, [organizationId, dto.treasuryUnitId]);
      assertVisibleAndActive(unit.rows[0]);
    }

    if (dto.bankId) {
      const bank = await client.query<{ state: string }>(`
        SELECT state
        FROM banks
        WHERE organization_id = $1 AND id = $2
        FOR SHARE
      `, [organizationId, dto.bankId]);
      assertVisibleAndActive(bank.rows[0]);
    }

    if (dto.chequeBookId) {
      const chequeBook = await client.query<{ state: string; bank_id: string }>(`
        SELECT cb.state, ba.bank_id
        FROM cheque_books cb
        JOIN bank_accounts ba ON ba.id = cb.bank_account_id
        WHERE ba.organization_id = $1 AND cb.id = $2
        FOR SHARE OF cb, ba
      `, [organizationId, dto.chequeBookId]);
      assertVisibleAndActive(chequeBook.rows[0]);
      if (dto.bankId && chequeBook.rows[0]!.bank_id !== dto.bankId) {
        throw new Error('VALIDATION');
      }
    }
  }

  private view(
    client: PoolClient,
    organizationId: string,
    id: string,
  ): Promise<PrintTemplateView> {
    return one<PrintTemplateView>(
      client,
      `${PRINT_TEMPLATE_VIEW_SELECT}
       WHERE pt.organization_id = $1 AND pt.id = $2`,
      [organizationId, id],
    );
  }

  private async idempotent<T extends object>(
    organizationId: string,
    actorUserId: string,
    idempotencyKey: string,
    requestDigest: string,
    authorizeReplay: (client: PoolClient) => Promise<void>,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.database.pool.connect();
    const scope = `createPrintTemplate:${actorUserId}`;
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

const PRINT_TEMPLATE_ONLY_SCOPE = `
  NOT EXISTS (
    SELECT 1 FROM access_grant_branch_scopes s WHERE s.access_grant_id = ag.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM access_grant_cashbox_scopes s WHERE s.access_grant_id = ag.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM access_grant_bank_account_scopes s WHERE s.access_grant_id = ag.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM access_grant_document_type_scopes s WHERE s.access_grant_id = ag.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM access_grant_method_category_scopes s WHERE s.access_grant_id = ag.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM access_grant_currency_scopes s WHERE s.access_grant_id = ag.id
  )
`;

const PRINT_TEMPLATE_VIEW_SELECT = `
  SELECT pt.id, pt.organization_id AS "organizationId", pt.code,
         pt.document_kind AS "documentKind",
         pt.treasury_unit_id AS "treasuryUnitId",
         pt.bank_id AS "bankId",
         pt.cheque_book_id AS "chequeBookId",
         CASE WHEN tu.id IS NULL THEN NULL ELSE jsonb_build_object(
           'id', tu.id, 'label', tu.name
         ) END AS "treasuryUnit",
         CASE WHEN b.id IS NULL THEN NULL ELSE jsonb_build_object(
           'id', b.id, 'label', b.display_name
         ) END AS bank,
         CASE WHEN cb.id IS NULL THEN NULL ELSE jsonb_build_object(
           'id', cb.id, 'label', cb.series
         ) END AS "chequeBook",
         pt.language, pt.direction, pt.page_profile AS "pageProfile",
         pt.calibration_x_mm::float8 AS "calibrationXmm",
         pt.calibration_y_mm::float8 AS "calibrationYmm",
         pt.template_body AS "templateBody",
         pt.template_digest AS "templateDigest",
         pt.template_version::int AS "templateVersion",
         pt.state,
         to_char(
           pt.created_at AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
         ) AS "createdAt"
  FROM print_templates pt
  LEFT JOIN treasury_units tu
    ON tu.organization_id = pt.organization_id AND tu.id = pt.treasury_unit_id
  LEFT JOIN banks b
    ON b.organization_id = pt.organization_id AND b.id = pt.bank_id
  LEFT JOIN cheque_books cb ON cb.id = pt.cheque_book_id
`;

function assertVisibleAndActive(reference: { state: string } | undefined): void {
  if (!reference) throw new ReferenceError('RESOURCE_HIDDEN');
  if (reference.state !== 'ACTIVE') throw new ReferenceError('INACTIVE_REFERENCE');
}

async function one<T extends object>(
  client: PoolClient,
  query: string,
  values: unknown[],
): Promise<T> {
  const result = await client.query<T>(query, values);
  if (!result.rows[0]) throw new ReferenceError('RESOURCE_HIDDEN');
  return compact(result.rows[0]) as T;
}

function compact<T extends object>(record: T): T {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== null),
  ) as T;
}
