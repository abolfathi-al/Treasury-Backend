export const COLLECTION_ITEM_STATES = [
  'OPEN',
  'PARTIALLY_ALLOCATED',
  'ALLOCATED',
  'SETTLED',
  'REOPENED_AFTER_REVERSAL',
  'DELAYED',
  'DISPUTED',
  'RETURNED',
  'CANCELLED',
] as const;

export const COLLECTION_ITEM_CHANNEL_TYPES = [
  'BANK_TRANSFER',
  'DIRECT_DEPOSIT',
  'POS',
  'GATEWAY',
  'CARD_TRANSFER',
  'WALLET',
  'FOREIGN_REMITTANCE',
  'DEPOSITED_CHEQUE',
] as const;

export type CollectionItemState = typeof COLLECTION_ITEM_STATES[number];
export type CollectionItemChannelType = typeof COLLECTION_ITEM_CHANNEL_TYPES[number];
export type CollectionItemSourceFactType = 'RECEIPT_LINE' | 'CHEQUE_EVENT';

export interface CollectionSemanticRef {
  id: string;
  label: string;
}

export interface CollectionMoney {
  amount: string;
  currency: string;
}

export interface CollectionItemView {
  id: string;
  organizationId: string;
  organization: CollectionSemanticRef;
  sourceFactType: CollectionItemSourceFactType;
  sourceFactId: string;
  sourceFact: CollectionSemanticRef;
  branchId?: string;
  branch?: CollectionSemanticRef;
  treasuryUnitId: string;
  treasuryUnit: CollectionSemanticRef;
  channelType: CollectionItemChannelType;
  channelId?: string;
  channel?: CollectionSemanticRef;
  providerReference?: string;
  collectedPartyId?: string;
  collectedParty?: CollectionSemanticRef;
  gross: CollectionMoney;
  allocated: CollectionMoney;
  remaining: CollectionMoney;
  currency: CollectionSemanticRef;
  destinationBankAccountId: string;
  destinationBankAccount: CollectionSemanticRef;
  collectedAt: string;
  expectedSettlementDate: string;
  state: CollectionItemState;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionItemPage {
  items: CollectionItemView[];
  page: {
    limit: number;
    hasMore: boolean;
    asOf: string;
    nextCursor?: string;
  };
}

export interface CollectionItemQuery {
  state?: string | string[];
  collectedAtFrom?: string;
  collectedAtTo?: string;
  expectedSettlementDateFrom?: string;
  expectedSettlementDateTo?: string;
  destinationBankAccountId?: string;
  currency?: string;
  channelType?: string;
  limit?: string;
  cursor?: string;
}
