import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';

import { DatabaseService } from '../database/database.service';
import {
  BranchCreateDto,
  CurrencyCreateDto,
  MethodCreateDto,
  TreasuryUnitCreateDto,
} from './master-data.dto';

export interface Page<T> {
  items: T[];
  page: { limit: number; hasMore: boolean; nextCursor?: string; asOf: string };
}

@Injectable()
export class MasterDataRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async organization(organizationId: string): Promise<Record<string, unknown> | null> {
    const result = await this.database.pool.query(`
      SELECT id, code, legal_name AS "legalName", timezone,
             base_currency AS "baseCurrency", state, version
      FROM organizations WHERE id = $1
    `, [organizationId]);
    return result.rows[0] ?? null;
  }

  listBranches(organizationId: string, limit: number, cursor?: string): Promise<Page<Record<string, unknown>>> {
    return this.list(`
      SELECT id, organization_id AS "organizationId", code, name, state, version
      FROM branches
      WHERE organization_id = $1 AND ($2::uuid IS NULL OR id > $2)
      ORDER BY id
      LIMIT $3
    `, [organizationId, cursor ?? null, limit + 1], limit);
  }

  createBranch(
    organizationId: string,
    dto: BranchCreateDto,
    idempotencyKey: string,
    requestDigest: string,
  ): Promise<Record<string, unknown>> {
    return this.idempotentCreate(organizationId, 'createBranch', idempotencyKey, requestDigest, async (client) => {
      const result = await client.query(`
        INSERT INTO branches (organization_id, code, name)
        VALUES ($1, $2, $3)
        RETURNING id, organization_id AS "organizationId", code, name, state, version
      `, [organizationId, dto.code, dto.name]);
      return result.rows[0];
    });
  }

  listTreasuryUnits(organizationId: string, limit: number, cursor?: string): Promise<Page<Record<string, unknown>>> {
    return this.list(`
      SELECT id, organization_id AS "organizationId", branch_id AS "branchId",
             code, name, default_currency AS "defaultCurrency", state, version
      FROM treasury_units
      WHERE organization_id = $1 AND ($2::uuid IS NULL OR id > $2)
      ORDER BY id
      LIMIT $3
    `, [organizationId, cursor ?? null, limit + 1], limit);
  }

  createTreasuryUnit(
    organizationId: string,
    dto: TreasuryUnitCreateDto,
    idempotencyKey: string,
    requestDigest: string,
  ): Promise<Record<string, unknown>> {
    return this.idempotentCreate(organizationId, 'createTreasuryUnit', idempotencyKey, requestDigest, async (client) => {
      if (dto.branchId) {
        const branch = await client.query(
          'SELECT 1 FROM branches WHERE id = $1 AND organization_id = $2 AND state = $3',
          [dto.branchId, organizationId, 'ACTIVE'],
        );
        if (!branch.rowCount) throw new ReferenceError('INACTIVE_BRANCH');
      }
      const currency = await client.query(
        'SELECT 1 FROM currencies WHERE organization_id = $1 AND code = $2 AND state = $3',
        [organizationId, dto.defaultCurrency, 'ACTIVE'],
      );
      if (!currency.rowCount) throw new ReferenceError('INACTIVE_CURRENCY');
      const result = await client.query(`
        INSERT INTO treasury_units (organization_id, branch_id, code, name, default_currency)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, organization_id AS "organizationId", branch_id AS "branchId",
                  code, name, default_currency AS "defaultCurrency", state, version
      `, [organizationId, dto.branchId ?? null, dto.code, dto.name, dto.defaultCurrency]);
      return result.rows[0];
    });
  }

  listCurrencies(organizationId: string, limit: number, cursor?: string): Promise<Page<Record<string, unknown>>> {
    return this.list(`
      SELECT code, name, english_name AS "englishName", symbol,
             decimal_places AS "decimalPlaces", base_currency AS "baseCurrency", state, version
      FROM currencies
      WHERE organization_id = $1 AND ($2::text IS NULL OR code > $2)
      ORDER BY code
      LIMIT $3
    `, [organizationId, cursor ?? null, limit + 1], limit, 'code');
  }

  createCurrency(
    organizationId: string,
    dto: CurrencyCreateDto,
    idempotencyKey: string,
    requestDigest: string,
  ): Promise<Record<string, unknown>> {
    return this.idempotentCreate(organizationId, 'createCurrency', idempotencyKey, requestDigest, async (client) => {
      if (dto.baseCurrency) {
        const existing = await client.query(
          'SELECT 1 FROM currencies WHERE organization_id = $1 AND base_currency',
          [organizationId],
        );
        if (existing.rowCount) throw new RangeError('BASE_CURRENCY_LOCKED');
      }
      const result = await client.query(`
        INSERT INTO currencies (
          organization_id, code, name, english_name, symbol, decimal_places, base_currency
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)
        RETURNING code, name, english_name AS "englishName", symbol,
                  decimal_places AS "decimalPlaces", base_currency AS "baseCurrency", state, version
      `, [
        organizationId,
        dto.code,
        dto.name,
        dto.englishName ?? null,
        dto.symbol ?? null,
        dto.decimalPlaces,
        dto.baseCurrency ?? false,
      ]);
      return result.rows[0];
    });
  }

  async listMethods(
    organizationId: string,
    limit: number,
    cursor?: string,
  ): Promise<Page<Record<string, unknown>>> {
    const result = await this.database.pool.query(`
      SELECT m.id, m.code, m.name, m.direction, m.behavior_category AS "behaviorCategory",
             m.creates_funds_in_transit AS "createsFundsInTransit",
             m.requires_approval AS "requiresApproval",
             (SELECT mapping_ref FROM method_mappings WHERE method_id = m.id AND mapping_kind = 'DEBIT') AS "debitMappingRef",
             (SELECT mapping_ref FROM method_mappings WHERE method_id = m.id AND mapping_kind = 'CREDIT') AS "creditMappingRef",
             (SELECT mapping_ref FROM method_mappings WHERE method_id = m.id AND mapping_kind = 'FEE') AS "feeMappingRef",
             (SELECT mapping_ref FROM method_mappings WHERE method_id = m.id AND mapping_kind = 'DISCREPANCY') AS "discrepancyMappingRef",
             (SELECT mapping_ref FROM method_mappings WHERE method_id = m.id AND mapping_kind = 'TEMPLATE') AS "templateMappingRef",
             m.state, m.version,
             COALESCE((
               SELECT jsonb_agg(r.reference ORDER BY r.reference)
               FROM method_required_references r WHERE r.method_id = m.id
             ), '[]') AS "requiredReferences",
             COALESCE((
               SELECT jsonb_agg(c.currency_code ORDER BY c.currency_code)
               FROM method_allowed_currencies c WHERE c.method_id = m.id
             ), '[]') AS "allowedCurrencies",
             COALESCE((
               SELECT jsonb_agg(jsonb_build_object('amount', l.amount::text, 'currency', l.currency_code) ORDER BY l.currency_code)
               FROM method_amount_limits l WHERE l.method_id = m.id
             ), '[]') AS "amountLimits"
      FROM method_definitions m
      WHERE m.organization_id = $1 AND ($2::uuid IS NULL OR m.id > $2)
      ORDER BY m.id
      LIMIT $3
    `, [organizationId, cursor ?? null, limit + 1]);
    return this.page(result.rows, limit);
  }

  createMethod(
    organizationId: string,
    dto: MethodCreateDto,
    idempotencyKey: string,
    requestDigest: string,
  ): Promise<Record<string, unknown>> {
    return this.idempotentCreate(organizationId, 'createMethodDefinition', idempotencyKey, requestDigest, async (client) => {
      const currencies = await client.query<{ code: string; decimal_places: number }>(`
        SELECT code, decimal_places FROM currencies
        WHERE organization_id = $1 AND state = 'ACTIVE' AND code = ANY($2::text[])
      `, [organizationId, dto.allowedCurrencies]);
      if (currencies.rowCount !== dto.allowedCurrencies.length) throw new ReferenceError('INACTIVE_CURRENCY');
      const decimalPlaces = new Map(currencies.rows.map((currency) => [
        currency.code,
        currency.decimal_places,
      ]));
      for (const limit of dto.amountLimits ?? []) {
        const fractionLength = limit.amount.split('.')[1]?.length ?? 0;
        if (fractionLength > (decimalPlaces.get(limit.currency) ?? -1)) {
          throw new RangeError('AMOUNT_PRECISION');
        }
      }

      const method = await client.query<{ id: string }>(`
        INSERT INTO method_definitions (
          organization_id, code, name, direction, behavior_category,
          creates_funds_in_transit, requires_approval
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)
        RETURNING id
      `, [
        organizationId, dto.code, dto.name, dto.direction, dto.behaviorCategory,
        dto.createsFundsInTransit, dto.requiresApproval,
      ]);
      const methodId = method.rows[0]!.id;
      const mappings = [
        ['DEBIT', dto.debitMappingRef],
        ['CREDIT', dto.creditMappingRef],
        ['FEE', dto.feeMappingRef],
        ['DISCREPANCY', dto.discrepancyMappingRef],
        ['TEMPLATE', dto.templateMappingRef],
      ] as const;
      for (const [kind, reference] of mappings) {
        if (reference) {
          await client.query(`
            INSERT INTO method_mappings (method_id, mapping_kind, mapping_ref)
            VALUES ($1,$2,$3)
          `, [methodId, kind, reference]);
        }
      }
      for (const reference of dto.requiredReferences) {
        await client.query(
          'INSERT INTO method_required_references (method_id, reference) VALUES ($1, $2)',
          [methodId, reference],
        );
      }
      for (const currency of dto.allowedCurrencies) {
        await client.query(`
          INSERT INTO method_allowed_currencies (method_id, organization_id, currency_code)
          VALUES ($1,$2,$3)
        `, [methodId, organizationId, currency]);
      }
      for (const limit of dto.amountLimits ?? []) {
        await client.query(`
          INSERT INTO method_amount_limits (method_id, currency_code, amount)
          VALUES ($1,$2,$3)
        `, [methodId, limit.currency, limit.amount]);
      }
      return {
        id: methodId,
        code: dto.code,
        name: dto.name,
        direction: dto.direction,
        behaviorCategory: dto.behaviorCategory,
        requiredReferences: [...dto.requiredReferences].sort(),
        createsFundsInTransit: dto.createsFundsInTransit,
        requiresApproval: dto.requiresApproval,
        allowedCurrencies: [...dto.allowedCurrencies].sort(),
        amountLimits: [...(dto.amountLimits ?? [])].sort((a, b) => a.currency.localeCompare(b.currency)),
        ...(dto.debitMappingRef ? { debitMappingRef: dto.debitMappingRef } : {}),
        ...(dto.creditMappingRef ? { creditMappingRef: dto.creditMappingRef } : {}),
        ...(dto.feeMappingRef ? { feeMappingRef: dto.feeMappingRef } : {}),
        ...(dto.discrepancyMappingRef ? { discrepancyMappingRef: dto.discrepancyMappingRef } : {}),
        ...(dto.templateMappingRef ? { templateMappingRef: dto.templateMappingRef } : {}),
        state: 'ACTIVE',
        version: 0,
      };
    });
  }

  private async list(
    query: string,
    values: unknown[],
    limit: number,
    cursorField = 'id',
  ): Promise<Page<Record<string, unknown>>> {
    const result = await this.database.pool.query(query, values);
    return this.page(result.rows, limit, cursorField);
  }

  private page(
    rows: Record<string, unknown>[],
    limit: number,
    cursorField = 'id',
  ): Page<Record<string, unknown>> {
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(omitNullProperties);
    const nextCursor = hasMore ? String(items.at(-1)?.[cursorField]) : undefined;
    return {
      items,
      page: {
        limit,
        hasMore,
        ...(nextCursor ? { nextCursor } : {}),
        asOf: new Date().toISOString(),
      },
    };
  }

  private async idempotentCreate<T extends Record<string, unknown>>(
    organizationId: string,
    scope: string,
    idempotencyKey: string,
    requestDigest: string,
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
      const response = omitNullProperties(await work(client)) as T;
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

function omitNullProperties<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== null),
  ) as T;
}
