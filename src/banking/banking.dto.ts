import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

const CODE = /^[A-Z0-9][A-Z0-9_-]{1,31}$/u;
const BRANCH_CODE = /^[A-Z0-9][A-Z0-9_-]{0,31}$/u;
const PROVIDER_CODE = /^[A-Z0-9][A-Z0-9._-]{0,63}$/u;
const CURRENCY = /^[A-Z0-9]{3,8}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const NONNEGATIVE_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,12})?$/u;
const MASKED_CARD = /^(?=.{5,32}$)[*Xx][*Xx -]*[0-9]{4}$/u;
const uppercase = ({ value }: { value: unknown }): unknown => (
  typeof value === 'string' ? value.trim().toUpperCase() : value
);

export enum BankAccountType {
  CURRENT = 'CURRENT',
  SAVINGS = 'SAVINGS',
  SHORT_TERM = 'SHORT_TERM',
  LONG_TERM = 'LONG_TERM',
  FOREIGN_CURRENCY = 'FOREIGN_CURRENCY',
  DEPOSIT = 'DEPOSIT',
  INTERMEDIARY = 'INTERMEDIARY',
  FUNDS_IN_TRANSIT = 'FUNDS_IN_TRANSIT',
  FACILITY_REFERENCE = 'FACILITY_REFERENCE',
  GUARANTEE_REFERENCE = 'GUARANTEE_REFERENCE',
}

export class BankCapabilitiesDto {
  @IsBoolean() receive!: boolean;
  @IsBoolean() pay!: boolean;
  @IsBoolean() transfer!: boolean;
}

export class NonNegativeMoneyDto {
  @IsString() @Matches(NONNEGATIVE_DECIMAL) amount!: string;
  @IsString() @Matches(CURRENCY) currency!: string;
}

export class BankingAccountingDimensionsDto {
  @IsOptional() @IsString() @MaxLength(128) generalAccount?: string;
  @IsOptional() @IsString() @MaxLength(128) subsidiaryAccount?: string;
  @IsOptional() @IsString() @MaxLength(128) detailAccount?: string;
  @IsOptional() @IsString() @MaxLength(128) floatingDetail?: string;
  @IsOptional() @IsString() @MaxLength(128) costCenter?: string;
  @IsOptional() @IsString() @MaxLength(128) project?: string;
  @IsOptional() @IsString() @MaxLength(128) branch?: string;
}

export class BankTypeCreateDto {
  @Transform(uppercase) @IsString() @Matches(CODE) code!: string;
  @IsString() @MinLength(1) @MaxLength(160) displayName!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
}

export class BankCreateDto {
  @IsUUID() bankTypeId!: string;
  @Transform(uppercase) @IsString() @Matches(CODE) code!: string;
  @IsString() @MinLength(1) @MaxLength(200) displayName!: string;
  @IsOptional() @IsString() @MaxLength(200) englishName?: string;
  @Transform(uppercase) @IsString() @Matches(/^[A-Z]{2}$/u) countryCode!: string;
  @IsOptional() @Transform(uppercase) @IsString()
  @Matches(/^[A-Z0-9][A-Z0-9._-]{0,31}$/u)
  nationalBankCode?: string;
  @IsOptional() @Transform(uppercase) @IsString()
  @Matches(/^[A-Z0-9]{8}(?:[A-Z0-9]{3})?$/u)
  swiftCode?: string;
  @IsOptional() @IsString() @MaxLength(256) logoRef?: string;
}

export class BankBranchCreateDto {
  @IsUUID() bankId!: string;
  @Transform(uppercase) @IsString() @Matches(BRANCH_CODE) code!: string;
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(100) city?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsString() @MaxLength(256) contactReference?: string;
}

export class BankAccountCreateDto {
  @IsUUID() bankId!: string;
  @IsOptional() @IsUUID() bankBranchId?: string;
  @IsOptional() @IsUUID() organizationBranchId?: string;
  @IsOptional() @IsUUID() treasuryUnitId?: string;
  @IsEnum(BankAccountType) accountType!: BankAccountType;
  @IsString() @MinLength(1) @MaxLength(64) accountNumber!: string;
  @IsOptional() @IsString() @MaxLength(64) iban?: string;
  @IsOptional() @IsString() @Matches(MASKED_CARD) maskedCardNumber?: string;
  @IsString() @Matches(CURRENCY) currency!: string;
  @IsString() @MinLength(1) @MaxLength(200) legalOwnerName!: string;
  @IsOptional() @IsBoolean() chequeEnabled?: boolean;
  @ValidateNested() @Type(() => BankCapabilitiesDto)
  capabilities!: BankCapabilitiesDto;
  @IsOptional() @ValidateNested() @Type(() => NonNegativeMoneyDto)
  withdrawalCeiling?: NonNegativeMoneyDto;
  @IsDateString({ strict: true }) @Matches(DATE) openingDate!: string;
  @IsOptional() @ValidateNested() @Type(() => BankingAccountingDimensionsDto)
  accountingDimensions?: BankingAccountingDimensionsDto;
}

export class PosTerminalCreateDto {
  @IsUUID() bankAccountId!: string;
  @IsString() @MinLength(1) @MaxLength(64) terminalNumber!: string;
  @IsString() @MinLength(1) @MaxLength(64) merchantNumber!: string;
  @IsUUID() treasuryUnitId!: string;
  @IsString() @Matches(CURRENCY) currency!: string;
  @IsString() @MinLength(1) @MaxLength(64) settlementCycle!: string;
  @IsOptional() @IsString() @MaxLength(128) feeRuleRef?: string;
  @IsOptional() @IsString() @MaxLength(160) providerLabel?: string;
}

export class PaymentGatewayCreateDto {
  @IsUUID() bankAccountId!: string;
  @Transform(uppercase) @IsString() @Matches(PROVIDER_CODE) providerCode!: string;
  @IsString() @MinLength(1) @MaxLength(128) merchantId!: string;
  @IsString() @MinLength(1) @MaxLength(128) terminalId!: string;
  @IsUUID() treasuryUnitId!: string;
  @IsString() @Matches(CURRENCY) currency!: string;
  @IsString() @MinLength(1) @MaxLength(64) settlementCycle!: string;
  @IsOptional() @IsString() @MaxLength(128) feeRuleRef?: string;
  @IsOptional() @IsString() @MaxLength(128) fundsInTransitMappingRef?: string;
  @IsOptional() @IsString() @MaxLength(128) feeMappingRef?: string;
}

export interface BankTypeSummary {
  id: string;
  code: string;
  displayName: string;
}

export interface BankSummary extends BankTypeSummary {}

export interface BankBranchSummary {
  id: string;
  code: string;
  name: string;
}

export interface OrganizationBranchSummary extends BankBranchSummary {}
export interface TreasuryUnitSummary extends BankBranchSummary {}

export interface BankAccountSummary {
  id: string;
  bank: BankSummary;
  accountNumber: string;
  iban?: string;
  currency: string;
  legalOwnerName: string;
}

interface VersionedView {
  id: string;
  organizationId: string;
  state: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface BankTypeView extends VersionedView {
  code: string;
  displayName: string;
  description?: string;
}

export interface BankView extends VersionedView {
  bankTypeId: string;
  bankType: BankTypeSummary;
  code: string;
  displayName: string;
  englishName?: string;
  countryCode: string;
  nationalBankCode?: string;
  swiftCode?: string;
  logoRef?: string;
}

export interface BankBranchView extends VersionedView {
  bankId: string;
  bank: BankSummary;
  code: string;
  name: string;
  city?: string;
  address?: string;
  contactReference?: string;
}

export interface BankAccountView extends VersionedView {
  bankId: string;
  bank: BankSummary;
  bankBranchId?: string;
  bankBranch?: BankBranchSummary;
  organizationBranchId?: string;
  organizationBranch?: OrganizationBranchSummary;
  treasuryUnitId?: string;
  treasuryUnit?: TreasuryUnitSummary;
  accountType: BankAccountType;
  accountNumber: string;
  iban?: string;
  maskedCardNumber?: string;
  currency: string;
  legalOwnerName: string;
  chequeEnabled: boolean;
  capabilities: BankCapabilitiesDto;
  withdrawalCeiling?: NonNegativeMoneyDto;
  openingDate: string;
  closingDate?: string;
  accountingDimensions?: BankingAccountingDimensionsDto;
}

export interface PosTerminalView extends VersionedView {
  bankAccountId: string;
  bankAccount: BankAccountSummary;
  terminalNumber: string;
  merchantNumber: string;
  organizationBranchId?: string;
  organizationBranch?: OrganizationBranchSummary;
  treasuryUnitId: string;
  treasuryUnit: TreasuryUnitSummary;
  currency: string;
  settlementCycle: string;
  feeRuleRef?: string;
  providerLabel?: string;
}

export interface PaymentGatewayView extends VersionedView {
  bankAccountId: string;
  bankAccount: BankAccountSummary;
  providerCode: string;
  merchantId: string;
  terminalId: string;
  organizationBranchId?: string;
  organizationBranch?: OrganizationBranchSummary;
  treasuryUnitId: string;
  treasuryUnit: TreasuryUnitSummary;
  currency: string;
  settlementCycle: string;
  feeRuleRef?: string;
  fundsInTransitMappingRef?: string;
  feeMappingRef?: string;
}

export interface Page<T> {
  items: T[];
  page: { limit: number; hasMore: boolean; nextCursor?: string; asOf: string };
}
