import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsDateString,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

const CURRENCY = /^[A-Z0-9]{3,8}$/u;
const POSITIVE_DECIMAL = /^(?:0\.0*[1-9][0-9]*|[1-9][0-9]*(?:\.[0-9]{1,12})?)$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

export enum TransferEndpointType {
  CASHBOX = 'CASHBOX',
  BANK_ACCOUNT = 'BANK_ACCOUNT',
  USER = 'USER',
}

export enum TransferRoute {
  CASHBOX_TO_CASHBOX = 'CASHBOX_TO_CASHBOX',
  CASHBOX_TO_BANK = 'CASHBOX_TO_BANK',
  BANK_TO_CASHBOX = 'BANK_TO_CASHBOX',
  BANK_TO_BANK = 'BANK_TO_BANK',
  CASHBOX_TO_USER = 'CASHBOX_TO_USER',
  USER_TO_CASHBOX = 'USER_TO_CASHBOX',
  USER_TO_USER = 'USER_TO_USER',
  BRANCH_TRANSFER = 'BRANCH_TRANSFER',
  CURRENCY_EXCHANGE = 'CURRENCY_EXCHANGE',
  PETTY_CASH = 'PETTY_CASH',
}

export enum TransferAssetType {
  RECEIVED_CHEQUE = 'RECEIVED_CHEQUE',
  ISSUED_CHEQUE = 'ISSUED_CHEQUE',
  DOCUMENT = 'DOCUMENT',
  OTHER_CONTROLLED = 'OTHER_CONTROLLED',
}

export class TransferMoneyDto {
  @IsString() @Matches(POSITIVE_DECIMAL) amount!: string;
  @IsString() @Matches(CURRENCY) currency!: string;
}

export class TransferEndpointDto {
  @IsEnum(TransferEndpointType) type!: TransferEndpointType;
  @IsUUID() id!: string;
}

export class TransferAssetDto {
  @IsEnum(TransferAssetType) type!: TransferAssetType;
  @IsUUID() id!: string;
  @IsOptional() @IsString() @Matches(POSITIVE_DECIMAL) quantity?: string;
}

export class TransferAttachmentDto {
  @IsUUID() id!: string;
  @IsString() @Matches(DIGEST) contentDigest!: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(64) purpose?: string;
}

export class TransferCreateDto {
  @IsDateString({ strict: true }) @Matches(DATE) businessDate!: string;
  @IsEnum(TransferRoute) route!: TransferRoute;
  @ValidateNested() @Type(() => TransferEndpointDto) source!: TransferEndpointDto;
  @ValidateNested() @Type(() => TransferEndpointDto) destination!: TransferEndpointDto;
  @ValidateNested() @Type(() => TransferMoneyDto) sourceMoney!: TransferMoneyDto;
  @IsString() @Matches(CURRENCY) destinationCurrency!: string;
  @IsOptional() @IsDateString({ strict: true }) expectedReceiptAt?: string;
  @IsString() @MinLength(1) @MaxLength(1000) purpose!: string;
  @IsOptional() @IsObject() accountingDimensions?: Record<string, never>;
  @IsOptional() @IsArray()
  @ArrayUnique((item: TransferAssetDto) => `${item.type}:${item.id}`)
  @ValidateNested({ each: true }) @Type(() => TransferAssetDto)
  assets?: TransferAssetDto[];
  @IsOptional() @IsArray()
  @ArrayUnique((item: TransferAttachmentDto) => item.id)
  @ValidateNested({ each: true }) @Type(() => TransferAttachmentDto)
  attachments?: TransferAttachmentDto[];
}

export enum TransferApprovalAction {
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
}

export class TransferApprovalActionDto {
  @IsEnum(TransferApprovalAction) action!: TransferApprovalAction;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(500) reason?: string;
}

export interface TransferSemanticRef { id: string; label: string }
export interface TransferEndpointView extends TransferEndpointDto { resource: TransferSemanticRef }
export interface TransferRateSnapshot {
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
export interface TransferAssetView {
  type: TransferAssetType;
  id: string;
  asset: TransferSemanticRef;
  quantity: string;
  state: 'PLANNED' | 'RELEASED' | 'RECEIVED' | 'RETURNED';
}
export interface TransferEvidenceRef {
  attachmentId: string;
  attachment: TransferSemanticRef;
  digest: string;
  purpose?: string;
}
export interface TransferApprovalStepView {
  order: number;
  roleId?: string;
  role?: TransferSemanticRef;
  approverUserId?: string;
  approver?: TransferSemanticRef;
  approvalsRequired: number;
  approvalsRecorded: number;
  separationRules: string[];
  sourceContextOrders: [1];
  state: 'WAITING' | 'CURRENT' | 'APPROVED' | 'REJECTED';
}
export interface TransferApprovalActionView {
  id: string;
  approvalSnapshotId: string;
  approvalSnapshotStepId: string;
  stepOrder: number;
  actorUserId: string;
  actor: TransferSemanticRef;
  delegatedFromUserId?: string;
  delegatedFrom?: TransferSemanticRef;
  action: 'APPROVED' | 'REJECTED';
  reason?: string;
  actedAt: string;
}
export interface TransferApprovalSnapshotView {
  id: string;
  documentVersion: number;
  amountBasis: TransferMoneyDto;
  evaluatedAt: string;
  policyContexts: Array<{
    order: 1;
    currency: string;
    policyId: string;
    policy: TransferSemanticRef;
    policyVersion: number;
  }>;
  steps: TransferApprovalStepView[];
  actions: TransferApprovalActionView[];
  state: 'PENDING' | 'APPROVED' | 'REJECTED';
}
export interface TransferView {
  id: string;
  organizationId: string;
  organization: TransferSemanticRef;
  businessNumber: string;
  businessDate: string;
  route: TransferRoute;
  source: TransferEndpointView;
  destination: TransferEndpointView;
  sourceMoney: TransferMoneyDto;
  destinationMoney: TransferMoneyDto;
  rateSnapshot: TransferRateSnapshot;
  rateRecord?: TransferSemanticRef;
  expectedReceiptAt?: string;
  purpose: string;
  accountingDimensions?: Record<string, never>;
  creatorUserId: string;
  creator: TransferSemanticRef;
  sourceCustodianUserId?: string;
  sourceCustodian?: TransferSemanticRef;
  destinationCustodianUserId?: string;
  destinationCustodian?: TransferSemanticRef;
  approvalSnapshot?: TransferApprovalSnapshotView;
  assets: TransferAssetView[];
  attachments: TransferEvidenceRef[];
  state: 'DRAFT' | 'REQUESTED' | 'APPROVED' | 'REJECTED';
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface TransferPage {
  items: TransferView[];
  page: { limit: number; hasMore: boolean; nextCursor?: string; asOf: string };
}
