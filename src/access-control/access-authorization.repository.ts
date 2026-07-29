import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { DatabaseTransaction } from '../database/database.service';

@Injectable()
export class AccessAuthorizationRepository {
  async canOperateReceipt(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    receiptId: string,
    permission: 'receipt.execute' | 'receipt.reverse',
  ): Promise<boolean> {
    const result = await transaction.execute<{ allowed: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
        FROM access_grants ag
        JOIN roles r ON r.id = ag.role_id AND r.state = 'ACTIVE'
        JOIN role_permissions rp ON rp.role_id = r.id AND rp.permission = ${permission}
        JOIN receipt_documents rd
          ON rd.organization_id = ag.organization_id AND rd.id = ${receiptId}
        WHERE ag.organization_id = ${organizationId}
          AND ag.user_ref_id = ${actorUserId}
          AND ag.state = 'ACTIVE'
          AND ag.valid_from <= now()
          AND (ag.valid_to IS NULL OR ag.valid_to > now())
          AND (
            ag.amount_ceiling IS NULL
            OR (
              ag.amount_ceiling_currency = rd.base_currency
              AND ag.amount_ceiling >= rd.total_base_amount
            )
          )
          AND (
            NOT EXISTS (SELECT 1 FROM access_grant_branch_scopes s WHERE s.access_grant_id = ag.id)
            OR (
              rd.branch_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM access_grant_branch_scopes s
                WHERE s.access_grant_id = ag.id AND s.branch_id = rd.branch_id
              )
            )
          )
          AND (
            NOT EXISTS (
              SELECT 1 FROM access_grant_treasury_unit_scopes s WHERE s.access_grant_id = ag.id
            )
            OR EXISTS (
              SELECT 1 FROM access_grant_treasury_unit_scopes s
              WHERE s.access_grant_id = ag.id AND s.treasury_unit_id = rd.treasury_unit_id
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM receipt_lines rl
            LEFT JOIN pos_terminals pos
              ON pos.organization_id = rl.organization_id
                AND pos.id = rl.pos_terminal_id
            LEFT JOIN payment_gateways gateway
              ON gateway.organization_id = rl.organization_id
                AND gateway.id = rl.payment_gateway_id
            WHERE rl.organization_id = rd.organization_id
              AND rl.receipt_document_id = rd.id
              AND (
                (
                  rl.cashbox_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM access_grant_cashbox_scopes s WHERE s.access_grant_id = ag.id
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM access_grant_cashbox_scopes s
                    WHERE s.access_grant_id = ag.id AND s.cashbox_id = rl.cashbox_id
                  )
                )
                OR (
                  COALESCE(
                    rl.bank_account_id,
                    pos.bank_account_id,
                    gateway.bank_account_id
                  ) IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM access_grant_bank_account_scopes s
                    WHERE s.access_grant_id = ag.id
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM access_grant_bank_account_scopes s
                    WHERE s.access_grant_id = ag.id
                      AND s.bank_account_id = COALESCE(
                        rl.bank_account_id,
                        pos.bank_account_id,
                        gateway.bank_account_id
                      )
                  )
                )
                OR (
                  EXISTS (
                    SELECT 1 FROM access_grant_method_category_scopes s
                    WHERE s.access_grant_id = ag.id
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM access_grant_method_category_scopes s
                    WHERE s.access_grant_id = ag.id
                      AND s.method_category = rl.method_category
                  )
                )
                OR (
                  EXISTS (
                    SELECT 1 FROM access_grant_currency_scopes s WHERE s.access_grant_id = ag.id
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM access_grant_currency_scopes s
                    WHERE s.access_grant_id = ag.id AND s.currency = rl.currency
                  )
                )
              )
          )
      ) AS allowed
    `);
    return result.rows[0]!.allowed;
  }

  async hasOrganizationPermission(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    permission: string,
  ): Promise<boolean> {
    const result = await transaction.execute<{ allowed: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
        FROM access_grants ag
        JOIN roles r ON r.id = ag.role_id AND r.state = 'ACTIVE'
        JOIN role_permissions rp ON rp.role_id = r.id AND rp.permission = ${permission}
        WHERE ag.organization_id = ${organizationId}
          AND ag.user_ref_id = ${actorUserId}
          AND ag.state = 'ACTIVE'
          AND ag.valid_from <= now()
          AND (ag.valid_to IS NULL OR ag.valid_to > now())
      ) AS allowed
    `);
    return result.rows[0]!.allowed;
  }

  async consumeStepUpProof(
    transaction: DatabaseTransaction,
    input: {
      proofDigest: string;
      physicalSessionId: string;
      method: string;
      path: string;
      bodyDigest: string;
      idempotencyKey: string;
    },
  ): Promise<boolean> {
    const result = await transaction.execute<{ id: string }>(sql`
      UPDATE auth_step_up_proofs p
      SET consumed_at = now()
      FROM auth_challenges c
      WHERE p.challenge_id = c.id
        AND p.token_digest = ${input.proofDigest}
        AND c.session_id = ${input.physicalSessionId}
        AND c.http_method = ${input.method}
        AND c.http_path = ${input.path}
        AND c.request_body_digest = ${input.bodyDigest}
        AND c.idempotency_key = ${input.idempotencyKey}
        AND p.expires_at > now()
        AND p.consumed_at IS NULL
      RETURNING p.id
    `);
    return result.rows.length === 1;
  }

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
