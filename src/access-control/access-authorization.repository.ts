import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { DatabaseTransaction } from '../database/database.service';

@Injectable()
export class AccessAuthorizationRepository {
  async canCreateCashboxHandover(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    context: {
      cashboxId: string;
      branchId: string | null;
      treasuryUnitId: string | null;
    },
  ): Promise<boolean> {
    const result = await transaction.execute<{ allowed: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
        FROM access_grants ag
        JOIN roles r ON r.id = ag.role_id AND r.state = 'ACTIVE'
        JOIN role_permissions rp ON rp.role_id = r.id AND rp.permission = 'cashbox.handover'
        WHERE ag.organization_id = ${organizationId}
          AND ag.user_ref_id = ${actorUserId}
          AND ag.state = 'ACTIVE'
          AND ag.valid_from <= now()
          AND (ag.valid_to IS NULL OR ag.valid_to > now())
          AND (
            NOT EXISTS (
              SELECT 1 FROM access_grant_cashbox_scopes s
              WHERE s.access_grant_id = ag.id
            )
            OR EXISTS (
              SELECT 1 FROM access_grant_cashbox_scopes s
              WHERE s.access_grant_id = ag.id AND s.cashbox_id = ${context.cashboxId}
            )
          )
          AND (
            NOT EXISTS (
              SELECT 1 FROM access_grant_branch_scopes s
              WHERE s.access_grant_id = ag.id
            )
            OR (
              ${context.branchId}::uuid IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM access_grant_branch_scopes s
                WHERE s.access_grant_id = ag.id AND s.branch_id = ${context.branchId}
              )
            )
          )
          AND (
            NOT EXISTS (
              SELECT 1 FROM access_grant_treasury_unit_scopes s
              WHERE s.access_grant_id = ag.id
            )
            OR (
              ${context.treasuryUnitId}::uuid IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM access_grant_treasury_unit_scopes s
                WHERE s.access_grant_id = ag.id
                  AND s.treasury_unit_id = ${context.treasuryUnitId}
              )
            )
          )
      ) AS allowed
    `);
    return result.rows[0]!.allowed;
  }
}
