import { Inject, Injectable } from '@nestjs/common';

import type { DatabaseTransaction } from '../database/database.service';
import { AccessAuthorizationRepository } from './access-authorization.repository';

@Injectable()
export class AccessAuthorizationService {
  constructor(
    @Inject(AccessAuthorizationRepository)
    private readonly repository: AccessAuthorizationRepository,
  ) {}

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
