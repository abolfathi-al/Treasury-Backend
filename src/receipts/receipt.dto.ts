import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsISO8601,
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

import { MethodBehaviorCategory, MethodReference } from '../master-data/master-data.dto';

const CURRENCY = /^[A-Z0-9]{3,8}$/u;
const POSITIVE_DECIMAL =
  /^(?:0\.0*[1-9][0-9]*|[1-9][0-9]*(?:\.[0-9]{1,12})?)$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

export class ReceiptPositiveMoneyDto {
  @IsString() @Matches(POSITIVE_DECIMAL) amount!: string;
  @IsString() @Matches(CURRENCY) currency!: string;
}

export class ReceiptAccountingDimensionsDto {
  @IsOptional() @IsString() @MaxLength(128) generalAccount?: string;
  @IsOptional() @IsString() @MaxLength(128) subsidiaryAccount?: string;
  @IsOptional() @IsString() @MaxLength(128) detailAccount?: string;
  @IsOptional() @IsString() @MaxLength(128) floatingDetail?: string;
  @IsOptional() @IsString() @MaxLength(128) costCenter?: string;
  @IsOptional() @IsString() @MaxLength(128) project?: string;
  @IsOptional() @IsString() @MaxLength(128) branch?: string;
}

export class ReceiptAttachmentRefDto {
  @IsUUID() id!: string;
  @IsString() @Matches(DIGEST) contentDigest!: string;
  @IsOptional() @IsString() @MaxLength(64) purpose?: string;
}

export enum ReceiptAllocationObjectType {
  INVOICE = 'INVOICE',
  DEBT = 'DEBT',
  CONTRACT_ITEM = 'CONTRACT_ITEM',
  ACCOUNTING_REFERENCE = 'ACCOUNTING_REFERENCE',
}

export class ReceiptAllocationInputDto {
  @IsEnum(ReceiptAllocationObjectType)
  externalObjectType!: ReceiptAllocationObjectType;
  @IsString() @MinLength(1) @MaxLength(128) externalObjectId!: string;
  @ValidateNested() @Type(() => ReceiptPositiveMoneyDto)
  baseMoney!: ReceiptPositiveMoneyDto;
}

export enum SayadObservationSource {
  MANUAL = 'MANUAL',
  FILE = 'FILE',
}

export class ReceiptSayadObservationDto {
  @IsString() @Matches(/^[0-9]{16}$/u) sayadId!: string;
  @IsString() @MinLength(1) @MaxLength(64) status!: string;
  @IsEnum(SayadObservationSource) source!: SayadObservationSource;
  @IsISO8601({ strict: true }) observedAt!: string;
  @IsOptional() @IsString() @Matches(DIGEST) sourceDigest?: string;
  @IsOptional() @IsString() @MaxLength(32) issuerNationalId?: string;
  @IsOptional() @IsString() @MaxLength(32) beneficiaryNationalId?: string;
}

export class ReceiptChequeInputDto {
  @IsUUID() bankId!: string;
  @IsOptional() @IsUUID() bankBranchId?: string;
  @IsString() @MinLength(1) @MaxLength(64) chequeNumber!: string;
  @IsOptional() @IsString() @MaxLength(32) series?: string;
  @IsOptional() @IsString() @MaxLength(64) localTrackingId?: string;
  @IsOptional() @IsString() @MaxLength(128) issuerAccountRef?: string;
  @IsOptional() @IsUUID() payerPartyId?: string;
  @IsOptional() @ValidateNested() @Type(() => ReceiptSayadObservationDto)
  sayadObservation?: ReceiptSayadObservationDto;
  @IsDateString({ strict: true }) @Matches(DATE) receiptDate!: string;
  @IsDateString({ strict: true }) @Matches(DATE) dueDate!: string;
}

export enum ReceiptRemainderTreatment {
  UNALLOCATED = 'UNALLOCATED',
  ADVANCE = 'ADVANCE',
  OVERPAYMENT = 'OVERPAYMENT',
}

export class ReceiptLineInputDto {
  @IsInt() @Min(1) lineNumber!: number;
  @IsUUID() methodId!: string;
  @ValidateNested() @Type(() => ReceiptPositiveMoneyDto)
  money!: ReceiptPositiveMoneyDto;
  @IsOptional() @IsUUID() cashboxId?: string;
  @IsOptional() @IsUUID() bankAccountId?: string;
  @IsOptional() @IsUUID() posTerminalId?: string;
  @IsOptional() @IsUUID() paymentGatewayId?: string;
  @IsOptional() @ValidateNested() @Type(() => ReceiptChequeInputDto)
  cheque?: ReceiptChequeInputDto;
  @IsOptional() @IsString() @MaxLength(128) trackingNumber?: string;
  @IsOptional() @IsString() @MaxLength(128) payerAccountReference?: string;
  @IsOptional() @IsDateString({ strict: true }) @Matches(DATE) dueDate?: string;
  @IsOptional() @IsString() @MaxLength(200) payerName?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true })
  @Type(() => ReceiptAllocationInputDto)
  allocations?: ReceiptAllocationInputDto[];
  @IsEnum(ReceiptRemainderTreatment)
  remainderTreatment!: ReceiptRemainderTreatment;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @ValidateNested() @Type(() => ReceiptAccountingDimensionsDto)
  accountingDimensions?: ReceiptAccountingDimensionsDto;
  @IsOptional() @IsArray() @ArrayUnique((item: ReceiptAttachmentRefDto) =>
    `${item.id}:${item.contentDigest}:${item.purpose ?? ''}`)
  @ValidateNested({ each: true }) @Type(() => ReceiptAttachmentRefDto)
  attachments?: ReceiptAttachmentRefDto[];
}

export class ReceiptCreateDto {
  @IsDateString({ strict: true }) @Matches(DATE) businessDate!: string;
  @IsUUID() partyId!: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsUUID() treasuryUnitId!: string;
  @IsString() @Matches(CURRENCY) baseCurrency!: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsString() @MaxLength(500) purpose?: string;
  @IsOptional() @IsString() @MaxLength(128) contractRef?: string;
  @IsOptional() @IsString() @MaxLength(128) invoiceRef?: string;
  @IsOptional() @IsString() @MaxLength(128) orderRef?: string;
  @IsOptional() @IsString() @MaxLength(128) projectRef?: string;
  @IsOptional() @IsString() @MaxLength(128) costCenterRef?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true })
  @Type(() => ReceiptLineInputDto)
  lines!: ReceiptLineInputDto[];
}

export enum ReceiptApprovalAction {
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
  RETURN = 'RETURN',
}

export class ReceiptApprovalActionDto {
  @IsEnum(ReceiptApprovalAction) action!: ReceiptApprovalAction;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(500) reason?: string;
}

export class ReceiptSeparationOverrideDto {
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
  @IsUUID() independentApprovalActionId!: string;
}

export class ReceiptExecuteDto {
  @ValidateNested() @Type(() => ReceiptSeparationOverrideDto)
  separationOverride!: ReceiptSeparationOverrideDto;
}

export class ReceiptReverseDto {
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
  @IsDateString({ strict: true }) @Matches(DATE) businessDate!: string;
}

export interface ReceiptSemanticRef {
  id: string;
  label: string;
}

export interface ReceiptEvidenceRef extends ReceiptSemanticRef {
  contentDigest: string;
  purpose?: string;
}

export interface ReceiptRateSnapshot {
  sourceCurrency: string;
  targetCurrency: string;
  rate: string;
  rateType: string;
  rateSource: 'IDENTITY' | 'TABLE';
  ratedAt: string;
  rateRecordId?: string;
  targetAmount: string;
  roundingDifference: string;
}

export interface ReceiptAllocationView {
  id: string;
  externalObjectType: ReceiptAllocationObjectType;
  externalObjectId: string;
  baseMoney: ReceiptPositiveMoneyDto;
  state: 'ACTIVE' | 'REVERSED';
}

export interface ReceiptChequeView extends ReceiptChequeInputDto {
  bank: ReceiptSemanticRef;
  bankBranch?: ReceiptSemanticRef;
  payerParty?: ReceiptSemanticRef;
  amount: ReceiptPositiveMoneyDto;
}

export interface ReceiptLineView {
  id: string;
  lineNumber: number;
  methodId: string;
  method: ReceiptSemanticRef;
  methodBehaviorCategory: MethodBehaviorCategory;
  methodRequiredReferences: MethodReference[];
  createsFundsInTransit: boolean;
  requiresApproval: boolean;
  money: ReceiptPositiveMoneyDto;
  baseAmount: ReceiptPositiveMoneyDto;
  rateSnapshot: ReceiptRateSnapshot;
  rateRecord?: ReceiptSemanticRef;
  cashboxId?: string;
  cashbox?: ReceiptSemanticRef;
  bankAccountId?: string;
  bankAccount?: ReceiptSemanticRef;
  posTerminalId?: string;
  posTerminal?: ReceiptSemanticRef;
  paymentGatewayId?: string;
  paymentGateway?: ReceiptSemanticRef;
  cheque?: ReceiptChequeView;
  trackingNumber?: string;
  payerAccountReference?: string;
  dueDate?: string;
  payerName?: string;
  allocations: ReceiptAllocationView[];
  remainderTreatment: ReceiptRemainderTreatment;
  description?: string;
  accountingDimensions?: ReceiptAccountingDimensionsDto;
  attachments?: ReceiptEvidenceRef[];
  executedAt?: string;
  executedByUserId?: string;
  executedBy?: ReceiptSemanticRef;
  executionEffects?: ReceiptExecutionEffectView[];
  state: 'DRAFT' | 'EXECUTED' | 'REVERSED';
  version: number;
}

export type ReceiptExecutionEffectType =
  | 'CASHBOX_MOVEMENT'
  | 'BANK_MOVEMENT'
  | 'RECEIVED_CHEQUE'
  | 'COLLECTION_ITEM';

export interface ReceiptExecutionEffectView {
  receiptEffectId: string;
  effectKey: string;
  effectType: ReceiptExecutionEffectType;
  effect?: ReceiptSemanticRef;
  chequeEventId?: string;
  collectionItemId?: string;
  collectionItemVersion?: number;
  collectionItemState?: 'RETURNED' | 'REOPENED_AFTER_REVERSAL';
  direction: 'INCOMING' | 'REVERSAL';
  money: ReceiptPositiveMoneyDto;
  businessDate: string;
  sourceVersion: number;
  reversalOfEffectId?: string;
}

export interface ReceiptApprovalPolicyContextView {
  order: number;
  firstLineNumber: number;
  currency: string;
  methodCategory: MethodBehaviorCategory;
  policyId: string;
  policy: ReceiptSemanticRef;
  policyVersion: number;
}

export interface ReceiptApprovalActionView {
  id: string;
  approvalSnapshotId: string;
  approvalSnapshotStepId?: string;
  stepOrder?: number;
  actorUserId: string;
  actor: ReceiptSemanticRef;
  delegatedFromUserId?: string;
  delegatedFrom?: ReceiptSemanticRef;
  action: 'APPROVED' | 'REJECTED' | 'RETURNED';
  reason?: string;
  actedAt: string;
}

export interface ReceiptApprovalStepView {
  order: number;
  roleId?: string;
  role?: ReceiptSemanticRef;
  approverUserId?: string;
  approver?: ReceiptSemanticRef;
  approvalsRequired: number;
  approvalsRecorded: number;
  separationRules: string[];
  sourceContextOrders: number[];
  state: 'WAITING' | 'CURRENT' | 'APPROVED' | 'REJECTED' | 'RETURNED';
}

export interface ReceiptApprovalSnapshotView {
  id: string;
  documentVersion: number;
  amountBasis: ReceiptPositiveMoneyDto;
  evaluatedAt: string;
  policyContexts: ReceiptApprovalPolicyContextView[];
  steps: ReceiptApprovalStepView[];
  actions: ReceiptApprovalActionView[];
  state: 'PENDING' | 'APPROVED' | 'REJECTED' | 'RETURNED';
}

export interface ReceiptView {
  id: string;
  organizationId: string;
  organization: ReceiptSemanticRef;
  businessNumber: string;
  businessDate: string;
  enteredAt: string;
  partyId: string;
  party: ReceiptSemanticRef;
  branchId?: string;
  branch?: ReceiptSemanticRef;
  treasuryUnitId: string;
  treasuryUnit: ReceiptSemanticRef;
  baseCurrency: string;
  baseCurrencyRef: ReceiptSemanticRef;
  description?: string;
  purpose?: string;
  contractRef?: string;
  invoiceRef?: string;
  orderRef?: string;
  projectRef?: string;
  costCenterRef?: string;
  origin: 'MANUAL';
  creatorUserId: string;
  creator: ReceiptSemanticRef;
  totalBaseAmount: ReceiptPositiveMoneyDto;
  approvalSnapshot?: ReceiptApprovalSnapshotView;
  executedAt?: string;
  executedByUserId?: string;
  executedBy?: ReceiptSemanticRef;
  reversalReceipt?: ReceiptSemanticRef;
  reversesReceipt?: ReceiptSemanticRef;
  lines: ReceiptLineView[];
  state:
    | 'DRAFT'
    | 'SUBMITTED'
    | 'APPROVAL_PENDING'
    | 'APPROVED'
    | 'REJECTED'
    | 'EXECUTED'
    | 'ACCOUNTING_READY'
    | 'ACCOUNTING_POSTED'
    | 'CANCELLED'
    | 'REVERSED';
  workflowState:
    | 'DRAFT'
    | 'SUBMITTED'
    | 'APPROVAL_PENDING'
    | 'APPROVED'
    | 'REJECTED'
    | 'CANCELLED';
  executionState: 'NOT_EXECUTED' | 'EXECUTED' | 'REVERSED';
  accountingState:
    | 'NOT_READY'
    | 'MAPPING_REQUIRED'
    | 'READY'
    | 'QUEUED'
    | 'SENDING'
    | 'SENDING_UNKNOWN'
    | 'ACCEPTED'
    | 'FAILED'
    | 'RETURNED'
    | 'CORRECTED';
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReceiptReversalResult {
  originalReceipt: ReceiptView;
  reversalReceipt: ReceiptView;
}

export interface ReceiptPage {
  items: ReceiptView[];
  page: { limit: number; hasMore: boolean; nextCursor?: string; asOf?: string };
}
