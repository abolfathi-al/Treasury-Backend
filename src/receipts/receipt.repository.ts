import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { stableJson } from '../common/http';
import { DatabaseService } from '../database/database.service';
import {
  ReceiptAllocationInputDto,
  ReceiptCreateDto,
  ReceiptLineInputDto,
  ReceiptLineView,
  ReceiptRateSnapshot,
  ReceiptView,
} from './receipt.dto';

export interface ReceiptCursor {
  businessDate: string;
  id: string;
}

interface MethodFact {
  id: string;
  name: string;
  direction: string;
  category: string;
  createsFundsInTransit: boolean;
  requiresApproval: boolean;
  state: string;
  requiredReferences: string[];
  allowedCurrencies: string[];
  amountLimits: Array<{ currency: string; amount: string }>;
  mappingCount: number;
}

interface DerivedLine {
  id: string;
  input: ReceiptLineInputDto;
  method: MethodFact;
  baseAmount: string;
  rate: ReceiptRateSnapshot;
}

interface DraftFacts {
  enteredAt: Date;
  baseScale: number;
  lines: DerivedLine[];
  totalBaseAmount: string;
  methodCategories: string[];
  currencies: string[];
  cashboxIds: string[];
  bankAccountIds: string[];
}

interface ReceiptAuthorizationSnapshot {
  branchId: string | null;
  treasuryUnitId: string;
  cashboxIds: string[];
  bankAccountIds: string[];
  methodCategories: string[];
  currencies: string[];
  baseCurrency: string;
  totalBaseAmount: string;
}

interface ReceiptIdempotencyEnvelope {
  response: ReceiptView;
  authorizationSnapshot: ReceiptAuthorizationSnapshot;
}

interface ReceiptLineRow extends ReceiptLineView {
  receiptId: string;
  chequeInput?: Record<string, unknown>;
  chequeBankId?: string;
  chequeBankBranchId?: string;
  chequePayerPartyId?: string;
}

@Injectable()
export class ReceiptRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async list(
    organizationId: string,
    actorUserId: string,
    limit: number,
    cursor?: ReceiptCursor,
    from?: string,
    to?: string,
  ): Promise<{ items: ReceiptView[]; hasMore: boolean }> {
    const client = await this.database.pool.connect();
    try {
      const result = await client.query<{ id: string }>(`
        SELECT rd.id
        FROM receipt_documents rd
        WHERE rd.organization_id = $1
          AND ($3::date IS NULL OR rd.business_date >= $3)
          AND ($4::date IS NULL OR rd.business_date <= $4)
          AND (
            $5::date IS NULL
            OR (rd.business_date, rd.id) < ($5::date, $6::uuid)
          )
          AND ${storedScopeSql('receipt.view')}
        ORDER BY rd.business_date DESC, rd.id DESC
        LIMIT $7
      `, [
        organizationId,
        actorUserId,
        from ?? null,
        to ?? null,
        cursor?.businessDate ?? null,
        cursor?.id ?? null,
        limit + 1,
      ]);
      const ids = result.rows.slice(0, limit).map(({ id }) => id);
      return {
        items: await this.views(client, organizationId, ids),
        hasMore: result.rows.length > limit,
      };
    } finally {
      client.release();
    }
  }

  async get(
    organizationId: string,
    actorUserId: string,
    receiptId: string,
  ): Promise<ReceiptView> {
    const client = await this.database.pool.connect();
    try {
      const visible = await client.query(`
        SELECT 1 FROM receipt_documents rd
        WHERE rd.organization_id = $1 AND rd.id = $3
          AND ${storedScopeSql('receipt.view')}
      `, [organizationId, actorUserId, receiptId]);
      if (!visible.rowCount) throw new Error('RESOURCE_HIDDEN');
      return (await this.views(client, organizationId, [receiptId]))[0]!;
    } finally {
      client.release();
    }
  }

  create(
    organizationId: string,
    actorUserId: string,
    dto: ReceiptCreateDto,
    idempotencyKey: string,
    requestDigest: string,
    enteredAt: Date,
  ): Promise<ReceiptView> {
    return this.idempotent(
      organizationId,
      `createReceipt:${actorUserId}`,
      idempotencyKey,
      requestDigest,
      201,
      async (client, replay) => {
        if (!await this.scopeFactsAllowed(
          client,
          organizationId,
          actorUserId,
          'receipt.create',
          replay.authorizationSnapshot,
        )) throw new Error('SCOPE_DENIED');
      },
      async (client) => {
        const facts = await this.derive(
          client,
          organizationId,
          actorUserId,
          'receipt.create',
          dto,
          enteredAt,
        );
        if (!await this.inputScopeAllowed(
          client, organizationId, actorUserId, 'receipt.create', dto, facts,
        )) throw new Error('SCOPE_DENIED');
        const receiptId = randomUUID();
        const counter = await client.query<{ value: string }>(`
          INSERT INTO receipt_number_counters (organization_id, business_date, next_value)
          VALUES ($1,$2,1)
          ON CONFLICT (organization_id, business_date)
          DO UPDATE SET next_value = receipt_number_counters.next_value + 1
          RETURNING next_value::text AS value
        `, [organizationId, dto.businessDate]);
        const businessNumber =
          `RCP-${dto.businessDate.replaceAll('-', '')}-${counter.rows[0]!.value.padStart(6, '0')}`;
        await this.insertDocument(
          client, receiptId, organizationId, actorUserId, businessNumber, dto, facts,
        );
        await this.insertLines(client, receiptId, organizationId, dto.baseCurrency, facts.lines);
        return {
          response: (await this.views(client, organizationId, [receiptId]))[0]!,
          authorizationSnapshot: this.authorizationSnapshot(dto, facts),
        };
      },
    );
  }

  replace(
    organizationId: string,
    actorUserId: string,
    receiptId: string,
    dto: ReceiptCreateDto,
    idempotencyKey: string,
    requestDigest: string,
    expectedVersion: number,
  ): Promise<ReceiptView> {
    return this.idempotent(
      organizationId,
      `replaceReceiptDraft:${actorUserId}:${receiptId}`,
      idempotencyKey,
      requestDigest,
      200,
      async (client, replay) => {
        if (!await this.scopeFactsAllowed(
          client,
          organizationId,
          actorUserId,
          'receipt.edit-draft',
          replay.authorizationSnapshot,
        )) throw new Error('SCOPE_DENIED');
      },
      async (client) => {
        if (!await this.storedScopeAllowed(
          client, organizationId, actorUserId, receiptId, 'receipt.edit-draft',
        )) throw new Error('SCOPE_DENIED');
        const current = await client.query<{
          state: string;
          version: string;
          entered_at: Date;
        }>(`
          SELECT state, version::text, entered_at
          FROM receipt_documents
          WHERE organization_id = $1 AND id = $2
          FOR UPDATE
        `, [organizationId, receiptId]);
        if (!current.rowCount) throw new Error('RESOURCE_HIDDEN');
        if (current.rows[0]!.state !== 'DRAFT') throw new Error('STATE_CONFLICT');
        if (Number(current.rows[0]!.version) !== expectedVersion) {
          throw new Error('STALE_VERSION');
        }
        const facts = await this.derive(
          client,
          organizationId,
          actorUserId,
          'receipt.edit-draft',
          dto,
          current.rows[0]!.entered_at,
        );
        if (!await this.inputScopeAllowed(
          client, organizationId, actorUserId, 'receipt.edit-draft', dto, facts,
        )) throw new Error('SCOPE_DENIED');

        await client.query(`
          DELETE FROM receipt_line_attachment_links
          WHERE organization_id = $1
            AND receipt_line_id IN (
              SELECT id FROM receipt_lines
              WHERE organization_id = $1 AND receipt_document_id = $2
            )
        `, [organizationId, receiptId]);
        await client.query(`
          DELETE FROM receipt_allocations
          WHERE organization_id = $1
            AND receipt_line_id IN (
              SELECT id FROM receipt_lines
              WHERE organization_id = $1 AND receipt_document_id = $2
            )
        `, [organizationId, receiptId]);
        await client.query(`
          DELETE FROM receipt_lines
          WHERE organization_id = $1 AND receipt_document_id = $2
        `, [organizationId, receiptId]);
        await client.query(`
          UPDATE receipt_documents SET
            business_date = $3, party_id = $4, branch_id = $5,
            treasury_unit_id = $6, base_currency = $7, total_base_amount = $8,
            description = $9, purpose = $10, contract_ref = $11, invoice_ref = $12,
            order_ref = $13, project_ref = $14, cost_center_ref = $15,
            version = version + 1, updated_at = now()
          WHERE organization_id = $1 AND id = $2
        `, [
          organizationId,
          receiptId,
          dto.businessDate,
          dto.partyId,
          dto.branchId ?? null,
          dto.treasuryUnitId,
          dto.baseCurrency,
          facts.totalBaseAmount,
          dto.description ?? null,
          dto.purpose ?? null,
          dto.contractRef ?? null,
          dto.invoiceRef ?? null,
          dto.orderRef ?? null,
          dto.projectRef ?? null,
          dto.costCenterRef ?? null,
        ]);
        await this.insertLines(client, receiptId, organizationId, dto.baseCurrency, facts.lines);
        return {
          response: (await this.views(client, organizationId, [receiptId]))[0]!,
          authorizationSnapshot: this.authorizationSnapshot(dto, facts),
        };
      },
    );
  }

  private async derive(
    client: PoolClient,
    organizationId: string,
    actorUserId: string,
    permission: 'receipt.create' | 'receipt.edit-draft',
    dto: ReceiptCreateDto,
    enteredAt: Date,
  ): Promise<DraftFacts> {
    if (!await this.preScopeAllowed(
      client,
      organizationId,
      actorUserId,
      permission,
      dto,
    )) throw new Error('SCOPE_DENIED');
    const header = await client.query<{
      party_state: string;
      unit_state: string;
      unit_branch_id: string | null;
      branch_state: string | null;
      currency_state: string;
      decimal_places: number;
      actor_state: string;
    }>(`
      SELECT p.state AS party_state, tu.state AS unit_state,
             tu.branch_id AS unit_branch_id, b.state AS branch_state,
             c.state AS currency_state, c.decimal_places, u.state AS actor_state
      FROM parties p
      JOIN treasury_units tu
        ON tu.organization_id = p.organization_id AND tu.id = $3
      JOIN currencies c
        ON c.organization_id = p.organization_id AND c.code = $5
      JOIN user_refs u
        ON u.organization_id = p.organization_id AND u.id = $6
      LEFT JOIN branches b
        ON b.organization_id = p.organization_id AND b.id = $4
      WHERE p.organization_id = $1 AND p.id = $2
      FOR SHARE OF p, tu, c, u
    `, [
      organizationId,
      dto.partyId,
      dto.treasuryUnitId,
      dto.branchId ?? null,
      dto.baseCurrency,
      actorUserId,
    ]);
    if (!header.rowCount || (dto.branchId && header.rows[0]!.branch_state === null)) {
      throw new Error('RESOURCE_HIDDEN');
    }
    const head = header.rows[0]!;
    if ([head.party_state, head.unit_state, head.currency_state, head.actor_state, head.branch_state]
      .some((state) => state !== null && state !== 'ACTIVE')) {
      throw new Error('INACTIVE_REFERENCE');
    }
    if (dto.branchId && head.unit_branch_id !== dto.branchId) throw new Error('VALIDATION');

    const currencyCodes = [...new Set([
      dto.baseCurrency,
      ...dto.lines.map(({ money }) => money.currency),
    ])];
    const currencies = await client.query<{
      code: string;
      decimal_places: number;
      state: string;
    }>(`
      SELECT code, decimal_places, state FROM currencies
      WHERE organization_id = $1 AND code = ANY($2::varchar[])
      FOR SHARE
    `, [organizationId, currencyCodes]);
    if (currencies.rowCount !== currencyCodes.length) throw new Error('RESOURCE_HIDDEN');
    if (currencies.rows.some(({ state }) => state !== 'ACTIVE')) {
      throw new Error('INACTIVE_REFERENCE');
    }
    const scales = new Map(currencies.rows.map((row) => [row.code, row.decimal_places]));

    const methodIds = [...new Set(dto.lines.map(({ methodId }) => methodId))];
    const methods = await client.query<MethodFact>(`
      SELECT md.id, md.name, md.direction, md.behavior_category AS category,
             md.creates_funds_in_transit AS "createsFundsInTransit",
             md.requires_approval AS "requiresApproval", md.state,
             coalesce(refs.value, '[]'::jsonb) AS "requiredReferences",
             coalesce(allowed.value, '[]'::jsonb) AS "allowedCurrencies",
             coalesce(limits.value, '[]'::jsonb) AS "amountLimits",
             mappings.count::int AS "mappingCount"
      FROM method_definitions md
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(reference ORDER BY reference) AS value
        FROM method_required_references WHERE method_id = md.id
      ) refs ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(currency_code ORDER BY currency_code) AS value
        FROM method_allowed_currencies WHERE method_id = md.id
      ) allowed ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'currency', currency_code, 'amount', amount::text
        ) ORDER BY currency_code) AS value
        FROM method_amount_limits WHERE method_id = md.id
      ) limits ON true
      LEFT JOIN LATERAL (
        SELECT count(*) AS count FROM method_mappings WHERE method_id = md.id
      ) mappings ON true
      WHERE md.organization_id = $1 AND md.id = ANY($2::uuid[])
      FOR SHARE OF md
    `, [organizationId, methodIds]);
    if (methods.rowCount !== methodIds.length) throw new Error('RESOURCE_HIDDEN');
    const methodMap = new Map(methods.rows.map((method) => [method.id, method]));

    const resources = await this.resourceFacts(client, organizationId, dto);
    const attachmentMap = await this.attachmentFacts(client, organizationId, dto);
    const rateCache = new Map<string, ReceiptRateSnapshot>();
    const lines: DerivedLine[] = [];
    let totalScaled = 0n;
    for (const line of dto.lines) {
      const method = methodMap.get(line.methodId)!;
      if (method.state !== 'ACTIVE') throw new Error('INACTIVE_REFERENCE');
      if (!['RECEIPT', 'BOTH'].includes(method.direction)) throw new Error('METHOD_INVALID');
      const sourceScale = scales.get(line.money.currency)!;
      if (decimalPlaces(line.money.amount) > sourceScale) throw new Error('VALIDATION');
      if (!method.allowedCurrencies.includes(line.money.currency)) {
        throw new Error('METHOD_INVALID');
      }
      const limit = method.amountLimits.find(({ currency }) => currency === line.money.currency);
      if (limit && compareDecimal(line.money.amount, limit.amount) > 0) {
        throw new Error('METHOD_INVALID');
      }
      this.validateLine(method, line, dto, resources, attachmentMap);

      let rate = rateCache.get(line.money.currency);
      if (!rate) {
        rate = line.money.currency === dto.baseCurrency
          ? identityRate(line.money.amount, dto.baseCurrency, enteredAt)
          : await this.tableRate(
            client,
            line.money.currency,
            dto.baseCurrency,
            line.money.amount,
            head.decimal_places,
            enteredAt,
          );
        rateCache.set(line.money.currency, rate);
      } else {
        rate = { ...rate, targetAmount: deriveTarget(
          line.money.amount, rate.rate, head.decimal_places,
        ).targetAmount, roundingDifference: deriveTarget(
          line.money.amount, rate.rate, head.decimal_places,
        ).roundingDifference };
      }
      const baseAmount = rate.targetAmount;
      const allocationTotal = (line.allocations ?? []).reduce(
        (sum, allocation) => sum + scaled(allocation.baseMoney.amount, head.decimal_places),
        0n,
      );
      const baseScaled = scaled(baseAmount, head.decimal_places);
      if (allocationTotal > baseScaled) throw new Error('ALLOCATION_EXCEEDED');
      totalScaled += baseScaled;
      lines.push({ id: randomUUID(), input: line, method, baseAmount, rate });
    }

    const cashboxIds = [...new Set(dto.lines.flatMap((line) =>
      line.cashboxId ? [line.cashboxId] : []))];
    const bankAccountIds = [...new Set([
      ...dto.lines.flatMap((line) => line.bankAccountId ? [line.bankAccountId] : []),
      ...resources.pos.map(({ bankAccountId }) => bankAccountId),
      ...resources.gateway.map(({ bankAccountId }) => bankAccountId),
    ])];
    return {
      enteredAt,
      baseScale: head.decimal_places,
      lines,
      totalBaseAmount: formatScaled(totalScaled, head.decimal_places),
      methodCategories: [...new Set(lines.map(({ method }) => method.category))],
      currencies: currencyCodes,
      cashboxIds,
      bankAccountIds,
    };
  }

  private validateLine(
    method: MethodFact,
    line: ReceiptLineInputDto,
    dto: ReceiptCreateDto,
    resources: Awaited<ReturnType<ReceiptRepository['resourceFacts']>>,
    attachments: Map<string, { state: string; digest: string }>,
  ): void {
    const anchors = [
      line.cashboxId, line.bankAccountId, line.posTerminalId,
      line.paymentGatewayId, line.cheque,
    ].filter(Boolean);
    const expected: Record<string, keyof ReceiptLineInputDto | undefined> = {
      CASH: 'cashboxId',
      CHEQUE: 'cheque',
      BANK_TRANSFER: 'bankAccountId',
      DIRECT_DEPOSIT: 'bankAccountId',
      CARD_TRANSFER: 'bankAccountId',
      FOREIGN_REMITTANCE: 'bankAccountId',
      POS: 'posTerminalId',
      GATEWAY: 'paymentGatewayId',
    };
    const expectedAnchor = expected[method.category];
    if (
      (expectedAnchor && (anchors.length !== 1 || !line[expectedAnchor]))
      || (!expectedAnchor && anchors.length > 0)
    ) throw new Error('METHOD_INVALID');
    if (
      method.category === 'OTHER_CONTROLLED'
      && (method.mappingCount !== 5 || !method.requiresApproval)
    ) throw new Error('METHOD_INVALID');
    const present: Record<string, boolean> = {
      CASHBOX: Boolean(line.cashboxId),
      BANK_ACCOUNT: Boolean(line.bankAccountId),
      CHEQUE: Boolean(line.cheque),
      POS: Boolean(line.posTerminalId),
      GATEWAY: Boolean(line.paymentGatewayId),
      TRACKING_NUMBER: Boolean(line.trackingNumber?.trim()),
      DUE_DATE: Boolean(line.dueDate),
      PARTY: Boolean(dto.partyId),
      EVIDENCE: Boolean(line.attachments?.length),
    };
    if (method.requiredReferences.some((reference) => !present[reference])) {
      throw new Error('RECEIPT_INCOMPLETE');
    }
    if (line.cashboxId) {
      const row = resources.cashbox.find(({ id }) => id === line.cashboxId);
      if (!row) throw new Error('RESOURCE_HIDDEN');
      if (row.state !== 'ACTIVE') throw new Error('INACTIVE_REFERENCE');
      if (!row.canReceive || row.treasuryUnitId !== dto.treasuryUnitId
        || !row.currencies.includes(line.money.currency)) throw new Error('METHOD_INVALID');
    }
    if (line.bankAccountId) {
      const row = resources.account.find(({ id }) => id === line.bankAccountId);
      if (!row) throw new Error('RESOURCE_HIDDEN');
      if (row.state !== 'ACTIVE') throw new Error('INACTIVE_REFERENCE');
      if (!row.canReceive || row.currency !== line.money.currency
        || (row.treasuryUnitId && row.treasuryUnitId !== dto.treasuryUnitId)) {
        throw new Error('METHOD_INVALID');
      }
    }
    for (const [id, rows] of [
      [line.posTerminalId, resources.pos],
      [line.paymentGatewayId, resources.gateway],
    ] as const) {
      if (!id) continue;
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) throw new Error('RESOURCE_HIDDEN');
      if (row.state !== 'ACTIVE' || row.accountState !== 'ACTIVE') {
        throw new Error('INACTIVE_REFERENCE');
      }
      if (!row.canReceive || row.currency !== line.money.currency
        || row.treasuryUnitId !== dto.treasuryUnitId) throw new Error('METHOD_INVALID');
    }
    if (line.cheque) {
      const cheque = resources.cheque.find(({ bankId, branchId, payerPartyId }) =>
        bankId === line.cheque!.bankId
        && branchId === (line.cheque!.bankBranchId ?? null)
        && payerPartyId === (line.cheque!.payerPartyId ?? null));
      if (!cheque) throw new Error('RESOURCE_HIDDEN');
      if ([cheque.bankState, cheque.branchState, cheque.payerState]
        .some((state) => state !== null && state !== 'ACTIVE')) {
        throw new Error('INACTIVE_REFERENCE');
      }
    }
    for (const attachment of line.attachments ?? []) {
      const row = attachments.get(`${attachment.id}:${attachment.contentDigest}`);
      if (!row) throw new Error('RECEIPT_INCOMPLETE');
      if (row.state !== 'ACTIVE') throw new Error('INACTIVE_REFERENCE');
    }
  }

  private async tableRate(
    client: PoolClient,
    source: string,
    target: string,
    amount: string,
    targetScale: number,
    enteredAt: Date,
  ): Promise<ReceiptRateSnapshot> {
    const result = await client.query<{
      id: string;
      rate: string;
      rate_type: string;
      source_name: string;
      valid_at: Date;
    }>(`
      SELECT id, rate::text, rate_type, source_name, valid_at
      FROM exchange_rates
      WHERE source_currency = $1 AND target_currency = $2
        AND state = 'APPROVED'
        AND valid_at = (
          SELECT max(valid_at) FROM exchange_rates
          WHERE source_currency = $1 AND target_currency = $2
            AND state = 'APPROVED' AND valid_at <= $3
        )
      ORDER BY id
      LIMIT 2
      FOR SHARE
    `, [source, target, enteredAt]);
    if (result.rowCount !== 1) throw new Error('RATE_INVALID');
    const row = result.rows[0]!;
    const derived = deriveTarget(amount, row.rate, targetScale);
    return {
      sourceCurrency: source,
      targetCurrency: target,
      rate: row.rate,
      rateType: row.rate_type,
      rateSource: 'TABLE',
      ratedAt: instant(row.valid_at),
      rateRecordId: row.id,
      targetAmount: derived.targetAmount,
      roundingDifference: derived.roundingDifference,
    };
  }

  private async resourceFacts(
    client: PoolClient,
    organizationId: string,
    dto: ReceiptCreateDto,
  ) {
    const cashboxIds = dto.lines.flatMap((line) => line.cashboxId ? [line.cashboxId] : []);
    const accountIds = dto.lines.flatMap((line) => line.bankAccountId ? [line.bankAccountId] : []);
    const posIds = dto.lines.flatMap((line) => line.posTerminalId ? [line.posTerminalId] : []);
    const gatewayIds =
      dto.lines.flatMap((line) => line.paymentGatewayId ? [line.paymentGatewayId] : []);
    const chequeInputs = dto.lines.flatMap((line) => line.cheque ? [line.cheque] : []);
    const cashbox = cashboxIds.length === 0 ? [] : (await client.query<{
      id: string; state: string; canReceive: boolean; treasuryUnitId: string;
      currencies: string[];
    }>(`
      SELECT c.id, c.state, c.can_receive AS "canReceive",
             c.treasury_unit_id AS "treasuryUnitId",
             ARRAY(
               SELECT selected.currency
               FROM (
                 SELECT c.main_currency AS currency
                 UNION
                 SELECT cc.currency
                 FROM cashbox_currency_controls cc
                 WHERE cc.cashbox_id = c.id
               ) selected
               ORDER BY selected.currency
             ) AS currencies
      FROM cashboxes c
      WHERE c.organization_id = $1 AND c.id = ANY($2::uuid[])
      FOR SHARE OF c
    `, [organizationId, cashboxIds])).rows;
    const account = accountIds.length === 0 ? [] : (await client.query<{
      id: string; state: string; canReceive: boolean; currency: string;
      treasuryUnitId: string | null;
    }>(`
      SELECT id, state, can_receive AS "canReceive", currency,
             treasury_unit_id AS "treasuryUnitId"
      FROM bank_accounts
      WHERE organization_id = $1 AND id = ANY($2::uuid[])
      FOR SHARE
    `, [organizationId, accountIds])).rows;
    const pos = posIds.length === 0 ? [] : (await client.query<{
      id: string; state: string; currency: string; treasuryUnitId: string;
      bankAccountId: string; accountState: string; canReceive: boolean;
    }>(`
      SELECT p.id, p.state, p.currency, p.treasury_unit_id AS "treasuryUnitId",
             p.bank_account_id AS "bankAccountId", a.state AS "accountState",
             a.can_receive AS "canReceive"
      FROM pos_terminals p
      JOIN bank_accounts a
        ON a.organization_id = p.organization_id AND a.id = p.bank_account_id
      WHERE p.organization_id = $1 AND p.id = ANY($2::uuid[])
      FOR SHARE OF p, a
    `, [organizationId, posIds])).rows;
    const gateway = gatewayIds.length === 0 ? [] : (await client.query<{
      id: string; state: string; currency: string; treasuryUnitId: string;
      bankAccountId: string; accountState: string; canReceive: boolean;
    }>(`
      SELECT g.id, g.state, g.currency, g.treasury_unit_id AS "treasuryUnitId",
             g.bank_account_id AS "bankAccountId", a.state AS "accountState",
             a.can_receive AS "canReceive"
      FROM payment_gateways g
      JOIN bank_accounts a
        ON a.organization_id = g.organization_id AND a.id = g.bank_account_id
      WHERE g.organization_id = $1 AND g.id = ANY($2::uuid[])
      FOR SHARE OF g, a
    `, [organizationId, gatewayIds])).rows;
    const cheque = [];
    for (const input of chequeInputs) {
      const row = await client.query<{
        bankId: string; branchId: string | null; payerPartyId: string | null;
        bankState: string; branchState: string | null; payerState: string | null;
      }>(`
        SELECT b.id AS "bankId", bb.id AS "branchId", p.id AS "payerPartyId",
               b.state AS "bankState", bb.state AS "branchState", p.state AS "payerState"
        FROM banks b
        LEFT JOIN bank_branches bb
          ON bb.organization_id = b.organization_id AND bb.bank_id = b.id AND bb.id = $3
        LEFT JOIN parties p
          ON p.organization_id = b.organization_id AND p.id = $4
        WHERE b.organization_id = $1 AND b.id = $2
      `, [
        organizationId,
        input.bankId,
        input.bankBranchId ?? null,
        input.payerPartyId ?? null,
      ]);
      if (!row.rowCount
        || (input.bankBranchId && !row.rows[0]!.branchId)
        || (input.payerPartyId && !row.rows[0]!.payerPartyId)) continue;
      cheque.push(row.rows[0]!);
    }
    return { cashbox, account, pos, gateway, cheque };
  }

  private async attachmentFacts(
    client: PoolClient,
    organizationId: string,
    dto: ReceiptCreateDto,
  ): Promise<Map<string, { state: string; digest: string }>> {
    const submitted = dto.lines.flatMap((line) => line.attachments ?? []);
    if (submitted.length === 0) return new Map();
    const rows = await client.query<{ id: string; digest: string; state: string }>(`
      SELECT id, content_digest AS digest, state
      FROM attachments
      WHERE organization_id = $1 AND id = ANY($2::uuid[])
      FOR SHARE
    `, [organizationId, submitted.map(({ id }) => id)]);
    return new Map(rows.rows.map((row) => [`${row.id}:${row.digest}`, row]));
  }

  private async preScopeAllowed(
    client: PoolClient,
    organizationId: string,
    actorUserId: string,
    permission: string,
    dto: ReceiptCreateDto,
  ): Promise<boolean> {
    const cashboxIds = [...new Set(dto.lines.flatMap((line) =>
      line.cashboxId ? [line.cashboxId] : []))];
    const bankAccountIds = [...new Set(dto.lines.flatMap((line) =>
      line.bankAccountId ? [line.bankAccountId] : []))];
    const posIds = [...new Set(dto.lines.flatMap((line) =>
      line.posTerminalId ? [line.posTerminalId] : []))];
    const gatewayIds = [...new Set(dto.lines.flatMap((line) =>
      line.paymentGatewayId ? [line.paymentGatewayId] : []))];
    const methodIds = [...new Set(dto.lines.map(({ methodId }) => methodId))];
    const currencies = [...new Set([
      dto.baseCurrency,
      ...dto.lines.map(({ money }) => money.currency),
    ])];
    const result = await client.query<{ allowed: boolean }>(`
      WITH requested_bank_accounts AS (
        SELECT unnest($7::uuid[]) AS id
        UNION
        SELECT p.bank_account_id
        FROM pos_terminals p
        WHERE p.organization_id = $1 AND p.id = ANY($8::uuid[])
        UNION
        SELECT g.bank_account_id
        FROM payment_gateways g
        WHERE g.organization_id = $1 AND g.id = ANY($9::uuid[])
      )
      SELECT EXISTS (
        SELECT 1
        FROM access_grants ag
        JOIN roles r ON r.id = ag.role_id AND r.state = 'ACTIVE'
        JOIN role_permissions rp ON rp.role_id = r.id AND rp.permission = $3
        WHERE ag.organization_id = $1 AND ag.user_ref_id = $2
          AND ag.state = 'ACTIVE' AND ag.valid_from <= now()
          AND (ag.valid_to IS NULL OR ag.valid_to > now())
          AND (
            ag.organization_wide OR (
              (NOT EXISTS (SELECT 1 FROM access_grant_branch_scopes s
                  WHERE s.access_grant_id = ag.id)
                OR ($4::uuid IS NOT NULL
                  AND EXISTS (SELECT 1 FROM access_grant_branch_scopes s
                    WHERE s.access_grant_id = ag.id AND s.branch_id = $4)))
              AND (NOT EXISTS (SELECT 1 FROM access_grant_treasury_unit_scopes s
                  WHERE s.access_grant_id = ag.id)
                OR EXISTS (SELECT 1 FROM access_grant_treasury_unit_scopes s
                  WHERE s.access_grant_id = ag.id AND s.treasury_unit_id = $5))
              AND (NOT EXISTS (SELECT 1 FROM access_grant_cashbox_scopes s
                  WHERE s.access_grant_id = ag.id)
                OR (
                  cardinality($6::uuid[]) > 0
                  AND NOT EXISTS (SELECT 1 FROM unnest($6::uuid[]) requested
                    WHERE NOT EXISTS (SELECT 1 FROM access_grant_cashbox_scopes s
                      WHERE s.access_grant_id = ag.id AND s.cashbox_id = requested))
                ))
              AND (NOT EXISTS (SELECT 1 FROM access_grant_bank_account_scopes s
                  WHERE s.access_grant_id = ag.id)
                OR (
                  EXISTS (SELECT 1 FROM requested_bank_accounts)
                  AND NOT EXISTS (SELECT 1 FROM requested_bank_accounts requested
                    WHERE NOT EXISTS (SELECT 1 FROM access_grant_bank_account_scopes s
                      WHERE s.access_grant_id = ag.id
                        AND s.bank_account_id = requested.id))
                ))
              AND (NOT EXISTS (SELECT 1 FROM access_grant_document_type_scopes s
                  WHERE s.access_grant_id = ag.id)
                OR EXISTS (SELECT 1 FROM access_grant_document_type_scopes s
                  WHERE s.access_grant_id = ag.id AND s.document_type = 'RECEIPT'))
              AND (NOT EXISTS (SELECT 1 FROM access_grant_method_category_scopes s
                  WHERE s.access_grant_id = ag.id)
                OR NOT EXISTS (SELECT 1 FROM unnest($10::uuid[]) requested
                  WHERE NOT EXISTS (
                    SELECT 1
                    FROM method_definitions md
                    JOIN access_grant_method_category_scopes s
                      ON s.access_grant_id = ag.id
                        AND s.method_category = md.behavior_category
                    WHERE md.organization_id = $1 AND md.id = requested
                  )))
              AND (NOT EXISTS (SELECT 1 FROM access_grant_currency_scopes s
                  WHERE s.access_grant_id = ag.id)
                OR NOT EXISTS (SELECT 1 FROM unnest($11::varchar[]) requested
                  WHERE NOT EXISTS (SELECT 1 FROM access_grant_currency_scopes s
                    WHERE s.access_grant_id = ag.id AND s.currency = requested)))
              AND (
                ag.amount_ceiling IS NULL OR ag.amount_ceiling_currency = $12
              )
            )
          )
      ) AS allowed
    `, [
      organizationId,
      actorUserId,
      permission,
      dto.branchId ?? null,
      dto.treasuryUnitId,
      cashboxIds,
      bankAccountIds,
      posIds,
      gatewayIds,
      methodIds,
      currencies,
      dto.baseCurrency,
    ]);
    return result.rows[0]!.allowed;
  }

  private async inputScopeAllowed(
    client: PoolClient,
    organizationId: string,
    actorUserId: string,
    permission: string,
    dto: ReceiptCreateDto,
    facts: DraftFacts,
  ): Promise<boolean> {
    return this.scopeFactsAllowed(
      client,
      organizationId,
      actorUserId,
      permission,
      this.authorizationSnapshot(dto, facts),
    );
  }

  private authorizationSnapshot(
    dto: ReceiptCreateDto,
    facts: DraftFacts,
  ): ReceiptAuthorizationSnapshot {
    return {
      branchId: dto.branchId ?? null,
      treasuryUnitId: dto.treasuryUnitId,
      cashboxIds: facts.cashboxIds,
      bankAccountIds: facts.bankAccountIds,
      methodCategories: facts.methodCategories,
      currencies: facts.currencies,
      baseCurrency: dto.baseCurrency,
      totalBaseAmount: facts.totalBaseAmount,
    };
  }

  private async scopeFactsAllowed(
    client: PoolClient,
    organizationId: string,
    actorUserId: string,
    permission: string,
    facts: ReceiptAuthorizationSnapshot,
  ): Promise<boolean> {
    const result = await client.query<{ allowed: boolean }>(`
      SELECT EXISTS (
        SELECT 1
        FROM access_grants ag
        JOIN roles r ON r.id = ag.role_id AND r.state = 'ACTIVE'
        JOIN role_permissions rp ON rp.role_id = r.id AND rp.permission = $3
        WHERE ag.organization_id = $1 AND ag.user_ref_id = $2
          AND ag.state = 'ACTIVE' AND ag.valid_from <= now()
          AND (ag.valid_to IS NULL OR ag.valid_to > now())
          AND (
            ag.organization_wide OR (
              (NOT EXISTS (
                  SELECT 1 FROM access_grant_branch_scopes s WHERE s.access_grant_id = ag.id)
                OR ($4::uuid IS NOT NULL AND EXISTS (
                  SELECT 1 FROM access_grant_branch_scopes s
                  WHERE s.access_grant_id = ag.id AND s.branch_id = $4)))
              AND (NOT EXISTS (SELECT 1 FROM access_grant_treasury_unit_scopes s WHERE s.access_grant_id = ag.id)
                OR EXISTS (SELECT 1 FROM access_grant_treasury_unit_scopes s
                  WHERE s.access_grant_id = ag.id AND s.treasury_unit_id = $5))
              AND (NOT EXISTS (SELECT 1 FROM access_grant_cashbox_scopes s WHERE s.access_grant_id = ag.id)
                OR (
                  cardinality($6::uuid[]) > 0
                  AND NOT EXISTS (SELECT 1 FROM unnest($6::uuid[]) x
                    WHERE NOT EXISTS (SELECT 1 FROM access_grant_cashbox_scopes s
                      WHERE s.access_grant_id = ag.id AND s.cashbox_id = x))
                ))
              AND (NOT EXISTS (SELECT 1 FROM access_grant_bank_account_scopes s WHERE s.access_grant_id = ag.id)
                OR (
                  cardinality($7::uuid[]) > 0
                  AND NOT EXISTS (SELECT 1 FROM unnest($7::uuid[]) x
                    WHERE NOT EXISTS (SELECT 1 FROM access_grant_bank_account_scopes s
                      WHERE s.access_grant_id = ag.id AND s.bank_account_id = x))
                ))
              AND (NOT EXISTS (SELECT 1 FROM access_grant_document_type_scopes s WHERE s.access_grant_id = ag.id)
                OR EXISTS (SELECT 1 FROM access_grant_document_type_scopes s
                  WHERE s.access_grant_id = ag.id AND s.document_type = 'RECEIPT'))
              AND (NOT EXISTS (SELECT 1 FROM access_grant_method_category_scopes s WHERE s.access_grant_id = ag.id)
                OR NOT EXISTS (SELECT 1 FROM unnest($8::varchar[]) x
                  WHERE NOT EXISTS (SELECT 1 FROM access_grant_method_category_scopes s
                    WHERE s.access_grant_id = ag.id AND s.method_category = x)))
              AND (NOT EXISTS (SELECT 1 FROM access_grant_currency_scopes s WHERE s.access_grant_id = ag.id)
                OR NOT EXISTS (SELECT 1 FROM unnest($9::varchar[]) x
                  WHERE NOT EXISTS (SELECT 1 FROM access_grant_currency_scopes s
                    WHERE s.access_grant_id = ag.id AND s.currency = x)))
              AND (ag.amount_ceiling IS NULL OR (
                ag.amount_ceiling_currency = $10 AND ag.amount_ceiling >= $11::numeric
              ))
            )
          )
      ) AS allowed
    `, [
      organizationId,
      actorUserId,
      permission,
      facts.branchId,
      facts.treasuryUnitId,
      facts.cashboxIds,
      facts.bankAccountIds,
      facts.methodCategories,
      facts.currencies,
      facts.baseCurrency,
      facts.totalBaseAmount,
    ]);
    return result.rows[0]!.allowed;
  }

  private async storedScopeAllowed(
    client: PoolClient,
    organizationId: string,
    actorUserId: string,
    receiptId: string,
    permission: string,
  ): Promise<boolean> {
    const result = await client.query<{ allowed: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM receipt_documents rd
        WHERE rd.organization_id = $1 AND rd.id = $3
          AND ${storedScopeSql(permission)}
      ) AS allowed
    `, [organizationId, actorUserId, receiptId]);
    return result.rows[0]!.allowed;
  }

  private async insertDocument(
    client: PoolClient,
    id: string,
    organizationId: string,
    actorUserId: string,
    businessNumber: string,
    dto: ReceiptCreateDto,
    facts: DraftFacts,
  ): Promise<void> {
    await client.query(`
      INSERT INTO receipt_documents (
        id, organization_id, business_number, business_date, entered_at,
        party_id, branch_id, treasury_unit_id, base_currency, total_base_amount,
        description, purpose, contract_ref, invoice_ref, order_ref, project_ref,
        cost_center_ref, origin, creator_user_id
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'MANUAL',$18
      )
    `, [
      id, organizationId, businessNumber, dto.businessDate, facts.enteredAt,
      dto.partyId, dto.branchId ?? null, dto.treasuryUnitId, dto.baseCurrency,
      facts.totalBaseAmount, dto.description ?? null, dto.purpose ?? null,
      dto.contractRef ?? null, dto.invoiceRef ?? null, dto.orderRef ?? null,
      dto.projectRef ?? null, dto.costCenterRef ?? null, actorUserId,
    ]);
  }

  private async insertLines(
    client: PoolClient,
    receiptId: string,
    organizationId: string,
    baseCurrency: string,
    lines: DerivedLine[],
  ): Promise<void> {
    for (const line of lines) {
      const input = line.input;
      await client.query(`
        INSERT INTO receipt_lines (
          id, organization_id, receipt_document_id, line_number, method_id,
          method_name, method_category, method_required_references,
          creates_funds_in_transit, requires_approval, amount, currency,
          base_currency, exchange_rate, rate_type, rate_source, rate_record_id,
          rate_at, base_amount, rounding_difference, cashbox_id, bank_account_id,
          pos_terminal_id, payment_gateway_id, cheque_bank_id,
          cheque_bank_branch_id, cheque_payer_party_id, cheque_input,
          tracking_number, payer_account_reference, due_date, payer_name,
          remainder_treatment, description, accounting_dimensions
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
          $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35
        )
      `, [
        line.id, organizationId, receiptId, input.lineNumber, input.methodId,
        line.method.name, line.method.category, JSON.stringify(line.method.requiredReferences),
        line.method.createsFundsInTransit, line.method.requiresApproval,
        input.money.amount, input.money.currency, baseCurrency, line.rate.rate,
        line.rate.rateType, line.rate.rateSource, line.rate.rateRecordId ?? null,
        line.rate.ratedAt, line.baseAmount, line.rate.roundingDifference,
        input.cashboxId ?? null, input.bankAccountId ?? null,
        input.posTerminalId ?? null, input.paymentGatewayId ?? null,
        input.cheque?.bankId ?? null, input.cheque?.bankBranchId ?? null,
        input.cheque?.payerPartyId ?? null, input.cheque ?? null,
        input.trackingNumber ?? null,
        input.payerAccountReference ?? null, input.dueDate ?? null,
        input.payerName ?? null, input.remainderTreatment,
        input.description ?? null, input.accountingDimensions ?? null,
      ]);
      for (const allocation of input.allocations ?? []) {
        await this.insertAllocation(client, organizationId, line.id, allocation);
      }
      for (const attachment of input.attachments ?? []) {
        await client.query(`
          INSERT INTO receipt_line_attachment_links (
            organization_id, receipt_line_id, attachment_id, content_digest, purpose
          ) VALUES ($1,$2,$3,$4,$5)
        `, [
          organizationId, line.id, attachment.id, attachment.contentDigest,
          attachment.purpose ?? '',
        ]);
      }
    }
  }

  private async insertAllocation(
    client: PoolClient,
    organizationId: string,
    lineId: string,
    allocation: ReceiptAllocationInputDto,
  ): Promise<void> {
    await client.query(`
      INSERT INTO receipt_allocations (
        organization_id, receipt_line_id, external_object_type,
        external_object_id, base_amount, base_currency
      ) VALUES ($1,$2,$3,$4,$5,$6)
    `, [
      organizationId,
      lineId,
      allocation.externalObjectType,
      allocation.externalObjectId,
      allocation.baseMoney.amount,
      allocation.baseMoney.currency,
    ]);
  }

  private async views(
    client: PoolClient,
    organizationId: string,
    ids: string[],
  ): Promise<ReceiptView[]> {
    if (ids.length === 0) return [];
    const headers = await client.query<ReceiptView>(`
      SELECT rd.id, rd.organization_id AS "organizationId",
             jsonb_build_object('id', o.id, 'label', o.legal_name) AS organization,
             rd.business_number AS "businessNumber", rd.business_date::text AS "businessDate",
             to_char(rd.entered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "enteredAt",
             rd.party_id AS "partyId",
             jsonb_build_object('id', p.id, 'label', p.display_name) AS party,
             rd.branch_id AS "branchId",
             CASE WHEN b.id IS NULL THEN NULL
               ELSE jsonb_build_object('id', b.id, 'label', b.name) END AS branch,
             rd.treasury_unit_id AS "treasuryUnitId",
             jsonb_build_object('id', tu.id, 'label', tu.name) AS "treasuryUnit",
             rd.base_currency AS "baseCurrency",
             jsonb_build_object('id', c.code, 'label', c.name) AS "baseCurrencyRef",
             rd.description, rd.purpose, rd.contract_ref AS "contractRef",
             rd.invoice_ref AS "invoiceRef", rd.order_ref AS "orderRef",
             rd.project_ref AS "projectRef", rd.cost_center_ref AS "costCenterRef",
             rd.origin, rd.creator_user_id AS "creatorUserId",
             jsonb_build_object('id', u.id, 'label', u.display_name) AS creator,
             jsonb_build_object('amount', rd.total_base_amount::text, 'currency', rd.base_currency)
               AS "totalBaseAmount",
             rd.state, rd.workflow_state AS "workflowState",
             rd.execution_state AS "executionState",
             rd.accounting_state AS "accountingState", rd.version::int,
             to_char(rd.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
             to_char(rd.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"
      FROM receipt_documents rd
      JOIN organizations o ON o.id = rd.organization_id
      JOIN parties p ON p.organization_id = rd.organization_id AND p.id = rd.party_id
      LEFT JOIN branches b ON b.organization_id = rd.organization_id AND b.id = rd.branch_id
      JOIN treasury_units tu
        ON tu.organization_id = rd.organization_id AND tu.id = rd.treasury_unit_id
      JOIN currencies c
        ON c.organization_id = rd.organization_id AND c.code = rd.base_currency
      JOIN user_refs u
        ON u.organization_id = rd.organization_id AND u.id = rd.creator_user_id
      WHERE rd.organization_id = $1 AND rd.id = ANY($2::uuid[])
    `, [organizationId, ids]);
    const lineRows = await client.query<ReceiptLineRow>(`
      SELECT rl.id, rl.receipt_document_id AS "receiptId",
             rl.line_number AS "lineNumber", rl.method_id AS "methodId",
             jsonb_build_object('id', rl.method_id, 'label', rl.method_name) AS method,
             rl.method_category AS "methodBehaviorCategory",
             rl.method_required_references AS "methodRequiredReferences",
             rl.creates_funds_in_transit AS "createsFundsInTransit",
             rl.requires_approval AS "requiresApproval",
             jsonb_build_object('amount', rl.amount::text, 'currency', rl.currency) AS money,
             jsonb_build_object('amount', rl.base_amount::text, 'currency', rl.base_currency)
               AS "baseAmount",
             jsonb_strip_nulls(jsonb_build_object(
               'sourceCurrency', rl.currency, 'targetCurrency', rl.base_currency,
               'rate', rl.exchange_rate::text, 'rateType', rl.rate_type,
               'rateSource', rl.rate_source,
               'ratedAt', to_char(rl.rate_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'rateRecordId', rl.rate_record_id, 'targetAmount', rl.base_amount::text,
               'roundingDifference', rl.rounding_difference::text
             )) AS "rateSnapshot",
             CASE WHEN er.id IS NULL THEN NULL ELSE jsonb_build_object(
               'id', er.id,
               'label', er.rate_type || ' · ' || er.source_name || ' · ' || er.valid_at::text
             ) END AS "rateRecord",
             rl.cashbox_id AS "cashboxId",
             CASE WHEN cb.id IS NULL THEN NULL ELSE jsonb_build_object('id', cb.id, 'label', cb.name) END AS cashbox,
             rl.bank_account_id AS "bankAccountId",
             CASE WHEN ba.id IS NULL THEN NULL ELSE jsonb_build_object(
               'id', ba.id, 'label', bank.display_name || ' · ' || ba.account_number
             ) END AS "bankAccount",
             rl.pos_terminal_id AS "posTerminalId",
             CASE WHEN pos.id IS NULL THEN NULL ELSE jsonb_build_object(
               'id', pos.id, 'label', pos.terminal_number || ' · ' || pos.merchant_number
             ) END AS "posTerminal",
             rl.payment_gateway_id AS "paymentGatewayId",
             CASE WHEN gw.id IS NULL THEN NULL ELSE jsonb_build_object(
               'id', gw.id, 'label', gw.provider_code || ' · ' || gw.merchant_id
             ) END AS "paymentGateway",
             rl.cheque_bank_id AS "chequeBankId",
             rl.cheque_bank_branch_id AS "chequeBankBranchId",
             rl.cheque_payer_party_id AS "chequePayerPartyId",
             rl.cheque_input AS "chequeInput", rl.tracking_number AS "trackingNumber",
             rl.payer_account_reference AS "payerAccountReference",
             rl.due_date::text AS "dueDate", rl.payer_name AS "payerName",
             rl.remainder_treatment AS "remainderTreatment", rl.description,
             rl.accounting_dimensions AS "accountingDimensions",
             rl.state, rl.version::int
      FROM receipt_lines rl
      LEFT JOIN exchange_rates er ON er.id = rl.rate_record_id
      LEFT JOIN cashboxes cb ON cb.organization_id = rl.organization_id AND cb.id = rl.cashbox_id
      LEFT JOIN bank_accounts ba
        ON ba.organization_id = rl.organization_id AND ba.id = rl.bank_account_id
      LEFT JOIN banks bank ON bank.organization_id = ba.organization_id AND bank.id = ba.bank_id
      LEFT JOIN pos_terminals pos
        ON pos.organization_id = rl.organization_id AND pos.id = rl.pos_terminal_id
      LEFT JOIN payment_gateways gw
        ON gw.organization_id = rl.organization_id AND gw.id = rl.payment_gateway_id
      WHERE rl.organization_id = $1 AND rl.receipt_document_id = ANY($2::uuid[])
      ORDER BY rl.receipt_document_id, rl.line_number
    `, [organizationId, ids]);
    const lineIds = lineRows.rows.map(({ id }) => id);
    const allocations = lineIds.length === 0 ? [] : (await client.query<{
      lineId: string; value: ReceiptLineView['allocations'][number];
    }>(`
      SELECT receipt_line_id AS "lineId", jsonb_build_object(
        'id', id, 'externalObjectType', external_object_type,
        'externalObjectId', external_object_id,
        'baseMoney', jsonb_build_object('amount', base_amount::text, 'currency', base_currency),
        'state', state
      ) AS value
      FROM receipt_allocations
      WHERE organization_id = $1 AND receipt_line_id = ANY($2::uuid[])
      ORDER BY receipt_line_id, created_at, id
    `, [organizationId, lineIds])).rows;
    const evidence = lineIds.length === 0 ? [] : (await client.query<{
      lineId: string; value: NonNullable<ReceiptLineView['attachments']>[number];
    }>(`
      SELECT l.receipt_line_id AS "lineId", jsonb_strip_nulls(jsonb_build_object(
        'id', a.id, 'label', a.file_name, 'contentDigest', l.content_digest,
        'purpose', nullif(l.purpose, '')
      )) AS value
      FROM receipt_line_attachment_links l
      JOIN attachments a
        ON a.organization_id = l.organization_id AND a.id = l.attachment_id
          AND a.content_digest = l.content_digest
      WHERE l.organization_id = $1 AND l.receipt_line_id = ANY($2::uuid[])
      ORDER BY l.receipt_line_id, a.file_name, a.id
    `, [organizationId, lineIds])).rows;
    const chequeSemantics = await this.chequeViews(client, organizationId, lineRows.rows);
    const linesByReceipt = new Map<string, ReceiptLineView[]>();
    for (const row of lineRows.rows) {
      const {
        receiptId,
        chequeInput,
        chequeBankId: _chequeBankId,
        chequeBankBranchId: _chequeBankBranchId,
        chequePayerPartyId: _chequePayerPartyId,
        ...line
      } = row;
      const view = compact({
        ...line,
        allocations: allocations.filter(({ lineId }) => lineId === row.id)
          .map(({ value }) => value),
        attachments: evidence.filter(({ lineId }) => lineId === row.id)
          .map(({ value }) => value),
        cheque: chequeInput ? chequeSemantics.get(row.id) : undefined,
      }) as ReceiptLineView;
      linesByReceipt.set(receiptId, [...(linesByReceipt.get(receiptId) ?? []), view]);
    }
    const headerMap = new Map(headers.rows.map((header) => [header.id, header]));
    return ids.map((id) => compact({
      ...headerMap.get(id)!,
      lines: linesByReceipt.get(id) ?? [],
    }) as ReceiptView);
  }

  private async chequeViews(
    client: PoolClient,
    organizationId: string,
    lines: ReceiptLineRow[],
  ): Promise<Map<string, ReceiptLineView['cheque']>> {
    const result = new Map<string, ReceiptLineView['cheque']>();
    const chequeLines = lines.filter((line) => line.chequeInput && line.chequeBankId);
    if (chequeLines.length === 0) return result;
    const banks = await client.query<{ id: string; label: string }>(`
      SELECT id, display_name AS label
      FROM banks
      WHERE organization_id = $1 AND id = ANY($2::uuid[])
    `, [organizationId, chequeLines.map(({ chequeBankId }) => chequeBankId!)]);
    const branchIds = chequeLines.flatMap(({ chequeBankBranchId }) =>
      chequeBankBranchId ? [chequeBankBranchId] : []);
    const branches = branchIds.length === 0 ? [] : (await client.query<{
      id: string;
      label: string;
    }>(`
      SELECT id, name AS label
      FROM bank_branches
      WHERE organization_id = $1 AND id = ANY($2::uuid[])
    `, [organizationId, branchIds])).rows;
    const partyIds = chequeLines.flatMap(({ chequePayerPartyId }) =>
      chequePayerPartyId ? [chequePayerPartyId] : []);
    const parties = partyIds.length === 0 ? [] : (await client.query<{
      id: string;
      label: string;
    }>(`
      SELECT id, display_name AS label
      FROM parties
      WHERE organization_id = $1 AND id = ANY($2::uuid[])
    `, [organizationId, partyIds])).rows;
    const bankMap = new Map(banks.rows.map((row) => [row.id, row]));
    const branchMap = new Map(branches.map((row) => [row.id, row]));
    const partyMap = new Map(parties.map((row) => [row.id, row]));
    for (const line of chequeLines) {
      const input = line.chequeInput!;
      result.set(line.id, compact({
        ...input,
        bankId: line.chequeBankId,
        bank: bankMap.get(line.chequeBankId!),
        bankBranchId: line.chequeBankBranchId,
        bankBranch: line.chequeBankBranchId
          ? branchMap.get(line.chequeBankBranchId)
          : undefined,
        payerPartyId: line.chequePayerPartyId,
        payerParty: line.chequePayerPartyId
          ? partyMap.get(line.chequePayerPartyId)
          : undefined,
        amount: line.money,
      }) as ReceiptLineView['cheque']);
    }
    return result;
  }

  private async idempotent(
    organizationId: string,
    scope: string,
    idempotencyKey: string,
    requestDigest: string,
    responseStatus: number,
    authorizeReplay: (
      client: PoolClient,
      replay: ReceiptIdempotencyEnvelope,
    ) => Promise<void>,
    work: (client: PoolClient) => Promise<ReceiptIdempotencyEnvelope>,
  ): Promise<ReceiptView> {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [organizationId, `${scope}:${idempotencyKey}`],
      );
      const existing = await client.query<{
        request_digest: string;
        response_body: ReceiptIdempotencyEnvelope | null;
      }>(`
        SELECT request_digest, response_body FROM idempotency_records
        WHERE organization_id = $1 AND scope = $2 AND idempotency_key = $3
      `, [organizationId, scope, idempotencyKey]);
      const replay = existing.rows[0];
      if (replay) {
        if (!replay.response_body) {
          throw new Error('IDEMPOTENCY_CONFLICT');
        }
        if (replay.request_digest !== requestDigest) {
          throw new Error('IDEMPOTENCY_CONFLICT');
        }
        if (
          !replay.response_body.response
          || !replay.response_body.authorizationSnapshot
        ) throw new Error('IDEMPOTENCY_CONFLICT');
        await authorizeReplay(client, replay.response_body);
        await client.query('COMMIT');
        return replay.response_body.response;
      }
      await client.query(`
        INSERT INTO idempotency_records (
          organization_id, scope, idempotency_key, request_digest
        ) VALUES ($1,$2,$3,$4)
      `, [organizationId, scope, idempotencyKey, requestDigest]);
      const response = await work(client);
      response.response = compact(response.response) as ReceiptView;
      await client.query(`
        UPDATE idempotency_records
        SET response_status = $1, response_body = $2
        WHERE organization_id = $3 AND scope = $4 AND idempotency_key = $5
      `, [responseStatus, response, organizationId, scope, idempotencyKey]);
      await client.query('COMMIT');
      return response.response;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

function storedScopeSql(permission: string): string {
  return `EXISTS (
    SELECT 1
    FROM access_grants ag
    JOIN roles r ON r.id = ag.role_id AND r.state = 'ACTIVE'
    JOIN role_permissions rp ON rp.role_id = r.id AND rp.permission = '${permission}'
    WHERE ag.organization_id = $1 AND ag.user_ref_id = $2
      AND ag.state = 'ACTIVE' AND ag.valid_from <= now()
      AND (ag.valid_to IS NULL OR ag.valid_to > now())
      AND (
        ag.organization_wide OR (
          (NOT EXISTS (
              SELECT 1 FROM access_grant_branch_scopes s WHERE s.access_grant_id = ag.id)
            OR (rd.branch_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM access_grant_branch_scopes s
              WHERE s.access_grant_id = ag.id AND s.branch_id = rd.branch_id)))
          AND (NOT EXISTS (SELECT 1 FROM access_grant_treasury_unit_scopes s WHERE s.access_grant_id = ag.id)
            OR EXISTS (SELECT 1 FROM access_grant_treasury_unit_scopes s
              WHERE s.access_grant_id = ag.id AND s.treasury_unit_id = rd.treasury_unit_id))
          AND (NOT EXISTS (SELECT 1 FROM access_grant_cashbox_scopes s WHERE s.access_grant_id = ag.id)
            OR (
              EXISTS (SELECT 1 FROM receipt_lines rl
                WHERE rl.organization_id = rd.organization_id
                  AND rl.receipt_document_id = rd.id AND rl.cashbox_id IS NOT NULL)
              AND NOT EXISTS (SELECT 1 FROM receipt_lines rl
                WHERE rl.organization_id = rd.organization_id
                  AND rl.receipt_document_id = rd.id AND rl.cashbox_id IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM access_grant_cashbox_scopes s
                    WHERE s.access_grant_id = ag.id AND s.cashbox_id = rl.cashbox_id))
            ))
          AND (NOT EXISTS (SELECT 1 FROM access_grant_bank_account_scopes s WHERE s.access_grant_id = ag.id)
            OR (
              EXISTS (SELECT 1 FROM receipt_lines rl
                LEFT JOIN pos_terminals pos
                  ON pos.organization_id = rl.organization_id AND pos.id = rl.pos_terminal_id
                LEFT JOIN payment_gateways gw
                  ON gw.organization_id = rl.organization_id AND gw.id = rl.payment_gateway_id
                WHERE rl.organization_id = rd.organization_id
                  AND rl.receipt_document_id = rd.id
                  AND coalesce(rl.bank_account_id, pos.bank_account_id, gw.bank_account_id) IS NOT NULL)
              AND NOT EXISTS (SELECT 1 FROM receipt_lines rl
                LEFT JOIN pos_terminals pos
                  ON pos.organization_id = rl.organization_id AND pos.id = rl.pos_terminal_id
                LEFT JOIN payment_gateways gw
                  ON gw.organization_id = rl.organization_id AND gw.id = rl.payment_gateway_id
                WHERE rl.organization_id = rd.organization_id
                  AND rl.receipt_document_id = rd.id
                  AND coalesce(rl.bank_account_id, pos.bank_account_id, gw.bank_account_id) IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM access_grant_bank_account_scopes s
                    WHERE s.access_grant_id = ag.id
                      AND s.bank_account_id =
                        coalesce(rl.bank_account_id, pos.bank_account_id, gw.bank_account_id)))
            ))
          AND (NOT EXISTS (SELECT 1 FROM access_grant_document_type_scopes s WHERE s.access_grant_id = ag.id)
            OR EXISTS (SELECT 1 FROM access_grant_document_type_scopes s
              WHERE s.access_grant_id = ag.id AND s.document_type = 'RECEIPT'))
          AND (NOT EXISTS (SELECT 1 FROM access_grant_method_category_scopes s WHERE s.access_grant_id = ag.id)
            OR NOT EXISTS (SELECT 1 FROM receipt_lines rl
              WHERE rl.organization_id = rd.organization_id
                AND rl.receipt_document_id = rd.id
                AND NOT EXISTS (SELECT 1 FROM access_grant_method_category_scopes s
                  WHERE s.access_grant_id = ag.id AND s.method_category = rl.method_category)))
          AND (NOT EXISTS (SELECT 1 FROM access_grant_currency_scopes s WHERE s.access_grant_id = ag.id)
            OR (
              EXISTS (SELECT 1 FROM access_grant_currency_scopes s
                WHERE s.access_grant_id = ag.id AND s.currency = rd.base_currency)
              AND NOT EXISTS (SELECT 1 FROM receipt_lines rl
                WHERE rl.organization_id = rd.organization_id
                  AND rl.receipt_document_id = rd.id
                  AND NOT EXISTS (SELECT 1 FROM access_grant_currency_scopes s
                    WHERE s.access_grant_id = ag.id AND s.currency = rl.currency))
            ))
        )
      )
  )`;
}

function identityRate(amount: string, currency: string, enteredAt: Date): ReceiptRateSnapshot {
  return {
    sourceCurrency: currency,
    targetCurrency: currency,
    rate: '1',
    rateType: 'IDENTITY',
    rateSource: 'IDENTITY',
    ratedAt: instant(enteredAt),
    targetAmount: amount,
    roundingDifference: '0',
  };
}

function deriveTarget(
  amount: string,
  rate: string,
  targetScale: number,
): { targetAmount: string; roundingDifference: string } {
  const a = decimalParts(amount);
  const r = decimalParts(rate);
  const numerator = a.value * r.value;
  const denominator = 10n ** BigInt(a.scale + r.scale);
  const targetValue = roundDivision(numerator * 10n ** BigInt(targetScale), denominator);
  const diffNumerator =
    numerator * 100_000_000n
    - targetValue * denominator * 10n ** BigInt(8 - targetScale);
  const difference = roundSignedDivision(diffNumerator, denominator);
  return {
    targetAmount: formatScaled(targetValue, targetScale),
    roundingDifference: formatScaled(difference, 8),
  };
}

function compareDecimal(left: string, right: string): number {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const scale = Math.max(a.scale, b.scale);
  const av = a.value * 10n ** BigInt(scale - a.scale);
  const bv = b.value * 10n ** BigInt(scale - b.scale);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

function scaled(value: string, scale: number): bigint {
  const parsed = decimalParts(value);
  if (parsed.scale > scale) throw new Error('VALIDATION');
  return parsed.value * 10n ** BigInt(scale - parsed.scale);
}

function decimalPlaces(value: string): number {
  return value.split('.')[1]?.length ?? 0;
}

function decimalParts(value: string): { value: bigint; scale: number } {
  const negative = value.startsWith('-');
  const raw = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = raw.split('.');
  const result = BigInt(`${whole}${fraction}`);
  return { value: negative ? -result : result, scale: fraction.length };
}

function roundDivision(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

function roundSignedDivision(numerator: bigint, denominator: bigint): bigint {
  return numerator < 0n
    ? -roundDivision(-numerator, denominator)
    : roundDivision(numerator, denominator);
}

function formatScaled(value: bigint, scale: number): string {
  const negative = value < 0n;
  const raw = (negative ? -value : value).toString().padStart(scale + 1, '0');
  const output = scale === 0
    ? raw
    : `${raw.slice(0, -scale)}.${raw.slice(-scale)}`;
  return `${negative ? '-' : ''}${output}`;
}

function instant(value: Date | string): string {
  return new Date(value).toISOString();
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== null && child !== undefined),
  ) as T;
}
