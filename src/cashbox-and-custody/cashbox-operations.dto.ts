import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const CURRENCY = /^[A-Z0-9]{3,8}$/u;
const NONNEGATIVE_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?$/u;
const POSITIVE_DECIMAL = /^(?!0(?:\.0{1,8})?$)(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?$/u;

export interface SemanticRef {
  id: string;
  label: string;
}

export class MoneyDto {
  @IsString() @Matches(POSITIVE_DECIMAL) amount!: string;
  @IsString() @Matches(CURRENCY) currency!: string;
}

export class NonNegativeMoneyDto {
  @IsString() @Matches(NONNEGATIVE_DECIMAL) amount!: string;
  @IsString() @Matches(CURRENCY) currency!: string;
}

export enum ReplenishmentSourceType {
  CASHBOX = 'CASHBOX',
  BANK_ACCOUNT = 'BANK_ACCOUNT',
}

export class ReplenishmentSourceDto {
  @IsEnum(ReplenishmentSourceType) type!: ReplenishmentSourceType;
  @IsUUID() id!: string;
}

export class PettyCashFundCreateDto {
  @IsUUID() cashboxId!: string;
  @ValidateNested() @Type(() => MoneyDto) ceiling!: MoneyDto;
  @IsArray() @ArrayMinSize(1) @ArrayUnique()
  @IsString({ each: true }) @Matches(/^[A-Z][A-Z0-9_-]{0,63}$/u, { each: true })
  expenseCategoryCodes!: string[];
  @IsOptional() @ValidateNested() @Type(() => NonNegativeMoneyDto)
  evidenceThreshold?: NonNegativeMoneyDto;
  @IsInt() @Min(1) @Max(3650) settlementDays!: number;
  @ValidateNested() @Type(() => ReplenishmentSourceDto)
  replenishmentSource!: ReplenishmentSourceDto;
}

export interface PettyCashFundView {
  id: string;
  organizationId: string;
  cashboxId: string;
  cashbox: SemanticRef;
  branchId?: string;
  treasuryUnitId: string;
  currency: string;
  custodianUserId: string;
  custodian: SemanticRef;
  ceiling: MoneyDto;
  expenseCategoryCodes: string[];
  evidenceThreshold?: NonNegativeMoneyDto;
  settlementDays: number;
  replenishmentSource: ReplenishmentSourceDto & { resource: SemanticRef };
  state: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Page<T> {
  items: T[];
  page: { limit: number; hasMore: boolean; nextCursor?: string; asOf: string };
}

export class CloseDayCountDto {
  @IsString() @Matches(CURRENCY) currency!: string;
  @IsString() @Matches(NONNEGATIVE_DECIMAL) countedAmount!: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(500) varianceReason?: string;
}

export class CashboxDayCloseApprovalRequestDto {
  @IsArray() @ArrayMinSize(1)
  @ValidateNested({ each: true }) @Type(() => CloseDayCountDto)
  counts!: CloseDayCountDto[];
  @IsArray() @ArrayUnique() @IsUUID('4', { each: true }) observedInstrumentIds!: string[];
}

export class CloseDayDto extends CashboxDayCloseApprovalRequestDto {
  @IsOptional() @IsUUID() approvalActionId?: string;
}

export class CashboxDayReopenApprovalRequestDto {
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
}

export class ReopenDayDto extends CashboxDayReopenApprovalRequestDto {
  @IsUUID() approvalActionId!: string;
}

export enum CashboxDayApprovalCommandKind {
  CLOSE = 'CLOSE',
  REOPEN = 'REOPEN',
}

export enum CashboxDayApprovalState {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export enum CashboxDayApprovalQueue {
  REQUESTED_CLOSE = 'REQUESTED_CLOSE',
  REQUESTED_REOPEN = 'REQUESTED_REOPEN',
  ACTIONABLE_APPROVE = 'ACTIONABLE_APPROVE',
  ACTIONABLE_REJECT = 'ACTIONABLE_REJECT',
}

export enum CashboxDayApprovalCommand {
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
}

export class CashboxDayApprovalActionDto {
  @IsEnum(CashboxDayApprovalCommand) action!: CashboxDayApprovalCommand;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(500) reason?: string;
}

export interface CashboxDayApprovalActionView {
  id: string;
  approvalRequestId: string;
  actorUserId: string;
  actor: SemanticRef;
  action: 'APPROVED' | 'REJECTED';
  reason?: string;
  actedAt: string;
}

export interface CashboxDayApprovalRequestView {
  id: string;
  organizationId: string;
  cashboxId: string;
  cashbox: SemanticRef;
  businessDate: string;
  commandKind: CashboxDayApprovalCommandKind;
  commandDigest: string;
  sourceDayId?: string;
  sourceDay?: SemanticRef;
  sourceDayVersion: number;
  closeCommand?: CashboxDayCloseApprovalRequestDto;
  reopenCommand?: CashboxDayReopenApprovalRequestDto;
  requestedByUserId: string;
  requestedBy: SemanticRef;
  state: CashboxDayApprovalState;
  action?: CashboxDayApprovalActionView;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CashboxDayCountView extends CloseDayCountDto {
  bookAmount: string;
  varianceAmount: string;
}

export interface CashboxDayView {
  id: string;
  organizationId: string;
  cashboxId: string;
  cashbox: SemanticRef;
  businessDate: string;
  closeCycle: number;
  businessNumber?: string;
  state: 'CLOSED' | 'REOPENED';
  counts: CashboxDayCountView[];
  heldInstrumentSnapshot: Array<{
    id: string;
    instrumentType: 'CHEQUE' | 'DOCUMENT' | 'OTHER';
    reference: string;
  }>;
  observedInstrumentIds: string[];
  approvalActionId?: string;
  approvalAction?: SemanticRef;
  priorCloseId?: string;
  reopenReason?: string;
  closedByUserId?: string;
  closedBy?: SemanticRef;
  closedAt?: string;
  reopenedByUserId?: string;
  reopenedBy?: SemanticRef;
  reopenedAt?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}
