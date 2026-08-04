import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export const CANON_PERMISSIONS = [
  'access-control.view',
  'access-grant.manage',
  'accounting.acknowledge',
  'accounting.export',
  'accounting.import',
  'approval-policy.manage',
  'auth.login',
  'auth.logout',
  'auth.verify-totp',
  'bank-account.manage',
  'bank-account.view',
  'bank-branch.manage',
  'bank-branch.view',
  'bank-instruction.record-outcome',
  'bank-reconciliation.confirm',
  'bank-reconciliation.match',
  'bank-reconciliation.view',
  'bank-statement.import',
  'bank-type.manage',
  'bank-type.view',
  'bank.manage',
  'bank.view',
  'cashbox.close',
  'cashbox.handover',
  'cashbox.manage',
  'cashbox.reopen',
  'cashbox.view',
  'cheque-book.manage',
  'cheque.transition',
  'collection.view',
  'delegation.manage',
  'identity-account.manage',
  'master-data.manage',
  'master-data.view',
  'notification-endpoint.manage',
  'notification-endpoint.view',
  'party.manage',
  'party.view',
  'payment-gateway.manage',
  'payment-gateway.view',
  'payment-request.create',
  'payment.approve',
  'payment.create',
  'payment.execute',
  'payment.reject',
  'payment.reverse',
  'payment.submit',
  'payment.view',
  'petty-cash.create',
  'petty-cash.view',
  'pos-terminal.manage',
  'pos-terminal.view',
  'print-template.manage',
  'print-template.view',
  'receipt.approve',
  'receipt.create',
  'receipt.edit-draft',
  'receipt.execute',
  'receipt.reverse',
  'receipt.submit',
  'receipt.view',
  'report.view',
  'role.manage',
  'separation.override',
  'settlement.confirm',
  'settlement.create',
  'settlement.reverse',
  'settlement.view',
  'transfer.approve',
  'transfer.create',
  'transfer.reject',
  'transfer.receive',
  'transfer.release',
  'transfer.submit',
  'transfer.view',
] as const;

export const PRIVILEGED_PERMISSIONS = [
  'access-grant.manage',
  'approval-policy.manage',
  'cashbox.reopen',
  'cheque.transition',
  'delegation.manage',
  'identity-account.manage',
  'payment.execute',
  'payment.reverse',
  'receipt.reverse',
  'role.manage',
  'separation.override',
  'settlement.reverse',
] as const;

export const METHOD_CATEGORIES = [
  'CASH',
  'CHEQUE',
  'BANK_TRANSFER',
  'DIRECT_DEPOSIT',
  'POS',
  'GATEWAY',
  'CARD_TRANSFER',
  'WALLET',
  'OFFSET',
  'FOREIGN_REMITTANCE',
  'OTHER_CONTROLLED',
] as const;

export const APPROVAL_SEPARATION_RULES = [
  'REQUESTER_NOT_APPROVER',
  'CREATOR_NOT_APPROVER',
  'CREATOR_NOT_EXECUTOR',
  'APPROVER_NOT_EXECUTOR',
  'SOURCE_CUSTODIAN_NOT_APPROVER',
  'CUSTODIAN_NOT_RECONCILER',
  'EXECUTOR_NOT_ACCOUNTING_EXPORTER',
] as const;

export const APPROVAL_AGGREGATION_KEYS = ['BENEFICIARY', 'EXTERNAL_OBLIGATION'] as const;

export class RoleCreateDto {
  @IsString() @Matches(/^[A-Z][A-Z0-9_-]{1,63}$/u) code!: string;
  @IsString() @MinLength(1) @MaxLength(160) name!: string;
  @IsArray() @ArrayMinSize(1) @ArrayUnique()
  @IsIn(CANON_PERMISSIONS as readonly string[], { each: true })
  permissions!: string[];
}

export class GrantMoneyDto {
  @IsString()
  @Matches(/^(0\.0*[1-9][0-9]*|[1-9][0-9]*(\.[0-9]{1,12})?)$/u)
  amount!: string;

  @IsString() @Matches(/^[A-Z0-9]{3,8}$/u) currency!: string;
}

export class GrantScopeDto {
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayUnique()
  @IsUUID('all', { each: true })
  branchIds?: string[];

  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayUnique()
  @IsUUID('all', { each: true })
  treasuryUnitIds?: string[];

  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayUnique()
  @IsUUID('all', { each: true })
  cashboxIds?: string[];

  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayUnique()
  @IsUUID('all', { each: true })
  bankAccountIds?: string[];

  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayUnique()
  @IsString({ each: true }) @MinLength(1, { each: true }) @MaxLength(64, { each: true })
  documentTypes?: string[];

  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayUnique()
  @IsIn(METHOD_CATEGORIES as readonly string[], { each: true })
  methodCategories?: string[];

  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayUnique()
  @Matches(/^[A-Z0-9]{3,8}$/u, { each: true })
  currencies?: string[];

  @IsOptional() @ValidateNested() @Type(() => GrantMoneyDto)
  amountCeiling?: GrantMoneyDto;
}

export class AccessGrantCreateDto {
  @IsUUID() userId!: string;
  @IsUUID() roleId!: string;

  @IsDefined() @IsBoolean()
  organizationWide!: boolean;

  @IsOptional() @ValidateNested() @Type(() => GrantScopeDto)
  scope?: GrantScopeDto;

  @IsOptional() @IsISO8601({ strict: true }) validFrom?: string;
  @IsOptional() @IsISO8601({ strict: true }) validTo?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(500) reason?: string;
}

export class ApprovalPolicyScopeDto {
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsUUID() treasuryUnitId?: string;
  @IsOptional() @Matches(/^[A-Z0-9]{3,8}$/u) currency?: string;
  @IsOptional() @IsIn(METHOD_CATEGORIES as readonly string[]) methodCategory?: string;
  @IsOptional() @Matches(/^(0|[1-9][0-9]{0,29})(\.[0-9]{1,8})?$/u) minimumBaseAmount?: string;
  @IsOptional() @Matches(/^(0|[1-9][0-9]{0,29})(\.[0-9]{1,8})?$/u) maximumBaseAmount?: string;
}

export class ApprovalPolicyStepDto {
  @IsInt() @Min(1) order!: number;
  @IsOptional() @IsUUID() roleId?: string;
  @IsOptional() @IsUUID() approverUserId?: string;
  @IsInt() @Min(1) approvalsRequired!: number;
}

export class ApprovalPaymentAggregationDto {
  @IsIn(['BUSINESS_DATE']) windowKind!: 'BUSINESS_DATE';
  @IsArray() @ArrayMinSize(1) @ArrayUnique()
  @IsIn(APPROVAL_AGGREGATION_KEYS as readonly string[], { each: true })
  keys!: string[];
  @IsDefined() @IsBoolean() overrideRequiresSecondApproval!: boolean;
}

export class ApprovalPolicyCreateDto {
  @IsString() @Matches(/^[A-Z][A-Z0-9_-]{1,63}$/u) code!: string;
  @IsString() @MinLength(1) @MaxLength(64) documentType!: string;
  @IsDefined() @IsBoolean() organizationWide!: boolean;
  @IsOptional() @ValidateNested() @Type(() => ApprovalPolicyScopeDto)
  scope?: ApprovalPolicyScopeDto;
  @IsArray() @ArrayUnique((step: ApprovalPolicyStepDto) => step.order)
  @ValidateNested({ each: true }) @Type(() => ApprovalPolicyStepDto)
  steps!: ApprovalPolicyStepDto[];
  @IsOptional() @IsArray() @ArrayUnique()
  @IsIn(APPROVAL_SEPARATION_RULES as readonly string[], { each: true })
  separationRules?: string[];
  @IsOptional() @ValidateNested() @Type(() => ApprovalPaymentAggregationDto)
  paymentAggregation?: ApprovalPaymentAggregationDto;
}

export class DelegationScopeDto {
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsUUID() treasuryUnitId?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(64) documentType?: string;
  @IsOptional() @IsIn(METHOD_CATEGORIES as readonly string[]) methodCategory?: string;
  @IsOptional() @Matches(/^[A-Z0-9]{3,8}$/u) currency?: string;
  @IsOptional() @ValidateNested() @Type(() => GrantMoneyDto) amountCeiling?: GrantMoneyDto;
}

export class DelegationCreateDto {
  @IsUUID() accessGrantId!: string;
  @IsUUID() delegateUserId!: string;
  @IsDefined() @ValidateNested() @Type(() => DelegationScopeDto) scope!: DelegationScopeDto;
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
  @IsISO8601({ strict: true }) validFrom!: string;
  @IsISO8601({ strict: true }) validTo!: string;
}

export enum SessionRevokeScope {
  CURRENT = 'CURRENT',
  ALL_FOR_ACCOUNT = 'ALL_FOR_ACCOUNT',
  ONE_SESSION = 'ONE_SESSION',
}

export class SessionRevokeDto {
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
  @IsIn(Object.values(SessionRevokeScope)) scope!: SessionRevokeScope;
  @IsOptional() @IsUUID() sessionId?: string;
}

export interface CanonicalGrantScope {
  branchIds: string[];
  treasuryUnitIds: string[];
  cashboxIds: string[];
  bankAccountIds: string[];
  documentTypes: string[];
  methodCategories: string[];
  currencies: string[];
  amountCeiling?: { amount: string; currency: string };
}

export interface GrantAuthorization {
  organizationWide: boolean;
  scope: CanonicalGrantScope;
  validFrom: Date;
  validTo: Date | null;
}
