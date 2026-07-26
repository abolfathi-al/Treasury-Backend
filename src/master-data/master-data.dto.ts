import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class BranchCreateDto {
  @IsString() @MinLength(1) @MaxLength(32) code!: string;
  @IsString() @MinLength(1) @MaxLength(160) name!: string;
}

export class TreasuryUnitCreateDto {
  @IsString() @MinLength(1) @MaxLength(32) code!: string;
  @IsString() @MinLength(1) @MaxLength(160) name!: string;
  @IsOptional() @IsString() @MaxLength(128) branchId?: string;
  @IsString() @Matches(/^[A-Z0-9]{3,8}$/u) defaultCurrency!: string;
}

export class CurrencyCreateDto {
  @IsString() @Matches(/^[A-Z0-9]{3,8}$/u) code!: string;
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsOptional() @IsString() @MaxLength(100) englishName?: string;
  @IsOptional() @IsString() @MaxLength(16) symbol?: string;
  @IsInt() @Min(0) @Max(8) decimalPlaces!: number;
  @IsOptional() @IsBoolean() baseCurrency?: boolean;
}

export enum PartyKind {
  CUSTOMER = 'CUSTOMER',
  SUPPLIER = 'SUPPLIER',
  EMPLOYEE = 'EMPLOYEE',
  SHAREHOLDER = 'SHAREHOLDER',
  REPRESENTATIVE = 'REPRESENTATIVE',
  BANK = 'BANK',
  COMPANY = 'COMPANY',
  ORGANIZATION = 'ORGANIZATION',
  NATURAL_PERSON = 'NATURAL_PERSON',
  LEGAL_PERSON = 'LEGAL_PERSON',
  OTHER = 'OTHER',
}

export class PartyCreateDto {
  @IsString() @MinLength(1) @MaxLength(64) code!: string;
  @IsArray() @ArrayMinSize(1) @ArrayUnique() @IsEnum(PartyKind, { each: true })
  partyKinds!: PartyKind[];
  @IsString() @MinLength(1) @MaxLength(200) displayName!: string;
  @IsOptional() @IsString() @MaxLength(200) legalName?: string;
  @IsOptional() @IsString() @MaxLength(64) nationalId?: string;
  @IsOptional() @IsString() @MaxLength(64) registrationId?: string;
  @IsOptional() @IsString() @MaxLength(64) phone?: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export interface PartyView extends PartyCreateDto {
  id: string;
  organizationId: string;
  state: 'ACTIVE';
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PartyPage {
  items: PartyView[];
  page: { limit: number; hasMore: boolean; nextCursor?: string; asOf: string };
}

export enum MethodDirection {
  RECEIPT = 'RECEIPT',
  PAYMENT = 'PAYMENT',
  BOTH = 'BOTH',
}

export enum MethodBehaviorCategory {
  CASH = 'CASH',
  CHEQUE = 'CHEQUE',
  BANK_TRANSFER = 'BANK_TRANSFER',
  DIRECT_DEPOSIT = 'DIRECT_DEPOSIT',
  POS = 'POS',
  GATEWAY = 'GATEWAY',
  CARD_TRANSFER = 'CARD_TRANSFER',
  WALLET = 'WALLET',
  OFFSET = 'OFFSET',
  FOREIGN_REMITTANCE = 'FOREIGN_REMITTANCE',
  OTHER_CONTROLLED = 'OTHER_CONTROLLED',
}

export enum MethodReference {
  CASHBOX = 'CASHBOX',
  BANK_ACCOUNT = 'BANK_ACCOUNT',
  CHEQUE = 'CHEQUE',
  POS = 'POS',
  GATEWAY = 'GATEWAY',
  TRACKING_NUMBER = 'TRACKING_NUMBER',
  DUE_DATE = 'DUE_DATE',
  PARTY = 'PARTY',
  EVIDENCE = 'EVIDENCE',
}

export class PositiveMoneyDto {
  @IsString()
  @Matches(/^(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,8})?$/u)
  amount!: string;

  @IsString()
  @Matches(/^[A-Z0-9]{3,8}$/u)
  currency!: string;
}

export class MethodCreateDto {
  @IsString() @MinLength(1) @MaxLength(64) code!: string;
  @IsString() @MinLength(1) @MaxLength(160) name!: string;
  @IsEnum(MethodDirection) direction!: MethodDirection;
  @IsEnum(MethodBehaviorCategory) behaviorCategory!: MethodBehaviorCategory;

  @IsArray()
  @ArrayUnique()
  @IsEnum(MethodReference, { each: true })
  requiredReferences!: MethodReference[];

  @IsBoolean() createsFundsInTransit!: boolean;
  @IsBoolean() requiresApproval!: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @Matches(/^[A-Z0-9]{3,8}$/u, { each: true })
  allowedCurrencies!: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PositiveMoneyDto)
  amountLimits?: PositiveMoneyDto[];

  @IsOptional() @IsString() @MinLength(1) @MaxLength(128) debitMappingRef?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128) creditMappingRef?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128) feeMappingRef?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128) discrepancyMappingRef?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128) templateMappingRef?: string;
}
