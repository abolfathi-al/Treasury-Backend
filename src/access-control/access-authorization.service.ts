import { Inject, Injectable } from '@nestjs/common';

import { digest, stableJson } from '../common/http';
import type { DatabaseTransaction } from '../database/database.service';
import { AccessAuthorizationRepository } from './access-authorization.repository';
import type { PaymentAuthorizationContext, PaymentGrant } from './access-authorization.repository';

export interface PaymentAuthority {
  delegatedFromUserId?: string;
}

export interface TransferAuthorizationContext {
  branchIds: string[];
  treasuryUnitIds: string[];
  cashboxIds: string[];
  bankAccountIds: string[];
  currencies: string[];
  amount: string;
  amountCurrency: string;
}

export interface SettlementAuthorizationContext {
  branchIds: string[];
  treasuryUnitIds: string[];
  bankAccountId: string;
  currency: string;
  amount: string;
}

export interface SettlementReadScope {
  grantIds: string[];
  fingerprint: string;
}

export interface CashboxAuthorizationContext {
  branchId: string | null;
  treasuryUnitId: string;
  cashboxIds: string[];
  bankAccountIds: string[];
  currencies: string[];
  amount?: string;
  amountCurrency?: string;
}

@Injectable()
export class AccessAuthorizationService {
  constructor(
    @Inject(AccessAuthorizationRepository)
    private readonly repository: AccessAuthorizationRepository,
  ) {}

  canOperateReceipt(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    receiptId: string,
    permission: 'receipt.execute' | 'receipt.reverse',
  ): Promise<boolean> {
    return this.repository.canOperateReceipt(
      transaction,
      organizationId,
      actorUserId,
      receiptId,
      permission,
    );
  }

  hasOrganizationPermission(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    permission: string,
  ): Promise<boolean> {
    return this.repository.hasOrganizationPermission(
      transaction,
      organizationId,
      actorUserId,
      permission,
    );
  }

  consumeStepUpProof(
    transaction: DatabaseTransaction,
    input: Parameters<AccessAuthorizationRepository['consumeStepUpProof']>[1],
  ): Promise<boolean> {
    return this.repository.consumeStepUpProof(transaction, input);
  }

  canCreateCashboxHandover(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    context: {
      cashboxId: string;
      branchId: string | null;
      treasuryUnitId: string | null;
    },
  ): Promise<boolean> {
    return this.repository.canCreateCashboxHandover(
      transaction,
      organizationId,
      actorUserId,
      context,
    );
  }

  async canOperateCashbox(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    context: CashboxAuthorizationContext,
    permission: 'cashbox.close' | 'cashbox.reopen' | 'cashbox.approve'
      | 'cashbox.reject' | 'petty-cash.create' | 'petty-cash.view',
  ): Promise<boolean> {
    const grants = await this.repository.paymentGrants(
      transaction,
      organizationId,
      actorUserId,
      permission,
    );
    return grants.some((grant) => (
      covers(grant.branchIds, context.branchId ? [context.branchId] : [])
      && covers(grant.treasuryUnitIds, [context.treasuryUnitId])
      && covers(grant.cashboxIds, context.cashboxIds)
      && covers(grant.bankAccountIds, context.bankAccountIds)
      && covers(grant.currencies, context.currencies)
      && grant.documentTypes.length === 0
      && grant.methodCategories.length === 0
      && (
        grant.amountCeiling === null
        || (
          context.amount !== undefined
          && context.amountCurrency === grant.amountCeilingCurrency
          && decimal(context.amount) <= decimal(grant.amountCeiling)
        )
      )
    ));
  }

  async canCreatePaymentRequest(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    context: PaymentAuthorizationContext,
  ): Promise<boolean> {
    return this.paymentAllowed(
      await this.repository.paymentGrants(
        transaction,
        organizationId,
        actorUserId,
        'payment-request.create',
      ),
      context,
    );
  }

  async canCreatePayment(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    context: PaymentAuthorizationContext,
  ): Promise<boolean> {
    return this.paymentAllowed(
      await this.repository.paymentGrants(
        transaction,
        organizationId,
        actorUserId,
        'payment.create',
      ),
      context,
    );
  }

  async canOperatePayment(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    context: PaymentAuthorizationContext,
    permission: 'payment.submit' | 'payment.approve' | 'payment.reject'
      | 'payment.execute' | 'payment.reverse' | 'bank-instruction.record-outcome'
      | 'accounting.export' | 'accounting.acknowledge',
    roleId?: string,
  ): Promise<boolean> {
    return !!this.paymentAuthority(
      await this.repository.paymentGrants(
        transaction,
        organizationId,
        actorUserId,
        permission,
        roleId,
      ),
      context,
    );
  }

  async canOperateAccounting(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    context: PaymentAuthorizationContext,
    permission: 'accounting.export' | 'accounting.acknowledge',
  ): Promise<boolean> {
    return !!this.paymentAuthority(
      await this.repository.paymentGrants(
        transaction,
        organizationId,
        actorUserId,
        permission,
      ),
      context,
      undefined,
      'ACCOUNTING',
    );
  }

  async accountingScopeFingerprint(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    permission: 'accounting.export' | 'accounting.acknowledge',
  ): Promise<string | undefined> {
    const grants = await this.repository.paymentGrants(
      transaction,
      organizationId,
      actorUserId,
      permission,
    );
    return grants.length ? digest(stableJson(grants)) : undefined;
  }

  async settlementReadScope(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
  ): Promise<SettlementReadScope | undefined> {
    const grants = await this.repository.paymentGrants(
      transaction,
      organizationId,
      actorUserId,
      'settlement.view',
    );
    return grants.length
      ? { grantIds: grants.map(({ id }) => id), fingerprint: digest(stableJson(grants)) }
      : undefined;
  }

  listVisibleAccountingExportIds(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    limit: number,
    cursor?: { createdAt: string; id: string },
  ): Promise<string[]> {
    return this.repository.visibleAccountingExportIds(
      transaction,
      organizationId,
      actorUserId,
      limit,
      cursor,
    );
  }

  async resolvePaymentAuthority(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    context: PaymentAuthorizationContext,
    permission: 'payment.submit' | 'payment.approve' | 'payment.reject'
      | 'payment.execute' | 'payment.reverse' | 'bank-instruction.record-outcome'
      | 'accounting.export' | 'accounting.acknowledge',
    roleId?: string,
    requiredAuthorityUserId?: string | null,
  ): Promise<PaymentAuthority | null> {
    return this.paymentAuthority(
      await this.repository.paymentGrants(
        transaction,
        organizationId,
        actorUserId,
        permission,
        roleId,
      ),
      context,
      requiredAuthorityUserId,
    );
  }

  listVisiblePaymentIds(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    limit: number,
    cursor?: { businessDate: string; id: string },
    from?: string,
    to?: string,
  ): Promise<string[]> {
    return this.repository.visiblePaymentIds(
      transaction,
      organizationId,
      actorUserId,
      limit,
      cursor,
      from,
      to,
    );
  }

  async resolveTransferAuthority(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    context: TransferAuthorizationContext,
    permission: 'transfer.create' | 'transfer.submit' | 'transfer.approve' | 'transfer.reject' | 'transfer.release' | 'transfer.receive',
    roleId?: string,
    requiredAuthorityUserId?: string | null,
  ): Promise<PaymentAuthority | null> {
    let grants = await this.repository.paymentGrants(
      transaction,
      organizationId,
      actorUserId,
      permission,
      roleId,
    );
    grants = grants.filter((grant) => (
      covers(grant.branchIds, context.branchIds)
      && covers(grant.treasuryUnitIds, context.treasuryUnitIds)
      && covers(grant.cashboxIds, context.cashboxIds)
      && covers(grant.bankAccountIds, context.bankAccountIds)
      && covers(grant.currencies, context.currencies)
      && covers(grant.documentTypes, ['TRANSFER'])
      && (
        grant.amountCeiling === null
        || (
          grant.amountCeilingCurrency === context.amountCurrency
          && decimal(context.amount) <= decimal(grant.amountCeiling)
        )
      )
    ));
    if (requiredAuthorityUserId) {
      grants = grants.filter(({ grantUserId }) => grantUserId === requiredAuthorityUserId);
    }
    if (grants.some(({ delegatedFromUserId }) => delegatedFromUserId === null)) return {};
    const grantors = [...new Set(grants.flatMap(({ delegatedFromUserId }) =>
      delegatedFromUserId ? [delegatedFromUserId] : []))];
    return grantors.length === 1 ? { delegatedFromUserId: grantors[0] } : null;
  }

  async resolveSettlementAuthority(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    context: SettlementAuthorizationContext,
    permission: 'settlement.create' | 'settlement.confirm' | 'settlement.reverse',
  ): Promise<PaymentAuthority | null> {
    const grants = (await this.repository.paymentGrants(
      transaction,
      organizationId,
      actorUserId,
      permission,
    )).filter((grant) => (
      covers(grant.branchIds, context.branchIds)
      && covers(grant.treasuryUnitIds, context.treasuryUnitIds)
      && covers(grant.bankAccountIds, [context.bankAccountId])
      && covers(grant.currencies, [context.currency])
      && (
        grant.amountCeiling === null
        || (
          grant.amountCeilingCurrency === context.currency
          && decimal(context.amount) <= decimal(grant.amountCeiling)
        )
      )
    ));
    if (grants.some(({ delegatedFromUserId }) => delegatedFromUserId === null)) return {};
    const grantors = [...new Set(grants.flatMap(({ delegatedFromUserId }) =>
      delegatedFromUserId ? [delegatedFromUserId] : []))];
    return grantors.length === 1 ? { delegatedFromUserId: grantors[0] } : null;
  }

  private paymentAllowed(grants: PaymentGrant[], context: PaymentAuthorizationContext): boolean {
    return !!this.paymentAuthority(grants, context);
  }

  private paymentAuthority(
    grants: PaymentGrant[],
    context: PaymentAuthorizationContext,
    requiredAuthorityUserId?: string | null,
    scopeProfile: 'PAYMENT' | 'ACCOUNTING' = 'PAYMENT',
  ): PaymentAuthority | null {
    let eligible = grants.filter((grant) => (
      covers(grant.branchIds, context.branchId ? [context.branchId] : [])
      && covers(grant.treasuryUnitIds, context.treasuryUnitId ? [context.treasuryUnitId] : [])
      && covers(grant.documentTypes, [context.documentType])
      && (scopeProfile === 'ACCOUNTING' || covers(grant.currencies, context.currencies))
      && (
        scopeProfile === 'ACCOUNTING'
        || context.documentType === 'PAYMENT_REQUEST'
        || (
          covers(grant.cashboxIds, context.cashboxIds)
          && covers(grant.bankAccountIds, context.bankAccountIds)
          && covers(grant.methodCategories, context.methodCategories)
        )
      )
      && (
        grant.amountCeiling === null
        || (
          grant.amountCeilingCurrency === context.amountCurrency
          && decimal(context.amount) <= decimal(grant.amountCeiling)
        )
      )
    ));
    if (requiredAuthorityUserId) {
      eligible = eligible.filter(({ grantUserId }) => grantUserId === requiredAuthorityUserId);
    }
    if (eligible.some(({ delegatedFromUserId }) => delegatedFromUserId === null)) return {};
    const grantors = [...new Set(eligible.flatMap(({ delegatedFromUserId }) =>
      delegatedFromUserId ? [delegatedFromUserId] : []))];
    return grantors.length === 1 ? { delegatedFromUserId: grantors[0] } : null;
  }
}

function covers(scope: string[], values: string[]): boolean {
  return scope.length === 0 || (values.length > 0 && values.every((value) => scope.includes(value)));
}

function decimal(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 1_000_000_000_000n + BigInt(fraction.padEnd(12, '0'));
}
