import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import type { CollectionSemanticRef } from './collection-items.dto';

const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const CURRENCY = /^[A-Z0-9]{3,8}$/u;
const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?$/u;
const POSITIVE_DECIMAL = /^(?:0\.0*[1-9][0-9]*|[1-9][0-9]*(?:\.[0-9]{1,8})?)$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

export class SettlementMoneyDto {
  @IsString() @Matches(DECIMAL) amount!: string;
  @IsString() @Matches(CURRENCY) currency!: string;
}

export class PositiveSettlementMoneyDto {
  @IsString() @Matches(POSITIVE_DECIMAL) amount!: string;
  @IsString() @Matches(CURRENCY) currency!: string;
}

export enum SettlementMatchKind {
  DETERMINISTIC = 'DETERMINISTIC',
  MANUAL = 'MANUAL',
}

export class SettlementMatchDto {
  @IsEnum(SettlementMatchKind) kind!: SettlementMatchKind;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128) ruleId?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(64) ruleVersion?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(500) reason?: string;
}

export class SettlementAllocationDto {
  @IsUUID() collectionItemId!: string;
  @IsInt() @Min(0) collectionItemVersion!: number;
  @ValidateNested() @Type(() => PositiveSettlementMoneyDto)
  amount!: PositiveSettlementMoneyDto;
}

export class SettlementAttachmentDto {
  @IsUUID() id!: string;
  @IsString() @Matches(DIGEST) contentDigest!: string;
  @IsString() @Matches(/^BANK_CREDIT_EVIDENCE$/u) purpose!: 'BANK_CREDIT_EVIDENCE';
}

export enum SettlementDiscrepancyDisposition {
  NONE = 'NONE',
  OPEN = 'OPEN',
  APPROVED_DIFFERENCE = 'APPROVED_DIFFERENCE',
  CORRECTION_REQUIRED = 'CORRECTION_REQUIRED',
  RETURNED = 'RETURNED',
}

export class SettlementCreateDto {
  @IsUUID() destinationBankAccountId!: string;
  @IsOptional() @IsUUID() bankStatementLineId?: string;
  @IsOptional() @IsString() @MaxLength(128) providerReference?: string;
  @IsDateString({ strict: true }) @Matches(DATE) settlementDate!: string;
  @ValidateNested() @Type(() => SettlementMatchDto) match!: SettlementMatchDto;
  @ValidateNested() @Type(() => PositiveSettlementMoneyDto) gross!: PositiveSettlementMoneyDto;
  @ValidateNested() @Type(() => SettlementMoneyDto) fee!: SettlementMoneyDto;
  @ValidateNested() @Type(() => SettlementMoneyDto) deduction!: SettlementMoneyDto;
  @ValidateNested() @Type(() => PositiveSettlementMoneyDto) expectedNet!: PositiveSettlementMoneyDto;
  @ValidateNested() @Type(() => PositiveSettlementMoneyDto) actualNet!: PositiveSettlementMoneyDto;
  @ValidateNested() @Type(() => SettlementMoneyDto) discrepancy!: SettlementMoneyDto;
  @IsEnum(SettlementDiscrepancyDisposition)
  discrepancyDisposition!: SettlementDiscrepancyDisposition;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(500) discrepancyReason?: string;
  @IsOptional() @IsUUID() replacementForBatchId?: string;
  @IsArray() @ArrayMinSize(1) @ArrayUnique((item: SettlementAllocationDto) => item.collectionItemId)
  @ValidateNested({ each: true }) @Type(() => SettlementAllocationDto)
  allocations!: SettlementAllocationDto[];
  @IsArray() @ArrayMinSize(1) @ArrayUnique((item: SettlementAttachmentDto) => item.id)
  @ValidateNested({ each: true }) @Type(() => SettlementAttachmentDto)
  attachments!: SettlementAttachmentDto[];
}

export class SettlementReverseDto {
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
  @IsDateString({ strict: true }) @Matches(DATE) businessDate!: string;
}

export interface SettlementAllocationView {
  id: string;
  collectionItemId: string;
  collectionItem: CollectionSemanticRef;
  collectionItemVersion: number;
  amount: PositiveSettlementMoneyDto;
  state: 'PROPOSED' | 'CONFIRMED' | 'REVERSED';
}

export type SettlementEffectType = 'BANK_CREDIT' | 'ALLOCATION_CONSUMPTION'
  | 'FEE_EVIDENCE' | 'DEDUCTION_EVIDENCE' | 'APPROVED_DISCREPANCY_EVIDENCE';

export interface SettlementEffectView {
  id: string;
  effectKey: string;
  effectType: SettlementEffectType;
  direction: 'SETTLEMENT' | 'REVERSAL';
  money: SettlementMoneyDto;
  businessDate: string;
  sourceVersion: number;
  movementFactId?: string;
  collectionItemId?: string;
  reversalOfEffectId?: string;
}

export interface SettlementBatchView {
  id: string;
  organizationId: string;
  organization: CollectionSemanticRef;
  businessNumber: string;
  destinationBankAccountId: string;
  destinationBankAccount: CollectionSemanticRef;
  bankStatementLineId?: string;
  providerReference?: string;
  settlementDate: string;
  match:
    | { kind: SettlementMatchKind.DETERMINISTIC; ruleId: string; ruleVersion: string }
    | { kind: SettlementMatchKind.MANUAL; reason: string };
  gross: PositiveSettlementMoneyDto;
  fee: SettlementMoneyDto;
  deduction: SettlementMoneyDto;
  expectedNet: PositiveSettlementMoneyDto;
  actualNet: PositiveSettlementMoneyDto;
  discrepancy: SettlementMoneyDto;
  discrepancyDisposition: SettlementDiscrepancyDisposition;
  discrepancyReason?: string;
  replacementForBatchId?: string;
  reversalBatchId?: string;
  allocations: SettlementAllocationView[];
  attachments: SettlementAttachmentDto[];
  creatorUserId: string;
  creator: CollectionSemanticRef;
  confirmedByUserId?: string;
  confirmedBy?: CollectionSemanticRef;
  confirmedAt?: string;
  reversedByUserId?: string;
  reversedBy?: CollectionSemanticRef;
  reversedAt?: string;
  effects: SettlementEffectView[];
  state: 'MATCHED' | 'DISCREPANCY' | 'CONFIRMED' | 'REVERSED';
  version: number;
  createdAt: string;
  updatedAt: string;
}

export const SETTLEMENT_ACTION_STATES = ['MATCHED', 'DISCREPANCY', 'CONFIRMED'] as const;
export type SettlementActionState = typeof SETTLEMENT_ACTION_STATES[number];

export interface SettlementBatchQuery {
  state?: string | string[];
  limit?: string;
  cursor?: string;
}

export interface SettlementBatchPage {
  items: SettlementBatchView[];
  page: {
    limit: number;
    hasMore: boolean;
    asOf: string;
    nextCursor?: string;
  };
}

export interface SettlementReversalView {
  id: string;
  organizationId: string;
  businessNumber: string;
  reversalOfBatchId: string;
  destinationBankAccountId: string;
  businessDate: string;
  actualNet: PositiveSettlementMoneyDto;
  reason: string;
  reversedByUserId: string;
  reversedBy: CollectionSemanticRef;
  effects: SettlementEffectView[];
  state: 'REVERSAL';
  version: number;
  createdAt: string;
}

export interface SettlementReversalResult {
  original: SettlementBatchView;
  reversal: SettlementReversalView;
}
