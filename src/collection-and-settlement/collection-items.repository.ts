import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  desc,
  eq,
  gt,
  gte,
  InferSelectModel,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm';

import { DatabaseService } from '../database/database.service';
import {
  accessGrants,
  bankAccounts,
  branches,
  chequeEvents,
  collectionItems,
  currencies,
  organizations,
  parties,
  paymentGateways,
  posTerminals,
  receiptDocuments,
  receiptLines,
  receivedCheques,
  rolePermissions,
  roles,
  treasuryUnits,
} from '../database/schema';
import {
  CollectionItemChannelType,
  CollectionItemState,
  CollectionItemView,
  CollectionSemanticRef,
} from './collection-items.dto';

type CollectionItemRow = InferSelectModel<typeof collectionItems>;

export interface NormalizedCollectionItemFilters {
  states: CollectionItemState[];
  collectedAtFrom?: string;
  collectedAtTo?: string;
  expectedSettlementDateFrom?: string;
  expectedSettlementDateTo?: string;
  destinationBankAccountId?: string;
  currency?: string;
  channelType?: CollectionItemChannelType;
}

export interface CollectionItemKeyset {
  collectedAt: string;
  id: string;
}

export interface CollectionItemListInput {
  organizationId: string;
  actorUserId: string;
  authorizedGrantIds: string[];
  filters: NormalizedCollectionItemFilters;
  limit: number;
  asOf: string;
  after?: CollectionItemKeyset;
}

export interface CollectionItemListResult {
  items: CollectionItemView[];
  hasMore: boolean;
}

export interface CollectionScopeSnapshot {
  grantId: string;
  grantVersion: number;
  roleId: string;
  roleVersion: number;
  organizationWide: boolean;
  validFrom: string;
  validTo: string | null;
  branches: string;
  treasuryUnits: string;
  bankAccounts: string;
  currencies: string;
}

@Injectable()
export class CollectionItemsRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async currentScope(
    organizationId: string,
    actorUserId: string,
  ): Promise<CollectionScopeSnapshot[]> {
    return this.database.db
      .select({
        grantId: accessGrants.id,
        grantVersion: accessGrants.version,
        roleId: roles.id,
        roleVersion: roles.version,
        organizationWide: accessGrants.organizationWide,
        validFrom: sql<string>`${accessGrants.validFrom}::text`,
        validTo: sql<string | null>`${accessGrants.validTo}::text`,
        branches: sql<string>`COALESCE((
          SELECT string_agg(scope.branch_id::text, ',' ORDER BY scope.branch_id)
          FROM access_grant_branch_scopes AS scope
          WHERE scope.access_grant_id = ${accessGrants.id}
        ), '')`,
        treasuryUnits: sql<string>`COALESCE((
          SELECT string_agg(scope.treasury_unit_id::text, ',' ORDER BY scope.treasury_unit_id)
          FROM access_grant_treasury_unit_scopes AS scope
          WHERE scope.access_grant_id = ${accessGrants.id}
        ), '')`,
        bankAccounts: sql<string>`COALESCE((
          SELECT string_agg(scope.bank_account_id::text, ',' ORDER BY scope.bank_account_id)
          FROM access_grant_bank_account_scopes AS scope
          WHERE scope.access_grant_id = ${accessGrants.id}
        ), '')`,
        currencies: sql<string>`COALESCE((
          SELECT string_agg(scope.currency, ',' ORDER BY scope.currency)
          FROM access_grant_currency_scopes AS scope
          WHERE scope.access_grant_id = ${accessGrants.id}
        ), '')`,
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
          eq(rolePermissions.permission, 'collection.view'),
        ),
      )
      .where(and(
        eq(accessGrants.organizationId, organizationId),
        eq(accessGrants.userRefId, actorUserId),
        eq(accessGrants.state, 'ACTIVE'),
        lte(accessGrants.validFrom, new Date()),
        or(isNull(accessGrants.validTo), gt(accessGrants.validTo, new Date())),
        isNull(accessGrants.amountCeiling),
        sql`NOT EXISTS (
          SELECT 1 FROM access_grant_cashbox_scopes AS scope
          WHERE scope.access_grant_id = ${accessGrants.id}
        )`,
        sql`NOT EXISTS (
          SELECT 1 FROM access_grant_document_type_scopes AS scope
          WHERE scope.access_grant_id = ${accessGrants.id}
        )`,
        sql`NOT EXISTS (
          SELECT 1 FROM access_grant_method_category_scopes AS scope
          WHERE scope.access_grant_id = ${accessGrants.id}
        )`,
      ))
      .orderBy(accessGrants.id);
  }

  async list(input: CollectionItemListInput): Promise<CollectionItemListResult> {
    const item = collectionItems;
    const conditions = [
      eq(item.organizationId, input.organizationId),
      lte(item.createdAt, new Date(input.asOf)),
      this.oneGrantScope(
        input.organizationId,
        input.actorUserId,
        input.authorizedGrantIds,
      ),
    ];
    if (input.filters.states.length > 0) {
      conditions.push(inArray(item.state, input.filters.states));
    }
    if (input.filters.collectedAtFrom) {
      conditions.push(gte(item.collectedAt, new Date(input.filters.collectedAtFrom)));
    }
    if (input.filters.collectedAtTo) {
      conditions.push(lt(item.collectedAt, new Date(input.filters.collectedAtTo)));
    }
    if (input.filters.expectedSettlementDateFrom) {
      conditions.push(gte(
        item.expectedSettlementDate,
        input.filters.expectedSettlementDateFrom,
      ));
    }
    if (input.filters.expectedSettlementDateTo) {
      conditions.push(lte(
        item.expectedSettlementDate,
        input.filters.expectedSettlementDateTo,
      ));
    }
    if (input.filters.destinationBankAccountId) {
      conditions.push(eq(
        item.destinationBankAccountId,
        input.filters.destinationBankAccountId,
      ));
    }
    if (input.filters.currency) {
      conditions.push(eq(item.currency, input.filters.currency));
    }
    if (input.filters.channelType) {
      conditions.push(eq(item.channelType, input.filters.channelType));
    }
    if (input.after) {
      const collectedAt = new Date(input.after.collectedAt);
      conditions.push(or(
        lt(item.collectedAt, collectedAt),
        and(eq(item.collectedAt, collectedAt), lt(item.id, input.after.id)),
      )!);
    }

    const rows = await this.database.db
      .select({
        item,
        organizationLabel: organizations.legalName,
        branchLabel: branches.name,
        treasuryUnitLabel: treasuryUnits.name,
        currencyLabel: currencies.name,
        accountLabel: sql<string>`concat(
          ${bankAccounts.legalOwnerName},
          ' · ',
          ${bankAccounts.accountNumber}
        )`,
        partyLabel: parties.displayName,
        sourceLabel: sql<string | null>`CASE
          WHEN ${item.sourceFactType} = 'RECEIPT_LINE' THEN concat(
            'Receipt ',
            ${receiptDocuments.businessNumber},
            ' · line ',
            ${receiptLines.lineNumber}::text
          )
          WHEN ${item.sourceFactType} = 'CHEQUE_EVENT' THEN concat(
            'Received cheque ',
            ${receivedCheques.chequeNumber},
            ' · event ',
            ${chequeEvents.sequenceNo}::text
          )
          ELSE NULL
        END`,
        channelLabel: sql<string | null>`CASE
          WHEN ${item.channelType} = 'POS' THEN concat(
            COALESCE(${posTerminals.providerLabel}, 'POS terminal'),
            ' · ',
            ${posTerminals.terminalNumber}
          )
          WHEN ${item.channelType} = 'GATEWAY' THEN concat(
            ${paymentGateways.providerCode},
            ' · ',
            ${paymentGateways.merchantId}
          )
          ELSE NULL
        END`,
      })
      .from(item)
      .innerJoin(
        organizations,
        eq(organizations.id, item.organizationId),
      )
      .leftJoin(
        branches,
        and(
          eq(branches.organizationId, item.organizationId),
          eq(branches.id, item.branchId),
        ),
      )
      .innerJoin(
        treasuryUnits,
        and(
          eq(treasuryUnits.organizationId, item.organizationId),
          eq(treasuryUnits.id, item.treasuryUnitId),
        ),
      )
      .innerJoin(
        currencies,
        and(
          eq(currencies.organizationId, item.organizationId),
          eq(currencies.code, item.currency),
        ),
      )
      .innerJoin(
        bankAccounts,
        and(
          eq(bankAccounts.organizationId, item.organizationId),
          eq(bankAccounts.id, item.destinationBankAccountId),
        ),
      )
      .leftJoin(
        parties,
        and(
          eq(parties.organizationId, item.organizationId),
          eq(parties.id, item.collectedPartyId),
        ),
      )
      .leftJoin(
        receiptLines,
        and(
          eq(item.sourceFactType, 'RECEIPT_LINE'),
          eq(receiptLines.organizationId, item.organizationId),
          eq(receiptLines.id, item.sourceFactId),
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
        chequeEvents,
        and(
          eq(item.sourceFactType, 'CHEQUE_EVENT'),
          eq(chequeEvents.id, item.sourceFactId),
          eq(chequeEvents.chequeType, 'RECEIVED'),
        ),
      )
      .leftJoin(
        receivedCheques,
        and(
          eq(receivedCheques.organizationId, item.organizationId),
          eq(receivedCheques.id, chequeEvents.chequeId),
        ),
      )
      .leftJoin(
        posTerminals,
        and(
          eq(item.channelType, 'POS'),
          eq(posTerminals.organizationId, item.organizationId),
          eq(posTerminals.id, item.channelId),
        ),
      )
      .leftJoin(
        paymentGateways,
        and(
          eq(item.channelType, 'GATEWAY'),
          eq(paymentGateways.organizationId, item.organizationId),
          eq(paymentGateways.id, item.channelId),
        ),
      )
      .where(and(...conditions))
      .orderBy(desc(item.collectedAt), desc(item.id))
      .limit(input.limit + 1);

    return {
      items: rows.slice(0, input.limit).map((row) => this.view(row.item, {
        organization: row.organizationLabel,
        branch: row.branchLabel,
        treasuryUnit: row.treasuryUnitLabel,
        currency: row.currencyLabel,
        account: row.accountLabel,
        party: row.partyLabel,
        source: row.sourceLabel,
        channel: row.channelLabel,
      })),
      hasMore: rows.length > input.limit,
    };
  }

  private oneGrantScope(
    organizationId: string,
    actorUserId: string,
    authorizedGrantIds: string[],
  ) {
    const grantIds = sql.join(
      authorizedGrantIds.map((grantId) => sql`${grantId}::uuid`),
      sql`, `,
    );
    return sql<boolean>`EXISTS (
      SELECT 1
        FROM access_grants AS grant
        JOIN roles AS role
          ON role.id = grant.role_id
         AND role.organization_id = grant.organization_id
         AND role.state = 'ACTIVE'
        JOIN role_permissions AS permission
          ON permission.role_id = role.id
         AND permission.permission = 'collection.view'
       WHERE grant.organization_id = ${organizationId}
         AND grant.user_ref_id = ${actorUserId}
         AND grant.id IN (${grantIds})
         AND grant.state = 'ACTIVE'
         AND grant.valid_from <= now()
         AND (grant.valid_to IS NULL OR grant.valid_to > now())
         AND grant.amount_ceiling IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM access_grant_cashbox_scopes AS scope
           WHERE scope.access_grant_id = grant.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM access_grant_document_type_scopes AS scope
           WHERE scope.access_grant_id = grant.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM access_grant_method_category_scopes AS scope
           WHERE scope.access_grant_id = grant.id
         )
         AND (
           NOT EXISTS (
             SELECT 1 FROM access_grant_branch_scopes AS scope
             WHERE scope.access_grant_id = grant.id
           )
           OR EXISTS (
             SELECT 1 FROM access_grant_branch_scopes AS scope
             WHERE scope.access_grant_id = grant.id
               AND scope.branch_id = ${collectionItems.branchId}
           )
         )
         AND (
           NOT EXISTS (
             SELECT 1 FROM access_grant_treasury_unit_scopes AS scope
             WHERE scope.access_grant_id = grant.id
           )
           OR EXISTS (
             SELECT 1 FROM access_grant_treasury_unit_scopes AS scope
             WHERE scope.access_grant_id = grant.id
               AND scope.treasury_unit_id = ${collectionItems.treasuryUnitId}
           )
         )
         AND (
           NOT EXISTS (
             SELECT 1 FROM access_grant_bank_account_scopes AS scope
             WHERE scope.access_grant_id = grant.id
           )
           OR EXISTS (
             SELECT 1 FROM access_grant_bank_account_scopes AS scope
             WHERE scope.access_grant_id = grant.id
               AND scope.bank_account_id = ${collectionItems.destinationBankAccountId}
           )
         )
         AND (
           NOT EXISTS (
             SELECT 1 FROM access_grant_currency_scopes AS scope
             WHERE scope.access_grant_id = grant.id
           )
           OR EXISTS (
             SELECT 1 FROM access_grant_currency_scopes AS scope
             WHERE scope.access_grant_id = grant.id
               AND scope.currency = ${collectionItems.currency}
           )
         )
    )`;
  }

  private view(
    item: CollectionItemRow,
    labels: {
      organization: string;
      branch: string | null;
      treasuryUnit: string;
      currency: string;
      account: string;
      party: string | null;
      source: string | null;
      channel: string | null;
    },
  ): CollectionItemView {
    if (
      !labels.organization
      || !labels.treasuryUnit
      || !labels.currency
      || !labels.account
      || !labels.source
      || (item.branchId !== null && !labels.branch)
      || (item.collectedPartyId !== null && !labels.party)
      || (item.channelId !== null && !labels.channel)
    ) throw new Error('SEMANTIC_REFERENCE_MISSING');

    const reference = (id: string, label: string): CollectionSemanticRef => ({ id, label });
    return {
      id: item.id,
      organizationId: item.organizationId,
      organization: reference(item.organizationId, labels.organization),
      sourceFactType: item.sourceFactType as CollectionItemView['sourceFactType'],
      sourceFactId: item.sourceFactId,
      sourceFact: reference(item.sourceFactId, labels.source),
      ...(item.branchId && labels.branch
        ? {
          branchId: item.branchId,
          branch: reference(item.branchId, labels.branch),
        }
        : {}),
      treasuryUnitId: item.treasuryUnitId,
      treasuryUnit: reference(item.treasuryUnitId, labels.treasuryUnit),
      channelType: item.channelType as CollectionItemChannelType,
      ...(item.channelId && labels.channel
        ? {
          channelId: item.channelId,
          channel: reference(item.channelId, labels.channel),
        }
        : {}),
      ...(item.providerReference ? { providerReference: item.providerReference } : {}),
      ...(item.collectedPartyId && labels.party
        ? {
          collectedPartyId: item.collectedPartyId,
          collectedParty: reference(item.collectedPartyId, labels.party),
        }
        : {}),
      gross: { amount: item.grossAmount, currency: item.currency },
      allocated: { amount: item.allocatedAmount, currency: item.currency },
      remaining: { amount: item.remainingAmount, currency: item.currency },
      currency: reference(item.currency, labels.currency),
      destinationBankAccountId: item.destinationBankAccountId,
      destinationBankAccount: reference(item.destinationBankAccountId, labels.account),
      collectedAt: item.collectedAt.toISOString(),
      expectedSettlementDate: item.expectedSettlementDate,
      state: item.state as CollectionItemState,
      version: Number(item.version),
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    };
  }
}
