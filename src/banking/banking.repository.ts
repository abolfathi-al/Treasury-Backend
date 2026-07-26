import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';

import { DatabaseService } from '../database/database.service';
import {
  BankAccountCreateDto,
  BankAccountView,
  BankBranchCreateDto,
  BankBranchView,
  BankCreateDto,
  BankTypeCreateDto,
  BankTypeView,
  BankView,
  PaymentGatewayCreateDto,
  PaymentGatewayView,
  PosTerminalCreateDto,
  PosTerminalView,
} from './banking.dto';

export type Cursor = string[];

interface ScopedResource {
  organizationBranchId?: string;
  treasuryUnitId?: string;
  bankAccountId?: string;
  currency: string;
}

@Injectable()
export class BankingRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async listBankTypes(
    organizationId: string,
    actorUserId: string,
    limit: number,
    cursor?: Cursor,
  ): Promise<{ items: BankTypeView[]; hasMore: boolean }> {
    await this.assertOrganizationPermission(
      this.database.pool,
      organizationId,
      actorUserId,
      'bank-type.view',
    );
    const result = await this.database.pool.query<BankTypeView>(`
      ${BANK_TYPE_VIEW_SELECT}
      WHERE bt.organization_id = $1
        AND ($2::varchar IS NULL OR (bt.code, bt.id) > ($2::varchar, $3::uuid))
      ORDER BY bt.code, bt.id
      LIMIT $4
    `, [organizationId, cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1]);
    return page(result.rows, limit);
  }

  createBankType(
    organizationId: string,
    actorUserId: string,
    dto: BankTypeCreateDto,
    idempotencyKey: string,
    requestDigest: string,
  ): Promise<BankTypeView> {
    return this.idempotent(
      organizationId,
      'createBankType',
      idempotencyKey,
      requestDigest,
      (client) => this.assertOrganizationPermission(
        client,
        organizationId,
        actorUserId,
        'bank-type.manage',
      ),
      async (client) => {
        await this.assertOrganizationPermission(
          client,
          organizationId,
          actorUserId,
          'bank-type.manage',
        );
        const created = await client.query<{ id: string }>(`
          INSERT INTO bank_types (organization_id, code, display_name, description)
          VALUES ($1,$2,$3,$4)
          RETURNING id
        `, [organizationId, dto.code, dto.displayName, dto.description ?? null]);
        return this.bankTypeView(client, created.rows[0]!.id);
      },
    );
  }

  async listBanks(
    organizationId: string,
    actorUserId: string,
    limit: number,
    cursor?: Cursor,
  ): Promise<{ items: BankView[]; hasMore: boolean }> {
    await this.assertOrganizationPermission(
      this.database.pool,
      organizationId,
      actorUserId,
      'bank.view',
    );
    const result = await this.database.pool.query<BankView>(`
      ${BANK_VIEW_SELECT}
      WHERE b.organization_id = $1
        AND ($2::varchar IS NULL OR (b.code, b.id) > ($2::varchar, $3::uuid))
      ORDER BY b.code, b.id
      LIMIT $4
    `, [organizationId, cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1]);
    return page(result.rows, limit);
  }

  createBank(
    organizationId: string,
    actorUserId: string,
    dto: BankCreateDto,
    idempotencyKey: string,
    requestDigest: string,
  ): Promise<BankView> {
    const authorize = async (client: PoolClient): Promise<void> => {
      await this.assertOrganizationPermission(
        client,
        organizationId,
        actorUserId,
        'bank.manage',
      );
      await this.assertActive(
        client,
        'bank_types',
        organizationId,
        dto.bankTypeId,
      );
    };
    return this.idempotent(
      organizationId,
      'createBank',
      idempotencyKey,
      requestDigest,
      authorize,
      async (client) => {
        await authorize(client);
        const created = await client.query<{ id: string }>(`
          INSERT INTO banks (
            organization_id, bank_type_id, code, display_name, english_name,
            country_code, national_bank_code, swift_code, logo_ref
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          RETURNING id
        `, [
          organizationId,
          dto.bankTypeId,
          dto.code,
          dto.displayName,
          dto.englishName ?? null,
          dto.countryCode,
          dto.nationalBankCode ?? null,
          dto.swiftCode ?? null,
          dto.logoRef ?? null,
        ]);
        return this.bankView(client, created.rows[0]!.id);
      },
    );
  }

  async listBankBranches(
    organizationId: string,
    actorUserId: string,
    limit: number,
    cursor?: Cursor,
  ): Promise<{ items: BankBranchView[]; hasMore: boolean }> {
    await this.assertOrganizationPermission(
      this.database.pool,
      organizationId,
      actorUserId,
      'bank-branch.view',
    );
    const result = await this.database.pool.query<BankBranchView>(`
      ${BANK_BRANCH_VIEW_SELECT}
      WHERE bb.organization_id = $1
        AND (
          $2::varchar IS NULL
          OR (b.code, bb.code, bb.id) > ($2::varchar, $3::varchar, $4::uuid)
        )
      ORDER BY b.code, bb.code, bb.id
      LIMIT $5
    `, [
      organizationId,
      cursor?.[0] ?? null,
      cursor?.[1] ?? null,
      cursor?.[2] ?? null,
      limit + 1,
    ]);
    return page(result.rows, limit);
  }

  createBankBranch(
    organizationId: string,
    actorUserId: string,
    dto: BankBranchCreateDto,
    idempotencyKey: string,
    requestDigest: string,
  ): Promise<BankBranchView> {
    const authorize = async (client: PoolClient): Promise<void> => {
      await this.assertOrganizationPermission(
        client,
        organizationId,
        actorUserId,
        'bank-branch.manage',
      );
      await this.assertActive(client, 'banks', organizationId, dto.bankId);
    };
    return this.idempotent(
      organizationId,
      'createBankBranch',
      idempotencyKey,
      requestDigest,
      authorize,
      async (client) => {
        await authorize(client);
        const created = await client.query<{ id: string }>(`
          INSERT INTO bank_branches (
            organization_id, bank_id, code, name, city, address, contact_reference
          ) VALUES ($1,$2,$3,$4,$5,$6,$7)
          RETURNING id
        `, [
          organizationId,
          dto.bankId,
          dto.code,
          dto.name,
          dto.city ?? null,
          dto.address ?? null,
          dto.contactReference ?? null,
        ]);
        return this.bankBranchView(client, created.rows[0]!.id);
      },
    );
  }

  async listBankAccounts(
    organizationId: string,
    actorUserId: string,
    limit: number,
    cursor?: Cursor,
  ): Promise<{ items: BankAccountView[]; hasMore: boolean }> {
    const result = await this.database.pool.query<BankAccountView>(`
      ${BANK_ACCOUNT_VIEW_SELECT}
      WHERE ba.organization_id = $1
        AND ${scopedPermission(
          'ba.organization_branch_id',
          'ba.treasury_unit_id',
          'ba.id',
          'ba.currency',
        )}
        AND (
          $4::varchar IS NULL
          OR (b.code, ba.account_number, ba.id)
             > ($4::varchar, $5::varchar, $6::uuid)
        )
      ORDER BY b.code, ba.account_number, ba.id
      LIMIT $7
    `, [
      organizationId,
      actorUserId,
      'bank-account.view',
      cursor?.[0] ?? null,
      cursor?.[1] ?? null,
      cursor?.[2] ?? null,
      limit + 1,
    ]);
    return page(result.rows, limit);
  }

  createBankAccount(
    organizationId: string,
    actorUserId: string,
    dto: BankAccountCreateDto,
    idempotencyKey: string,
    requestDigest: string,
  ): Promise<BankAccountView> {
    const authorize = async (client: PoolClient): Promise<void> => {
      if (!await this.scopedAllowed(
        client,
        organizationId,
        actorUserId,
        'bank-account.manage',
        {
          organizationBranchId: dto.organizationBranchId,
          treasuryUnitId: dto.treasuryUnitId,
          currency: dto.currency,
        },
      )) throw new Error('SCOPE_DENIED');
      await this.assertBankAccountReferences(client, organizationId, dto);
    };
    return this.idempotent(
      organizationId,
      'createBankAccount',
      idempotencyKey,
      requestDigest,
      authorize,
      async (client) => {
        await authorize(client);
        const created = await client.query<{ id: string }>(`
          INSERT INTO bank_accounts (
            organization_id, bank_id, bank_branch_id, organization_branch_id,
            treasury_unit_id, account_type, account_number, iban,
            masked_card_number, currency, legal_owner_name, opening_date,
            cheque_enabled, can_receive, can_pay, can_transfer,
            withdrawal_ceiling, withdrawal_ceiling_currency,
            accounting_dimensions, state
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
            $17,$18,$19,'DRAFT'
          )
          RETURNING id
        `, [
          organizationId,
          dto.bankId,
          dto.bankBranchId ?? null,
          dto.organizationBranchId ?? null,
          dto.treasuryUnitId ?? null,
          dto.accountType,
          dto.accountNumber,
          dto.iban ?? null,
          dto.maskedCardNumber ?? null,
          dto.currency,
          dto.legalOwnerName,
          dto.openingDate,
          dto.chequeEnabled ?? false,
          dto.capabilities.receive,
          dto.capabilities.pay,
          dto.capabilities.transfer,
          dto.withdrawalCeiling?.amount ?? null,
          dto.withdrawalCeiling?.currency ?? null,
          dto.accountingDimensions ?? null,
        ]);
        await client.query(`
          UPDATE bank_accounts
          SET state = 'ACTIVE', version = version + 1, updated_at = now()
          WHERE id = $1 AND state = 'DRAFT'
        `, [created.rows[0]!.id]);
        return this.bankAccountView(client, created.rows[0]!.id);
      },
    );
  }

  async listPosTerminals(
    organizationId: string,
    actorUserId: string,
    limit: number,
    cursor?: Cursor,
  ): Promise<{ items: PosTerminalView[]; hasMore: boolean }> {
    const result = await this.database.pool.query<PosTerminalView>(`
      ${POS_TERMINAL_VIEW_SELECT}
      WHERE pt.organization_id = $1
        AND ${scopedPermission('br.id', 'pt.treasury_unit_id', 'pt.bank_account_id', 'pt.currency')}
        AND (
          $4::varchar IS NULL
          OR (pt.terminal_number, pt.id) > ($4::varchar, $5::uuid)
        )
      ORDER BY pt.terminal_number, pt.id
      LIMIT $6
    `, [
      organizationId,
      actorUserId,
      'pos-terminal.view',
      cursor?.[0] ?? null,
      cursor?.[1] ?? null,
      limit + 1,
    ]);
    return page(result.rows, limit);
  }

  createPosTerminal(
    organizationId: string,
    actorUserId: string,
    dto: PosTerminalCreateDto,
    idempotencyKey: string,
    requestDigest: string,
  ): Promise<PosTerminalView> {
    return this.createEndpoint(
      organizationId,
      actorUserId,
      dto,
      'createPosTerminal',
      'pos-terminal.manage',
      idempotencyKey,
      requestDigest,
      async (client) => {
        const created = await client.query<{ id: string }>(`
          INSERT INTO pos_terminals (
            organization_id, bank_account_id, treasury_unit_id,
            terminal_number, merchant_number, currency, settlement_cycle,
            fee_rule_ref, provider_label
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          RETURNING id
        `, [
          organizationId,
          dto.bankAccountId,
          dto.treasuryUnitId,
          dto.terminalNumber,
          dto.merchantNumber,
          dto.currency,
          dto.settlementCycle,
          dto.feeRuleRef ?? null,
          dto.providerLabel ?? null,
        ]);
        return this.posTerminalView(client, created.rows[0]!.id);
      },
    );
  }

  async listPaymentGateways(
    organizationId: string,
    actorUserId: string,
    limit: number,
    cursor?: Cursor,
  ): Promise<{ items: PaymentGatewayView[]; hasMore: boolean }> {
    const result = await this.database.pool.query<PaymentGatewayView>(`
      ${PAYMENT_GATEWAY_VIEW_SELECT}
      WHERE pg.organization_id = $1
        AND ${scopedPermission('br.id', 'pg.treasury_unit_id', 'pg.bank_account_id', 'pg.currency')}
        AND (
          $4::varchar IS NULL
          OR (pg.provider_code, pg.merchant_id, pg.terminal_id, pg.id)
             > ($4::varchar, $5::varchar, $6::varchar, $7::uuid)
        )
      ORDER BY pg.provider_code, pg.merchant_id, pg.terminal_id, pg.id
      LIMIT $8
    `, [
      organizationId,
      actorUserId,
      'payment-gateway.view',
      cursor?.[0] ?? null,
      cursor?.[1] ?? null,
      cursor?.[2] ?? null,
      cursor?.[3] ?? null,
      limit + 1,
    ]);
    return page(result.rows, limit);
  }

  createPaymentGateway(
    organizationId: string,
    actorUserId: string,
    dto: PaymentGatewayCreateDto,
    idempotencyKey: string,
    requestDigest: string,
  ): Promise<PaymentGatewayView> {
    return this.createEndpoint(
      organizationId,
      actorUserId,
      dto,
      'createPaymentGateway',
      'payment-gateway.manage',
      idempotencyKey,
      requestDigest,
      async (client) => {
        const created = await client.query<{ id: string }>(`
          INSERT INTO payment_gateways (
            organization_id, bank_account_id, treasury_unit_id, provider_code,
            merchant_id, terminal_id, currency, settlement_cycle, fee_rule_ref,
            funds_in_transit_mapping_ref, fee_mapping_ref
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          RETURNING id
        `, [
          organizationId,
          dto.bankAccountId,
          dto.treasuryUnitId,
          dto.providerCode,
          dto.merchantId,
          dto.terminalId,
          dto.currency,
          dto.settlementCycle,
          dto.feeRuleRef ?? null,
          dto.fundsInTransitMappingRef ?? null,
          dto.feeMappingRef ?? null,
        ]);
        return this.paymentGatewayView(client, created.rows[0]!.id);
      },
    );
  }

  private createEndpoint<T extends PosTerminalCreateDto | PaymentGatewayCreateDto, V extends object>(
    organizationId: string,
    actorUserId: string,
    dto: T,
    scope: string,
    permission: string,
    idempotencyKey: string,
    requestDigest: string,
    insert: (client: PoolClient) => Promise<V>,
  ): Promise<V> {
    const authorize = async (client: PoolClient): Promise<void> => {
      const references = await this.endpointReferences(client, organizationId, dto);
      if (!await this.scopedAllowed(
        client,
        organizationId,
        actorUserId,
        permission,
        {
          organizationBranchId: references.branchId ?? undefined,
          treasuryUnitId: dto.treasuryUnitId,
          bankAccountId: dto.bankAccountId,
          currency: dto.currency,
        },
      )) throw new Error('SCOPE_DENIED');
      if (references.currencyState !== 'ACTIVE') throw new ReferenceError('INACTIVE_REFERENCE');
      if (
        references.unitState !== 'ACTIVE'
        || references.accountState !== 'ACTIVE'
        || !references.canReceive
        || references.accountCurrency !== dto.currency
      ) throw new RangeError('ACCOUNT_UNAVAILABLE');
    };
    return this.idempotent(
      organizationId,
      scope,
      idempotencyKey,
      requestDigest,
      authorize,
      async (client) => {
        await authorize(client);
        return insert(client);
      },
    );
  }

  private async endpointReferences(
    client: PoolClient,
    organizationId: string,
    dto: PosTerminalCreateDto | PaymentGatewayCreateDto,
  ): Promise<{
    branchId: string | null;
    unitState: string;
    accountState: string;
    accountCurrency: string;
    canReceive: boolean;
    currencyState: string;
  }> {
    const unit = await client.query<{ branch_id: string | null; state: string }>(`
      SELECT branch_id, state
      FROM treasury_units
      WHERE organization_id = $1 AND id = $2
      FOR SHARE
    `, [organizationId, dto.treasuryUnitId]);
    const account = await client.query<{
      state: string;
      currency: string;
      can_receive: boolean;
    }>(`
      SELECT state, currency, can_receive
      FROM bank_accounts
      WHERE organization_id = $1 AND id = $2
      FOR SHARE
    `, [organizationId, dto.bankAccountId]);
    const currency = await client.query<{ state: string }>(`
      SELECT state
      FROM currencies
      WHERE organization_id = $1 AND code = $2
      FOR SHARE
    `, [organizationId, dto.currency]);
    if (!unit.rowCount || !account.rowCount || !currency.rowCount) {
      throw new ReferenceError('RESOURCE_HIDDEN');
    }
    return {
      branchId: unit.rows[0]!.branch_id,
      unitState: unit.rows[0]!.state,
      accountState: account.rows[0]!.state,
      accountCurrency: account.rows[0]!.currency,
      canReceive: account.rows[0]!.can_receive,
      currencyState: currency.rows[0]!.state,
    };
  }

  private async assertBankAccountReferences(
    client: PoolClient,
    organizationId: string,
    dto: BankAccountCreateDto,
  ): Promise<void> {
    await this.assertActive(client, 'banks', organizationId, dto.bankId);
    if (dto.bankBranchId) {
      const branch = await client.query<{ bank_id: string; state: string }>(`
        SELECT bank_id, state
        FROM bank_branches
        WHERE organization_id = $1 AND id = $2
        FOR SHARE
      `, [organizationId, dto.bankBranchId]);
      if (!branch.rowCount) throw new ReferenceError('RESOURCE_HIDDEN');
      if (branch.rows[0]!.state !== 'ACTIVE') throw new ReferenceError('INACTIVE_REFERENCE');
      if (branch.rows[0]!.bank_id !== dto.bankId) throw new Error('VALIDATION');
    }
    if (dto.organizationBranchId) {
      await this.assertActive(
        client,
        'branches',
        organizationId,
        dto.organizationBranchId,
      );
    }
    if (dto.treasuryUnitId) {
      const unit = await client.query<{ branch_id: string | null; state: string }>(`
        SELECT branch_id, state
        FROM treasury_units
        WHERE organization_id = $1 AND id = $2
        FOR SHARE
      `, [organizationId, dto.treasuryUnitId]);
      if (!unit.rowCount) throw new ReferenceError('RESOURCE_HIDDEN');
      if (unit.rows[0]!.state !== 'ACTIVE') throw new ReferenceError('INACTIVE_REFERENCE');
      if (
        unit.rows[0]!.branch_id !== null
        && dto.organizationBranchId !== undefined
        && unit.rows[0]!.branch_id !== dto.organizationBranchId
      ) throw new Error('VALIDATION');
    }
    const currency = await client.query<{ state: string; decimal_places: number }>(`
      SELECT state, decimal_places
      FROM currencies
      WHERE organization_id = $1 AND code = $2
      FOR SHARE
    `, [organizationId, dto.currency]);
    if (!currency.rowCount) throw new ReferenceError('RESOURCE_HIDDEN');
    if (currency.rows[0]!.state !== 'ACTIVE') throw new ReferenceError('INACTIVE_REFERENCE');
    if (
      dto.withdrawalCeiling
      && (dto.withdrawalCeiling.amount.split('.')[1]?.length ?? 0)
        > currency.rows[0]!.decimal_places
    ) throw new Error('VALIDATION');
  }

  private async assertActive(
    client: PoolClient,
    table: 'bank_types' | 'banks' | 'branches',
    organizationId: string,
    id: string,
  ): Promise<void> {
    const result = await client.query<{ state: string }>(`
      SELECT state FROM ${table}
      WHERE organization_id = $1 AND id = $2
      FOR SHARE
    `, [organizationId, id]);
    if (!result.rowCount) throw new ReferenceError('RESOURCE_HIDDEN');
    if (result.rows[0]!.state !== 'ACTIVE') throw new ReferenceError('INACTIVE_REFERENCE');
  }

  private async assertOrganizationPermission(
    executor: Pool | PoolClient,
    organizationId: string,
    actorUserId: string,
    permission: string,
  ): Promise<void> {
    const result = await executor.query<{ allowed: boolean }>(`
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
          AND NOT EXISTS (
            SELECT 1 FROM access_grant_branch_scopes s WHERE s.access_grant_id = ag.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM access_grant_treasury_unit_scopes s
            WHERE s.access_grant_id = ag.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM access_grant_cashbox_scopes s WHERE s.access_grant_id = ag.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM access_grant_bank_account_scopes s
            WHERE s.access_grant_id = ag.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM access_grant_document_type_scopes s
            WHERE s.access_grant_id = ag.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM access_grant_method_category_scopes s
            WHERE s.access_grant_id = ag.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM access_grant_currency_scopes s WHERE s.access_grant_id = ag.id
          )
      ) AS allowed
    `, [organizationId, actorUserId, permission]);
    if (!result.rows[0]!.allowed) throw new Error('SCOPE_DENIED');
  }

  private async scopedAllowed(
    client: PoolClient,
    organizationId: string,
    actorUserId: string,
    permission: string,
    resource: ScopedResource,
  ): Promise<boolean> {
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
          AND NOT EXISTS (
            SELECT 1 FROM access_grant_cashbox_scopes s WHERE s.access_grant_id = ag.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM access_grant_document_type_scopes s
            WHERE s.access_grant_id = ag.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM access_grant_method_category_scopes s
            WHERE s.access_grant_id = ag.id
          )
          AND (
            NOT EXISTS (
              SELECT 1 FROM access_grant_branch_scopes s WHERE s.access_grant_id = ag.id
            )
            OR EXISTS (
              SELECT 1 FROM access_grant_branch_scopes s
              WHERE s.access_grant_id = ag.id AND s.branch_id = $4
            )
          )
          AND (
            NOT EXISTS (
              SELECT 1 FROM access_grant_treasury_unit_scopes s
              WHERE s.access_grant_id = ag.id
            )
            OR EXISTS (
              SELECT 1 FROM access_grant_treasury_unit_scopes s
              WHERE s.access_grant_id = ag.id AND s.treasury_unit_id = $5
            )
          )
          AND (
            NOT EXISTS (
              SELECT 1 FROM access_grant_bank_account_scopes s
              WHERE s.access_grant_id = ag.id
            )
            OR EXISTS (
              SELECT 1 FROM access_grant_bank_account_scopes s
              WHERE s.access_grant_id = ag.id AND s.bank_account_id = $6
            )
          )
          AND (
            NOT EXISTS (
              SELECT 1 FROM access_grant_currency_scopes s WHERE s.access_grant_id = ag.id
            )
            OR EXISTS (
              SELECT 1 FROM access_grant_currency_scopes s
              WHERE s.access_grant_id = ag.id AND s.currency = $7
            )
          )
      ) AS allowed
    `, [
      organizationId,
      actorUserId,
      permission,
      resource.organizationBranchId ?? null,
      resource.treasuryUnitId ?? null,
      resource.bankAccountId ?? null,
      resource.currency,
    ]);
    return result.rows[0]!.allowed;
  }

  private bankTypeView(client: PoolClient, id: string): Promise<BankTypeView> {
    return one(client, `${BANK_TYPE_VIEW_SELECT} WHERE bt.id = $1`, id);
  }

  private bankView(client: PoolClient, id: string): Promise<BankView> {
    return one(client, `${BANK_VIEW_SELECT} WHERE b.id = $1`, id);
  }

  private bankBranchView(client: PoolClient, id: string): Promise<BankBranchView> {
    return one(client, `${BANK_BRANCH_VIEW_SELECT} WHERE bb.id = $1`, id);
  }

  private bankAccountView(client: PoolClient, id: string): Promise<BankAccountView> {
    return one(client, `${BANK_ACCOUNT_VIEW_SELECT} WHERE ba.id = $1`, id);
  }

  private posTerminalView(client: PoolClient, id: string): Promise<PosTerminalView> {
    return one(client, `${POS_TERMINAL_VIEW_SELECT} WHERE pt.id = $1`, id);
  }

  private paymentGatewayView(client: PoolClient, id: string): Promise<PaymentGatewayView> {
    return one(client, `${PAYMENT_GATEWAY_VIEW_SELECT} WHERE pg.id = $1`, id);
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

const VIEW_TIMESTAMPS = (alias: string): string => `
  ${alias}.version::int AS version,
  to_char(${alias}.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    AS "createdAt",
  to_char(${alias}.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    AS "updatedAt"
`;

const BANK_TYPE_VIEW_SELECT = `
  SELECT bt.id, bt.organization_id AS "organizationId", bt.code,
         bt.display_name AS "displayName", bt.description, bt.state,
         ${VIEW_TIMESTAMPS('bt')}
  FROM bank_types bt
`;

const BANK_VIEW_SELECT = `
  SELECT b.id, b.organization_id AS "organizationId",
         b.bank_type_id AS "bankTypeId",
         jsonb_build_object(
           'id', bt.id, 'code', bt.code, 'displayName', bt.display_name
         ) AS "bankType",
         b.code, b.display_name AS "displayName", b.english_name AS "englishName",
         b.country_code AS "countryCode", b.national_bank_code AS "nationalBankCode",
         b.swift_code AS "swiftCode", b.logo_ref AS "logoRef", b.state,
         ${VIEW_TIMESTAMPS('b')}
  FROM banks b
  JOIN bank_types bt
    ON bt.organization_id = b.organization_id AND bt.id = b.bank_type_id
`;

const BANK_BRANCH_VIEW_SELECT = `
  SELECT bb.id, bb.organization_id AS "organizationId", bb.bank_id AS "bankId",
         jsonb_build_object(
           'id', b.id, 'code', b.code, 'displayName', b.display_name
         ) AS bank,
         bb.code, bb.name, bb.city, bb.address,
         bb.contact_reference AS "contactReference", bb.state,
         ${VIEW_TIMESTAMPS('bb')}
  FROM bank_branches bb
  JOIN banks b ON b.organization_id = bb.organization_id AND b.id = bb.bank_id
`;

const BANK_ACCOUNT_VIEW_SELECT = `
  SELECT ba.id, ba.organization_id AS "organizationId", ba.bank_id AS "bankId",
         jsonb_build_object(
           'id', b.id, 'code', b.code, 'displayName', b.display_name
         ) AS bank,
         ba.bank_branch_id AS "bankBranchId",
         CASE WHEN bb.id IS NULL THEN NULL ELSE jsonb_build_object(
           'id', bb.id, 'code', bb.code, 'name', bb.name
         ) END AS "bankBranch",
         ba.organization_branch_id AS "organizationBranchId",
         CASE WHEN br.id IS NULL THEN NULL ELSE jsonb_build_object(
           'id', br.id, 'code', br.code, 'name', br.name
         ) END AS "organizationBranch",
         ba.treasury_unit_id AS "treasuryUnitId",
         CASE WHEN tu.id IS NULL THEN NULL ELSE jsonb_build_object(
           'id', tu.id, 'code', tu.code, 'name', tu.name
         ) END AS "treasuryUnit",
         ba.account_type AS "accountType", ba.account_number AS "accountNumber",
         ba.iban, ba.masked_card_number AS "maskedCardNumber", ba.currency,
         ba.legal_owner_name AS "legalOwnerName", ba.cheque_enabled AS "chequeEnabled",
         jsonb_build_object(
           'receive', ba.can_receive, 'pay', ba.can_pay, 'transfer', ba.can_transfer
         ) AS capabilities,
         CASE WHEN ba.withdrawal_ceiling IS NULL THEN NULL ELSE jsonb_build_object(
           'amount', ba.withdrawal_ceiling::text,
           'currency', ba.withdrawal_ceiling_currency
         ) END AS "withdrawalCeiling",
         to_char(ba.opening_date, 'YYYY-MM-DD') AS "openingDate",
         to_char(ba.closing_date, 'YYYY-MM-DD') AS "closingDate",
         ba.accounting_dimensions AS "accountingDimensions", ba.state,
         ${VIEW_TIMESTAMPS('ba')}
  FROM bank_accounts ba
  JOIN banks b ON b.organization_id = ba.organization_id AND b.id = ba.bank_id
  LEFT JOIN bank_branches bb
    ON bb.organization_id = ba.organization_id
   AND bb.bank_id = ba.bank_id
   AND bb.id = ba.bank_branch_id
  LEFT JOIN branches br
    ON br.organization_id = ba.organization_id AND br.id = ba.organization_branch_id
  LEFT JOIN treasury_units tu
    ON tu.organization_id = ba.organization_id AND tu.id = ba.treasury_unit_id
`;

const BANK_ACCOUNT_SUMMARY = `
  jsonb_strip_nulls(jsonb_build_object(
    'id', ba.id,
    'bank', jsonb_build_object(
      'id', b.id, 'code', b.code, 'displayName', b.display_name
    ),
    'accountNumber', ba.account_number,
    'iban', ba.iban,
    'currency', ba.currency,
    'legalOwnerName', ba.legal_owner_name
  ))
`;

const POS_TERMINAL_VIEW_SELECT = `
  SELECT pt.id, pt.organization_id AS "organizationId",
         pt.bank_account_id AS "bankAccountId",
         ${BANK_ACCOUNT_SUMMARY} AS "bankAccount",
         pt.terminal_number AS "terminalNumber",
         pt.merchant_number AS "merchantNumber",
         br.id AS "organizationBranchId",
         CASE WHEN br.id IS NULL THEN NULL ELSE jsonb_build_object(
           'id', br.id, 'code', br.code, 'name', br.name
         ) END AS "organizationBranch",
         pt.treasury_unit_id AS "treasuryUnitId",
         jsonb_build_object('id', tu.id, 'code', tu.code, 'name', tu.name)
           AS "treasuryUnit",
         pt.currency, pt.settlement_cycle AS "settlementCycle",
         pt.fee_rule_ref AS "feeRuleRef", pt.provider_label AS "providerLabel",
         pt.state, ${VIEW_TIMESTAMPS('pt')}
  FROM pos_terminals pt
  JOIN bank_accounts ba
    ON ba.organization_id = pt.organization_id AND ba.id = pt.bank_account_id
  JOIN banks b ON b.organization_id = ba.organization_id AND b.id = ba.bank_id
  JOIN treasury_units tu
    ON tu.organization_id = pt.organization_id AND tu.id = pt.treasury_unit_id
  LEFT JOIN branches br
    ON br.organization_id = tu.organization_id AND br.id = tu.branch_id
`;

const PAYMENT_GATEWAY_VIEW_SELECT = `
  SELECT pg.id, pg.organization_id AS "organizationId",
         pg.bank_account_id AS "bankAccountId",
         ${BANK_ACCOUNT_SUMMARY} AS "bankAccount",
         pg.provider_code AS "providerCode", pg.merchant_id AS "merchantId",
         pg.terminal_id AS "terminalId", br.id AS "organizationBranchId",
         CASE WHEN br.id IS NULL THEN NULL ELSE jsonb_build_object(
           'id', br.id, 'code', br.code, 'name', br.name
         ) END AS "organizationBranch",
         pg.treasury_unit_id AS "treasuryUnitId",
         jsonb_build_object('id', tu.id, 'code', tu.code, 'name', tu.name)
           AS "treasuryUnit",
         pg.currency, pg.settlement_cycle AS "settlementCycle",
         pg.fee_rule_ref AS "feeRuleRef",
         pg.funds_in_transit_mapping_ref AS "fundsInTransitMappingRef",
         pg.fee_mapping_ref AS "feeMappingRef", pg.state,
         ${VIEW_TIMESTAMPS('pg')}
  FROM payment_gateways pg
  JOIN bank_accounts ba
    ON ba.organization_id = pg.organization_id AND ba.id = pg.bank_account_id
  JOIN banks b ON b.organization_id = ba.organization_id AND b.id = ba.bank_id
  JOIN treasury_units tu
    ON tu.organization_id = pg.organization_id AND tu.id = pg.treasury_unit_id
  LEFT JOIN branches br
    ON br.organization_id = tu.organization_id AND br.id = tu.branch_id
`;

function scopedPermission(
  branch: string,
  unit: string,
  account: string,
  currency: string,
): string {
  return `EXISTS (
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
      AND NOT EXISTS (
        SELECT 1 FROM access_grant_cashbox_scopes s WHERE s.access_grant_id = ag.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM access_grant_document_type_scopes s
        WHERE s.access_grant_id = ag.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM access_grant_method_category_scopes s
        WHERE s.access_grant_id = ag.id
      )
      AND (
        NOT EXISTS (
          SELECT 1 FROM access_grant_branch_scopes s WHERE s.access_grant_id = ag.id
        )
        OR EXISTS (
          SELECT 1 FROM access_grant_branch_scopes s
          WHERE s.access_grant_id = ag.id AND s.branch_id = ${branch}
        )
      )
      AND (
        NOT EXISTS (
          SELECT 1 FROM access_grant_treasury_unit_scopes s
          WHERE s.access_grant_id = ag.id
        )
        OR EXISTS (
          SELECT 1 FROM access_grant_treasury_unit_scopes s
          WHERE s.access_grant_id = ag.id AND s.treasury_unit_id = ${unit}
        )
      )
      AND (
        NOT EXISTS (
          SELECT 1 FROM access_grant_bank_account_scopes s
          WHERE s.access_grant_id = ag.id
        )
        OR EXISTS (
          SELECT 1 FROM access_grant_bank_account_scopes s
          WHERE s.access_grant_id = ag.id AND s.bank_account_id = ${account}
        )
      )
      AND (
        NOT EXISTS (
          SELECT 1 FROM access_grant_currency_scopes s WHERE s.access_grant_id = ag.id
        )
        OR EXISTS (
          SELECT 1 FROM access_grant_currency_scopes s
          WHERE s.access_grant_id = ag.id AND s.currency = ${currency}
        )
      )
  )`;
}

async function one<T extends object>(
  client: PoolClient,
  query: string,
  id: string,
): Promise<T> {
  const result = await client.query<T>(query, [id]);
  return compact(result.rows[0]!) as T;
}

function page<T extends object>(
  rows: T[],
  limit: number,
): { items: T[]; hasMore: boolean } {
  return {
    items: rows.slice(0, limit).map((row) => compact(row) as T),
    hasMore: rows.length > limit,
  };
}

function compact<T extends object>(record: T): T {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== null),
  ) as T;
}
