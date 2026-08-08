import { Inject, Injectable } from '@nestjs/common';

import { AccessAuthorizationService } from '../access-control/access-authorization.service';
import type { TreasuryRequest } from '../access-control/auth.guard';
import { commandDigest, digest, stableJson } from '../common/http';
import { TreasuryProblem } from '../common/problem';
import { DatabaseService, type DatabaseTransaction } from '../database/database.service';
import { FoundationEffectsService } from '../foundation-effects/foundation-effects.service';
import {
  CashboxDayApprovalActionDto,
  CashboxDayApprovalCommand,
  CashboxDayApprovalCommandKind,
  CashboxDayApprovalQueue,
  CashboxDayApprovalRequestView,
  CashboxDayApprovalState,
  CashboxDayCloseApprovalRequestDto,
  CashboxDayCountView,
  CashboxDayReopenApprovalRequestDto,
  CashboxDayView,
  CloseDayDto,
  Page,
  PettyCashFundCreateDto,
  PettyCashFundView,
  ReopenDayDto,
  ReplenishmentSourceType,
} from './cashbox-operations.dto';
import {
  CashboxOperationFacts,
  CashboxOperationsRepository,
} from './cashbox-operations.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const LIMIT = 500;

interface CommandContext {
  organizationId: string;
  actorUserId: string;
  physicalSessionId?: string;
  key: string;
  requestId: string;
  ifMatch?: string;
  stepUp?: TreasuryRequest['stepUp'];
}

interface ApprovalBody {
  command: Record<string, unknown>;
  snapshotDigest?: string;
}

@Injectable()
export class CashboxOperationsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CashboxOperationsRepository)
    private readonly repository: CashboxOperationsRepository,
    @Inject(AccessAuthorizationService)
    private readonly authorization: AccessAuthorizationService,
    @Inject(FoundationEffectsService)
    private readonly effects: FoundationEffectsService,
  ) {}

  createPettyCashFund(
    context: CommandContext,
    dto: PettyCashFundCreateDto,
  ): Promise<PettyCashFundView> {
    this.validateCreateFund(dto);
    this.commandContext(context);
    const scope = `createPettyCashFund:${dto.cashboxId}`;
    const requestDigest = commandDigest('createPettyCashFund', {
      actorUserId: context.actorUserId,
      body: dto,
    });
    return this.map(() => this.database.db.transaction(async (transaction) => {
      await this.repository.acquireIdempotencyLock(
        transaction, context.organizationId, scope, context.key,
      );
      const replay = await this.repository.findIdempotency<PettyCashFundView>(
        transaction, context.organizationId, scope, context.key,
      );
      if (replay) {
        if (replay.requestDigest !== requestDigest || !replay.response) {
          throw new Error('IDEMPOTENCY_CONFLICT');
        }
        await this.assertFundAuthorized(transaction, context, replay.response);
        return replay.response;
      }
      await this.repository.insertIdempotency(
        transaction, context.organizationId, scope, context.key, requestDigest,
      );
      const cashbox = await this.repository.cashboxFacts(
        transaction, context.organizationId, dto.cashboxId, 'update',
      );
      if (!cashbox) throw new Error('RESOURCE_HIDDEN');
      if (cashbox.state !== 'ACTIVE' || cashbox.cashboxType !== 'PETTY_CASH') {
        throw new Error('STATE_CONFLICT');
      }
      if (await this.repository.profileExists(transaction, context.organizationId, dto.cashboxId)) {
        throw new Error('STATE_CONFLICT');
      }
      if (dto.ceiling.currency !== cashbox.mainCurrency
        || (dto.evidenceThreshold && dto.evidenceThreshold.currency !== cashbox.mainCurrency)
        || (dto.evidenceThreshold
          && decimal(dto.evidenceThreshold.amount) > decimal(dto.ceiling.amount))) {
        throw new Error('VALIDATION');
      }
      const mainControl = cashbox.currencies.find(({ currency }) => currency === cashbox.mainCurrency);
      if (!mainControl) throw new Error('STATE_CONFLICT');
      if (mainControl.maximumHolding !== null
        && decimal(dto.ceiling.amount) > decimal(mainControl.maximumHolding)) {
        throw new Error('PETTY_CASH_CEILING');
      }
      const source = await this.repository.replenishmentSource(
        transaction,
        context.organizationId,
        dto.replenishmentSource.type,
        dto.replenishmentSource.id,
      );
      if (!source) throw new Error('RESOURCE_HIDDEN');
      if (source.id === cashbox.id || source.state !== 'ACTIVE'
        || source.currency !== cashbox.mainCurrency || !source.canTransfer) {
        throw new Error('STATE_CONFLICT');
      }
      if (!await this.authorization.canOperateCashbox(
        transaction,
        context.organizationId,
        context.actorUserId,
        {
          branchId: cashbox.branchId,
          treasuryUnitId: cashbox.treasuryUnitId,
          cashboxIds: [cashbox.id, ...(dto.replenishmentSource.type === ReplenishmentSourceType.CASHBOX
            ? [source.id] : [])],
          bankAccountIds: dto.replenishmentSource.type === ReplenishmentSourceType.BANK_ACCOUNT
            ? [source.id] : [],
          currencies: [cashbox.mainCurrency],
          amount: dto.ceiling.amount,
          amountCurrency: cashbox.mainCurrency,
        },
        'petty-cash.create',
      )) throw new Error('SCOPE_DENIED');
      const id = await this.repository.insertProfile(transaction, {
        organizationId: context.organizationId,
        cashboxId: cashbox.id,
        ceiling: normalizeDecimal(dto.ceiling.amount),
        expenseCategoryCodes: [...dto.expenseCategoryCodes].sort(),
        evidenceThreshold: dto.evidenceThreshold
          ? normalizeDecimal(dto.evidenceThreshold.amount)
          : undefined,
        settlementDays: dto.settlementDays,
        replenishmentSourceType: dto.replenishmentSource.type,
        replenishmentSourceId: dto.replenishmentSource.id,
      });
      const response = await this.repository.profileView(transaction, context.organizationId, id);
      if (!response) throw new Error('RESOURCE_HIDDEN');
      await this.effects.appendAudit(transaction, {
        organizationId: context.organizationId,
        requestId: context.requestId,
        actorUserId: context.actorUserId,
        entityType: 'PettyCashProfile',
        entityId: id,
        action: 'PETTY_CASH_FUND_CREATED',
      });
      await this.repository.saveIdempotency(
        transaction, context.organizationId, scope, context.key, response, 201,
      );
      return response;
    }));
  }

  listPettyCashFunds(
    organizationId: string,
    actorUserId: string,
    rawLimit?: string,
    rawCursor?: string,
    cashboxId?: string,
    state?: string,
  ): Promise<Page<PettyCashFundView>> {
    const limit = this.limit(rawLimit);
    if (cashboxId && !UUID.test(cashboxId)) this.validation('cashboxId is malformed.');
    if (state && !['ACTIVE', 'SUSPENDED', 'CLOSED'].includes(state)) {
      this.validation('state is unsupported.');
    }
    const cursor = this.cursor(rawCursor);
    return this.map(() => this.database.db.transaction(async (transaction) => {
      if (!await this.authorization.hasOrganizationPermission(
        transaction, organizationId, actorUserId, 'petty-cash.view',
      )) throw new Error('SCOPE_DENIED');
      const ids = await this.repository.profileIds(transaction, organizationId, cashboxId, state);
      const visible: PettyCashFundView[] = [];
      for (const id of ids) {
        const view = await this.repository.profileView(transaction, organizationId, id);
        if (!view || !await this.fundVisible(transaction, organizationId, actorUserId, view)) continue;
        const code = view.cashbox.label.split(' · ', 1)[0]!;
        if (cursor && compare([code, view.id], cursor) <= 0) continue;
        visible.push(view);
        if (visible.length > limit) break;
      }
      return page(
        visible,
        limit,
        (last) => this.encodeCursor([last.cashbox.label.split(' · ', 1)[0]!, last.id]),
      );
    }));
  }

  requestCloseApproval(
    context: CommandContext,
    cashboxId: string,
    businessDate: string,
    dto: CashboxDayCloseApprovalRequestDto,
  ): Promise<CashboxDayApprovalRequestView> {
    this.path(cashboxId, businessDate);
    this.commandContext(context);
    const normalized = normalizeClose(dto);
    const scope = `requestCashboxDayCloseApproval:${cashboxId}:${businessDate}`;
    const requestDigest = commandDigest('requestCashboxDayCloseApproval', {
      actorUserId: context.actorUserId,
      cashboxId,
      businessDate,
      body: normalized,
    });
    return this.map(() => this.database.db.transaction(async (transaction) => {
      const replay = await this.idempotency<CashboxDayApprovalRequestView>(
        transaction, context, scope, requestDigest,
      );
      if (replay) return replay;
      const cashbox = await this.requiredCashbox(transaction, context.organizationId, cashboxId);
      const latest = await this.repository.latestDay(
        transaction, context.organizationId, cashboxId, businessDate, 'update',
      );
      if (latest?.state === 'CLOSED') throw new Error('DAY_ALREADY_CLOSED');
      this.assertCustodian(cashbox, context.actorUserId);
      const counts = this.counts(cashbox, normalized.counts, true);
      if (!counts.some(({ varianceAmount }) => !isZero(varianceAmount))) {
        throw new Error('VALIDATION');
      }
      this.assertObserved(cashbox, normalized.observedInstrumentIds);
      await this.assertCloseScope(transaction, context, cashbox, counts, 'cashbox.close');
      const source = sourceVersion(latest);
      const subjectDigest = closeSubjectDigest(cashboxId, businessDate, source, normalized);
      const requestId = await this.repository.insertApprovalRequest(transaction, {
        organizationId: context.organizationId,
        cashboxId,
        businessDate,
        commandKind: CashboxDayApprovalCommandKind.CLOSE,
        commandBody: {
          command: normalized,
          snapshotDigest: snapshotDigest(cashbox, counts),
        },
        commandDigest: subjectDigest,
        sourceDayId: source.id,
        sourceDayVersion: source.version,
        requestedByUserId: context.actorUserId,
      });
      const response = await this.repository.approvalView(
        transaction, context.organizationId, requestId,
      );
      if (!response) throw new Error('RESOURCE_HIDDEN');
      await this.repository.saveIdempotency(
        transaction, context.organizationId, scope, context.key, response, 201,
      );
      return response;
    }));
  }

  requestReopenApproval(
    context: CommandContext,
    cashboxId: string,
    businessDate: string,
    dto: CashboxDayReopenApprovalRequestDto,
  ): Promise<CashboxDayApprovalRequestView> {
    this.path(cashboxId, businessDate);
    this.commandContext(context);
    const command = { reason: this.reason(dto.reason) };
    const scope = `requestCashboxDayReopenApproval:${cashboxId}:${businessDate}`;
    const requestDigest = commandDigest('requestCashboxDayReopenApproval', {
      actorUserId: context.actorUserId,
      cashboxId,
      businessDate,
      body: command,
    });
    return this.map(() => this.database.db.transaction(async (transaction) => {
      const replay = await this.idempotency<CashboxDayApprovalRequestView>(
        transaction, context, scope, requestDigest,
      );
      if (replay) return replay;
      const cashbox = await this.requiredCashbox(transaction, context.organizationId, cashboxId);
      const latest = await this.repository.latestDay(
        transaction, context.organizationId, cashboxId, businessDate, 'update',
      );
      if (!latest) throw new Error('RESOURCE_HIDDEN');
      if (latest.state !== 'CLOSED') throw new Error('STATE_CONFLICT');
      await this.assertCashboxScope(transaction, context, cashbox, 'cashbox.reopen');
      const source = { id: latest.id, version: Number(latest.version) };
      const subjectDigest = reopenSubjectDigest(cashboxId, businessDate, source, command);
      const requestId = await this.repository.insertApprovalRequest(transaction, {
        organizationId: context.organizationId,
        cashboxId,
        businessDate,
        commandKind: CashboxDayApprovalCommandKind.REOPEN,
        commandBody: { command },
        commandDigest: subjectDigest,
        sourceDayId: latest.id,
        sourceDayVersion: Number(latest.version),
        requestedByUserId: context.actorUserId,
      });
      const response = await this.repository.approvalView(
        transaction, context.organizationId, requestId,
      );
      if (!response) throw new Error('RESOURCE_HIDDEN');
      await this.repository.saveIdempotency(
        transaction, context.organizationId, scope, context.key, response, 201,
      );
      return response;
    }));
  }

  listApprovalRequests(
    organizationId: string,
    actorUserId: string,
    queueValue: string,
    rawLimit?: string,
    rawCursor?: string,
    cashboxId?: string,
    commandKindValue?: string,
    stateValue?: string,
    from?: string,
    to?: string,
  ): Promise<Page<CashboxDayApprovalRequestView>> {
    const queue = this.queue(queueValue);
    const limit = this.limit(rawLimit);
    const cursor = this.approvalCursor(rawCursor);
    if (cashboxId && !UUID.test(cashboxId)) this.validation('cashboxId is malformed.');
    if (from && !validDate(from)) this.validation('businessDateFrom is invalid.');
    if (to && !validDate(to)) this.validation('businessDateTo is invalid.');
    if (from && to && from > to) this.validation('business date range is invalid.');
    const requestedKind = queue === CashboxDayApprovalQueue.REQUESTED_CLOSE
      ? CashboxDayApprovalCommandKind.CLOSE
      : queue === CashboxDayApprovalQueue.REQUESTED_REOPEN
        ? CashboxDayApprovalCommandKind.REOPEN
        : undefined;
    const commandKind = commandKindValue
      ? this.commandKind(commandKindValue)
      : requestedKind;
    if (requestedKind && commandKind !== requestedKind) this.validation('commandKind conflicts with queue.');
    const state = stateValue ? this.approvalState(stateValue) : undefined;
    const actionable = queue === CashboxDayApprovalQueue.ACTIONABLE_APPROVE
      || queue === CashboxDayApprovalQueue.ACTIONABLE_REJECT;
    if (actionable && state && state !== CashboxDayApprovalState.PENDING) {
      this.validation('Actionable queues permit only PENDING.');
    }
    const permission = queuePermission(queue);
    return this.map(() => this.database.db.transaction(async (transaction) => {
      if (!await this.authorization.hasOrganizationPermission(
        transaction, organizationId, actorUserId, permission,
      )) throw new Error('SCOPE_DENIED');
      const ids = await this.repository.approvalCandidateIds(transaction, organizationId, {
        requestedByUserId: actionable ? undefined : actorUserId,
        commandKind,
        state,
        cashboxId,
        from,
        to,
        pendingOnly: actionable,
      });
      const visible: CashboxDayApprovalRequestView[] = [];
      for (const id of ids) {
        const view = await this.repository.approvalView(transaction, organizationId, id);
        if (!view || (actionable && view.requestedByUserId === actorUserId)) continue;
        if (cursor && compareApproval(view, cursor) <= 0) continue;
        if (!await this.approvalVisible(transaction, organizationId, actorUserId, view, permission)) {
          continue;
        }
        visible.push(view);
        if (visible.length > limit) break;
      }
      return page(visible, limit, (last) => this.encodeCursor([last.createdAt, last.id]));
    }));
  }

  actOnApproval(
    context: CommandContext,
    approvalRequestId: string,
    dto: CashboxDayApprovalActionDto,
  ): Promise<CashboxDayApprovalRequestView> {
    if (!UUID.test(approvalRequestId)) this.validation('approvalRequestId is malformed.');
    this.commandContext(context, true);
    const expectedVersion = this.ifMatch(context.ifMatch);
    if (dto.action === CashboxDayApprovalCommand.REJECT && !dto.reason?.trim()) {
      this.validation('REJECT requires a reason.');
    }
    if (dto.reason !== undefined && !dto.reason.trim()) this.validation('reason is empty.');
    const command = { action: dto.action, ...(dto.reason ? { reason: dto.reason.trim() } : {}) };
    const scope = `actOnCashboxDayApproval:${approvalRequestId}`;
    const requestDigest = commandDigest('actOnCashboxDayApproval', {
      actorUserId: context.actorUserId,
      approvalRequestId,
      ifMatch: context.ifMatch,
      body: command,
    });
    return this.map(() => this.database.db.transaction(async (transaction) => {
      const replay = await this.idempotency<CashboxDayApprovalRequestView>(
        transaction, context, scope, requestDigest,
      );
      if (replay) return replay;
      const request = await this.repository.lockApprovalRequest(
        transaction, context.organizationId, approvalRequestId,
      );
      if (!request) throw new Error('RESOURCE_HIDDEN');
      if (Number(request.version) !== expectedVersion) throw new Error('STALE_VERSION');
      if (request.state !== 'PENDING') throw new Error('STATE_CONFLICT');
      if (request.requestedByUserId === context.actorUserId) throw new Error('SCOPE_DENIED');
      const view = await this.repository.approvalView(
        transaction, context.organizationId, approvalRequestId,
      );
      if (!view) throw new Error('RESOURCE_HIDDEN');
      const permission = dto.action === CashboxDayApprovalCommand.APPROVE
        ? 'cashbox.approve' as const
        : 'cashbox.reject' as const;
      if (!await this.approvalVisible(
        transaction, context.organizationId, context.actorUserId, view, permission,
      )) throw new Error('SCOPE_DENIED');
      await this.consumeProof(transaction, context);
      if (!await this.repository.completeApprovalAction(transaction, {
        organizationId: context.organizationId,
        requestId: approvalRequestId,
        expectedVersion,
        actorUserId: context.actorUserId,
        action: dto.action === CashboxDayApprovalCommand.APPROVE ? 'APPROVED' : 'REJECTED',
        reason: dto.reason?.trim(),
      })) throw new Error('STALE_VERSION');
      const response = await this.repository.approvalView(
        transaction, context.organizationId, approvalRequestId,
      );
      if (!response) throw new Error('RESOURCE_HIDDEN');
      await this.repository.saveIdempotency(
        transaction, context.organizationId, scope, context.key, response, 200,
      );
      return response;
    }));
  }

  closeDay(
    context: CommandContext,
    cashboxId: string,
    businessDate: string,
    dto: CloseDayDto,
  ): Promise<CashboxDayView> {
    this.path(cashboxId, businessDate);
    this.commandContext(context);
    const normalized = normalizeClose(dto);
    const scope = `closeCashboxDay:${cashboxId}:${businessDate}`;
    const requestDigest = commandDigest('closeCashboxDay', {
      actorUserId: context.actorUserId,
      cashboxId,
      businessDate,
      body: { ...normalized, approvalActionId: dto.approvalActionId ?? null },
    });
    return this.map(() => this.database.db.transaction(async (transaction) => {
      const replay = await this.idempotency<CashboxDayView>(
        transaction, context, scope, requestDigest,
      );
      if (replay) return replay;
      const cashbox = await this.requiredCashbox(transaction, context.organizationId, cashboxId);
      const latest = await this.repository.latestDay(
        transaction, context.organizationId, cashboxId, businessDate, 'update',
      );
      if (latest?.state === 'CLOSED') throw new Error('DAY_ALREADY_CLOSED');
      this.assertCustodian(cashbox, context.actorUserId);
      await this.assertCashboxScope(transaction, context, cashbox, 'cashbox.close');
      const counts = this.counts(cashbox, normalized.counts, false);
      this.assertObserved(cashbox, normalized.observedInstrumentIds);
      const variances = counts.filter(({ varianceAmount }) => !isZero(varianceAmount));
      const source = sourceVersion(latest);
      if (variances.length) {
        if (!dto.approvalActionId) throw new Error('APPROVAL_REQUIRED');
        const approved = await this.repository.approvedAction(
          transaction, context.organizationId, dto.approvalActionId,
        );
        const expectedDigest = closeSubjectDigest(cashboxId, businessDate, source, normalized);
        if (!approved || approved.action !== 'APPROVED'
          || approved.requestedByUserId !== context.actorUserId
          || approved.commandKind !== CashboxDayApprovalCommandKind.CLOSE
          || approved.cashboxId !== cashboxId
          || approved.businessDate !== businessDate
          || approved.commandDigest !== expectedDigest
          || (approved.sourceDayId ?? undefined) !== source.id
          || Number(approved.sourceDayVersion) !== source.version) {
          throw new Error('VALID_APPROVAL_MISSING');
        }
        const request = await this.repository.lockApprovalRequest(
          transaction, context.organizationId, approved.requestId,
        );
        const payload = request?.commandBody as unknown as ApprovalBody | undefined;
        if (!payload?.snapshotDigest || payload.snapshotDigest !== snapshotDigest(cashbox, counts)) {
          throw new Error('VALID_APPROVAL_MISSING');
        }
      } else if (dto.approvalActionId) {
        throw new Error('VALIDATION');
      }
      const businessNumber = await this.repository.reserveBusinessNumber(transaction, businessDate);
      const dayId = await this.repository.closeDay(transaction, {
        organizationId: context.organizationId,
        cashboxId,
        businessDate,
        actorUserId: context.actorUserId,
        businessNumber,
        bookSnapshotDigest: snapshotDigest(cashbox, counts),
        heldInstrumentSnapshot: cashbox.heldInstruments,
        observedInstrumentIds: normalized.observedInstrumentIds,
        approvalActionId: dto.approvalActionId,
        latest,
        counts,
      });
      const movementFactIds: string[] = [];
      for (const variance of variances) {
        movementFactIds.push(await this.effects.appendMovement(transaction, {
          organizationId: context.organizationId,
          owner: 'domain.cashbox-and-custody',
          sourceType: 'CashboxDay',
          sourceId: dayId,
          effectKey: `CLOSE_VARIANCE:${variance.currency}`,
          endpointType: 'CASHBOX',
          endpointId: cashboxId,
          direction: decimal(variance.varianceAmount) > 0n ? 'CREDIT' : 'DEBIT',
          amount: absoluteDecimal(variance.varianceAmount),
          currency: variance.currency,
          businessDate,
          state: 'POSTED',
        }));
      }
      const response = await this.repository.dayView(transaction, context.organizationId, dayId);
      if (!response || !response.businessNumber || !response.closedAt) {
        throw new Error('STATE_CONFLICT');
      }
      await this.effects.appendAudit(transaction, {
        organizationId: context.organizationId,
        requestId: context.requestId,
        actorUserId: context.actorUserId,
        entityType: 'CashboxDay',
        entityId: dayId,
        action: 'CASHBOX_DAY_CLOSED',
      });
      await this.effects.appendOutbox(transaction, {
        organizationId: context.organizationId,
        aggregateType: 'CashboxDay',
        aggregateId: dayId,
        aggregateVersion: response.version,
        eventType: 'treasury.cashbox.day-closed.v1',
        payload: {
          sourceType: 'CashboxDay',
          sourceId: dayId,
          sourceVersion: response.version,
          cashboxId,
          businessDate,
          closeCycle: response.closeCycle,
          businessNumber: response.businessNumber,
          counts: response.counts,
          varianceMovementFactIds: movementFactIds,
          closedAt: response.closedAt,
        },
      });
      await this.repository.saveIdempotency(
        transaction, context.organizationId, scope, context.key, response, 200,
      );
      return response;
    }));
  }

  reopenDay(
    context: CommandContext,
    cashboxId: string,
    businessDate: string,
    dto: ReopenDayDto,
  ): Promise<CashboxDayView> {
    this.path(cashboxId, businessDate);
    this.commandContext(context, true);
    const expectedVersion = this.ifMatch(context.ifMatch);
    const command = { reason: this.reason(dto.reason) };
    const scope = `reopenCashboxDay:${cashboxId}:${businessDate}`;
    const requestDigest = commandDigest('reopenCashboxDay', {
      actorUserId: context.actorUserId,
      cashboxId,
      businessDate,
      ifMatch: context.ifMatch,
      body: dto,
    });
    return this.map(() => this.database.db.transaction(async (transaction) => {
      const replay = await this.idempotency<CashboxDayView>(
        transaction, context, scope, requestDigest,
      );
      if (replay) return replay;
      const cashbox = await this.requiredCashbox(transaction, context.organizationId, cashboxId);
      const latest = await this.repository.latestDay(
        transaction, context.organizationId, cashboxId, businessDate, 'update',
      );
      if (!latest) throw new Error('RESOURCE_HIDDEN');
      if (Number(latest.version) !== expectedVersion) throw new Error('STALE_VERSION');
      if (latest.state !== 'CLOSED') throw new Error('STATE_CONFLICT');
      await this.assertCashboxScope(transaction, context, cashbox, 'cashbox.reopen');
      const approved = await this.repository.approvedAction(
        transaction, context.organizationId, dto.approvalActionId,
      );
      const source = { id: latest.id, version: Number(latest.version) };
      const expectedDigest = reopenSubjectDigest(cashboxId, businessDate, source, command);
      if (!approved || approved.action !== 'APPROVED'
        || approved.requestedByUserId !== context.actorUserId
        || approved.commandKind !== CashboxDayApprovalCommandKind.REOPEN
        || approved.cashboxId !== cashboxId
        || approved.businessDate !== businessDate
        || approved.commandDigest !== expectedDigest
        || approved.sourceDayId !== latest.id
        || Number(approved.sourceDayVersion) !== expectedVersion) {
        throw new Error('VALID_APPROVAL_MISSING');
      }
      await this.consumeProof(transaction, context);
      const dayId = await this.repository.reopenDay(transaction, {
        organizationId: context.organizationId,
        cashboxId,
        businessDate,
        priorCloseId: latest.id,
        nextCycle: latest.closeCycle + 1,
        approvalActionId: dto.approvalActionId,
        reason: command.reason,
        actorUserId: context.actorUserId,
      });
      const response = await this.repository.dayView(transaction, context.organizationId, dayId);
      if (!response) throw new Error('STATE_CONFLICT');
      await this.effects.appendAudit(transaction, {
        organizationId: context.organizationId,
        requestId: context.requestId,
        actorUserId: context.actorUserId,
        entityType: 'CashboxDay',
        entityId: dayId,
        action: 'CASHBOX_DAY_REOPENED',
        reason: command.reason,
      });
      await this.repository.saveIdempotency(
        transaction, context.organizationId, scope, context.key, response, 200,
      );
      return response;
    }));
  }

  private async requiredCashbox(
    transaction: DatabaseTransaction,
    organizationId: string,
    cashboxId: string,
  ): Promise<CashboxOperationFacts> {
    const cashbox = await this.repository.cashboxFacts(
      transaction, organizationId, cashboxId, 'update',
    );
    if (!cashbox) throw new Error('RESOURCE_HIDDEN');
    if (cashbox.state !== 'ACTIVE') throw new Error('STATE_CONFLICT');
    return cashbox;
  }

  private async idempotency<T>(
    transaction: DatabaseTransaction,
    context: CommandContext,
    scope: string,
    requestDigest: string,
  ): Promise<T | undefined> {
    await this.repository.acquireIdempotencyLock(
      transaction, context.organizationId, scope, context.key,
    );
    const replay = await this.repository.findIdempotency<T>(
      transaction, context.organizationId, scope, context.key,
    );
    if (replay) {
      if (replay.requestDigest !== requestDigest || !replay.response) {
        throw new Error('IDEMPOTENCY_CONFLICT');
      }
      return replay.response;
    }
    await this.repository.insertIdempotency(
      transaction, context.organizationId, scope, context.key, requestDigest,
    );
    return undefined;
  }

  private async assertFundAuthorized(
    transaction: DatabaseTransaction,
    context: CommandContext,
    view: PettyCashFundView,
  ): Promise<void> {
    const cashbox = await this.repository.cashboxFacts(
      transaction, context.organizationId, view.cashboxId,
    );
    if (!cashbox) throw new Error('RESOURCE_HIDDEN');
    if (!await this.authorization.canOperateCashbox(
      transaction,
      context.organizationId,
      context.actorUserId,
      {
        branchId: cashbox.branchId,
        treasuryUnitId: cashbox.treasuryUnitId,
        cashboxIds: [view.cashboxId, ...(view.replenishmentSource.type === ReplenishmentSourceType.CASHBOX
          ? [view.replenishmentSource.id] : [])],
        bankAccountIds: view.replenishmentSource.type === ReplenishmentSourceType.BANK_ACCOUNT
          ? [view.replenishmentSource.id] : [],
        currencies: [view.currency],
        amount: view.ceiling.amount,
        amountCurrency: view.currency,
      },
      'petty-cash.create',
    )) throw new Error('SCOPE_DENIED');
  }

  private async fundVisible(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    view: PettyCashFundView,
  ): Promise<boolean> {
    const cashbox = await this.repository.cashboxFacts(transaction, organizationId, view.cashboxId);
    return Boolean(cashbox && await this.authorization.canOperateCashbox(
      transaction,
      organizationId,
      actorUserId,
      {
        branchId: cashbox.branchId,
        treasuryUnitId: cashbox.treasuryUnitId,
        cashboxIds: [view.cashboxId],
        bankAccountIds: [],
        currencies: [view.currency],
      },
      'petty-cash.view',
    ));
  }

  private async approvalVisible(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    view: CashboxDayApprovalRequestView,
    permission: 'cashbox.close' | 'cashbox.reopen' | 'cashbox.approve' | 'cashbox.reject',
  ): Promise<boolean> {
    const cashbox = await this.repository.cashboxFacts(transaction, organizationId, view.cashboxId);
    if (!cashbox) return false;
    if (view.commandKind === CashboxDayApprovalCommandKind.CLOSE) {
      if (permission === 'cashbox.reopen') return false;
      const command = view.closeCommand;
      if (!command) return false;
      const counts = this.counts(cashbox, normalizeClose(command).counts, true);
      return this.closeScopeAllowed(transaction, organizationId, actorUserId, cashbox, counts, permission);
    }
    return this.authorization.canOperateCashbox(
      transaction,
      organizationId,
      actorUserId,
      {
        branchId: cashbox.branchId,
        treasuryUnitId: cashbox.treasuryUnitId,
        cashboxIds: [cashbox.id],
        bankAccountIds: [],
        currencies: [],
      },
      permission,
    );
  }

  private async assertCloseScope(
    transaction: DatabaseTransaction,
    context: CommandContext,
    cashbox: CashboxOperationFacts,
    counts: CashboxDayCountView[],
    permission: 'cashbox.close' | 'cashbox.approve' | 'cashbox.reject',
  ): Promise<void> {
    if (!await this.closeScopeAllowed(
      transaction,
      context.organizationId,
      context.actorUserId,
      cashbox,
      counts,
      permission,
    )) throw new Error('SCOPE_DENIED');
  }

  private async closeScopeAllowed(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    cashbox: CashboxOperationFacts,
    counts: CashboxDayCountView[],
    permission: 'cashbox.close' | 'cashbox.approve' | 'cashbox.reject',
  ): Promise<boolean> {
    for (const count of counts) {
      if (!await this.authorization.canOperateCashbox(
        transaction,
        organizationId,
        actorUserId,
        {
          branchId: cashbox.branchId,
          treasuryUnitId: cashbox.treasuryUnitId,
          cashboxIds: [cashbox.id],
          bankAccountIds: [],
          currencies: [count.currency],
          amount: absoluteDecimal(count.varianceAmount),
          amountCurrency: count.currency,
        },
        permission,
      )) return false;
    }
    return true;
  }

  private async assertCashboxScope(
    transaction: DatabaseTransaction,
    context: CommandContext,
    cashbox: CashboxOperationFacts,
    permission: 'cashbox.close' | 'cashbox.reopen',
  ): Promise<void> {
    if (!await this.authorization.canOperateCashbox(
      transaction,
      context.organizationId,
      context.actorUserId,
      {
        branchId: cashbox.branchId,
        treasuryUnitId: cashbox.treasuryUnitId,
        cashboxIds: [cashbox.id],
        bankAccountIds: [],
        currencies: [],
      },
      permission,
    )) throw new Error('SCOPE_DENIED');
  }

  private counts(
    cashbox: CashboxOperationFacts,
    submitted: CashboxDayCloseApprovalRequestDto['counts'],
    approvalRequest: boolean,
  ): CashboxDayCountView[] {
    if (new Set(submitted.map(({ currency }) => currency)).size !== submitted.length) {
      throw new Error('VALIDATION');
    }
    const sorted = [...submitted].sort((left, right) => left.currency.localeCompare(right.currency));
    if (stableJson(sorted.map(({ currency }) => currency))
      !== stableJson(cashbox.currencies.map(({ currency }) => currency))) {
      throw new Error('VALIDATION');
    }
    const counts = sorted.map((count) => {
      const bookAmount = cashbox.currencies.find(({ currency }) => currency === count.currency)!.bookAmount;
      const varianceAmount = subtractDecimal(count.countedAmount, bookAmount);
      const reason = count.varianceReason?.trim();
      if ((isZero(varianceAmount) && reason) || (!isZero(varianceAmount) && !reason)) {
        throw new Error(approvalRequest ? 'VALIDATION' : 'APPROVAL_REQUIRED');
      }
      return {
        currency: count.currency,
        bookAmount: normalizeDecimal(bookAmount),
        countedAmount: normalizeDecimal(count.countedAmount),
        varianceAmount,
        ...(reason ? { varianceReason: reason } : {}),
      };
    });
    return counts;
  }

  private assertObserved(cashbox: CashboxOperationFacts, observed: string[]): void {
    const allowed = new Set(cashbox.heldInstruments.map(({ id }) => id));
    if (new Set(observed).size !== observed.length || observed.some((id) => !allowed.has(id))) {
      throw new Error('VALIDATION');
    }
  }

  private assertCustodian(cashbox: CashboxOperationFacts, actorUserId: string): void {
    if (cashbox.primaryCustodianId !== actorUserId) throw new Error('CUSTODY_CONFLICT');
  }

  private async consumeProof(
    transaction: DatabaseTransaction,
    context: CommandContext,
  ): Promise<void> {
    if (!context.stepUp || !context.physicalSessionId
      || !await this.authorization.consumeStepUpProof(transaction, {
        proofDigest: digest(context.stepUp.proofId),
        physicalSessionId: context.physicalSessionId,
        ...context.stepUp.command,
      })) throw new Error('STEP_UP_REQUIRED');
  }

  private validateCreateFund(dto: PettyCashFundCreateDto): void {
    if (!dto.ceiling || !dto.replenishmentSource
      || dto.expenseCategoryCodes.length === 0
      || new Set(dto.expenseCategoryCodes).size !== dto.expenseCategoryCodes.length
      || (dto as unknown as Record<string, unknown>).evidenceThreshold === null) {
      this.validation('Petty Cash Fund input is incomplete.');
    }
  }

  private commandContext(context: CommandContext, stepUp = false): void {
    if (!context.requestId || context.requestId.length > 128) {
      this.validation('X-Request-Id must contain 1 through 128 characters.');
    }
    if (!context.key || context.key.length < 8 || context.key.length > 128) {
      this.validation('Idempotency-Key must contain 8 through 128 characters.');
    }
    if (stepUp && (!context.physicalSessionId || !context.stepUp)) {
      throw new TreasuryProblem('TRS-AUT-010', 428);
    }
  }

  private path(cashboxId: string, businessDate: string): void {
    if (!UUID.test(cashboxId)) this.validation('cashboxId is malformed.');
    if (!validDate(businessDate)) this.validation('businessDate is invalid.');
  }

  private reason(value: string): string {
    const reason = value?.trim();
    if (!reason || reason.length > 500) this.validation('reason must contain 1 through 500 characters.');
    return reason;
  }

  private ifMatch(value?: string): number {
    const match = /^"([0-9]+)"$/u.exec(value ?? '');
    const version = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(version) || version < 1) {
      this.validation('If-Match must be one strong numeric version tag.');
    }
    return version;
  }

  private limit(value?: string): number {
    if (!value) return 50;
    const limit = Number(value);
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT) {
      this.validation('limit must be an integer from 1 through 500.');
    }
    return limit;
  }

  private cursor(value?: string): [string, string] | undefined {
    if (!value) return undefined;
    const decoded = decodeCursor(value);
    if (decoded.length !== 2 || typeof decoded[0] !== 'string'
      || typeof decoded[1] !== 'string' || !UUID.test(decoded[1])) {
      this.validation('cursor is malformed.');
    }
    return decoded as [string, string];
  }

  private approvalCursor(value?: string): [string, string] | undefined {
    const cursor = this.cursor(value);
    if (cursor && Number.isNaN(Date.parse(cursor[0]))) this.validation('cursor is malformed.');
    return cursor;
  }

  private encodeCursor(value: [string, string]): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
  }

  private queue(value: string): CashboxDayApprovalQueue {
    if (!Object.values(CashboxDayApprovalQueue).includes(value as CashboxDayApprovalQueue)) {
      this.validation('queue is required and must be supported.');
    }
    return value as CashboxDayApprovalQueue;
  }

  private commandKind(value: string): CashboxDayApprovalCommandKind {
    if (!Object.values(CashboxDayApprovalCommandKind).includes(value as CashboxDayApprovalCommandKind)) {
      this.validation('commandKind is unsupported.');
    }
    return value as CashboxDayApprovalCommandKind;
  }

  private approvalState(value: string): CashboxDayApprovalState {
    if (!Object.values(CashboxDayApprovalState).includes(value as CashboxDayApprovalState)) {
      this.validation('state is unsupported.');
    }
    return value as CashboxDayApprovalState;
  }

  private validation(detail: string): never {
    throw new TreasuryProblem('TRS-GEN-001', 422, detail);
  }

  private async map<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof TreasuryProblem) throw error;
      const message = error instanceof Error ? error.message : '';
      const mapped = {
        VALIDATION: ['TRS-GEN-001', 422],
        RESOURCE_HIDDEN: ['TRS-GEN-004', 404],
        SCOPE_DENIED: ['TRS-GEN-003', 403],
        STATE_CONFLICT: ['TRS-GEN-005', 409],
        STALE_VERSION: ['TRS-GEN-006', 409],
        IDEMPOTENCY_CONFLICT: ['TRS-GEN-007', 409],
        STEP_UP_REQUIRED: ['TRS-AUT-010', 428],
        CUSTODY_CONFLICT: ['TRS-CSH-002', 409],
        APPROVAL_REQUIRED: ['TRS-CSH-003', 409],
        VALID_APPROVAL_MISSING: ['TRS-CSH-003', 409],
        DAY_ALREADY_CLOSED: ['TRS-CSH-004', 409],
        PETTY_CASH_CEILING: ['TRS-CSH-005', 409],
      } as const;
      const match = mapped[message as keyof typeof mapped];
      if (match) throw new TreasuryProblem(match[0], match[1]);
      const databaseError = error as { code?: string; constraint?: string };
      if (databaseError.code === '23505') throw new TreasuryProblem('TRS-GEN-005', 409);
      if (databaseError.code === '23514' || databaseError.code === '22P02') {
        throw new TreasuryProblem('TRS-GEN-001', 422);
      }
      throw error;
    }
  }
}

function normalizeClose(dto: CashboxDayCloseApprovalRequestDto): CashboxDayCloseApprovalRequestDto {
  return {
    counts: dto.counts.map((count) => ({
      currency: count.currency,
      countedAmount: normalizeDecimal(count.countedAmount),
      ...(count.varianceReason ? { varianceReason: count.varianceReason.trim() } : {}),
    })).sort((left, right) => left.currency.localeCompare(right.currency)),
    observedInstrumentIds: [...dto.observedInstrumentIds].sort(),
  };
}

function sourceVersion(latest?: { id: string; state: string; version: number }) {
  return latest && latest.state === 'REOPENED'
    ? { id: latest.id, version: Number(latest.version) }
    : { id: undefined, version: 0 };
}

function closeSubjectDigest(
  cashboxId: string,
  businessDate: string,
  source: { id?: string; version: number },
  command: CashboxDayCloseApprovalRequestDto,
): string {
  return digest(stableJson({
    path: `/v1/cashboxes/${cashboxId}/days/${businessDate}/close`,
    commandKind: 'CLOSE',
    cashboxId,
    businessDate,
    sourceDayId: source.id ?? null,
    sourceDayVersion: source.version,
    command,
  }));
}

function reopenSubjectDigest(
  cashboxId: string,
  businessDate: string,
  source: { id: string; version: number },
  command: { reason: string },
): string {
  return digest(stableJson({
    path: `/v1/cashboxes/${cashboxId}/days/${businessDate}/reopen`,
    commandKind: 'REOPEN',
    cashboxId,
    businessDate,
    sourceDayId: source.id,
    sourceDayVersion: source.version,
    command,
  }));
}

function snapshotDigest(cashbox: CashboxOperationFacts, counts: CashboxDayCountView[]): string {
  return digest(stableJson({
    cashboxId: cashbox.id,
    cashboxVersion: cashbox.version,
    counts: counts.map(({ currency, bookAmount }) => ({ currency, bookAmount })),
    heldInstruments: cashbox.heldInstruments,
  }));
}

function queuePermission(queue: CashboxDayApprovalQueue) {
  return ({
    [CashboxDayApprovalQueue.REQUESTED_CLOSE]: 'cashbox.close',
    [CashboxDayApprovalQueue.REQUESTED_REOPEN]: 'cashbox.reopen',
    [CashboxDayApprovalQueue.ACTIONABLE_APPROVE]: 'cashbox.approve',
    [CashboxDayApprovalQueue.ACTIONABLE_REJECT]: 'cashbox.reject',
  } as const)[queue];
}

function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function decimal(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const scaled = BigInt(whole) * 1_000_000_000_000n + BigInt(fraction.padEnd(12, '0'));
  return negative ? -scaled : scaled;
}

function decimalString(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 1_000_000_000_000n;
  const fraction = (absolute % 1_000_000_000_000n).toString().padStart(12, '0').replace(/0+$/u, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function normalizeDecimal(value: string): string {
  return decimalString(decimal(value));
}

function subtractDecimal(left: string, right: string): string {
  return decimalString(decimal(left) - decimal(right));
}

function absoluteDecimal(value: string): string {
  const scaled = decimal(value);
  return decimalString(scaled < 0n ? -scaled : scaled);
}

function isZero(value: string): boolean {
  return decimal(value) === 0n;
}

function decodeCursor(value: string): unknown[] {
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(value)) return [];
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function compare(left: [string, string], right: [string, string]): number {
  return left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]);
}

function compareApproval(
  value: CashboxDayApprovalRequestView,
  cursor: [string, string],
): number {
  return cursor[0].localeCompare(value.createdAt) || cursor[1].localeCompare(value.id);
}

function page<T>(items: T[], limit: number, cursor: (value: T) => string): Page<T> {
  const pageItems = items.slice(0, limit);
  const last = pageItems.at(-1);
  return {
    items: pageItems,
    page: {
      limit,
      hasMore: items.length > limit,
      ...(items.length > limit && last ? { nextCursor: cursor(last) } : {}),
      asOf: new Date().toISOString(),
    },
  };
}
