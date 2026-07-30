export const REPORT_KEYS = [
  'receipts',
  'received-cheques',
  'issued-cheques',
  'funds-in-transit',
] as const;

export const REPORT_CURRENCY_MODES = ['ORIGINAL', 'BASE_SOURCE_SNAPSHOT'] as const;

export type ReportKey = typeof REPORT_KEYS[number];
export type ReportCurrencyMode = typeof REPORT_CURRENCY_MODES[number];

export interface ReportQuery {
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
  state?: string | string[];
  projectRef?: string;
  costCenterRef?: string;
  accountingState?: string | string[];
  channelType?: string;
  currencyMode?: string;
  limit?: string;
  cursor?: string;
  format?: string;
}

export interface ReportSemanticRef {
  id: string;
  label: string;
}

export interface ReportSourceRef extends ReportSemanticRef {
  type:
    | 'RECEIPT'
    | 'RECEIPT_LINE'
    | 'RECEIVED_CHEQUE'
    | 'ISSUED_CHEQUE'
    | 'COLLECTION_ITEM';
}

export interface ReportMoney {
  amount: string;
  currency: string;
}

export interface ReceiptReportRow {
  kind: 'RECEIPT';
  source: ReportSourceRef;
  businessDate: string;
  organization: ReportSemanticRef;
  branch?: ReportSemanticRef;
  treasuryUnit: ReportSemanticRef;
  cashbox?: ReportSemanticRef;
  bankAccount?: ReportSemanticRef;
  user?: ReportSemanticRef;
  party: ReportSemanticRef;
  method?: ReportSemanticRef;
  currency: ReportSemanticRef;
  project?: ReportSemanticRef;
  costCenter?: ReportSemanticRef;
  documentCount: 1;
  lineCount: number;
  original: ReportMoney;
  base: ReportMoney;
  allocated: ReportMoney;
  unallocated: ReportMoney;
  reversed: ReportMoney;
  transit: ReportMoney;
  settled: ReportMoney;
  workflowState: string;
  executionState: 'NOT_EXECUTED' | 'EXECUTED' | 'REVERSED';
  accountingState: string;
}

export interface ChequeReportRow {
  kind: 'RECEIVED_CHEQUE' | 'ISSUED_CHEQUE';
  source: ReportSourceRef;
  organization: ReportSemanticRef;
  party: ReportSemanticRef;
  bank: ReportSemanticRef;
  bankAccount?: ReportSemanticRef;
  cashbox?: ReportSemanticRef;
  leaf: ReportSemanticRef;
  custody: ReportSemanticRef;
  state: string;
  dueDate: string;
  dueStatus: 'UPCOMING' | 'DUE_TODAY' | 'OVERDUE' | 'TERMINAL';
  amount: ReportMoney;
}

export interface FundsInTransitReportRow {
  kind: 'FUNDS_IN_TRANSIT';
  source: ReportSourceRef;
  organization: ReportSemanticRef;
  branch?: ReportSemanticRef;
  treasuryUnit?: ReportSemanticRef;
  destinationBankAccount: ReportSemanticRef;
  channel: ReportSemanticRef;
  gross: ReportMoney;
  fee: ReportMoney;
  deduction: ReportMoney;
  expectedNet: ReportMoney;
  actualNet?: ReportMoney;
  discrepancy?: ReportMoney;
  expectedDate: string;
  ageDays: number;
  matchingState: 'UNMATCHED' | 'PARTIALLY_MATCHED' | 'MATCHED' | 'DISPUTED';
  state: string;
}

export type OperationalReportRow =
  | ReceiptReportRow
  | ChequeReportRow
  | FundsInTransitReportRow;

export interface AppliedReportFilters {
  businessDateFrom?: string;
  businessDateTo?: string;
  dueDateFrom?: string;
  dueDateTo?: string;
  branch?: ReportSemanticRef;
  treasuryUnit?: ReportSemanticRef;
  cashbox?: ReportSemanticRef;
  bankAccount?: ReportSemanticRef;
  user?: ReportSemanticRef;
  party?: ReportSemanticRef;
  method?: ReportSemanticRef;
  currency?: ReportSemanticRef;
  state?: string[];
  project?: ReportSemanticRef;
  costCenter?: ReportSemanticRef;
  accountingState?: string[];
  channelType?: string;
}

export interface ReportScopeDimension {
  dimension:
    | 'organization'
    | 'branch'
    | 'treasury_unit'
    | 'cashbox'
    | 'bank_account'
    | 'currency'
    | 'party'
    | 'project'
    | 'cost_center';
  values: ReportSemanticRef[];
}

export interface OperationalReportPage {
  reportKey: ReportKey;
  organization: ReportSemanticRef;
  currencyMode: ReportCurrencyMode;
  appliedFilters: AppliedReportFilters;
  appliedAuthorizationScope: ReportScopeDimension[];
  freshness: 'READ_AFTER_WRITE';
  sourceWatermark: string;
  items: OperationalReportRow[];
  page: {
    limit: number;
    hasMore: boolean;
    asOf: string;
    nextCursor?: string;
  };
}
