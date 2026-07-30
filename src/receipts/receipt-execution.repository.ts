import { Injectable } from '@nestjs/common';
import {
  and,
  eq,
  InferSelectModel,
  sql,
} from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import type { DatabaseTransaction } from '../database/database.service';
import {
  idempotencyRecords,
  paymentGateways,
  posTerminals,
  receiptAllocations,
  receiptApprovalActions,
  receiptApprovalSnapshots,
  receiptDocuments,
  receiptExecutionEffects,
  receiptLines,
} from '../database/schema';
import type {
  ReceiptExecutionEffectType,
  ReceiptExecutionEffectView,
  ReceiptView,
} from './receipt.dto';

type ReceiptRow = InferSelectModel<typeof receiptDocuments>;
type ReceiptLineRow = InferSelectModel<typeof receiptLines>;
type ReceiptEffectRow = InferSelectModel<typeof receiptExecutionEffects>;

const EFFECT_LABELS: Record<ReceiptExecutionEffectType, string> = {
  CASHBOX_MOVEMENT: 'Cashbox movement',
  BANK_MOVEMENT: 'Bank account movement',
  RECEIVED_CHEQUE: 'Received cheque',
  COLLECTION_ITEM: 'Collection item',
};

export interface LockedReceipt {
  document: ReceiptRow;
  lines: Array<ReceiptLineRow & {
    effectiveBankAccountId: string | null;
  }>;
  approverUserIds: string[];
}

export interface StoredExecutionResult {
  receiptId: string;
  version: number;
  reversalReceiptId?: string;
  reversalReceiptVersion?: number;
  response?: ReceiptView;
  etag?: string;
}

@Injectable()
export class ReceiptExecutionRepository {
  async acquireIdempotencyLock(
    transaction: DatabaseTransaction,
    organizationId: string,
    scope: string,
    key: string,
  ): Promise<void> {
    await transaction.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtext(${organizationId}),
        hashtext(${scope + ':' + key})
      )
    `);
  }

  async findIdempotency(
    transaction: DatabaseTransaction,
    organizationId: string,
    scope: string,
    key: string,
  ): Promise<{ requestDigest: string; result: StoredExecutionResult | null } | undefined> {
    const rows = await transaction
      .select({
        requestDigest: idempotencyRecords.requestDigest,
        responseBody: idempotencyRecords.responseBody,
      })
      .from(idempotencyRecords)
      .where(and(
        eq(idempotencyRecords.organizationId, organizationId),
        eq(idempotencyRecords.scope, scope),
        eq(idempotencyRecords.idempotencyKey, key),
      ))
      .limit(1);
    const row = rows[0];
    return row
      ? {
        requestDigest: row.requestDigest,
        result: row.responseBody as StoredExecutionResult | null,
      }
      : undefined;
  }

  async startIdempotency(
    transaction: DatabaseTransaction,
    organizationId: string,
    scope: string,
    key: string,
    requestDigest: string,
  ): Promise<void> {
    await transaction.insert(idempotencyRecords).values({
      organizationId,
      scope,
      idempotencyKey: key,
      requestDigest,
    });
  }

  async finishIdempotency(
    transaction: DatabaseTransaction,
    organizationId: string,
    scope: string,
    key: string,
    status: number,
    result: StoredExecutionResult,
  ): Promise<void> {
    await transaction
      .update(idempotencyRecords)
      .set({ responseStatus: status, responseBody: { ...result } })
      .where(and(
        eq(idempotencyRecords.organizationId, organizationId),
        eq(idempotencyRecords.scope, scope),
        eq(idempotencyRecords.idempotencyKey, key),
      ));
  }

  async lockReceipt(
    transaction: DatabaseTransaction,
    organizationId: string,
    receiptId: string,
  ): Promise<LockedReceipt | undefined> {
    const documents = await transaction
      .select()
      .from(receiptDocuments)
      .where(and(
        eq(receiptDocuments.organizationId, organizationId),
        eq(receiptDocuments.id, receiptId),
      ))
      .for('update');
    const document = documents[0];
    if (!document) return undefined;

    const lines = await transaction
      .select({
        line: receiptLines,
        effectiveBankAccountId: sql<string | null>`
          COALESCE(
            ${receiptLines.bankAccountId},
            ${posTerminals.bankAccountId},
            ${paymentGateways.bankAccountId}
          )
        `.as('effective_bank_account_id'),
      })
      .from(receiptLines)
      .leftJoin(
        posTerminals,
        and(
          eq(posTerminals.organizationId, receiptLines.organizationId),
          eq(posTerminals.id, receiptLines.posTerminalId),
        ),
      )
      .leftJoin(
        paymentGateways,
        and(
          eq(paymentGateways.organizationId, receiptLines.organizationId),
          eq(paymentGateways.id, receiptLines.paymentGatewayId),
        ),
      )
      .where(and(
        eq(receiptLines.organizationId, organizationId),
        eq(receiptLines.receiptDocumentId, receiptId),
      ))
      .orderBy(receiptLines.lineNumber)
      .for('update', { of: receiptLines });

    const approvers = document.currentApprovalSnapshotId
      ? await transaction
        .select({ actorUserId: receiptApprovalActions.actorUserId })
        .from(receiptApprovalActions)
        .where(and(
          eq(receiptApprovalActions.organizationId, organizationId),
          eq(
            receiptApprovalActions.approvalSnapshotId,
            document.currentApprovalSnapshotId,
          ),
          eq(receiptApprovalActions.action, 'APPROVED'),
        ))
      : [];
    return {
      document,
      lines: lines.map(({ line, effectiveBankAccountId }) => ({
        ...line,
        effectiveBankAccountId,
      })),
      approverUserIds: approvers.map(({ actorUserId }) => actorUserId),
    };
  }

  async overrideApprovalValid(
    transaction: DatabaseTransaction,
    input: {
      organizationId: string;
      receipt: LockedReceipt;
      approvalActionId: string;
      reason: string;
      executorUserId: string;
      conflictingUserIds: string[];
    },
  ): Promise<'VALID' | 'INVALID_EVIDENCE' | 'NOT_INDEPENDENT'> {
    const rows = await transaction
      .select({
        actorUserId: receiptApprovalActions.actorUserId,
        reason: receiptApprovalActions.reason,
        approvalSnapshotId: receiptApprovalActions.approvalSnapshotId,
        action: receiptApprovalActions.action,
        documentVersion: receiptApprovalSnapshots.documentVersion,
      })
      .from(receiptApprovalActions)
      .innerJoin(
        receiptApprovalSnapshots,
        and(
          eq(receiptApprovalSnapshots.organizationId, receiptApprovalActions.organizationId),
          eq(receiptApprovalSnapshots.id, receiptApprovalActions.approvalSnapshotId),
        ),
      )
      .where(and(
        eq(receiptApprovalActions.organizationId, input.organizationId),
        eq(receiptApprovalActions.id, input.approvalActionId),
      ))
      .limit(1);
    const row = rows[0];
    if (
      !row
      || row.action !== 'APPROVED'
      || row.approvalSnapshotId !== input.receipt.document.currentApprovalSnapshotId
      || row.reason?.trim() !== input.reason.trim()
      || Number(row.documentVersion) > Number(input.receipt.document.version)
    ) return 'INVALID_EVIDENCE';
    if (
      row.actorUserId === input.executorUserId
      || input.conflictingUserIds.includes(row.actorUserId)
    ) return 'NOT_INDEPENDENT';
    return 'VALID';
  }

  async appendEffect(
    transaction: DatabaseTransaction,
    input: {
      organizationId: string;
      receiptLineId: string;
      effectKey: string;
      effectType: ReceiptExecutionEffectType;
      direction: 'INCOMING' | 'REVERSAL';
      amount: string;
      currency: string;
      businessDate: string;
      sourceVersion: number;
      movementFactId?: string;
      receivedChequeId?: string;
      chequeEventId?: string;
      collectionItemId?: string;
      collectionItemVersion?: number;
      collectionItemState?: 'RETURNED' | 'REOPENED_AFTER_REVERSAL';
      reversalOfEffectId?: string;
    },
  ): Promise<string> {
    const id = randomUUID();
    await transaction.insert(receiptExecutionEffects).values({ id, ...input });
    return id;
  }

  async effects(
    transaction: DatabaseTransaction,
    organizationId: string,
    receiptId: string,
  ): Promise<Array<ReceiptEffectRow & { receiptDocumentId: string }>> {
    return transaction
      .select({
        effect: receiptExecutionEffects,
        receiptDocumentId: receiptLines.receiptDocumentId,
      })
      .from(receiptExecutionEffects)
      .innerJoin(
        receiptLines,
        and(
          eq(receiptLines.organizationId, receiptExecutionEffects.organizationId),
          eq(receiptLines.id, receiptExecutionEffects.receiptLineId),
        ),
      )
      .where(and(
        eq(receiptExecutionEffects.organizationId, organizationId),
        eq(receiptLines.receiptDocumentId, receiptId),
      ))
      .then((rows) => rows.map(({ effect, receiptDocumentId }) => ({
        ...effect,
        receiptDocumentId,
      })));
  }

  async completedExecutionResponse(
    transaction: DatabaseTransaction,
    organizationId: string,
    receiptId: string,
  ): Promise<ReceiptView | undefined> {
    const result = await transaction.execute<{ response: ReceiptView }>(sql`
      SELECT jsonb_strip_nulls(jsonb_build_object(
        'id', rd.id,
        'organizationId', rd.organization_id,
        'organization', jsonb_build_object('id', o.id, 'label', o.legal_name),
        'businessNumber', rd.business_number,
        'businessDate', rd.business_date::text,
        'enteredAt', to_char(
          rd.entered_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'partyId', rd.party_id,
        'party', jsonb_build_object('id', party.id, 'label', party.display_name),
        'branchId', rd.branch_id,
        'branch', CASE WHEN branch.id IS NULL THEN NULL
          ELSE jsonb_build_object('id', branch.id, 'label', branch.name)
        END,
        'treasuryUnitId', rd.treasury_unit_id,
        'treasuryUnit', jsonb_build_object(
          'id', treasury_unit.id,
          'label', treasury_unit.name
        ),
        'baseCurrency', rd.base_currency,
        'baseCurrencyRef', jsonb_build_object(
          'id', currency.code,
          'label', currency.name
        ),
        'description', rd.description,
        'purpose', rd.purpose,
        'contractRef', rd.contract_ref,
        'invoiceRef', rd.invoice_ref,
        'orderRef', rd.order_ref,
        'projectRef', rd.project_ref,
        'costCenterRef', rd.cost_center_ref,
        'origin', rd.origin,
        'creatorUserId', rd.creator_user_id,
        'creator', jsonb_build_object('id', creator.id, 'label', creator.display_name),
        'totalBaseAmount', jsonb_build_object(
          'amount', rd.total_base_amount::text,
          'currency', rd.base_currency
        ),
        'approvalSnapshot', (
          SELECT jsonb_build_object(
            'id', snapshot.id,
            'documentVersion', snapshot.document_version::int,
            'amountBasis', jsonb_build_object(
              'amount', snapshot.amount_basis::text,
              'currency', snapshot.base_currency
            ),
            'evaluatedAt', to_char(
              snapshot.evaluated_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ),
            'policyContexts', COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'order', context.context_order,
                'firstLineNumber', context.first_line_number,
                'currency', context.currency,
                'methodCategory', context.method_category,
                'policyId', context.policy_id,
                'policy', jsonb_build_object(
                  'id', context.policy_id,
                  'label', context.policy_name
                ),
                'policyVersion', context.policy_version
              ) ORDER BY context.context_order)
              FROM receipt_approval_snapshot_contexts context
              WHERE context.organization_id = snapshot.organization_id
                AND context.approval_snapshot_id = snapshot.id
            ), '[]'::jsonb),
            'steps', COALESCE((
              SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                'order', step.step_order,
                'roleId', step.role_id,
                'role', CASE WHEN step.role_id IS NULL THEN NULL
                  ELSE jsonb_build_object('id', step.role_id, 'label', step.role_name)
                END,
                'approverUserId', step.approver_user_id,
                'approver', CASE WHEN step.approver_user_id IS NULL THEN NULL
                  ELSE jsonb_build_object(
                    'id', step.approver_user_id,
                    'label', step.approver_name
                  )
                END,
                'approvalsRequired', step.approvals_required,
                'approvalsRecorded', (
                  SELECT count(DISTINCT action.actor_user_id)::int
                  FROM receipt_approval_actions action
                  WHERE action.organization_id = step.organization_id
                    AND action.approval_snapshot_id = step.approval_snapshot_id
                    AND action.approval_snapshot_step_id = step.id
                    AND action.action = 'APPROVED'
                ),
                'separationRules', step.separation_rules,
                'sourceContextOrders', step.source_context_orders,
                'state', COALESCE((
                  SELECT action.action
                  FROM receipt_approval_actions action
                  WHERE action.organization_id = step.organization_id
                    AND action.approval_snapshot_id = step.approval_snapshot_id
                    AND action.approval_snapshot_step_id = step.id
                    AND action.action IN ('REJECTED', 'RETURNED')
                  ORDER BY action.acted_at, action.id
                  LIMIT 1
                ), CASE WHEN (
                  SELECT count(DISTINCT action.actor_user_id)
                  FROM receipt_approval_actions action
                  WHERE action.organization_id = step.organization_id
                    AND action.approval_snapshot_id = step.approval_snapshot_id
                    AND action.approval_snapshot_step_id = step.id
                    AND action.action = 'APPROVED'
                ) >= step.approvals_required THEN 'APPROVED' ELSE 'WAITING' END)
              )) ORDER BY step.step_order)
              FROM receipt_approval_snapshot_steps step
              WHERE step.organization_id = snapshot.organization_id
                AND step.approval_snapshot_id = snapshot.id
            ), '[]'::jsonb),
            'actions', COALESCE((
              SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                'id', action.id,
                'approvalSnapshotId', action.approval_snapshot_id,
                'approvalSnapshotStepId', action.approval_snapshot_step_id,
                'stepOrder', action.step_order,
                'actorUserId', action.actor_user_id,
                'actor', jsonb_build_object(
                  'id', actor.id,
                  'label', actor.display_name
                ),
                'delegatedFromUserId', action.delegated_from_user_id,
                'delegatedFrom', CASE WHEN delegated.id IS NULL THEN NULL
                  ELSE jsonb_build_object(
                    'id', delegated.id,
                    'label', delegated.display_name
                  )
                END,
                'action', action.action,
                'reason', action.reason,
                'actedAt', to_char(
                  action.acted_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                )
              )) ORDER BY action.acted_at, action.id)
              FROM receipt_approval_actions action
              JOIN user_refs actor
                ON actor.organization_id = action.organization_id
                  AND actor.id = action.actor_user_id
              LEFT JOIN user_refs delegated
                ON delegated.organization_id = action.organization_id
                  AND delegated.id = action.delegated_from_user_id
              WHERE action.organization_id = snapshot.organization_id
                AND action.approval_snapshot_id = snapshot.id
            ), '[]'::jsonb),
            'state', 'APPROVED'
          )
          FROM receipt_approval_snapshots snapshot
          WHERE snapshot.organization_id = rd.organization_id
            AND snapshot.receipt_document_id = rd.id
            AND snapshot.id = rd.current_approval_snapshot_id
        ),
        'executedAt', to_char(
          rd.executed_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'executedByUserId', rd.executed_by_user_id,
        'executedBy', CASE WHEN executor.id IS NULL THEN NULL
          ELSE jsonb_build_object('id', executor.id, 'label', executor.display_name)
        END,
        'reversalReceipt', CASE WHEN reversal.id IS NULL THEN NULL
          ELSE jsonb_build_object('id', reversal.id, 'label', reversal.business_number)
        END,
        'reversesReceipt', CASE WHEN original.id IS NULL THEN NULL
          ELSE jsonb_build_object('id', original.id, 'label', original.business_number)
        END,
        'lines', COALESCE((
          SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
            'id', line.id,
            'lineNumber', line.line_number,
            'methodId', line.method_id,
            'method', jsonb_build_object('id', line.method_id, 'label', line.method_name),
            'methodBehaviorCategory', line.method_category,
            'methodRequiredReferences', line.method_required_references,
            'createsFundsInTransit', line.creates_funds_in_transit,
            'requiresApproval', line.requires_approval,
            'money', jsonb_build_object(
              'amount', line.amount::text,
              'currency', line.currency
            ),
            'baseAmount', jsonb_build_object(
              'amount', line.base_amount::text,
              'currency', line.base_currency
            ),
            'rateSnapshot', jsonb_strip_nulls(jsonb_build_object(
              'sourceCurrency', line.currency,
              'targetCurrency', line.base_currency,
              'rate', line.exchange_rate::text,
              'rateType', line.rate_type,
              'rateSource', line.rate_source,
              'ratedAt', to_char(
                line.rate_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ),
              'rateRecordId', line.rate_record_id,
              'targetAmount', line.base_amount::text,
              'roundingDifference', line.rounding_difference::text
            )),
            'rateRecord', CASE WHEN rate.id IS NULL THEN NULL
              ELSE jsonb_build_object(
                'id', rate.id,
                'label', rate.rate_type || ' · ' || rate.source_name || ' · '
                  || rate.valid_at::text
              )
            END,
            'cashboxId', line.cashbox_id,
            'cashbox', CASE WHEN cashbox.id IS NULL THEN NULL
              ELSE jsonb_build_object('id', cashbox.id, 'label', cashbox.name)
            END,
            'bankAccountId', line.bank_account_id,
            'bankAccount', CASE WHEN account.id IS NULL THEN NULL
              ELSE jsonb_build_object(
                'id', account.id,
                'label', account_bank.display_name || ' · ' || account.account_number
              )
            END,
            'posTerminalId', line.pos_terminal_id,
            'posTerminal', CASE WHEN terminal.id IS NULL THEN NULL
              ELSE jsonb_build_object(
                'id', terminal.id,
                'label', terminal.terminal_number || ' · ' || terminal.merchant_number
              )
            END,
            'paymentGatewayId', line.payment_gateway_id,
            'paymentGateway', CASE WHEN gateway.id IS NULL THEN NULL
              ELSE jsonb_build_object(
                'id', gateway.id,
                'label', gateway.provider_code || ' · ' || gateway.merchant_id
              )
            END,
            'cheque', CASE WHEN line.cheque_input IS NULL THEN NULL
              ELSE jsonb_strip_nulls(line.cheque_input || jsonb_build_object(
                'bankId', line.cheque_bank_id,
                'bank', jsonb_build_object(
                  'id', cheque_bank.id,
                  'label', cheque_bank.display_name
                ),
                'bankBranchId', line.cheque_bank_branch_id,
                'bankBranch', CASE WHEN cheque_branch.id IS NULL THEN NULL
                  ELSE jsonb_build_object(
                    'id', cheque_branch.id,
                    'label', cheque_branch.name
                  )
                END,
                'payerPartyId', line.cheque_payer_party_id,
                'payerParty', CASE WHEN cheque_party.id IS NULL THEN NULL
                  ELSE jsonb_build_object(
                    'id', cheque_party.id,
                    'label', cheque_party.display_name
                  )
                END,
                'amount', jsonb_build_object(
                  'amount', line.amount::text,
                  'currency', line.currency
                )
              ))
            END,
            'trackingNumber', line.tracking_number,
            'payerAccountReference', line.payer_account_reference,
            'dueDate', line.due_date::text,
            'payerName', line.payer_name,
            'allocations', COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'id', allocation.id,
                'externalObjectType', allocation.external_object_type,
                'externalObjectId', allocation.external_object_id,
                'baseMoney', jsonb_build_object(
                  'amount', allocation.base_amount::text,
                  'currency', allocation.base_currency
                ),
                'state', allocation.state
              ) ORDER BY allocation.created_at, allocation.id)
              FROM receipt_allocations allocation
              WHERE allocation.organization_id = line.organization_id
                AND allocation.receipt_line_id = line.id
            ), '[]'::jsonb),
            'remainderTreatment', line.remainder_treatment,
            'description', line.description,
            'accountingDimensions', line.accounting_dimensions,
            'attachments', COALESCE((
              SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                'id', attachment.id,
                'label', attachment.file_name,
                'contentDigest', link.content_digest,
                'purpose', nullif(link.purpose, '')
              )) ORDER BY attachment.file_name, attachment.id)
              FROM receipt_line_attachment_links link
              JOIN attachments attachment
                ON attachment.organization_id = link.organization_id
                  AND attachment.id = link.attachment_id
                  AND attachment.content_digest = link.content_digest
              WHERE link.organization_id = line.organization_id
                AND link.receipt_line_id = line.id
            ), '[]'::jsonb),
            'executedAt', to_char(
              line.executed_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ),
            'executedByUserId', line.executed_by_user_id,
            'executedBy', CASE WHEN line_executor.id IS NULL THEN NULL
              ELSE jsonb_build_object(
                'id', line_executor.id,
                'label', line_executor.display_name
              )
            END,
            'executionEffects', COALESCE((
              SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                'receiptEffectId', effect.id,
                'effectKey', effect.effect_key,
                'effectType', effect.effect_type,
                'effect', CASE WHEN COALESCE(
                  effect.movement_fact_id,
                  effect.received_cheque_id,
                  effect.collection_item_id
                ) IS NULL THEN NULL ELSE jsonb_build_object(
                  'id', COALESCE(
                    effect.movement_fact_id,
                    effect.received_cheque_id,
                    effect.collection_item_id
                  ),
                  'label', CASE effect.effect_type
                    WHEN 'CASHBOX_MOVEMENT' THEN 'Cashbox movement'
                    WHEN 'BANK_MOVEMENT' THEN 'Bank account movement'
                    WHEN 'RECEIVED_CHEQUE' THEN 'Received cheque'
                    WHEN 'COLLECTION_ITEM' THEN 'Collection item'
                  END
                ) END,
                'chequeEventId', effect.cheque_event_id,
                'collectionItemId', effect.collection_item_id,
                'collectionItemVersion', effect.collection_item_version,
                'collectionItemState', effect.collection_item_state,
                'direction', effect.direction,
                'money', jsonb_build_object(
                  'amount', effect.amount::text,
                  'currency', effect.currency
                ),
                'businessDate', effect.business_date::text,
                'sourceVersion', effect.source_version::int,
                'reversalOfEffectId', effect.reversal_of_effect_id
              )) ORDER BY effect.created_at, effect.id)
              FROM receipt_execution_effects effect
              WHERE effect.organization_id = line.organization_id
                AND effect.receipt_line_id = line.id
            ), '[]'::jsonb),
            'state', line.state,
            'version', line.version::int
          )) ORDER BY line.line_number)
          FROM receipt_lines line
          LEFT JOIN exchange_rates rate ON rate.id = line.rate_record_id
          LEFT JOIN cashboxes cashbox
            ON cashbox.organization_id = line.organization_id
              AND cashbox.id = line.cashbox_id
          LEFT JOIN bank_accounts account
            ON account.organization_id = line.organization_id
              AND account.id = line.bank_account_id
          LEFT JOIN banks account_bank
            ON account_bank.organization_id = account.organization_id
              AND account_bank.id = account.bank_id
          LEFT JOIN pos_terminals terminal
            ON terminal.organization_id = line.organization_id
              AND terminal.id = line.pos_terminal_id
          LEFT JOIN payment_gateways gateway
            ON gateway.organization_id = line.organization_id
              AND gateway.id = line.payment_gateway_id
          LEFT JOIN banks cheque_bank
            ON cheque_bank.organization_id = line.organization_id
              AND cheque_bank.id = line.cheque_bank_id
          LEFT JOIN bank_branches cheque_branch
            ON cheque_branch.organization_id = line.organization_id
              AND cheque_branch.bank_id = line.cheque_bank_id
              AND cheque_branch.id = line.cheque_bank_branch_id
          LEFT JOIN parties cheque_party
            ON cheque_party.organization_id = line.organization_id
              AND cheque_party.id = line.cheque_payer_party_id
          LEFT JOIN user_refs line_executor
            ON line_executor.organization_id = line.organization_id
              AND line_executor.id = line.executed_by_user_id
          WHERE line.organization_id = rd.organization_id
            AND line.receipt_document_id = rd.id
        ), '[]'::jsonb),
        'state', rd.state,
        'workflowState', rd.workflow_state,
        'executionState', rd.execution_state,
        'accountingState', rd.accounting_state,
        'version', rd.version::int,
        'createdAt', to_char(
          rd.created_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'updatedAt', to_char(
          rd.updated_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
      )) AS response
      FROM receipt_documents rd
      JOIN organizations o ON o.id = rd.organization_id
      JOIN parties party
        ON party.organization_id = rd.organization_id
          AND party.id = rd.party_id
      LEFT JOIN branches branch
        ON branch.organization_id = rd.organization_id
          AND branch.id = rd.branch_id
      JOIN treasury_units treasury_unit
        ON treasury_unit.organization_id = rd.organization_id
          AND treasury_unit.id = rd.treasury_unit_id
      JOIN currencies currency
        ON currency.organization_id = rd.organization_id
          AND currency.code = rd.base_currency
      JOIN user_refs creator
        ON creator.organization_id = rd.organization_id
          AND creator.id = rd.creator_user_id
      LEFT JOIN user_refs executor
        ON executor.organization_id = rd.organization_id
          AND executor.id = rd.executed_by_user_id
      LEFT JOIN receipt_documents reversal
        ON reversal.organization_id = rd.organization_id
          AND reversal.id = rd.reversal_receipt_id
      LEFT JOIN receipt_documents original
        ON original.organization_id = rd.organization_id
          AND original.id = rd.reverses_receipt_id
      WHERE rd.organization_id = ${organizationId}
        AND rd.id = ${receiptId}
        AND rd.state = 'EXECUTED'
        AND rd.execution_state = 'EXECUTED'
      FOR KEY SHARE OF rd
    `);
    return result.rows[0]?.response;
  }

  async markExecuted(
    transaction: DatabaseTransaction,
    input: {
      organizationId: string;
      receiptId: string;
      actorUserId: string;
      executedAt: Date;
      version: number;
    },
  ): Promise<void> {
    await transaction
      .update(receiptLines)
      .set({
        state: 'EXECUTED',
        executedAt: input.executedAt,
        executedByUserId: input.actorUserId,
        version: sql`${receiptLines.version} + 1`,
        updatedAt: input.executedAt,
      })
      .where(and(
        eq(receiptLines.organizationId, input.organizationId),
        eq(receiptLines.receiptDocumentId, input.receiptId),
      ));
    await transaction
      .update(receiptDocuments)
      .set({
        state: 'EXECUTED',
        workflowState: 'APPROVED',
        executionState: 'EXECUTED',
        accountingState: 'READY',
        executedAt: input.executedAt,
        executedByUserId: input.actorUserId,
        version: input.version,
        updatedAt: input.executedAt,
      })
      .where(and(
        eq(receiptDocuments.organizationId, input.organizationId),
        eq(receiptDocuments.id, input.receiptId),
      ));
  }

  async createReversalReceipt(
    transaction: DatabaseTransaction,
    input: {
      original: LockedReceipt;
      actorUserId: string;
      businessDate: string;
      executedAt: Date;
    },
  ): Promise<{ receiptId: string; lineIds: Map<string, string> }> {
    const receiptId = randomUUID();
    const document = input.original.document;
    await transaction.insert(receiptDocuments).values({
      id: receiptId,
      organizationId: document.organizationId,
      businessNumber: `REV-${document.businessNumber}`,
      businessDate: input.businessDate,
      enteredAt: input.executedAt,
      partyId: document.partyId,
      branchId: document.branchId,
      treasuryUnitId: document.treasuryUnitId,
      baseCurrency: document.baseCurrency,
      totalBaseAmount: document.totalBaseAmount,
      description: document.description,
      purpose: document.purpose,
      contractRef: document.contractRef,
      invoiceRef: document.invoiceRef,
      orderRef: document.orderRef,
      projectRef: document.projectRef,
      costCenterRef: document.costCenterRef,
      origin: document.origin,
      creatorUserId: input.actorUserId,
      currentApprovalSnapshotId: null,
      state: 'EXECUTED',
      workflowState: 'APPROVED',
      executionState: 'EXECUTED',
      accountingState: 'READY',
      executedAt: input.executedAt,
      executedByUserId: input.actorUserId,
      reversesReceiptId: document.id,
      version: 1,
      createdAt: input.executedAt,
      updatedAt: input.executedAt,
    });
    const lineIds = new Map<string, string>();
    for (const line of input.original.lines) {
      const id = randomUUID();
      lineIds.set(line.id, id);
      const { effectiveBankAccountId: _effectiveBankAccountId, ...storedLine } = line;
      await transaction.insert(receiptLines).values({
        ...storedLine,
        id,
        receiptDocumentId: receiptId,
        state: 'EXECUTED',
        executedAt: input.executedAt,
        executedByUserId: input.actorUserId,
        version: 1,
        createdAt: input.executedAt,
        updatedAt: input.executedAt,
      });
    }
    return { receiptId, lineIds };
  }

  async completeReversal(
    transaction: DatabaseTransaction,
    input: {
      organizationId: string;
      originalReceiptId: string;
      reversalReceiptId: string;
      originalVersion: number;
      at: Date;
    },
  ): Promise<void> {
    await transaction
      .update(receiptAllocations)
      .set({ state: 'REVERSED', version: sql`${receiptAllocations.version} + 1`, updatedAt: input.at })
      .where(sql`${receiptAllocations.receiptLineId} IN (
        SELECT id FROM receipt_lines
        WHERE organization_id = ${input.organizationId}
          AND receipt_document_id = ${input.originalReceiptId}
      )`);
    await transaction
      .update(receiptLines)
      .set({ state: 'REVERSED', version: sql`${receiptLines.version} + 1`, updatedAt: input.at })
      .where(and(
        eq(receiptLines.organizationId, input.organizationId),
        eq(receiptLines.receiptDocumentId, input.originalReceiptId),
      ));
    await transaction
      .update(receiptDocuments)
      .set({
        state: 'REVERSED',
        executionState: 'REVERSED',
        reversalReceiptId: input.reversalReceiptId,
        version: input.originalVersion,
        updatedAt: input.at,
      })
      .where(and(
        eq(receiptDocuments.organizationId, input.organizationId),
        eq(receiptDocuments.id, input.originalReceiptId),
      ));
  }

  effectView(effect: ReceiptEffectRow): ReceiptExecutionEffectView {
    const effectType = effect.effectType as ReceiptExecutionEffectType;
    const concreteId = effect.movementFactId
      ?? effect.receivedChequeId
      ?? effect.collectionItemId;
    return {
      receiptEffectId: effect.id,
      effectKey: effect.effectKey,
      effectType,
      ...(concreteId ? { effect: { id: concreteId, label: EFFECT_LABELS[effectType] } } : {}),
      ...(effect.chequeEventId ? { chequeEventId: effect.chequeEventId } : {}),
      ...(effect.collectionItemId ? { collectionItemId: effect.collectionItemId } : {}),
      ...(effect.collectionItemVersion === null
        ? {} : { collectionItemVersion: Number(effect.collectionItemVersion) }),
      ...(effect.collectionItemState
        ? {
          collectionItemState: effect.collectionItemState as
            'RETURNED' | 'REOPENED_AFTER_REVERSAL',
        }
        : {}),
      direction: effect.direction as 'INCOMING' | 'REVERSAL',
      money: { amount: effect.amount, currency: effect.currency },
      businessDate: effect.businessDate,
      sourceVersion: Number(effect.sourceVersion),
      ...(effect.reversalOfEffectId
        ? { reversalOfEffectId: effect.reversalOfEffectId }
        : {}),
    };
  }
}
