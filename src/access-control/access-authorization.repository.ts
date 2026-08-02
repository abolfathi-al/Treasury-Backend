import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { DatabaseTransaction } from '../database/database.service';

export interface PaymentAuthorizationContext {
  branchId: string | null;
  treasuryUnitId: string | null;
  cashboxIds: string[];
  bankAccountIds: string[];
  currencies: string[];
  methodCategories: string[];
  documentType: 'PAYMENT_REQUEST' | 'PAYMENT' | 'TRANSFER';
  amount: string;
  amountCurrency: string;
}

export interface PaymentGrant {
  [key: string]: unknown;
  id: string;
  grantUserId: string;
  delegatedFromUserId: string | null;
  amountCeiling: string | null;
  amountCeilingCurrency: string | null;
  branchIds: string[];
  treasuryUnitIds: string[];
  cashboxIds: string[];
  bankAccountIds: string[];
  documentTypes: string[];
  methodCategories: string[];
  currencies: string[];
}

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

  async paymentGrants(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    permission: 'payment-request.create' | 'payment.create' | 'payment.submit'
      | 'payment.approve' | 'payment.reject' | 'payment.execute' | 'payment.reverse'
      | 'bank-instruction.record-outcome' | 'accounting.export' | 'accounting.acknowledge'
      | 'transfer.create' | 'transfer.submit' | 'transfer.approve' | 'transfer.reject',
    roleId?: string,
  ): Promise<PaymentGrant[]> {
    const result = await transaction.execute<PaymentGrant>(sql`
      SELECT ag.id,
             ag.user_ref_id AS "grantUserId",
             CASE WHEN ag.user_ref_id = ${actorUserId}
               THEN NULL ELSE ag.user_ref_id END AS "delegatedFromUserId",
             ag.amount_ceiling::text AS "amountCeiling",
             ag.amount_ceiling_currency AS "amountCeilingCurrency",
             ARRAY(SELECT s.branch_id::text FROM access_grant_branch_scopes s
                   WHERE s.access_grant_id = ag.id ORDER BY s.branch_id) AS "branchIds",
             ARRAY(SELECT s.treasury_unit_id::text FROM access_grant_treasury_unit_scopes s
                   WHERE s.access_grant_id = ag.id ORDER BY s.treasury_unit_id) AS "treasuryUnitIds",
             ARRAY(SELECT s.cashbox_id::text FROM access_grant_cashbox_scopes s
                   WHERE s.access_grant_id = ag.id ORDER BY s.cashbox_id) AS "cashboxIds",
             ARRAY(SELECT s.bank_account_id::text FROM access_grant_bank_account_scopes s
                   WHERE s.access_grant_id = ag.id ORDER BY s.bank_account_id) AS "bankAccountIds",
             ARRAY(SELECT s.document_type FROM access_grant_document_type_scopes s
                   WHERE s.access_grant_id = ag.id ORDER BY s.document_type) AS "documentTypes",
             ARRAY(SELECT s.method_category FROM access_grant_method_category_scopes s
                   WHERE s.access_grant_id = ag.id ORDER BY s.method_category) AS "methodCategories",
             ARRAY(SELECT s.currency FROM access_grant_currency_scopes s
                   WHERE s.access_grant_id = ag.id ORDER BY s.currency) AS currencies
      FROM access_grants ag
      JOIN roles r ON r.id = ag.role_id AND r.state = 'ACTIVE'
      JOIN role_permissions rp ON rp.role_id = r.id AND rp.permission = ${permission}
      WHERE ag.organization_id = ${organizationId}
        AND (
          ag.user_ref_id = ${actorUserId}
          OR EXISTS (
            SELECT 1 FROM delegations d
            WHERE d.organization_id = ag.organization_id
              AND d.access_grant_id = ag.id
              AND d.grantor_user_id = ag.user_ref_id
              AND d.delegate_user_id = ${actorUserId}
              AND d.revoked_at IS NULL
              AND d.valid_from <= now()
              AND d.valid_to > now()
          )
        )
        AND (${roleId ?? null}::uuid IS NULL OR ag.role_id = ${roleId ?? null}::uuid)
        AND ag.state = 'ACTIVE'
        AND ag.valid_from <= now()
        AND (ag.valid_to IS NULL OR ag.valid_to > now())
      ORDER BY ag.id
    `);
    return result.rows;
  }

  async visiblePaymentIds(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    limit: number,
    cursor?: { businessDate: string; id: string },
    from?: string,
    to?: string,
  ): Promise<string[]> {
    const result = await transaction.execute<{ id: string }>(sql`
      SELECT pd.id
      FROM payment_documents pd
      JOIN treasury_units tu
        ON tu.organization_id = pd.organization_id
       AND tu.id = pd.treasury_unit_id
      WHERE pd.organization_id = ${organizationId}
        AND (${from ?? null}::date IS NULL OR pd.business_date >= ${from ?? null}::date)
        AND (${to ?? null}::date IS NULL OR pd.business_date <= ${to ?? null}::date)
        AND (
          ${cursor?.businessDate ?? null}::date IS NULL
          OR (pd.business_date, pd.id) < (
            ${cursor?.businessDate ?? null}::date,
            ${cursor?.id ?? null}::uuid
          )
        )
        AND EXISTS (
          SELECT 1
          FROM access_grants ag
          JOIN roles r ON r.id = ag.role_id AND r.state = 'ACTIVE'
          JOIN role_permissions rp ON rp.role_id = r.id AND rp.permission = 'payment.view'
          WHERE ag.organization_id = pd.organization_id
            AND ag.user_ref_id = ${actorUserId}
            AND ag.state = 'ACTIVE'
            AND ag.valid_from <= now()
            AND (ag.valid_to IS NULL OR ag.valid_to > now())
            AND (
              NOT EXISTS (SELECT 1 FROM access_grant_branch_scopes s WHERE s.access_grant_id = ag.id)
              OR (COALESCE(pd.branch_id, tu.branch_id) IS NOT NULL AND EXISTS (
                SELECT 1 FROM access_grant_branch_scopes s
                WHERE s.access_grant_id = ag.id
                  AND s.branch_id = COALESCE(pd.branch_id, tu.branch_id)
              ))
            )
            AND (
              NOT EXISTS (SELECT 1 FROM access_grant_treasury_unit_scopes s WHERE s.access_grant_id = ag.id)
              OR EXISTS (
                SELECT 1 FROM access_grant_treasury_unit_scopes s
                WHERE s.access_grant_id = ag.id AND s.treasury_unit_id = pd.treasury_unit_id
              )
            )
            AND (
              NOT EXISTS (SELECT 1 FROM access_grant_document_type_scopes s WHERE s.access_grant_id = ag.id)
              OR EXISTS (
                SELECT 1 FROM access_grant_document_type_scopes s
                WHERE s.access_grant_id = ag.id AND s.document_type = 'PAYMENT'
              )
            )
            AND (
              NOT EXISTS (SELECT 1 FROM access_grant_cashbox_scopes s WHERE s.access_grant_id = ag.id)
              OR EXISTS (
                SELECT 1 FROM payment_lines pl
                JOIN access_grant_cashbox_scopes s
                  ON s.access_grant_id = ag.id AND s.cashbox_id = pl.cashbox_id
                WHERE pl.organization_id = pd.organization_id
                  AND pl.payment_document_id = pd.id
              )
            )
            AND (
              NOT EXISTS (SELECT 1 FROM access_grant_bank_account_scopes s WHERE s.access_grant_id = ag.id)
              OR EXISTS (
                SELECT 1 FROM payment_lines pl
                JOIN access_grant_bank_account_scopes s
                  ON s.access_grant_id = ag.id AND s.bank_account_id = pl.bank_account_id
                WHERE pl.organization_id = pd.organization_id
                  AND pl.payment_document_id = pd.id
              )
            )
            AND (
              NOT EXISTS (SELECT 1 FROM access_grant_currency_scopes s WHERE s.access_grant_id = ag.id)
              OR EXISTS (
                SELECT 1 FROM access_grant_currency_scopes s
                WHERE s.access_grant_id = ag.id AND s.currency = pd.base_currency
              )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM payment_lines pl
              WHERE pl.organization_id = pd.organization_id
                AND pl.payment_document_id = pd.id
                AND (
                  (pl.cashbox_id IS NOT NULL
                    AND EXISTS (SELECT 1 FROM access_grant_cashbox_scopes s WHERE s.access_grant_id = ag.id)
                    AND NOT EXISTS (SELECT 1 FROM access_grant_cashbox_scopes s
                                    WHERE s.access_grant_id = ag.id AND s.cashbox_id = pl.cashbox_id))
                  OR
                  (pl.bank_account_id IS NOT NULL
                    AND EXISTS (SELECT 1 FROM access_grant_bank_account_scopes s WHERE s.access_grant_id = ag.id)
                    AND NOT EXISTS (SELECT 1 FROM access_grant_bank_account_scopes s
                                    WHERE s.access_grant_id = ag.id AND s.bank_account_id = pl.bank_account_id))
                  OR
                  (EXISTS (SELECT 1 FROM access_grant_method_category_scopes s WHERE s.access_grant_id = ag.id)
                    AND NOT EXISTS (SELECT 1 FROM access_grant_method_category_scopes s
                                    WHERE s.access_grant_id = ag.id AND s.method_category = pl.method_category))
                  OR
                  (EXISTS (SELECT 1 FROM access_grant_currency_scopes s WHERE s.access_grant_id = ag.id)
                    AND NOT EXISTS (SELECT 1 FROM access_grant_currency_scopes s
                                    WHERE s.access_grant_id = ag.id AND s.currency = pl.currency))
                )
            )
        )
      ORDER BY pd.business_date DESC, pd.id DESC
      LIMIT ${limit}
    `);
    return result.rows.map(({ id }) => id);
  }

  async visibleAccountingExportIds(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    limit: number,
    cursor?: { createdAt: string; id: string },
  ): Promise<string[]> {
    const result = await transaction.execute<{ id: string }>(sql`
      SELECT ae.id
      FROM accounting_exports ae
      WHERE ae.organization_id = ${organizationId}
        AND ae.source_type = 'PAYMENT'
        AND ae.exported_by <> ${actorUserId}
        AND ae.state IN ('QUEUED', 'SENDING', 'SENDING_UNKNOWN', 'ACCEPTED')
        AND (
          ${cursor?.createdAt ?? null}::timestamptz IS NULL
          OR (ae.created_at, ae.id) < (
            ${cursor?.createdAt ?? null}::timestamptz,
            ${cursor?.id ?? null}::uuid
          )
        )
        AND EXISTS (
          SELECT 1
          FROM access_grants ag
          JOIN roles r ON r.id = ag.role_id AND r.state = 'ACTIVE'
          JOIN role_permissions rp
            ON rp.role_id = r.id AND rp.permission = 'accounting.acknowledge'
          WHERE ag.organization_id = ae.organization_id
            AND (
              ag.user_ref_id = ${actorUserId}
              OR EXISTS (
                SELECT 1 FROM delegations d
                WHERE d.organization_id = ag.organization_id
                  AND d.access_grant_id = ag.id
                  AND d.grantor_user_id = ag.user_ref_id
                  AND d.delegate_user_id = ${actorUserId}
                  AND d.revoked_at IS NULL
                  AND d.valid_from <= now()
                  AND d.valid_to > now()
              )
            )
            AND ag.state = 'ACTIVE'
            AND ag.valid_from <= now()
            AND (ag.valid_to IS NULL OR ag.valid_to > now())
            AND (
              NOT EXISTS (SELECT 1 FROM access_grant_branch_scopes s WHERE s.access_grant_id = ag.id)
              OR (ae.branch_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM access_grant_branch_scopes s
                WHERE s.access_grant_id = ag.id AND s.branch_id = ae.branch_id
              ))
            )
            AND (
              NOT EXISTS (SELECT 1 FROM access_grant_treasury_unit_scopes s WHERE s.access_grant_id = ag.id)
              OR (ae.treasury_unit_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM access_grant_treasury_unit_scopes s
                WHERE s.access_grant_id = ag.id AND s.treasury_unit_id = ae.treasury_unit_id
              ))
            )
            AND (
              NOT EXISTS (SELECT 1 FROM access_grant_document_type_scopes s WHERE s.access_grant_id = ag.id)
              OR EXISTS (
                SELECT 1 FROM access_grant_document_type_scopes s
                WHERE s.access_grant_id = ag.id AND s.document_type = ae.document_type
              )
            )
            AND (
              ag.amount_ceiling IS NULL
              OR (
                ag.amount_ceiling_currency = ae.base_currency
                AND ae.aggregate_base_amount <= ag.amount_ceiling
              )
            )
        )
      ORDER BY ae.created_at DESC, ae.id DESC
      LIMIT ${limit}
    `);
    return result.rows.map(({ id }) => id);
  }
}
