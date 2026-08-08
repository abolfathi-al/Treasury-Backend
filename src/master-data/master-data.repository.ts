import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';

import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';
import { currencies, numberingRules } from '../database/schema';
import {
  BranchCreateDto,
  CurrencyCreateDto,
  MethodCreateDto,
  PartyCreateDto,
  PartyPage,
  PartyView,
  TreasuryUnitCreateDto,
} from './master-data.dto';

const POSTGRES_BIGINT_MAX = 9223372036854775807n;

export interface Page<T> {
  items: T[];
  page: { limit: number; hasMore: boolean; nextCursor?: string; asOf: string };
}

@Injectable()
export class MasterDataRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async findCurrencyDecimalPlaces(
    transaction: DatabaseTransaction,
    organizationId: string,
    currencyCodes: string[],
  ): Promise<Array<{ currency: string; decimalPlaces: number }>> {
    if (currencyCodes.length === 0) return [];
    return transaction
      .select({
        currency: currencies.code,
        decimalPlaces: currencies.decimalPlaces,
      })
      .from(currencies)
      .where(and(
        eq(currencies.organizationId, organizationId),
        inArray(currencies.code, currencyCodes),
        eq(currencies.state, 'ACTIVE'),
      ))
      .orderBy(currencies.code);
  }

  async reserveCashboxDayNumber(
    transaction: DatabaseTransaction,
    organizationId: string,
    branchId: string | null,
    treasuryUnitId: string,
    businessDate: string,
  ) {
    const rows = await transaction
      .select({
        id: numberingRules.id,
        version: numberingRules.version,
        branchId: numberingRules.branchId,
        treasuryUnitId: numberingRules.treasuryUnitId,
        fiscalYear: numberingRules.fiscalYear,
        fiscalYearStartsOn: numberingRules.fiscalYearStartsOn,
        fiscalYearEndsOn: numberingRules.fiscalYearEndsOn,
        prefix: numberingRules.prefix,
        numberWidth: numberingRules.numberWidth,
        nextValue: numberingRules.nextValue,
      })
      .from(numberingRules)
      .where(and(
        eq(numberingRules.organizationId, organizationId),
        eq(numberingRules.operation, 'CASHBOX_DAY_CLOSE'),
        branchId === null ? isNull(numberingRules.branchId) : eq(numberingRules.branchId, branchId),
        eq(numberingRules.treasuryUnitId, treasuryUnitId),
        eq(numberingRules.state, 'ACTIVE'),
        sql`${businessDate}::date BETWEEN ${numberingRules.fiscalYearStartsOn} AND ${numberingRules.fiscalYearEndsOn}`,
      ))
      .orderBy(numberingRules.id)
      .for('update')
      .limit(2);
    if (rows.length !== 1
      || String(rows[0]!.nextValue).length > rows[0]!.numberWidth
      || rows[0]!.nextValue === POSTGRES_BIGINT_MAX) {
      return undefined;
    }
    const rule = rows[0]!;
    const updated = await transaction
      .update(numberingRules)
      .set({
        nextValue: sql`${numberingRules.nextValue} + 1`,
        version: sql`${numberingRules.version} + 1`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(and(
        eq(numberingRules.organizationId, organizationId),
        eq(numberingRules.id, rule.id),
        eq(numberingRules.nextValue, rule.nextValue),
        eq(numberingRules.state, 'ACTIVE'),
      ))
      .returning({ id: numberingRules.id });
    return updated.length === 1 ? { ...rule, sequenceValue: rule.nextValue } : undefined;
  }

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

  async listParties(
    organizationId: string,
    limit: number,
    cursor?: string,
  ): Promise<PartyPage> {
    const result = await this.database.pool.query<PartyView>(`
      SELECT p.id, p.organization_id AS "organizationId", p.code,
             COALESCE((
               SELECT jsonb_agg(k.party_kind ORDER BY k.party_kind)
               FROM party_kinds k WHERE k.party_id = p.id
             ), '[]') AS "partyKinds",
             p.display_name AS "displayName", p.legal_name AS "legalName",
             p.national_id AS "nationalId", p.registration_id AS "registrationId",
             p.phone, p.email, p.notes, p.state, p.version,
             to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
             to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"
      FROM parties p
      WHERE p.organization_id = $1 AND ($2::uuid IS NULL OR p.id > $2)
      ORDER BY p.id
      LIMIT $3
    `, [organizationId, cursor ?? null, limit + 1]);
    return this.page(result.rows, limit);
  }

  createParty(
    organizationId: string,
    dto: PartyCreateDto,
    idempotencyKey: string,
    requestDigest: string,
  ): Promise<PartyView> {
    return this.idempotentCreate(
      organizationId,
      'createParty',
      idempotencyKey,
      requestDigest,
      async (client) => {
        const party = await client.query<PartyView>(`
          INSERT INTO parties (
            organization_id, code, display_name, legal_name, national_id,
            registration_id, phone, email, notes
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          RETURNING id, organization_id AS "organizationId", code,
                    display_name AS "displayName", legal_name AS "legalName",
                    national_id AS "nationalId", registration_id AS "registrationId",
                    phone, email, notes, state, version,
                    to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
                    to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"
        `, [
          organizationId,
          dto.code,
          dto.displayName,
          dto.legalName ?? null,
          dto.nationalId ?? null,
          dto.registrationId ?? null,
          dto.phone ?? null,
          dto.email ?? null,
          dto.notes ?? null,
        ]);
        const created = party.rows[0]!;
        for (const kind of dto.partyKinds) {
          await client.query(
            'INSERT INTO party_kinds (party_id, party_kind) VALUES ($1, $2)',
            [created.id, kind],
          );
        }
        return { ...created, partyKinds: [...dto.partyKinds].sort() };
      },
    );
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

  private page<T extends object>(
    rows: T[],
    limit: number,
    cursorField = 'id',
  ): Page<T> {
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(omitNullProperties);
    const nextCursor = hasMore
      ? String((items.at(-1) as Record<string, unknown> | undefined)?.[cursorField])
      : undefined;
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

  private async idempotentCreate<T extends object>(
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

function omitNullProperties<T extends object>(record: T): T {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== null),
  ) as T;
}
