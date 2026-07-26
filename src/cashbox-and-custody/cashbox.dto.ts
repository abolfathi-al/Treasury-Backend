import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDefined,
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

const DECIMAL = /^-?(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,8})?$/u;
const NONNEGATIVE_DECIMAL = /^(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,8})?$/u;
const CURRENCY = /^[A-Z0-9]{3,8}$/u;
const RFC3339_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

export enum CashboxType {
  CASH = 'CASH',
  FOREIGN_CURRENCY = 'FOREIGN_CURRENCY',
  SALES = 'SALES',
  BRANCH = 'BRANCH',
  TEMPORARY = 'TEMPORARY',
  VIRTUAL = 'VIRTUAL',
  INSTRUMENT = 'INSTRUMENT',
  CHEQUE = 'CHEQUE',
  COLLECTION = 'COLLECTION',
  CUSTODIAL = 'CUSTODIAL',
  PETTY_CASH = 'PETTY_CASH',
}

export class CashboxCapabilitiesDto {
  @IsBoolean() receive!: boolean;
  @IsBoolean() pay!: boolean;
  @IsBoolean() transfer!: boolean;
}

export class CashboxCurrencyControlDto {
  @IsString() @Matches(CURRENCY) currency!: string;
  @IsOptional() @IsString() @Matches(NONNEGATIVE_DECIMAL) transactionCeiling?: string;
  @IsOptional() @IsString() @Matches(DECIMAL) minimumPosition?: string;
  @IsOptional() @IsString() @Matches(NONNEGATIVE_DECIMAL) maximumHolding?: string;
  @IsOptional() @IsBoolean() allowNegative?: boolean;
}

export class AccountingDimensionsDto {
  @IsOptional() @IsString() @MaxLength(128) generalAccount?: string;
  @IsOptional() @IsString() @MaxLength(128) subsidiaryAccount?: string;
  @IsOptional() @IsString() @MaxLength(128) detailAccount?: string;
  @IsOptional() @IsString() @MaxLength(128) floatingDetail?: string;
  @IsOptional() @IsString() @MaxLength(128) costCenter?: string;
  @IsOptional() @IsString() @MaxLength(128) project?: string;
  @IsOptional() @IsString() @MaxLength(128) branch?: string;
}

export class CashboxCreateDto {
  @IsString() @MinLength(1) @MaxLength(64) code!: string;
  @IsString() @MinLength(1) @MaxLength(160) name!: string;
  @IsEnum(CashboxType) type!: CashboxType;
  @IsOptional() @IsUUID() branchId?: string;
  @IsUUID() treasuryUnitId!: string;
  @IsString() @Matches(CURRENCY) mainCurrency!: string;

  @IsArray() @ArrayMinSize(1)
  @ValidateNested({ each: true }) @Type(() => CashboxCurrencyControlDto)
  currencyControls!: CashboxCurrencyControlDto[];

  @IsUUID() primaryCustodianId!: string;
  @IsOptional() @IsUUID() substituteCustodianId?: string;
  @IsDefined() @ValidateNested() @Type(() => CashboxCapabilitiesDto)
  capabilities!: CashboxCapabilitiesDto;
  @IsBoolean() requiresApproval!: boolean;

  @IsOptional() @ValidateNested() @Type(() => AccountingDimensionsDto)
  accountingDimensions?: AccountingDimensionsDto;
  @IsOptional() @IsISO8601({ strict: true }) @Matches(RFC3339_INSTANT)
  activeTo?: string;
}

export interface HeldInstrumentOption {
  id: string;
  instrumentType: 'CHEQUE' | 'DOCUMENT' | 'OTHER';
  reference: string;
}

export interface CashboxView {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  type: CashboxType;
  branchId?: string;
  treasuryUnitId: string;
  mainCurrency: string;
  currencyControls: Array<CashboxCurrencyControlDto & { allowNegative: boolean }>;
  primaryCustodianId: string;
  substituteCustodianId?: string;
  capabilities: CashboxCapabilitiesDto;
  requiresApproval: boolean;
  accountingDimensions?: AccountingDimensionsDto;
  heldInstrumentOptions: HeldInstrumentOption[];
  activeFrom: string;
  activeTo?: string;
  state: 'DRAFT' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CashboxPage {
  items: CashboxView[];
  page: { limit: number; hasMore: boolean; nextCursor?: string; asOf: string };
}

export class HandoverMoneyCountDto {
  @IsString() @Matches(CURRENCY) currency!: string;
  @IsString() @Matches(DECIMAL) countedAmount!: string;
}

export class HandoverCreateDto {
  @IsUUID() incomingUserId!: string;

  @IsArray() @ArrayMinSize(1)
  @ValidateNested({ each: true }) @Type(() => HandoverMoneyCountDto)
  moneyCounts!: HandoverMoneyCountDto[];

  @IsArray() @ArrayUnique() @IsString({ each: true })
  @MinLength(1, { each: true }) @MaxLength(128, { each: true })
  observedInstrumentIds!: string[];

  @IsOptional() @IsString() @MinLength(1) @MaxLength(500) reason?: string;
}

export interface HandoverMoneyCount {
  currency: string;
  bookAmount: string;
  countedAmount: string;
  varianceAmount: string;
}

export interface CashboxHandoverView {
  id: string;
  cashboxId: string;
  currentAssignmentId: string;
  outgoingUserId: string;
  incomingUserId: string;
  moneyCounts: HandoverMoneyCount[];
  heldInstrumentSnapshot: HeldInstrumentOption[];
  observedInstrumentIds: string[];
  discrepancy: {
    hasDiscrepancy: boolean;
    moneyCurrencies: string[];
    missingInstrumentIds: string[];
  };
  reason?: string;
  state: 'COUNTED';
  version: number;
  createdByUserId: string;
  requestId: string;
  countedAt: string;
  createdAt: string;
  updatedAt: string;
}
