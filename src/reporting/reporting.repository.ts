import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  SQLWrapper,
  sql,
} from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import {
  accessGrants,
  bankAccounts,
  banks,
  branches,
  cashboxes,
  collectionItems,
  currencies,
  methodDefinitions,
  organizations,
  parties,
  paymentGateways,
  posTerminals,
  receiptAllocations,
  receiptDocuments,
  receiptExecutionEffects,
  receiptLines,
  receivedCheques,
  rolePermissions,
  roles,
  treasuryUnits,
  userRefs,
} from '../database/schema';
import {
  ChequeReportRow,
  FundsInTransitReportRow,
  OperationalReportRow,
  ReceiptReportRow,
  ReportCurrencyMode,
  ReportKey,
  ReportSemanticRef,
} from './reporting.dto';

export interface NormalizedReportFilters {
  businessDateFrom?: string;
  businessDateTo?: string;
  dueDateFrom?: string;
  dueDateTo?: string;
  branchId?: string;
  treasuryUnitId?: string;
  cashboxId?: string;
  bankAccountId?: string;
  userId?: string;
  partyId?: string;
  methodId?: string;
  currency?: string;
  states: string[];
  projectRef?: string;
  costCenterRef?: string;
  accountingStates: string[];
  channelType?: string;
}

export interface ReportKeyset {
  businessDate: string;
  id: string;
}

export interface ReportScopeSnapshot {
  grantId: string;
  grantVersion: number;
  roleId: string;
  roleVersion: number;
  organizationWide: boolean;
  validFrom: string;
  validTo: string | null;
  branches: ReportSemanticRef[];
  treasuryUnits: ReportSemanticRef[];
  cashboxes: ReportSemanticRef[];
  bankAccounts: ReportSemanticRef[];
  currencies: ReportSemanticRef[];
}

export interface ReportContext {
  organization: ReportSemanticRef;
  timezone: string;
  branch: ReportSemanticRef | null;
  treasuryUnit: ReportSemanticRef | null;
  cashbox: ReportSemanticRef | null;
  bankAccount: ReportSemanticRef | null;
  user: ReportSemanticRef | null;
  party: ReportSemanticRef | null;
  method: ReportSemanticRef | null;
  currency: ReportSemanticRef | null;
}

export interface ReportListInput {
  organizationId: string;
  actorUserId: string;
  authorizedGrantIds: string[];
  filters: NormalizedReportFilters;
  currencyMode: ReportCurrencyMode;
  businessDate: string;
  limit: number;
  asOf: string;
  after?: ReportKeyset;
}

export interface ReportListResult {
  items: OperationalReportRow[];
  keys: ReportKeyset[];
  hasMore: boolean;
}

@Injectable()
export class ReportingRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async currentScope(
    organizationId: string,
    actorUserId: string,
  ): Promise<ReportScopeSnapshot[]> {
    return this.database.db
      .select({
        grantId: accessGrants.id,
        grantVersion: accessGrants.version,
        roleId: roles.id,
        roleVersion: roles.version,
        organizationWide: accessGrants.organizationWide,
        validFrom: sql<string>`${accessGrants.validFrom}::text`,
        validTo: sql<string | null>`${accessGrants.validTo}::text`,
        branches: this.scopeRefs(
          'access_grant_branch_scopes',
          'branch_id',
          'branches',
          'name',
          accessGrants.id,
        ),
        treasuryUnits: this.scopeRefs(
          'access_grant_treasury_unit_scopes',
          'treasury_unit_id',
          'treasury_units',
          'name',
          accessGrants.id,
        ),
        cashboxes: this.scopeRefs(
          'access_grant_cashbox_scopes',
          'cashbox_id',
          'cashboxes',
          'name',
          accessGrants.id,
        ),
        bankAccounts: sql<ReportSemanticRef[]>`COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', account.id,
              'label', concat(account.legal_owner_name, ' · ', account.account_number)
            )
            ORDER BY account.id
          )
          FROM access_grant_bank_account_scopes AS scope
          JOIN bank_accounts AS account ON account.id = scope.bank_account_id
          WHERE scope.access_grant_id = ${accessGrants.id}
        ), '[]'::jsonb)`,
        currencies: sql<ReportSemanticRef[]>`COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object('id', scope.currency, 'label', currency.name)
            ORDER BY scope.currency
          )
          FROM access_grant_currency_scopes AS scope
          JOIN currencies AS currency
            ON currency.organization_id = ${accessGrants.organizationId}
           AND currency.code = scope.currency
          WHERE scope.access_grant_id = ${accessGrants.id}
        ), '[]'::jsonb)`,
      })
      .from(accessGrants)
      .innerJoin(
        roles,
        and(
          eq(roles.id, accessGrants.roleId),
          eq(roles.organizationId, accessGrants.organizationId),
          eq(roles.state, 'ACTIVE'),
        ),
      )
      .innerJoin(
        rolePermissions,
        and(
          eq(rolePermissions.roleId, roles.id),
          eq(rolePermissions.permission, 'report.view'),
        ),
      )
      .where(and(
        eq(accessGrants.organizationId, organizationId),
        eq(accessGrants.userRefId, actorUserId),
        eq(accessGrants.state, 'ACTIVE'),
        lte(accessGrants.validFrom, new Date()),
        or(isNull(accessGrants.validTo), gt(accessGrants.validTo, new Date())),
      ))
      .orderBy(accessGrants.id);
  }

  async context(
    organizationId: string,
    actorUserId: string,
    authorizedGrantIds: string[],
    filters: NormalizedReportFilters,
  ): Promise<ReportContext | undefined> {
    const rows = await this.database.db
      .select({
        organization: sql<ReportSemanticRef>`jsonb_build_object(
          'id', ${organizations.id}, 'label', ${organizations.legalName}
        )`,
        timezone: organizations.timezone,
        branch: this.filterRef(
          filters.branchId,
          sql`SELECT id, name AS label FROM branches
              WHERE organization_id = ${organizationId} AND id = ${filters.branchId}`,
        ),
        treasuryUnit: this.filterRef(
          filters.treasuryUnitId,
          sql`SELECT id, name AS label FROM treasury_units
              WHERE organization_id = ${organizationId} AND id = ${filters.treasuryUnitId}`,
        ),
        cashbox: this.filterRef(
          filters.cashboxId,
          sql`SELECT id, name AS label FROM cashboxes
              WHERE organization_id = ${organizationId} AND id = ${filters.cashboxId}`,
        ),
        bankAccount: this.filterRef(
          filters.bankAccountId,
          sql`SELECT id, concat(legal_owner_name, ' · ', account_number) AS label
              FROM bank_accounts
              WHERE organization_id = ${organizationId} AND id = ${filters.bankAccountId}`,
        ),
        user: this.filterRef(
          filters.userId,
          sql`SELECT id, display_name AS label FROM user_refs
              WHERE organization_id = ${organizationId} AND id = ${filters.userId}`,
        ),
        party: this.filterRef(
          filters.partyId,
          sql`SELECT id, display_name AS label FROM parties
              WHERE organization_id = ${organizationId} AND id = ${filters.partyId}`,
        ),
        method: this.filterRef(
          filters.methodId,
          sql`SELECT id, name AS label FROM method_definitions
              WHERE organization_id = ${organizationId} AND id = ${filters.methodId}`,
        ),
        currency: this.filterRef(
          filters.currency,
          sql`SELECT code AS id, name AS label FROM currencies
              WHERE organization_id = ${organizationId} AND code = ${filters.currency}`,
        ),
      })
      .from(organizations)
      .where(and(
        eq(organizations.id, organizationId),
        this.filterGrantAuthorization(
          organizationId,
          actorUserId,
          authorizedGrantIds,
          filters,
        ),
      ))
      .limit(1);
    return rows[0];
  }

  async list(reportKey: ReportKey, input: ReportListInput): Promise<ReportListResult> {
    if (reportKey === 'receipts') return this.receipts(input);
    if (reportKey === 'received-cheques') return this.receivedCheques(input);
    if (reportKey === 'issued-cheques') return this.issuedCheques(input);
    if (reportKey === 'funds-in-transit') return this.fundsInTransit(input);
    return { items: [], keys: [], hasMore: false };
  }

  async sourceWatermark(
    reportKey: ReportKey,
    organizationId: string,
  ): Promise<string> {
    const source = reportKey === 'receipts'
      ? this.ownerDigest(organizationId, [
        'organizations',
        'receipt_documents',
        'receipt_lines',
        'receipt_allocations',
        'receipt_execution_effects',
        'collection_items',
        'branches',
        'treasury_units',
        'cashboxes',
        'bank_accounts',
        'user_refs',
        'parties',
        'method_definitions',
        'currencies',
        'pos_terminals',
        'payment_gateways',
      ])
      : reportKey === 'received-cheques'
        ? this.ownerDigest(organizationId, [
          'organizations',
          'received_cheques',
          'receipt_execution_effects',
          'receipt_documents',
          'receipt_lines',
          'branches',
          'treasury_units',
          'cashboxes',
          'bank_accounts',
          'banks',
          'parties',
          'currencies',
          'pos_terminals',
          'payment_gateways',
        ])
        : reportKey === 'issued-cheques'
          ? this.ownerDigest(organizationId, [
            'organizations',
            'cheque_books',
            'cheque_leaves',
            'bank_accounts',
            'banks',
            'user_refs',
            'currencies',
          ])
          : this.ownerDigest(organizationId, [
            'organizations',
            'collection_items',
            'received_cheques',
            'cheque_leaves',
            'receipt_execution_effects',
            'receipt_documents',
            'receipt_lines',
            'branches',
            'treasury_units',
            'bank_accounts',
            'parties',
            'currencies',
            'pos_terminals',
            'payment_gateways',
          ]);
    const rows = await this.database.db
      .select({ source })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    return `${reportKey}:${rows[0]?.source ?? 'none'}`;
  }

  private async receipts(input: ReportListInput): Promise<ReportListResult> {
    const effectiveBankAccountId = sql<string | null>`COALESCE(
      ${receiptLines.bankAccountId},
      ${posTerminals.bankAccountId},
      ${paymentGateways.bankAccountId}
    )`;
    const allocation = sql<string>`COALESCE((
      SELECT sum(allocation.base_amount)
      FROM receipt_allocations AS allocation
      WHERE allocation.organization_id = ${receiptLines.organizationId}
        AND allocation.receipt_line_id = ${receiptLines.id}
        AND allocation.state = 'ACTIVE'
        AND allocation.created_at <= ${new Date(input.asOf)}
    ), 0)::text`;
    const collectionState = sql<string | null>`(
      SELECT item.state
      FROM receipt_execution_effects AS effect
      JOIN collection_items AS item
        ON item.organization_id = effect.organization_id
       AND item.id = effect.collection_item_id
      WHERE effect.organization_id = ${receiptLines.organizationId}
        AND effect.receipt_line_id = ${receiptLines.id}
        AND effect.direction = 'INCOMING'
        AND effect.created_at <= ${new Date(input.asOf)}
      ORDER BY effect.created_at DESC, effect.id DESC
      LIMIT 1
    )`;
    const conditions = [
      eq(receiptDocuments.organizationId, input.organizationId),
      lte(receiptDocuments.createdAt, new Date(input.asOf)),
      lte(receiptLines.createdAt, new Date(input.asOf)),
      this.oneGrantScope(input, {
        branchId: receiptDocuments.branchId,
        treasuryUnitId: receiptDocuments.treasuryUnitId,
        cashboxId: receiptLines.cashboxId,
        bankAccountId: effectiveBankAccountId,
        currency: receiptLines.currency,
        partyId: receiptDocuments.partyId,
        projectRef: receiptDocuments.projectRef,
        costCenterRef: receiptDocuments.costCenterRef,
      }),
    ];
    this.receiptFilters(conditions, input.filters, effectiveBankAccountId);
    if (input.after) {
      conditions.push(or(
        lt(receiptDocuments.businessDate, input.after.businessDate),
        and(
          eq(receiptDocuments.businessDate, input.after.businessDate),
          lt(receiptLines.id, input.after.id),
        ),
      )!);
    }

    const rows = await this.database.db
      .select({
        id: receiptLines.id,
        businessDate: receiptDocuments.businessDate,
        businessNumber: receiptDocuments.businessNumber,
        lineNumber: receiptLines.lineNumber,
        organizationId: organizations.id,
        organizationLabel: organizations.legalName,
        branchId: receiptDocuments.branchId,
        branchLabel: branches.name,
        treasuryUnitId: receiptDocuments.treasuryUnitId,
        treasuryUnitLabel: treasuryUnits.name,
        cashboxId: receiptLines.cashboxId,
        cashboxLabel: cashboxes.name,
        bankAccountId: effectiveBankAccountId,
        bankAccountLabel: sql<string | null>`CASE WHEN ${bankAccounts.id} IS NULL
          THEN NULL
          ELSE concat(${bankAccounts.legalOwnerName}, ' · ', ${bankAccounts.accountNumber})
        END`,
        userId: receiptDocuments.creatorUserId,
        userLabel: userRefs.displayName,
        partyId: receiptDocuments.partyId,
        partyLabel: parties.displayName,
        methodId: receiptLines.methodId,
        methodLabel: receiptLines.methodName,
        currencyCode: receiptLines.currency,
        currencyLabel: currencies.name,
        projectRef: receiptDocuments.projectRef,
        costCenterRef: receiptDocuments.costCenterRef,
        amount: receiptLines.amount,
        baseAmount: receiptLines.baseAmount,
        baseCurrency: receiptLines.baseCurrency,
        allocatedAmount: allocation,
        collectionState,
        documentState: receiptDocuments.state,
        workflowState: receiptDocuments.workflowState,
        executionState: receiptDocuments.executionState,
        accountingState: receiptDocuments.accountingState,
      })
      .from(receiptLines)
      .innerJoin(
        receiptDocuments,
        and(
          eq(receiptDocuments.organizationId, receiptLines.organizationId),
          eq(receiptDocuments.id, receiptLines.receiptDocumentId),
        ),
      )
      .innerJoin(organizations, eq(organizations.id, receiptDocuments.organizationId))
      .leftJoin(
        branches,
        and(
          eq(branches.organizationId, receiptDocuments.organizationId),
          eq(branches.id, receiptDocuments.branchId),
        ),
      )
      .innerJoin(
        treasuryUnits,
        and(
          eq(treasuryUnits.organizationId, receiptDocuments.organizationId),
          eq(treasuryUnits.id, receiptDocuments.treasuryUnitId),
        ),
      )
      .leftJoin(
        cashboxes,
        and(
          eq(cashboxes.organizationId, receiptLines.organizationId),
          eq(cashboxes.id, receiptLines.cashboxId),
        ),
      )
      .leftJoin(
        posTerminals,
        and(
          eq(posTerminals.organizationId, receiptLines.organizationId),
          eq(posTerminals.id, receiptLines.posTerminalId),
        ),
      )
      .leftJoin(
        paymentGateways,
        and(
          eq(paymentGateways.organizationId, receiptLines.organizationId),
          eq(paymentGateways.id, receiptLines.paymentGatewayId),
        ),
      )
      .leftJoin(
        bankAccounts,
        and(
          eq(bankAccounts.organizationId, receiptLines.organizationId),
          eq(bankAccounts.id, effectiveBankAccountId),
        ),
      )
      .innerJoin(
        userRefs,
        and(
          eq(userRefs.organizationId, receiptDocuments.organizationId),
          eq(userRefs.id, receiptDocuments.creatorUserId),
        ),
      )
      .innerJoin(
        parties,
        and(
          eq(parties.organizationId, receiptDocuments.organizationId),
          eq(parties.id, receiptDocuments.partyId),
        ),
      )
      .innerJoin(
        currencies,
        and(
          eq(currencies.organizationId, receiptLines.organizationId),
          eq(currencies.code, receiptLines.currency),
        ),
      )
      .where(and(...conditions))
      .orderBy(desc(receiptDocuments.businessDate), desc(receiptLines.id))
      .limit(input.limit + 1);

    const visible = rows.slice(0, input.limit);
    return {
      items: visible.map((row): ReceiptReportRow => {
        const zero = this.money('0', row.baseCurrency);
        const allocated = this.money(row.allocatedAmount, row.baseCurrency);
        const unallocated = this.money(
          this.subtract(row.baseAmount, row.allocatedAmount),
          row.baseCurrency,
        );
        const reversed = row.documentState === 'REVERSED'
          ? this.money(row.baseAmount, row.baseCurrency)
          : zero;
        const transit = row.collectionState && row.collectionState !== 'SETTLED'
          ? this.money(row.baseAmount, row.baseCurrency)
          : zero;
        const settled = row.collectionState === 'SETTLED'
          ? this.money(row.baseAmount, row.baseCurrency)
          : zero;
        return {
          kind: 'RECEIPT',
          source: {
            type: 'RECEIPT_LINE',
            id: row.id,
            label: `Receipt ${row.businessNumber} · line ${row.lineNumber}`,
          },
          businessDate: row.businessDate,
          organization: this.ref(row.organizationId, row.organizationLabel),
          ...(row.branchId && row.branchLabel
            ? { branch: this.ref(row.branchId, row.branchLabel) }
            : {}),
          treasuryUnit: this.ref(row.treasuryUnitId, row.treasuryUnitLabel),
          ...(row.cashboxId && row.cashboxLabel
            ? { cashbox: this.ref(row.cashboxId, row.cashboxLabel) }
            : {}),
          ...(row.bankAccountId && row.bankAccountLabel
            ? { bankAccount: this.ref(row.bankAccountId, row.bankAccountLabel) }
            : {}),
          user: this.ref(row.userId, row.userLabel),
          party: this.ref(row.partyId, row.partyLabel),
          method: this.ref(row.methodId, row.methodLabel),
          currency: this.ref(row.currencyCode, row.currencyLabel),
          ...(row.projectRef
            ? { project: this.ref(row.projectRef, this.referenceLabel(row.projectRef, 'Project')) }
            : {}),
          ...(row.costCenterRef
            ? {
              costCenter: this.ref(
                row.costCenterRef,
                this.referenceLabel(row.costCenterRef, 'Cost center'),
              ),
            }
            : {}),
          documentCount: 1,
          lineCount: 1,
          original: this.money(row.amount, row.currencyCode),
          base: this.money(row.baseAmount, row.baseCurrency),
          allocated,
          unallocated,
          reversed,
          transit,
          settled,
          workflowState: row.workflowState,
          executionState: row.executionState as ReceiptReportRow['executionState'],
          accountingState: row.accountingState,
        };
      }),
      keys: visible.map(({ businessDate, id }) => ({ businessDate, id })),
      hasMore: rows.length > input.limit,
    };
  }

  private async receivedCheques(input: ReportListInput): Promise<ReportListResult> {
    const effectiveCashboxId = sql<string | null>`CASE
      WHEN ${receivedCheques.custodianType} = 'CASHBOX' THEN ${receivedCheques.custodianId}
      ELSE ${receiptLines.cashboxId}
    END`;
    const effectiveBankAccountId = sql<string | null>`COALESCE(
      ${receiptLines.bankAccountId},
      ${posTerminals.bankAccountId},
      ${paymentGateways.bankAccountId}
    )`;
    const partyId = sql<string>`COALESCE(
      ${receivedCheques.payerPartyId},
      ${receiptDocuments.partyId}
    )`;
    const conditions = [
      eq(receivedCheques.organizationId, input.organizationId),
      lte(receiptExecutionEffects.createdAt, new Date(input.asOf)),
      this.oneGrantScope(input, {
        branchId: receiptDocuments.branchId,
        treasuryUnitId: receiptDocuments.treasuryUnitId,
        cashboxId: effectiveCashboxId,
        bankAccountId: effectiveBankAccountId,
        currency: receivedCheques.currency,
        partyId,
        projectRef: sql<null>`NULL`,
        costCenterRef: sql<null>`NULL`,
      }),
    ];
    this.chequeFilters(
      conditions,
      input.filters,
      effectiveCashboxId,
      effectiveBankAccountId,
      partyId,
    );
    if (input.after) {
      conditions.push(or(
        lt(receiptExecutionEffects.businessDate, input.after.businessDate),
        and(
          eq(receiptExecutionEffects.businessDate, input.after.businessDate),
          lt(receivedCheques.id, input.after.id),
        ),
      )!);
    }

    const rows = await this.database.db
      .select({
        id: receivedCheques.id,
        businessDate: receiptExecutionEffects.businessDate,
        organizationId: organizations.id,
        organizationLabel: organizations.legalName,
        partyId,
        partyLabel: sql<string>`COALESCE((
          SELECT display_name FROM parties
          WHERE organization_id = ${receivedCheques.organizationId}
            AND id = ${partyId}
        ), 'Unknown party')`,
        bankId: receivedCheques.issuerBankId,
        bankLabel: banks.displayName,
        bankAccountId: effectiveBankAccountId,
        bankAccountLabel: sql<string | null>`CASE WHEN ${bankAccounts.id} IS NULL
          THEN NULL
          ELSE concat(${bankAccounts.legalOwnerName}, ' · ', ${bankAccounts.accountNumber})
        END`,
        cashboxId: effectiveCashboxId,
        cashboxLabel: sql<string | null>`(
          SELECT name FROM cashboxes
          WHERE organization_id = ${receivedCheques.organizationId}
            AND id = ${effectiveCashboxId}
        )`,
        chequeNumber: receivedCheques.chequeNumber,
        series: receivedCheques.series,
        custodianId: receivedCheques.custodianId,
        custodyLabel: sql<string>`CASE
          WHEN ${receivedCheques.custodianType} = 'CASHBOX' THEN COALESCE((
            SELECT name FROM cashboxes
            WHERE organization_id = ${receivedCheques.organizationId}
              AND id = ${receivedCheques.custodianId}
          ), 'Cashbox')
          ELSE COALESCE((
            SELECT name FROM treasury_units
            WHERE organization_id = ${receivedCheques.organizationId}
              AND id = ${receivedCheques.custodianId}
          ), 'Treasury unit')
        END`,
        state: receivedCheques.state,
        dueDate: receivedCheques.dueDate,
        amount: input.currencyMode === 'BASE_SOURCE_SNAPSHOT'
          ? receiptLines.baseAmount
          : receivedCheques.amount,
        currency: input.currencyMode === 'BASE_SOURCE_SNAPSHOT'
          ? receiptLines.baseCurrency
          : receivedCheques.currency,
      })
      .from(receivedCheques)
      .innerJoin(
        receiptExecutionEffects,
        and(
          eq(receiptExecutionEffects.organizationId, receivedCheques.organizationId),
          eq(receiptExecutionEffects.receivedChequeId, receivedCheques.id),
          eq(receiptExecutionEffects.direction, 'INCOMING'),
        ),
      )
      .innerJoin(
        receiptLines,
        and(
          eq(receiptLines.organizationId, receivedCheques.organizationId),
          eq(receiptLines.id, receivedCheques.receiptLineId),
        ),
      )
      .innerJoin(
        receiptDocuments,
        and(
          eq(receiptDocuments.organizationId, receiptLines.organizationId),
          eq(receiptDocuments.id, receiptLines.receiptDocumentId),
        ),
      )
      .innerJoin(organizations, eq(organizations.id, receivedCheques.organizationId))
      .innerJoin(
        banks,
        and(
          eq(banks.organizationId, receivedCheques.organizationId),
          eq(banks.id, receivedCheques.issuerBankId),
        ),
      )
      .leftJoin(
        posTerminals,
        and(
          eq(posTerminals.organizationId, receiptLines.organizationId),
          eq(posTerminals.id, receiptLines.posTerminalId),
        ),
      )
      .leftJoin(
        paymentGateways,
        and(
          eq(paymentGateways.organizationId, receiptLines.organizationId),
          eq(paymentGateways.id, receiptLines.paymentGatewayId),
        ),
      )
      .leftJoin(
        bankAccounts,
        and(
          eq(bankAccounts.organizationId, receiptLines.organizationId),
          eq(bankAccounts.id, effectiveBankAccountId),
        ),
      )
      .where(and(...conditions))
      .orderBy(desc(receiptExecutionEffects.businessDate), desc(receivedCheques.id))
      .limit(input.limit + 1);

    const visible = rows.slice(0, input.limit);
    return {
      items: visible.map((row): ChequeReportRow => ({
        kind: 'RECEIVED_CHEQUE',
        source: {
          type: 'RECEIVED_CHEQUE',
          id: row.id,
          label: `Received cheque ${row.chequeNumber}`,
        },
        organization: this.ref(row.organizationId, row.organizationLabel),
        party: this.ref(row.partyId, row.partyLabel),
        bank: this.ref(row.bankId, row.bankLabel),
        ...(row.bankAccountId && row.bankAccountLabel
          ? { bankAccount: this.ref(row.bankAccountId, row.bankAccountLabel) }
          : {}),
        ...(row.cashboxId && row.cashboxLabel
          ? { cashbox: this.ref(row.cashboxId, row.cashboxLabel) }
          : {}),
        leaf: this.ref(
          row.id,
          row.series ? `${row.series} · ${row.chequeNumber}` : row.chequeNumber,
        ),
        custody: this.ref(row.custodianId, row.custodyLabel),
        state: row.state,
        dueDate: row.dueDate,
        dueStatus: this.dueStatus(
          'RECEIVED_CHEQUE',
          row.state,
          row.dueDate,
          input.businessDate,
        ),
        amount: this.money(row.amount, row.currency),
      })),
      keys: visible.map(({ businessDate, id }) => ({ businessDate, id })),
      hasMore: rows.length > input.limit,
    };
  }

  private async issuedCheques(_input: ReportListInput): Promise<ReportListResult> {
    // INC-2E cannot manufacture an IssuedCheque from Foundation ChequeLeaf facts.
    // The current owner runtime has no issued-cheque/payment aggregate carrying
    // the Canon-required party, custody, due-date, and Money facts.
    return { items: [], keys: [], hasMore: false };
  }

  private async fundsInTransit(input: ReportListInput): Promise<ReportListResult> {
    const businessDate = sql<string>`CASE
      WHEN ${collectionItems.sourceFactType} = 'RECEIPT_LINE'
        THEN ${receiptDocuments.businessDate}
      ELSE (${collectionItems.collectedAt} AT TIME ZONE ${organizations.timezone})::date
    END`;
    const conditions = [
      eq(collectionItems.organizationId, input.organizationId),
      lte(collectionItems.createdAt, new Date(input.asOf)),
      this.oneGrantScope(input, {
        branchId: collectionItems.branchId,
        treasuryUnitId: collectionItems.treasuryUnitId,
        cashboxId: receiptLines.cashboxId,
        bankAccountId: collectionItems.destinationBankAccountId,
        currency: collectionItems.currency,
        partyId: collectionItems.collectedPartyId,
        projectRef: sql<null>`NULL`,
        costCenterRef: sql<null>`NULL`,
      }),
    ];
    this.fundsFilters(conditions, input.filters, businessDate);
    if (input.after) {
      conditions.push(or(
        lt(businessDate, input.after.businessDate),
        and(
          eq(businessDate, input.after.businessDate),
          lt(collectionItems.id, input.after.id),
        ),
      )!);
    }
    const amount = input.currencyMode === 'BASE_SOURCE_SNAPSHOT'
      ? sql<string>`CASE
          WHEN ${collectionItems.sourceFactType} = 'RECEIPT_LINE' THEN round(
            ${collectionItems.grossAmount}::numeric * ${receiptLines.exchangeRate}::numeric,
            8
          )::text
          ELSE ${collectionItems.grossAmount}::text
        END`
      : collectionItems.grossAmount;
    const currency = input.currencyMode === 'BASE_SOURCE_SNAPSHOT'
      ? sql<string>`CASE
          WHEN ${collectionItems.sourceFactType} = 'RECEIPT_LINE'
            THEN ${receiptLines.baseCurrency}
          ELSE ${collectionItems.currency}
        END`
      : collectionItems.currency;

    const rows = await this.database.db
      .select({
        id: collectionItems.id,
        businessDate,
        organizationId: organizations.id,
        organizationLabel: organizations.legalName,
        branchId: collectionItems.branchId,
        branchLabel: branches.name,
        treasuryUnitId: collectionItems.treasuryUnitId,
        treasuryUnitLabel: treasuryUnits.name,
        destinationBankAccountId: collectionItems.destinationBankAccountId,
        destinationBankAccountLabel: sql<string>`concat(
          ${bankAccounts.legalOwnerName}, ' · ', ${bankAccounts.accountNumber}
        )`,
        channelId: collectionItems.channelId,
        channelType: collectionItems.channelType,
        channelLabel: sql<string>`CASE
          WHEN ${collectionItems.channelType} = 'POS' THEN COALESCE((
            SELECT concat(COALESCE(provider_label, 'POS terminal'), ' · ', terminal_number)
            FROM pos_terminals
            WHERE organization_id = ${collectionItems.organizationId}
              AND id = ${collectionItems.channelId}
          ), 'POS')
          WHEN ${collectionItems.channelType} = 'GATEWAY' THEN COALESCE((
            SELECT concat(provider_code, ' · ', merchant_id)
            FROM payment_gateways
            WHERE organization_id = ${collectionItems.organizationId}
              AND id = ${collectionItems.channelId}
          ), 'Gateway')
          ELSE replace(initcap(lower(${collectionItems.channelType})), '_', ' ')
        END`,
        sourceFactType: collectionItems.sourceFactType,
        sourceFactId: collectionItems.sourceFactId,
        sourceLabel: sql<string>`CASE
          WHEN ${collectionItems.sourceFactType} = 'RECEIPT_LINE' THEN concat(
            'Receipt ', ${receiptDocuments.businessNumber}, ' · line ', ${receiptLines.lineNumber}
          )
          ELSE COALESCE((
            SELECT CASE
              WHEN event.cheque_type = 'RECEIVED' THEN COALESCE((
                SELECT concat(
                  'Received cheque ',
                  CASE WHEN cheque.series IS NULL THEN '' ELSE cheque.series || ' · ' END,
                  cheque.cheque_number
                )
                FROM received_cheques AS cheque
                WHERE cheque.organization_id = ${collectionItems.organizationId}
                  AND cheque.id = event.cheque_id
              ), 'Received cheque')
              WHEN event.cheque_type = 'LEAF' THEN COALESCE((
                SELECT concat('Cheque leaf ', leaf.series, ' · ', leaf.leaf_number)
                FROM cheque_leaves AS leaf
                WHERE leaf.organization_id = ${collectionItems.organizationId}
                  AND leaf.id = event.cheque_id
              ), 'Cheque leaf')
              WHEN event.cheque_type = 'ISSUED' THEN 'Issued cheque'
              ELSE 'Cheque event'
            END
            FROM cheque_events AS event
            WHERE event.id = ${collectionItems.sourceFactId}
          ), 'Cheque event')
        END`,
        amount,
        currency,
        expectedDate: collectionItems.expectedSettlementDate,
        state: collectionItems.state,
      })
      .from(collectionItems)
      .innerJoin(organizations, eq(organizations.id, collectionItems.organizationId))
      .leftJoin(
        receiptLines,
        and(
          eq(collectionItems.sourceFactType, 'RECEIPT_LINE'),
          eq(receiptLines.organizationId, collectionItems.organizationId),
          eq(receiptLines.id, collectionItems.sourceFactId),
        ),
      )
      .leftJoin(
        receiptDocuments,
        and(
          eq(receiptDocuments.organizationId, receiptLines.organizationId),
          eq(receiptDocuments.id, receiptLines.receiptDocumentId),
        ),
      )
      .leftJoin(
        branches,
        and(
          eq(branches.organizationId, collectionItems.organizationId),
          eq(branches.id, collectionItems.branchId),
        ),
      )
      .innerJoin(
        treasuryUnits,
        and(
          eq(treasuryUnits.organizationId, collectionItems.organizationId),
          eq(treasuryUnits.id, collectionItems.treasuryUnitId),
        ),
      )
      .innerJoin(
        bankAccounts,
        and(
          eq(bankAccounts.organizationId, collectionItems.organizationId),
          eq(bankAccounts.id, collectionItems.destinationBankAccountId),
        ),
      )
      .where(and(...conditions))
      .orderBy(desc(businessDate), desc(collectionItems.id))
      .limit(input.limit + 1);

    const visible = rows.slice(0, input.limit);
    return {
      items: visible.map((row): FundsInTransitReportRow => {
        const gross = this.money(row.amount, row.currency);
        const zero = this.money('0', row.currency);
        return {
          kind: 'FUNDS_IN_TRANSIT',
          source: {
            type: 'COLLECTION_ITEM',
            id: row.id,
            label: row.sourceLabel,
          },
          organization: this.ref(row.organizationId, row.organizationLabel),
          ...(row.branchId && row.branchLabel
            ? { branch: this.ref(row.branchId, row.branchLabel) }
            : {}),
          treasuryUnit: this.ref(row.treasuryUnitId, row.treasuryUnitLabel),
          destinationBankAccount: this.ref(
            row.destinationBankAccountId,
            row.destinationBankAccountLabel,
          ),
          channel: this.ref(row.channelId ?? row.channelType, row.channelLabel),
          gross,
          // ponytail: fee facts do not exist yet; replace zeros only when Canon assigns an owner.
          fee: zero,
          deduction: zero,
          expectedNet: gross,
          expectedDate: row.expectedDate,
          ageDays: this.ageDays(row.expectedDate, input.businessDate),
          matchingState: this.matchingState(row.state),
          state: row.state,
        };
      }),
      keys: visible.map(({ businessDate, id }) => ({ businessDate, id })),
      hasMore: rows.length > input.limit,
    };
  }

  private receiptFilters(
    conditions: SQLWrapper[],
    filters: NormalizedReportFilters,
    effectiveBankAccountId: SQLWrapper,
  ): void {
    this.commonReceiptFilters(conditions, filters, effectiveBankAccountId);
    if (filters.methodId) conditions.push(eq(receiptLines.methodId, filters.methodId));
    if (filters.projectRef) conditions.push(eq(receiptDocuments.projectRef, filters.projectRef));
    if (filters.costCenterRef) {
      conditions.push(eq(receiptDocuments.costCenterRef, filters.costCenterRef));
    }
    if (filters.accountingStates.length > 0) {
      conditions.push(inArray(receiptDocuments.accountingState, filters.accountingStates));
    }
  }

  private chequeFilters(
    conditions: SQLWrapper[],
    filters: NormalizedReportFilters,
    effectiveCashboxId: SQLWrapper,
    effectiveBankAccountId: SQLWrapper,
    partyId: SQLWrapper,
  ): void {
    this.dateFilters(conditions, filters, receiptExecutionEffects.businessDate);
    if (filters.dueDateFrom) conditions.push(gte(receivedCheques.dueDate, filters.dueDateFrom));
    if (filters.dueDateTo) conditions.push(lte(receivedCheques.dueDate, filters.dueDateTo));
    if (filters.branchId) conditions.push(eq(receiptDocuments.branchId, filters.branchId));
    if (filters.treasuryUnitId) {
      conditions.push(eq(receiptDocuments.treasuryUnitId, filters.treasuryUnitId));
    }
    if (filters.cashboxId) conditions.push(eq(effectiveCashboxId, filters.cashboxId));
    if (filters.bankAccountId) {
      conditions.push(eq(effectiveBankAccountId, filters.bankAccountId));
    }
    if (filters.userId) conditions.push(eq(receiptDocuments.creatorUserId, filters.userId));
    if (filters.partyId) conditions.push(eq(partyId, filters.partyId));
    if (filters.currency) conditions.push(eq(receivedCheques.currency, filters.currency));
    if (filters.states.length > 0) {
      conditions.push(inArray(receivedCheques.state, filters.states));
    }
  }

  private fundsFilters(
    conditions: SQLWrapper[],
    filters: NormalizedReportFilters,
    businessDate: SQLWrapper,
  ): void {
    this.dateFilters(conditions, filters, businessDate);
    if (filters.branchId) conditions.push(eq(collectionItems.branchId, filters.branchId));
    if (filters.treasuryUnitId) {
      conditions.push(eq(collectionItems.treasuryUnitId, filters.treasuryUnitId));
    }
    if (filters.bankAccountId) {
      conditions.push(eq(collectionItems.destinationBankAccountId, filters.bankAccountId));
    }
    if (filters.partyId) {
      conditions.push(eq(collectionItems.collectedPartyId, filters.partyId));
    }
    if (filters.currency) conditions.push(eq(collectionItems.currency, filters.currency));
    if (filters.states.length > 0) {
      conditions.push(inArray(collectionItems.state, filters.states));
    }
    if (filters.channelType) {
      conditions.push(eq(collectionItems.channelType, filters.channelType));
    }
  }

  private commonReceiptFilters(
    conditions: SQLWrapper[],
    filters: NormalizedReportFilters,
    effectiveBankAccountId: SQLWrapper,
  ): void {
    this.dateFilters(conditions, filters, receiptDocuments.businessDate);
    if (filters.branchId) conditions.push(eq(receiptDocuments.branchId, filters.branchId));
    if (filters.treasuryUnitId) {
      conditions.push(eq(receiptDocuments.treasuryUnitId, filters.treasuryUnitId));
    }
    if (filters.cashboxId) conditions.push(eq(receiptLines.cashboxId, filters.cashboxId));
    if (filters.bankAccountId) {
      conditions.push(eq(effectiveBankAccountId, filters.bankAccountId));
    }
    if (filters.userId) conditions.push(eq(receiptDocuments.creatorUserId, filters.userId));
    if (filters.partyId) conditions.push(eq(receiptDocuments.partyId, filters.partyId));
    if (filters.currency) conditions.push(eq(receiptLines.currency, filters.currency));
    if (filters.states.length > 0) {
      conditions.push(inArray(receiptDocuments.state, filters.states));
    }
  }

  private dateFilters(
    conditions: SQLWrapper[],
    filters: NormalizedReportFilters,
    businessDate: SQLWrapper,
  ): void {
    if (filters.businessDateFrom) {
      conditions.push(gte(businessDate, filters.businessDateFrom));
    }
    if (filters.businessDateTo) {
      conditions.push(lte(businessDate, filters.businessDateTo));
    }
  }

  private oneGrantScope(
    input: ReportListInput,
    anchor: {
      branchId: SQLWrapper;
      treasuryUnitId: SQLWrapper;
      cashboxId: SQLWrapper;
      bankAccountId: SQLWrapper;
      currency: SQLWrapper;
      partyId: SQLWrapper;
      projectRef: SQLWrapper;
      costCenterRef: SQLWrapper;
    },
  ) {
    const grantIds = sql.join(
      input.authorizedGrantIds.map((grantId) => sql`${grantId}::uuid`),
      sql`, `,
    );
    return sql<boolean>`EXISTS (
      SELECT 1
      FROM access_grants AS access_grant
      JOIN roles AS role
        ON role.id = access_grant.role_id
       AND role.organization_id = access_grant.organization_id
       AND role.state = 'ACTIVE'
      JOIN role_permissions AS permission
        ON permission.role_id = role.id
       AND permission.permission = 'report.view'
      WHERE access_grant.organization_id = ${input.organizationId}
        AND access_grant.user_ref_id = ${input.actorUserId}
        AND access_grant.id IN (${grantIds})
        AND access_grant.state = 'ACTIVE'
        AND access_grant.valid_from <= now()
        AND (access_grant.valid_to IS NULL OR access_grant.valid_to > now())
        AND (
          access_grant.organization_wide
          OR (
            (NOT EXISTS (
              SELECT 1 FROM access_grant_branch_scopes AS scope
              WHERE scope.access_grant_id = access_grant.id
            ) OR EXISTS (
              SELECT 1 FROM access_grant_branch_scopes AS scope
              WHERE scope.access_grant_id = access_grant.id
                AND scope.branch_id = ${anchor.branchId}
            ))
            AND (NOT EXISTS (
              SELECT 1 FROM access_grant_treasury_unit_scopes AS scope
              WHERE scope.access_grant_id = access_grant.id
            ) OR EXISTS (
              SELECT 1 FROM access_grant_treasury_unit_scopes AS scope
              WHERE scope.access_grant_id = access_grant.id
                AND scope.treasury_unit_id = ${anchor.treasuryUnitId}
            ))
            AND (NOT EXISTS (
              SELECT 1 FROM access_grant_cashbox_scopes AS scope
              WHERE scope.access_grant_id = access_grant.id
            ) OR EXISTS (
              SELECT 1 FROM access_grant_cashbox_scopes AS scope
              WHERE scope.access_grant_id = access_grant.id
                AND scope.cashbox_id = ${anchor.cashboxId}
            ))
            AND (NOT EXISTS (
              SELECT 1 FROM access_grant_bank_account_scopes AS scope
              WHERE scope.access_grant_id = access_grant.id
            ) OR EXISTS (
              SELECT 1 FROM access_grant_bank_account_scopes AS scope
              WHERE scope.access_grant_id = access_grant.id
                AND scope.bank_account_id = ${anchor.bankAccountId}
            ))
            AND (NOT EXISTS (
              SELECT 1 FROM access_grant_currency_scopes AS scope
              WHERE scope.access_grant_id = access_grant.id
            ) OR EXISTS (
              SELECT 1 FROM access_grant_currency_scopes AS scope
              WHERE scope.access_grant_id = access_grant.id
                AND scope.currency = ${anchor.currency}
            ))
          )
        )
    )`;
  }

  private filterGrantAuthorization(
    organizationId: string,
    actorUserId: string,
    authorizedGrantIds: string[],
    filters: NormalizedReportFilters,
  ) {
    const grantIds = sql.join(
      authorizedGrantIds.map((grantId) => sql`${grantId}::uuid`),
      sql`, `,
    );
    const checks: SQLWrapper[] = [];
    if (filters.branchId) {
      checks.push(this.grantScopeValue(
        'access_grant_branch_scopes',
        'branch_id',
        filters.branchId,
      ));
    }
    if (filters.treasuryUnitId) {
      checks.push(
        this.grantScopeValue(
          'access_grant_treasury_unit_scopes',
          'treasury_unit_id',
          filters.treasuryUnitId,
        ),
        sql<boolean>`(
          NOT EXISTS (
            SELECT 1 FROM access_grant_branch_scopes AS scope
            WHERE scope.access_grant_id = access_grant.id
          )
          OR EXISTS (
            SELECT 1
            FROM treasury_units AS owner
            JOIN access_grant_branch_scopes AS scope
              ON scope.branch_id = owner.branch_id
             AND scope.access_grant_id = access_grant.id
            WHERE owner.organization_id = ${organizationId}
              AND owner.id = ${filters.treasuryUnitId}
          )
        )`,
      );
    }
    if (filters.cashboxId) {
      checks.push(
        this.grantScopeValue(
          'access_grant_cashbox_scopes',
          'cashbox_id',
          filters.cashboxId,
        ),
        sql<boolean>`(
          NOT EXISTS (
            SELECT 1 FROM access_grant_branch_scopes AS scope
            WHERE scope.access_grant_id = access_grant.id
          )
          OR EXISTS (
            SELECT 1
            FROM cashboxes AS owner
            JOIN access_grant_branch_scopes AS scope
              ON scope.branch_id = owner.branch_id
             AND scope.access_grant_id = access_grant.id
            WHERE owner.organization_id = ${organizationId}
              AND owner.id = ${filters.cashboxId}
          )
        )`,
        sql<boolean>`(
          NOT EXISTS (
            SELECT 1 FROM access_grant_treasury_unit_scopes AS scope
            WHERE scope.access_grant_id = access_grant.id
          )
          OR EXISTS (
            SELECT 1
            FROM cashboxes AS owner
            JOIN access_grant_treasury_unit_scopes AS scope
              ON scope.treasury_unit_id = owner.treasury_unit_id
             AND scope.access_grant_id = access_grant.id
            WHERE owner.organization_id = ${organizationId}
              AND owner.id = ${filters.cashboxId}
          )
        )`,
      );
    }
    if (filters.bankAccountId) {
      checks.push(
        this.grantScopeValue(
          'access_grant_bank_account_scopes',
          'bank_account_id',
          filters.bankAccountId,
        ),
        sql<boolean>`(
          NOT EXISTS (
            SELECT 1 FROM access_grant_branch_scopes AS scope
            WHERE scope.access_grant_id = access_grant.id
          )
          OR EXISTS (
            SELECT 1
            FROM bank_accounts AS owner
            LEFT JOIN treasury_units AS unit
              ON unit.organization_id = owner.organization_id
             AND unit.id = owner.treasury_unit_id
            JOIN access_grant_branch_scopes AS scope
              ON scope.branch_id = COALESCE(owner.organization_branch_id, unit.branch_id)
             AND scope.access_grant_id = access_grant.id
            WHERE owner.organization_id = ${organizationId}
              AND owner.id = ${filters.bankAccountId}
          )
        )`,
        sql<boolean>`(
          NOT EXISTS (
            SELECT 1 FROM access_grant_treasury_unit_scopes AS scope
            WHERE scope.access_grant_id = access_grant.id
          )
          OR EXISTS (
            SELECT 1
            FROM bank_accounts AS owner
            JOIN access_grant_treasury_unit_scopes AS scope
              ON scope.treasury_unit_id = owner.treasury_unit_id
             AND scope.access_grant_id = access_grant.id
            WHERE owner.organization_id = ${organizationId}
              AND owner.id = ${filters.bankAccountId}
          )
        )`,
      );
    }
    if (filters.currency) {
      checks.push(this.grantScopeValue(
        'access_grant_currency_scopes',
        'currency',
        filters.currency,
      ));
    }
    const scopedChecks = checks.length > 0
      ? sql.join(checks.map((check) => sql`(${check})`), sql` AND `)
      : sql`TRUE`;
    return sql<boolean>`EXISTS (
      SELECT 1
      FROM access_grants AS access_grant
      JOIN roles AS role
        ON role.id = access_grant.role_id
       AND role.organization_id = access_grant.organization_id
       AND role.state = 'ACTIVE'
      JOIN role_permissions AS permission
        ON permission.role_id = role.id
       AND permission.permission = 'report.view'
      WHERE access_grant.organization_id = ${organizationId}
        AND access_grant.user_ref_id = ${actorUserId}
        AND access_grant.id IN (${grantIds})
        AND access_grant.state = 'ACTIVE'
        AND access_grant.valid_from <= now()
        AND (access_grant.valid_to IS NULL OR access_grant.valid_to > now())
        AND (access_grant.organization_wide OR (${scopedChecks}))
    )`;
  }

  private grantScopeValue(
    scopeTable: string,
    scopeColumn: string,
    value: string,
  ) {
    return sql<boolean>`(
      NOT EXISTS (
        SELECT 1
        FROM ${sql.raw(scopeTable)} AS scope
        WHERE scope.access_grant_id = access_grant.id
      )
      OR EXISTS (
        SELECT 1
        FROM ${sql.raw(scopeTable)} AS scope
        WHERE scope.access_grant_id = access_grant.id
          AND scope.${sql.raw(scopeColumn)} = ${value}
      )
    )`;
  }

  private ownerDigest(organizationId: string, tableNames: string[]) {
    const sources = tableNames.map((tableName) => {
      const organizationColumn = tableName === 'organizations' ? 'id' : 'organization_id';
      return sql`COALESCE((
        SELECT string_agg(
          to_jsonb(owner)::text,
          '|' ORDER BY to_jsonb(owner)::text
        )
        FROM ${sql.raw(tableName)} AS owner
        WHERE owner.${sql.raw(organizationColumn)} = ${organizationId}
      ), '')`;
    });
    return sql<string>`md5(concat_ws('|', ${sql.join(sources, sql`, `)}))`;
  }

  private scopeRefs(
    scopeTable: string,
    scopeColumn: string,
    ownerTable: string,
    labelColumn: string,
    grantId: SQLWrapper,
  ) {
    return sql<ReportSemanticRef[]>`COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object('id', owner.id, 'label', owner.${sql.raw(labelColumn)})
        ORDER BY owner.id
      )
      FROM ${sql.raw(scopeTable)} AS scope
      JOIN ${sql.raw(ownerTable)} AS owner
        ON owner.id = scope.${sql.raw(scopeColumn)}
      WHERE scope.access_grant_id = ${grantId}
    ), '[]'::jsonb)`;
  }

  private filterRef(value: string | undefined, query: SQLWrapper) {
    if (!value) return sql<null>`NULL`;
    return sql<ReportSemanticRef | null>`(
      SELECT jsonb_build_object('id', ref.id, 'label', ref.label)
      FROM (${query}) AS ref
      LIMIT 1
    )`;
  }

  private ref(id: string, label: string): ReportSemanticRef {
    return { id, label };
  }

  private referenceLabel(value: string, fallback: string): string {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(value)
      ? fallback
      : value;
  }

  private money(amount: string, currency: string) {
    return { amount, currency };
  }

  private subtract(left: string, right: string): string {
    const scale = 100_000_000n;
    const integer = (value: string) => {
      const [whole, fraction = ''] = value.split('.');
      return BigInt(whole) * scale + BigInt(fraction.padEnd(8, '0').slice(0, 8));
    };
    const result = integer(left) - integer(right);
    const safe = result < 0n ? 0n : result;
    const whole = safe / scale;
    const fraction = (safe % scale).toString().padStart(8, '0').replace(/0+$/u, '');
    return fraction ? `${whole}.${fraction}` : whole.toString();
  }

  private dueStatus(
    kind: ChequeReportRow['kind'],
    state: string,
    dueDate: string,
    businessDate: string,
  ): ChequeReportRow['dueStatus'] {
    const terminalStates = kind === 'RECEIVED_CHEQUE'
      ? ['RETURNED_TO_PARTY', 'ASSIGNED', 'CANCELLED']
      : ['CLEARANCE_REVERSED', 'PAID_EXCEPTION'];
    if (terminalStates.includes(state)) return 'TERMINAL';
    if (dueDate === businessDate) return 'DUE_TODAY';
    return dueDate < businessDate ? 'OVERDUE' : 'UPCOMING';
  }

  private ageDays(expectedDate: string, businessDate: string): number {
    const day = 86_400_000;
    return Math.max(
      0,
      Math.floor(
        (Date.parse(`${businessDate}T00:00:00Z`) - Date.parse(`${expectedDate}T00:00:00Z`))
        / day,
      ),
    );
  }

  private matchingState(state: string): FundsInTransitReportRow['matchingState'] {
    if (state === 'SETTLED') return 'MATCHED';
    if (state === 'PARTIALLY_ALLOCATED' || state === 'ALLOCATED') {
      return 'PARTIALLY_MATCHED';
    }
    return state === 'DISPUTED' ? 'DISPUTED' : 'UNMATCHED';
  }
}
