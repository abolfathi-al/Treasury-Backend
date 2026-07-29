import { Inject, Injectable } from '@nestjs/common';

import type { DatabaseTransaction } from '../database/database.service';
import { AccessAuthorizationRepository } from './access-authorization.repository';

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
}
