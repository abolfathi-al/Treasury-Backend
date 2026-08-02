import { Inject, Injectable } from '@nestjs/common';

import { digest, stableJson } from '../common/http';
import type { DatabaseTransaction } from '../database/database.service';
import { AccessAuthorizationRepository } from './access-authorization.repository';
import type { PaymentAuthorizationContext, PaymentGrant } from './access-authorization.repository';

export interface PaymentAuthority {
  delegatedFromUserId?: string;
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
