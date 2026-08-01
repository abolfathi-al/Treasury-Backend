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

import { MethodBehaviorCategory, MethodReference } from '../master-data/master-data.dto';

const CURRENCY = /^[A-Z0-9]{3,8}$/u;
const POSITIVE_DECIMAL = /^(?:0\.0*[1-9][0-9]*|[1-9][0-9]*(?:\.[0-9]{1,12})?)$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

export class PaymentPositiveMoneyDto {
  @IsString() @Matches(POSITIVE_DECIMAL) amount!: string;
  @IsString() @Matches(CURRENCY) currency!: string;
}

export class PaymentAccountingDimensionsDto {
  @IsOptional() @IsString() @MaxLength(128) generalAccount?: string;
  @IsOptional() @IsString() @MaxLength(128) subsidiaryAccount?: string;
  @IsOptional() @IsString() @MaxLength(128) detailAccount?: string;
  @IsOptional() @IsString() @MaxLength(128) floatingDetail?: string;
  @IsOptional() @IsString() @MaxLength(128) costCenter?: string;
  @IsOptional() @IsString() @MaxLength(128) project?: string;
  @IsOptional() @IsString() @MaxLength(128) branch?: string;
}

export class PaymentAttachmentRefDto {
  @IsUUID() id!: string;
  @IsString() @Matches(DIGEST) contentDigest!: string;
  @IsOptional() @IsString() @MaxLength(64) purpose?: string;
}

export class PaymentRequestCreateDto {
  @IsUUID() beneficiaryPartyId!: string;
  @ValidateNested() @Type(() => PaymentPositiveMoneyDto)
  requestedMoney!: PaymentPositiveMoneyDto;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsUUID() treasuryUnitId?: string;
  @IsOptional() @IsDateString({ strict: true }) @Matches(DATE) dueDate?: string;
  @IsString() @MinLength(1) @MaxLength(1000) purpose!: string;
  @IsOptional() @IsString() @MaxLength(128) contractRef?: string;
  @IsOptional() @IsString() @MaxLength(128) invoiceRef?: string;
  @IsOptional() @ValidateNested() @Type(() => PaymentAccountingDimensionsDto)
  accountingDimensions?: PaymentAccountingDimensionsDto;
  @IsOptional() @IsArray()
  @ArrayUnique((item: PaymentAttachmentRefDto) => `${item.id}:${item.contentDigest}:${item.purpose ?? ''}`)
  @ValidateNested({ each: true }) @Type(() => PaymentAttachmentRefDto)
  attachments?: PaymentAttachmentRefDto[];
}

export class PaymentLineInputDto {
  @IsInt() @Min(1) lineNumber!: number;
  @IsUUID() methodId!: string;
  @ValidateNested() @Type(() => PaymentPositiveMoneyDto)
  money!: PaymentPositiveMoneyDto;
  @IsOptional() @IsUUID() cashboxId?: string;
  @IsOptional() @IsUUID() bankAccountId?: string;
  @IsUUID() beneficiaryPartyId!: string;
  @IsOptional() @IsString() @MaxLength(128) beneficiaryAccountReference?: string;
  @IsOptional() @IsString() @MaxLength(128) trackingNumber?: string;
  @IsOptional() @IsDateString({ strict: true }) @Matches(DATE) dueDate?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @ValidateNested() @Type(() => PaymentAccountingDimensionsDto)
  accountingDimensions?: PaymentAccountingDimensionsDto;
  @IsOptional() @IsArray()
  @ArrayUnique((item: PaymentAttachmentRefDto) => `${item.id}:${item.contentDigest}:${item.purpose ?? ''}`)
  @ValidateNested({ each: true }) @Type(() => PaymentAttachmentRefDto)
  attachments?: PaymentAttachmentRefDto[];
}

export class PaymentCreateDto {
  @IsDateString({ strict: true }) @Matches(DATE) businessDate!: string;
  @IsUUID() beneficiaryPartyId!: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsUUID() treasuryUnitId!: string;
  @IsString() @Matches(CURRENCY) baseCurrency!: string;
  @IsString() @MinLength(1) @MaxLength(1000) purpose!: string;
  @IsOptional() @IsDateString({ strict: true }) @Matches(DATE) dueDate?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true })
  @Type(() => PaymentLineInputDto)
  lines!: PaymentLineInputDto[];
}

export enum PaymentApprovalAction {
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
  RETURN = 'RETURN',
}

export class PaymentApprovalActionDto {
  @IsEnum(PaymentApprovalAction) action!: PaymentApprovalAction;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export interface PaymentSemanticRef {
  id: string;
  label: string;
}

export interface PaymentEvidenceRef extends PaymentSemanticRef {
  contentDigest: string;
  purpose?: string;
}

export interface PaymentRateSnapshot {
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

export interface PaymentApprovalPolicyContextView {
  order: number;
  firstLineNumber: number;
  currency: string;
  methodCategory: MethodBehaviorCategory;
  policyId: string;
  policy: PaymentSemanticRef;
  policyVersion: number;
}

export interface PaymentApprovalActionView {
  id: string;
  approvalSnapshotId: string;
  approvalSnapshotStepId?: string;
  stepOrder?: number;
  actorUserId: string;
  actor: PaymentSemanticRef;
  delegatedFromUserId?: string;
  delegatedFrom?: PaymentSemanticRef;
  action: 'APPROVED' | 'REJECTED' | 'RETURNED';
  reason?: string;
  actedAt: string;
}

export interface PaymentApprovalSnapshotStepView {
  order: number;
  roleId?: string;
  role?: PaymentSemanticRef;
  approverUserId?: string;
  approver?: PaymentSemanticRef;
  approvalsRequired: number;
  approvalsRecorded: number;
  separationRules: string[];
  sourceContextOrders: number[];
  state: 'WAITING' | 'CURRENT' | 'APPROVED' | 'REJECTED' | 'RETURNED';
}

export interface PaymentApprovalAggregationParticipantView {
  paymentId: string;
  payment: PaymentSemanticRef;
  versionBasis: 'SUBMITTED_CONTENT' | 'LIVE_AGGREGATE';
  paymentVersion: number;
  baseAmount: PaymentPositiveMoneyDto;
}

export interface PaymentApprovalSnapshotView {
  id: string;
  documentVersion: number;
  amountBasis: PaymentPositiveMoneyDto;
  evaluatedAt: string;
  policyContexts: PaymentApprovalPolicyContextView[];
  steps: PaymentApprovalSnapshotStepView[];
  actions: PaymentApprovalActionView[];
  paymentAggregation?: {
    businessDate: string;
    keys: Array<'BENEFICIARY' | 'EXTERNAL_OBLIGATION'>;
    participants: PaymentApprovalAggregationParticipantView[];
  };
  state: 'PENDING' | 'APPROVED' | 'REJECTED' | 'RETURNED';
}

export interface PaymentRequestView {
  id: string;
  organizationId: string;
  organization: PaymentSemanticRef;
  businessNumber: string;
  requesterUserId: string;
  requester: PaymentSemanticRef;
  beneficiaryPartyId: string;
  beneficiary: PaymentSemanticRef;
  requestedMoney: PaymentPositiveMoneyDto;
  branchId?: string;
  branch?: PaymentSemanticRef;
  treasuryUnitId?: string;
  treasuryUnit?: PaymentSemanticRef;
  dueDate?: string;
  purpose: string;
  contractRef?: string;
  invoiceRef?: string;
  accountingDimensions?: PaymentAccountingDimensionsDto;
  attachments?: PaymentEvidenceRef[];
  approvalProgress: { state: 'NOT_STARTED'; completedSteps: 0; requiredSteps: 0 };
  state: 'DRAFT';
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentLineView {
  id: string;
  lineNumber: number;
  methodId: string;
  method: PaymentSemanticRef;
  methodBehaviorCategory: MethodBehaviorCategory;
  methodRequiredReferences: MethodReference[];
  requiresApproval: boolean;
  money: PaymentPositiveMoneyDto;
  baseAmount: PaymentPositiveMoneyDto;
  rateSnapshot: PaymentRateSnapshot;
  rateRecord?: PaymentSemanticRef;
  cashboxId?: string;
  cashbox?: PaymentSemanticRef;
  bankAccountId?: string;
  bankAccount?: PaymentSemanticRef;
  beneficiaryPartyId: string;
  beneficiary: PaymentSemanticRef;
  beneficiaryAccountReference?: string;
  trackingNumber?: string;
  dueDate?: string;
  description?: string;
  accountingDimensions?: PaymentAccountingDimensionsDto;
  attachments?: PaymentEvidenceRef[];
  state: 'DRAFT';
  version: number;
}

export interface PaymentView {
  id: string;
  organizationId: string;
  organization: PaymentSemanticRef;
  businessNumber: string;
  businessDate: string;
  beneficiaryPartyId: string;
  beneficiary: PaymentSemanticRef;
  paymentRequestId?: string;
  paymentRequest?: PaymentSemanticRef;
  branchId?: string;
  branch?: PaymentSemanticRef;
  treasuryUnitId: string;
  treasuryUnit: PaymentSemanticRef;
  baseCurrency: string;
  baseCurrencyRef: PaymentSemanticRef;
  purpose: string;
  dueDate?: string;
  creatorUserId: string;
  creator: PaymentSemanticRef;
  totalBaseAmount: PaymentPositiveMoneyDto;
  lines: PaymentLineView[];
  approvalSnapshot?: PaymentApprovalSnapshotView;
  state: 'DRAFT' | 'SUBMITTED' | 'APPROVAL_PENDING' | 'APPROVED' | 'REJECTED';
  workflowState: 'DRAFT' | 'SUBMITTED' | 'APPROVAL_PENDING' | 'APPROVED' | 'REJECTED';
  executionState: 'NOT_EXECUTED';
  accountingState: 'NOT_READY';
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentPage {
  items: PaymentView[];
  page: { limit: number; hasMore: boolean; nextCursor?: string; asOf: string };
}
