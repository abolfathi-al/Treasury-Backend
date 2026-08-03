import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import {
  AccessAuthorizationService,
  type PaymentAuthority,
  type TransferAuthorizationContext,
} from '../access-control/access-authorization.service';
import { commandDigest } from '../common/http';
import { TreasuryProblem } from '../common/problem';
import { DatabaseService, type DatabaseTransaction } from '../database/database.service';
import { FoundationEffectsService } from '../foundation-effects/foundation-effects.service';
import {
  TransferAcknowledgeDto,
  TransferApprovalAction,
  TransferApprovalActionDto,
  TransferCreateDto,
  TransferEndpointType,
  TransferPage,
  TransferRateSnapshot,
  TransferRoute,
  TransferView,
} from './transfer.dto';
import {
  TransferFacts,
  TransferPolicy,
  TransferRepository,
  type TransferSourceAvailability,
} from './transfer.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const NON_NEGATIVE_DECIMAL = /^(?:0(?:\.0{1,12})?|0\.0*[1-9][0-9]*|[1-9][0-9]*(?:\.[0-9]{1,12})?)$/u;

@Injectable()
export class TransferService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(TransferRepository) private readonly repository: TransferRepository,
    @Inject(AccessAuthorizationService) private readonly authorization: AccessAuthorizationService,
    @Inject(FoundationEffectsService) private readonly effects: FoundationEffectsService,
  ) {}

  create(
    organizationId: string,
    actorUserId: string,
    dto: TransferCreateDto,
    rawKey: string,
    requestId: string,
  ): Promise<TransferView> {
    this.validateDto(dto);
    this.requiredRequestId(requestId);
    const key = this.key(rawKey);
    const scope = `createTransfer:${actorUserId}`;
    const digest = commandDigest('createTransfer', { actorUserId, body: dto });
    return this.map(() => this.database.db.transaction(async (transaction) => {
      await this.repository.acquireIdempotencyLock(transaction, organizationId, scope, key);
      const replay = await this.repository.findIdempotency<TransferView>(transaction, organizationId, scope, key);
      if (replay) {
        if (replay.requestDigest !== digest || !replay.response) throw new Error('IDEMPOTENCY_CONFLICT');
        const facts = await this.repository.facts(transaction, organizationId, actorUserId, this.dto(replay.response), new Date());
        await this.assertAuthorized(transaction, organizationId, actorUserId, replay.response, facts, 'transfer.create');
        return replay.response;
      }
      await this.repository.startIdempotency(transaction, organizationId, scope, key, digest);
      const commandAt = new Date();
      const facts = await this.repository.facts(transaction, organizationId, actorUserId, dto, commandAt);
      const derived = this.derive(dto, facts, commandAt);
      await this.assertAuthorized(transaction, organizationId, actorUserId, { sourceMoney: dto.sourceMoney }, facts, 'transfer.create');
      const response = await this.repository.insert(transaction, {
        id: randomUUID(),
        organizationId,
        businessNumber: await this.repository.nextNumber(transaction, organizationId),
        actorUserId,
        dto,
        destinationAmount: derived.destinationAmount,
        rate: derived.rate,
        assets: facts.assets,
      });
      await this.repository.finishIdempotency(transaction, organizationId, scope, key, response);
      return response;
    }));
  }

  list(
    organizationId: string,
    actorUserId: string,
    rawLimit?: string,
    rawCursor?: string,
  ): Promise<TransferPage> {
    const limit = this.limit(rawLimit);
    const cursor = this.cursor(rawCursor);
    return this.map(() => this.database.db.transaction(async (transaction) => {
      const ids = await this.repository.visibleIds(transaction, organizationId, actorUserId, limit + 1, cursor);
      const items = await this.repository.views(transaction, organizationId, ids.slice(0, limit));
      const last = items.at(-1);
      return {
        items,
        page: {
          limit,
          hasMore: ids.length > limit,
          ...(ids.length > limit && last ? { nextCursor: this.encodeCursor({ businessDate: last.businessDate, id: last.id }) } : {}),
          asOf: new Date().toISOString(),
        },
      };
    }));
  }

  submit(
    organizationId: string,
    actorUserId: string,
    transferId: string,
    rawKey: string,
    rawIfMatch: string,
    requestId: string,
  ): Promise<TransferView> {
    this.uuid(transferId);
    this.requiredRequestId(requestId);
    const key = this.key(rawKey);
    const expectedVersion = this.ifMatch(rawIfMatch);
    const scope = `submitTransfer:${actorUserId}:${transferId}`;
    const digest = commandDigest('submitTransfer', { actorUserId, transferId, ifMatch: rawIfMatch });
    return this.map(() => this.database.db.transaction(async (transaction) => {
      await this.repository.acquireIdempotencyLock(transaction, organizationId, scope, key);
      const replay = await this.repository.findIdempotency<TransferView>(transaction, organizationId, scope, key);
      if (replay) {
        if (replay.requestDigest !== digest || !replay.response) throw new Error('IDEMPOTENCY_CONFLICT');
        await this.authorizeView(transaction, organizationId, actorUserId, replay.response, 'transfer.submit');
        return replay.response;
      }
      await this.repository.startIdempotency(transaction, organizationId, scope, key, digest);
      const locked = await this.repository.lock(transaction, organizationId, transferId);
      if (!locked) throw new Error('RESOURCE_HIDDEN');
      if (locked.state !== 'DRAFT') throw new Error('STATE_CONFLICT');
      if (locked.version !== expectedVersion) throw new Error('STALE_VERSION');
      const view = (await this.repository.views(transaction, organizationId, [transferId]))[0]!;
      const dto = this.dto(view);
      const facts = await this.repository.facts(transaction, organizationId, view.creatorUserId, dto, new Date());
      this.validateFrozen(view, dto, facts);
      await this.assertAuthorized(transaction, organizationId, actorUserId, view, facts, 'transfer.submit');
      const policy = uniqueMaximal(await this.repository.policies(
        transaction,
        organizationId,
        facts.source!.branchId,
        facts.source!.treasuryUnitId,
        view.sourceMoney.currency,
        view.sourceMoney.amount,
      ));
      if (!policy || policy.steps.some((step) =>
        (step.roleId && step.roleState !== 'ACTIVE')
        || (step.approverUserId && step.approverState !== 'ACTIVE'))
      ) throw new Error('APPROVAL_POLICY_UNAVAILABLE');
      this.validatePolicy(policy);
      const snapshotId = randomUUID();
      await this.repository.insertSnapshot(transaction, {
        id: snapshotId,
        organizationId,
        transferId,
        documentVersion: view.version + 1,
        amount: view.sourceMoney.amount,
        currency: view.sourceMoney.currency,
        policy,
        evaluatedAt: new Date(),
      });
      const custodians = policy.steps.length
        ? undefined
        : await this.requiredCustodians(transaction, organizationId, view);
      await this.repository.completeSubmission(
        transaction,
        organizationId,
        transferId,
        snapshotId,
        policy.steps.length ? 'REQUESTED' : 'APPROVED',
        custodians,
      );
      const response = (await this.repository.views(transaction, organizationId, [transferId]))[0]!;
      await this.repository.finishIdempotency(transaction, organizationId, scope, key, response);
      return response;
    }));
  }

  act(
    organizationId: string,
    actorUserId: string,
    transferId: string,
    dto: TransferApprovalActionDto,
    rawKey: string,
    rawIfMatch: string,
    requestId: string,
  ): Promise<TransferView> {
    this.uuid(transferId);
    this.requiredRequestId(requestId);
    this.validateAction(dto);
    const key = this.key(rawKey);
    const expectedVersion = this.ifMatch(rawIfMatch);
    const permission = dto.action === TransferApprovalAction.APPROVE ? 'transfer.approve' as const : 'transfer.reject' as const;
    const scope = `actOnTransferApproval:${actorUserId}:${transferId}`;
    const digest = commandDigest('actOnTransferApproval', { actorUserId, transferId, ifMatch: rawIfMatch, body: dto });
    return this.map(() => this.database.db.transaction(async (transaction) => {
      await this.repository.acquireIdempotencyLock(transaction, organizationId, scope, key);
      const replay = await this.repository.findIdempotency<TransferView>(transaction, organizationId, scope, key);
      if (replay) {
        if (replay.requestDigest !== digest || !replay.response) throw new Error('IDEMPOTENCY_CONFLICT');
        const expectedAction = dto.action === TransferApprovalAction.APPROVE ? 'APPROVED' : 'REJECTED';
        const recorded = [...(replay.response.approvalSnapshot?.actions ?? [])].reverse().find((action) =>
          action.actorUserId === actorUserId && action.action === expectedAction);
        if (!recorded) throw new Error('IDEMPOTENCY_CONFLICT');
        const step = replay.response.approvalSnapshot?.steps.find(({ order }) => order === recorded.stepOrder);
        if (!step) throw new Error('IDEMPOTENCY_CONFLICT');
        const facts = await this.repository.facts(transaction, organizationId, replay.response.creatorUserId, this.dto(replay.response), new Date());
        const authority = await this.assertAuthorized(transaction, organizationId, actorUserId, replay.response, facts, permission, step.roleId, step.approverUserId);
        if (authority.delegatedFromUserId !== recorded.delegatedFromUserId) throw new Error('SCOPE_DENIED');
        await this.assertStepEligible(transaction, organizationId, replay.response, { approverUserId: step.approverUserId ?? null, separationRules: step.separationRules }, actorUserId, authority);
        return replay.response;
      }
      await this.repository.startIdempotency(transaction, organizationId, scope, key, digest);
      const locked = await this.repository.lock(transaction, organizationId, transferId);
      if (!locked) throw new Error('RESOURCE_HIDDEN');
      if (locked.version !== expectedVersion) throw new Error('STALE_VERSION');
      if (locked.state !== 'REQUESTED' || !locked.currentApprovalSnapshotId) throw new Error('STATE_CONFLICT');
      const steps = await this.repository.currentSteps(transaction, organizationId, locked.currentApprovalSnapshotId);
      const current = steps.find(({ approvalsRecorded, approvalsRequired }) => approvalsRecorded < approvalsRequired);
      if (!current) throw new Error('STATE_CONFLICT');
      const view = (await this.repository.views(transaction, organizationId, [transferId]))[0]!;
      const facts = await this.repository.facts(transaction, organizationId, view.creatorUserId, this.dto(view), new Date());
      const authority = await this.assertAuthorized(transaction, organizationId, actorUserId, view, facts, permission, current.roleId ?? undefined, current.approverUserId);
      await this.assertStepEligible(transaction, organizationId, view, current, actorUserId, authority);
      await this.repository.insertAction(
        transaction,
        organizationId,
        locked.currentApprovalSnapshotId,
        current,
        actorUserId,
        authority.delegatedFromUserId,
        dto.action === TransferApprovalAction.APPROVE ? 'APPROVED' : 'REJECTED',
        dto.reason?.trim(),
      );
      let state: 'REQUESTED' | 'APPROVED' | 'REJECTED';
      let custodians: { source: string; destination: string } | undefined;
      if (dto.action === TransferApprovalAction.REJECT) state = 'REJECTED';
      else {
        const complete = current.approvalsRecorded + 1 >= current.approvalsRequired;
        const hasLater = steps.some(({ order }) => order > current.order);
        state = complete && !hasLater ? 'APPROVED' : 'REQUESTED';
        if (state === 'APPROVED') {
          custodians = await this.requiredCustodians(transaction, organizationId, view);
          await this.assertCustodianSeparation(transaction, organizationId, transferId, custodians.source);
        }
      }
      await this.repository.completeAction(transaction, organizationId, transferId, state, custodians);
      const response = (await this.repository.views(transaction, organizationId, [transferId]))[0]!;
      await this.repository.finishIdempotency(transaction, organizationId, scope, key, response);
      return response;
    }));
  }

  release(
    organizationId: string,
    actorUserId: string,
    transferId: string,
    rawKey: string,
    rawIfMatch: string,
    requestId: string,
  ): Promise<TransferView> {
    this.uuid(transferId);
    this.requiredRequestId(requestId);
    const key = this.key(rawKey);
    const expectedVersion = this.ifMatch(rawIfMatch);
    const scope = `releaseTransfer:${actorUserId}:${transferId}`;
    const digest = commandDigest('releaseTransfer', { actorUserId, transferId, ifMatch: rawIfMatch });
    return this.map(() => this.database.db.transaction(async (transaction) => {
      await this.repository.acquireIdempotencyLock(transaction, organizationId, scope, key);
      const replay = await this.repository.findIdempotency<TransferView>(transaction, organizationId, scope, key);
      if (replay) {
        if (replay.requestDigest !== digest || !replay.response?.release) throw new Error('IDEMPOTENCY_CONFLICT');
        await this.assertCustodyCommand(transaction, organizationId, actorUserId, replay.response, 'transfer.release', 'source');
        return replay.response;
      }
      await this.repository.startIdempotency(transaction, organizationId, scope, key, digest);
      const locked = await this.repository.lock(transaction, organizationId, transferId);
      if (!locked) throw new Error('RESOURCE_HIDDEN');
      if (locked.version !== expectedVersion) throw new Error('STALE_VERSION');
      if (locked.state !== 'APPROVED') throw new Error('STATE_CONFLICT');
      const view = (await this.repository.views(transaction, organizationId, [transferId]))[0]!;
      await this.assertCustodyCommand(transaction, organizationId, actorUserId, view, 'transfer.release', 'source');
      const availability = await this.repository.sourceAvailability(transaction, view);
      if (!this.sourceAvailable(view, availability) || view.assets.some(({ state }) => state !== 'PLANNED')) {
        throw new Error('SOURCE_UNAVAILABLE');
      }
      const releasedAt = new Date();
      const sourceMovementFactId = await this.effects.appendMovement(transaction, {
        organizationId,
        owner: 'domain.transfers',
        sourceType: 'Transfer',
        sourceId: transferId,
        effectKey: 'SOURCE_RELEASE',
        endpointType: view.source.type,
        endpointId: view.source.id,
        direction: 'DEBIT',
        amount: view.sourceMoney.amount,
        currency: view.sourceMoney.currency,
        businessDate: view.businessDate,
        state: 'POSTED',
      });
      await this.repository.recordRelease(transaction, {
        organizationId, transferId, actorUserId, releasedAt, sourceMovementFactId, view,
      });
      await this.effects.appendAudit(transaction, {
        organizationId, requestId, actorUserId, entityType: 'Transfer', entityId: transferId, action: 'TRANSFER_RELEASED',
      });
      const response = (await this.repository.views(transaction, organizationId, [transferId]))[0]!;
      await this.repository.finishIdempotency(transaction, organizationId, scope, key, response);
      return response;
    }));
  }

  acknowledge(
    organizationId: string,
    actorUserId: string,
    transferId: string,
    dto: TransferAcknowledgeDto,
    rawKey: string,
    rawIfMatch: string,
    requestId: string,
  ): Promise<TransferView> {
    this.uuid(transferId);
    this.requiredRequestId(requestId);
    this.validateAcknowledgement(dto);
    const key = this.key(rawKey);
    const expectedVersion = this.ifMatch(rawIfMatch);
    const scope = `acknowledgeTransfer:${actorUserId}:${transferId}`;
    const digest = commandDigest('acknowledgeTransfer', { actorUserId, transferId, ifMatch: rawIfMatch, body: dto });
    return this.map(() => this.database.db.transaction(async (transaction) => {
      await this.repository.acquireIdempotencyLock(transaction, organizationId, scope, key);
      const replay = await this.repository.findIdempotency<TransferView>(transaction, organizationId, scope, key);
      if (replay) {
        if (replay.requestDigest !== digest || !replay.response?.receipt) throw new Error('IDEMPOTENCY_CONFLICT');
        await this.assertCustodyCommand(transaction, organizationId, actorUserId, replay.response, 'transfer.receive', 'destination');
        return replay.response;
      }
      await this.repository.startIdempotency(transaction, organizationId, scope, key, digest);
      const locked = await this.repository.lock(transaction, organizationId, transferId);
      if (!locked) throw new Error('RESOURCE_HIDDEN');
      if (locked.version !== expectedVersion) throw new Error('STALE_VERSION');
      if (locked.state !== 'IN_TRANSIT') {
        if (locked.receivedByUserId) throw new Error('ALREADY_ACKNOWLEDGED');
        throw new Error('STATE_CONFLICT');
      }
      const view = (await this.repository.views(transaction, organizationId, [transferId]))[0]!;
      const facts = await this.assertCustodyCommand(transaction, organizationId, actorUserId, view, 'transfer.receive', 'destination');
      const recordedAt = new Date();
      const receivedAt = new Date(dto.receivedAt);
      if (!view.release || receivedAt < new Date(view.release.releasedAt) || receivedAt > recordedAt
        || dto.receivedMoney.currency !== view.destinationMoney.currency
        || decimalPlaces(dto.receivedMoney.amount) > facts.currencies.find(({ code }) => code === dto.receivedMoney.currency)!.decimalPlaces) {
        throw new Error('RECEIPT_INVALID');
      }
      const expectedAssets = view.assets.map(({ id }) => id);
      const receivedAssetIds = dto.receivedAssetIds ?? [];
      if (view.assets.some(({ state }) => state !== 'RELEASED')
        || receivedAssetIds.some((id) => !expectedAssets.includes(id))) throw new Error('RECEIPT_INVALID');
      const exact = compareDecimal(dto.receivedMoney.amount, view.destinationMoney.amount) === 0
        && expectedAssets.length === receivedAssetIds.length
        && expectedAssets.every((id) => receivedAssetIds.includes(id));
      const reason = dto.discrepancyReason?.trim();
      if ((exact && reason) || (!exact && !reason)) throw new Error('RECEIPT_INVALID');
      const evidence = await this.repository.evidence(transaction, organizationId, dto.attachments ?? []);
      if (evidence.length !== (dto.attachments?.length ?? 0)
        || (dto.attachments ?? []).some((input) => !evidence.some((row) => row.id === input.id
          && row.contentDigest === input.contentDigest && row.state === 'ACTIVE'))) throw new Error('RECEIPT_INVALID');
      const destinationMovementFactId = exact ? await this.effects.appendMovement(transaction, {
        organizationId,
        owner: 'domain.transfers',
        sourceType: 'Transfer',
        sourceId: transferId,
        effectKey: 'DESTINATION_RECEIPT',
        endpointType: view.destination.type,
        endpointId: view.destination.id,
        direction: 'CREDIT',
        amount: view.destinationMoney.amount,
        currency: view.destinationMoney.currency,
        businessDate: view.businessDate,
        state: 'POSTED',
      }) : undefined;
      await this.repository.recordAcknowledgement(transaction, {
        organizationId, transferId, actorUserId, recordedAt, receivedAt,
        receivedAmount: dto.receivedMoney.amount, receivedCurrency: dto.receivedMoney.currency,
        receivedAssetIds, discrepancyAmount: decimalDifference(view.destinationMoney.amount, dto.receivedMoney.amount),
        discrepancyReason: reason, attachments: dto.attachments ?? [], destinationMovementFactId,
      });
      await this.effects.appendAudit(transaction, {
        organizationId, requestId, actorUserId, entityType: 'Transfer', entityId: transferId,
        action: exact ? 'TRANSFER_COMPLETED' : 'TRANSFER_DISCREPANCY', reason,
      });
      if (exact) {
        const eventId = randomUUID();
        await this.effects.appendOutbox(transaction, {
          organizationId,
          aggregateType: 'Transfer',
          aggregateId: transferId,
          aggregateVersion: view.version + 1,
          eventType: 'treasury.transfer.completed.v1',
          payload: {
            specVersion: '1.0', eventId, eventType: 'treasury.transfer.completed.v1',
            occurredAt: recordedAt.toISOString(), organizationId, aggregateType: 'Transfer',
            aggregateId: transferId, aggregateVersion: view.version + 1, correlationId: eventId,
            actorId: actorUserId,
            data: { sourceType: 'Transfer', sourceId: transferId, sourceVersion: view.version + 1,
              businessDate: view.businessDate, money: view.destinationMoney, state: 'COMPLETED', previousState: 'IN_TRANSIT', requestId },
          },
        });
      }
      const response = (await this.repository.views(transaction, organizationId, [transferId]))[0]!;
      await this.repository.finishIdempotency(transaction, organizationId, scope, key, response);
      return response;
    }));
  }

  private async assertCustodyCommand(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    view: TransferView,
    permission: 'transfer.release' | 'transfer.receive',
    side: 'source' | 'destination',
  ): Promise<TransferFacts> {
    const facts = await this.repository.facts(transaction, organizationId, view.creatorUserId, this.dto(view), new Date());
    const current = await this.requiredCustodians(transaction, organizationId, view);
    if (current.source !== view.sourceCustodianUserId || current.destination !== view.destinationCustodianUserId
      || actorUserId !== (side === 'source' ? view.sourceCustodianUserId : view.destinationCustodianUserId)
      || (view.release && view.release.releasedByUserId !== view.sourceCustodianUserId)) {
      throw new Error('CUSTODIAN_UNAVAILABLE');
    }
    await this.assertAuthorized(transaction, organizationId, actorUserId, view, facts, permission);
    return facts;
  }

  private sourceAvailable(view: TransferView, fact: TransferSourceAvailability | undefined): boolean {
    if (!fact || fact.state !== 'ACTIVE' || !fact.canTransfer || !fact.active) return false;
    const amount = decimalValue(view.sourceMoney.amount);
    if (fact.transactionCeiling !== null && amount > decimalValue(fact.transactionCeiling)) return false;
    return fact.minimumPosition === null
      || decimalValue(fact.position) - decimalValue(fact.reserved) - amount >= decimalValue(fact.minimumPosition);
  }

  private validateAcknowledgement(dto: TransferAcknowledgeDto): void {
    if (!dto || containsNull(dto) || !dto.receivedMoney
      || !NON_NEGATIVE_DECIMAL.test(dto.receivedMoney.amount ?? '')
      || !/^[A-Z0-9]{3,8}$/u.test(dto.receivedMoney.currency ?? '')
      || !Number.isFinite(new Date(dto.receivedAt).getTime())) {
      this.validation('Transfer acknowledgement contains invalid receipt facts.');
    }
    if (new Set(dto.receivedAssetIds ?? []).size !== (dto.receivedAssetIds?.length ?? 0)
      || new Set((dto.attachments ?? []).map(({ id }) => id)).size !== (dto.attachments?.length ?? 0)
      || (dto.discrepancyReason !== undefined && !dto.discrepancyReason.trim())) {
      this.validation('Transfer acknowledgement contains duplicate or empty evidence.');
    }
  }

  private derive(dto: TransferCreateDto, facts: TransferFacts, commandAt: Date) {
    this.validateFacts(dto, facts);
    const target = facts.currencies.find(({ code }) => code === dto.destinationCurrency)!;
    if (dto.sourceMoney.currency === dto.destinationCurrency) {
      const rate: TransferRateSnapshot = {
        sourceCurrency: dto.sourceMoney.currency,
        targetCurrency: dto.destinationCurrency,
        rate: '1',
        rateType: 'IDENTITY',
        rateSource: 'IDENTITY',
        ratedAt: commandAt.toISOString(),
        targetAmount: dto.sourceMoney.amount,
        roundingDifference: '0',
      };
      return { destinationAmount: dto.sourceMoney.amount, rate };
    }
    const latest = facts.rates[0]?.validAt;
    const selected = latest ? facts.rates.filter(({ validAt }) => validAt.getTime() === latest.getTime()) : [];
    if (selected.length !== 1) throw new Error('RATE_INVALID');
    const row = selected[0]!;
    const derived = deriveTarget(dto.sourceMoney.amount, row.rate, target.decimalPlaces);
    return {
      destinationAmount: derived.targetAmount,
      rate: {
        sourceCurrency: dto.sourceMoney.currency,
        targetCurrency: dto.destinationCurrency,
        rate: row.rate,
        rateType: row.rateType,
        rateSource: 'TABLE' as const,
        ratedAt: row.validAt.toISOString(),
        rateRecordId: row.id,
        targetAmount: derived.targetAmount,
        roundingDifference: derived.roundingDifference,
      },
    };
  }

  private validateFrozen(view: TransferView, dto: TransferCreateDto, facts: TransferFacts): void {
    this.validateFacts(dto, facts);
    const target = facts.currencies.find(({ code }) => code === dto.destinationCurrency)!;
    const rate = view.rateSnapshot;
    if (rate.sourceCurrency !== dto.sourceMoney.currency || rate.targetCurrency !== dto.destinationCurrency
      || compareDecimal(rate.targetAmount, view.destinationMoney.amount) !== 0) throw new Error('RATE_INVALID');
    if (rate.rateSource === 'IDENTITY') {
      if (dto.sourceMoney.currency !== dto.destinationCurrency || rate.rateRecordId
        || compareDecimal(rate.rate, '1') !== 0 || compareDecimal(rate.roundingDifference, '0') !== 0
        || compareDecimal(dto.sourceMoney.amount, view.destinationMoney.amount) !== 0) throw new Error('RATE_INVALID');
      return;
    }
    const stored = facts.rates.filter(({ id, validAt }) => id === rate.rateRecordId
      && validAt.toISOString() === rate.ratedAt);
    const derived = deriveTarget(dto.sourceMoney.amount, rate.rate, target.decimalPlaces);
    if (stored.length !== 1 || stored[0]!.rate !== rate.rate || stored[0]!.rateType !== rate.rateType
      || compareDecimal(derived.targetAmount, view.destinationMoney.amount) !== 0
      || compareDecimal(derived.roundingDifference, rate.roundingDifference) !== 0) throw new Error('RATE_INVALID');
  }

  private validateFacts(dto: TransferCreateDto, facts: TransferFacts): void {
    if (!facts.organization || !facts.creator || !facts.source || !facts.destination) throw new Error('RESOURCE_HIDDEN');
    if (facts.creator.state !== 'ACTIVE' || facts.source.state !== 'ACTIVE' || facts.destination.state !== 'ACTIVE') throw new Error('INACTIVE_REFERENCE');
    if (!facts.source.canTransfer || !facts.destination.canTransfer) throw new Error('TRANSFER_INVALID');
    if (dto.source.type === dto.destination.type && dto.source.id === dto.destination.id) throw new Error('TRANSFER_INVALID');
    if (!routeMatches(dto.route, dto.source.type, dto.destination.type)) throw new Error('TRANSFER_INVALID');
    if (facts.currencies.length !== new Set([dto.sourceMoney.currency, dto.destinationCurrency]).size
      || facts.currencies.some(({ state }) => state !== 'ACTIVE')) throw new Error('RESOURCE_HIDDEN');
    const sourceCurrency = facts.currencies.find(({ code }) => code === dto.sourceMoney.currency)!;
    if (decimalPlaces(dto.sourceMoney.amount) > sourceCurrency.decimalPlaces) throw new Error('VALIDATION');
    if (facts.source.currencies.length && !facts.source.currencies.includes(dto.sourceMoney.currency)) throw new Error('TRANSFER_INVALID');
    if (facts.destination.currencies.length && !facts.destination.currencies.includes(dto.destinationCurrency)) throw new Error('TRANSFER_INVALID');
    const attachments = new Map(facts.attachments.map((item) => [`${item.id}:${item.contentDigest}`, item]));
    for (const input of dto.attachments ?? []) {
      const attachment = attachments.get(`${input.id}:${input.contentDigest}`);
      if (!attachment) throw new Error('TRANSFER_INVALID');
      if (attachment.state !== 'ACTIVE') throw new Error('INACTIVE_REFERENCE');
    }
    if (facts.assets.length !== (dto.assets?.length ?? 0)) throw new Error('TRANSFER_INVALID');
    if (facts.assets.some(({ type, state }) =>
      (type === 'DOCUMENT' && state !== 'ACTIVE')
      || (type === 'RECEIVED_CHEQUE' && ['RETURNED_TO_PARTY', 'ASSIGNED', 'LOST', 'CANCELLED'].includes(state)))) {
      throw new Error('INACTIVE_REFERENCE');
    }
  }

  private async authorizeView(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    view: TransferView,
    permission: 'transfer.submit' | 'transfer.approve' | 'transfer.reject',
  ): Promise<PaymentAuthority> {
    const facts = await this.repository.facts(transaction, organizationId, view.creatorUserId, this.dto(view), new Date());
    return this.assertAuthorized(transaction, organizationId, actorUserId, view, facts, permission);
  }

  private async assertAuthorized(
    transaction: DatabaseTransaction,
    organizationId: string,
    actorUserId: string,
    view: Pick<TransferView, 'sourceMoney'>,
    facts: TransferFacts,
    permission: 'transfer.create' | 'transfer.submit' | 'transfer.approve' | 'transfer.reject' | 'transfer.release' | 'transfer.receive',
    roleId?: string,
    requiredAuthorityUserId?: string | null,
  ): Promise<PaymentAuthority> {
    const authority = await this.authorization.resolveTransferAuthority(
      transaction,
      organizationId,
      actorUserId,
      this.context(facts, view.sourceMoney.amount, view.sourceMoney.currency),
      permission,
      roleId,
      requiredAuthorityUserId,
    );
    if (!authority) throw new Error('SCOPE_DENIED');
    return authority;
  }

  private async assertStepEligible(
    transaction: DatabaseTransaction,
    organizationId: string,
    view: TransferView,
    step: { approverUserId: string | null; separationRules: string[] },
    actorUserId: string,
    authority: PaymentAuthority,
  ): Promise<void> {
    const subjects = new Set([actorUserId, ...(authority.delegatedFromUserId ? [authority.delegatedFromUserId] : [])]);
    if (step.approverUserId && !subjects.has(step.approverUserId)) throw new Error('SCOPE_DENIED');
    if (step.separationRules.includes('CREATOR_NOT_APPROVER') && subjects.has(view.creatorUserId)) throw new Error('SCOPE_DENIED');
    if (step.separationRules.includes('SOURCE_CUSTODIAN_NOT_APPROVER')) {
      const custodian = await this.repository.custodian(transaction, organizationId, view.source);
      if (!custodian) throw new Error('CUSTODIAN_UNAVAILABLE');
      if (subjects.has(custodian)) throw new Error('SCOPE_DENIED');
    }
  }

  private async assertCustodianSeparation(
    transaction: DatabaseTransaction,
    organizationId: string,
    transferId: string,
    sourceCustodian: string,
  ): Promise<void> {
    const view = (await this.repository.views(transaction, organizationId, [transferId]))[0]!;
    for (const step of view.approvalSnapshot?.steps ?? []) {
      if (!step.separationRules.includes('SOURCE_CUSTODIAN_NOT_APPROVER')) continue;
      if ((view.approvalSnapshot?.actions ?? []).some(({ stepOrder, actorUserId, delegatedFromUserId }) =>
        stepOrder === step.order && (actorUserId === sourceCustodian || delegatedFromUserId === sourceCustodian))) {
        throw new Error('SCOPE_DENIED');
      }
    }
  }

  private async requiredCustodians(
    transaction: DatabaseTransaction,
    organizationId: string,
    view: TransferView,
  ): Promise<{ source: string; destination: string }> {
    const custodians = await this.repository.custodians(transaction, organizationId, view.source, view.destination);
    if (!custodians) throw new Error('CUSTODIAN_UNAVAILABLE');
    return custodians;
  }

  private validateDto(dto: TransferCreateDto): void {
    if (containsNull(dto)) this.validation('Optional Transfer fields must be omitted, not null.');
    if (!dto.purpose.trim()) this.validation('Transfer purpose must contain visible characters.');
    if (dto.accountingDimensions && Object.keys(dto.accountingDimensions).length) this.validation('Accounting dimensions do not accept properties.');
  }

  private validateAction(dto: TransferApprovalActionDto): void {
    if (dto.action === TransferApprovalAction.REJECT && !dto.reason?.trim()) this.validation('REJECT requires a non-empty reason.');
    if (dto.reason !== undefined && !dto.reason.trim()) this.validation('Approval reasons must be non-empty when supplied.');
  }

  private validatePolicy(policy: TransferPolicy): void {
    const orders = policy.steps.map(({ order }) => order);
    if (new Set(orders).size !== orders.length || orders.some((order, index) => order !== index + 1)) throw new Error('APPROVAL_POLICY_UNAVAILABLE');
    if (policy.steps.some((step) => !step.roleId && !step.approverUserId)) throw new Error('APPROVAL_POLICY_UNAVAILABLE');
    if (policy.steps.some(({ separationRules }) => separationRules.some((rule) => !['CREATOR_NOT_APPROVER', 'SOURCE_CUSTODIAN_NOT_APPROVER'].includes(rule)))) throw new Error('APPROVAL_POLICY_UNAVAILABLE');
  }

  private context(facts: TransferFacts, amount: string, currency: string): TransferAuthorizationContext {
    const endpoints = [facts.source!, facts.destination!];
    return {
      branchIds: [...new Set(endpoints.flatMap(({ branchId }) => branchId ? [branchId] : []))],
      treasuryUnitIds: [...new Set(endpoints.flatMap(({ treasuryUnitId }) => treasuryUnitId ? [treasuryUnitId] : []))],
      cashboxIds: endpoints.filter(({ type }) => type === TransferEndpointType.CASHBOX).map(({ id }) => id),
      bankAccountIds: endpoints.filter(({ type }) => type === TransferEndpointType.BANK_ACCOUNT).map(({ id }) => id),
      currencies: [...new Set(facts.currencies.map(({ code }) => code))],
      amount,
      amountCurrency: currency,
    };
  }

  private dto(view: TransferView): TransferCreateDto {
    return {
      businessDate: view.businessDate,
      route: view.route,
      source: { type: view.source.type, id: view.source.id },
      destination: { type: view.destination.type, id: view.destination.id },
      sourceMoney: view.sourceMoney,
      destinationCurrency: view.destinationMoney.currency,
      expectedReceiptAt: view.expectedReceiptAt,
      purpose: view.purpose,
      accountingDimensions: view.accountingDimensions,
      assets: view.assets.map(({ type, id, quantity }) => ({ type, id, quantity })),
      attachments: view.attachments.map(({ attachmentId, digest, purpose }) => ({ id: attachmentId, contentDigest: digest, purpose })),
    };
  }

  private limit(raw?: string): number {
    if (!raw) return 50;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 500) this.validation('limit must be an integer from 1 through 500.');
    return value;
  }

  private cursor(value?: string): { businessDate: string; id: string } | undefined {
    if (!value) return undefined;
    try {
      if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error();
      const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
      if (!Array.isArray(decoded) || decoded.length !== 2 || typeof decoded[0] !== 'string'
        || !DATE.test(decoded[0]) || typeof decoded[1] !== 'string' || !UUID.test(decoded[1])) throw new Error();
      return { businessDate: decoded[0], id: decoded[1] };
    } catch {
      this.validation('cursor is malformed.');
    }
  }

  private encodeCursor(cursor: { businessDate: string; id: string }): string {
    return Buffer.from(JSON.stringify([cursor.businessDate, cursor.id])).toString('base64url');
  }

  private uuid(value: string): void { if (!UUID.test(value)) this.validation('resourceId is malformed.'); }
  private key(value: string | undefined): string {
    if (!value || value.length < 8 || value.length > 128) this.validation('Idempotency-Key must contain 8 through 128 characters.');
    return value;
  }
  private requiredRequestId(value: string | undefined): string {
    if (!value || value.length > 128) this.validation('X-Request-Id must contain 1 through 128 characters.');
    return value;
  }
  private ifMatch(value: string | undefined): number {
    const match = value?.match(/^"([0-9]+)"$/u);
    const version = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(version)) this.validation('If-Match must be one strong numeric version tag.');
    return version;
  }
  private validation(detail: string): never { throw new TreasuryProblem('TRS-GEN-001', 422, detail); }

  private async map<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (error) {
      if (error instanceof TreasuryProblem) throw error;
      const mapped = {
        IDEMPOTENCY_CONFLICT: ['TRS-GEN-007', 409],
        SCOPE_DENIED: ['TRS-GEN-003', 403],
        RESOURCE_HIDDEN: ['TRS-GEN-004', 404],
        INACTIVE_REFERENCE: ['TRS-MST-001', 409],
        RATE_INVALID: ['TRS-MST-003', 422],
        TRANSFER_INVALID: ['TRS-TRF-001', 422],
        SOURCE_UNAVAILABLE: ['TRS-TRF-002', 409],
        RECEIPT_INVALID: ['TRS-TRF-003', 422],
        ALREADY_ACKNOWLEDGED: ['TRS-TRF-004', 409],
        CUSTODIAN_UNAVAILABLE: ['TRS-TRF-005', 409],
        APPROVAL_POLICY_UNAVAILABLE: ['TRS-TRF-006', 409],
        STATE_CONFLICT: ['TRS-GEN-005', 409],
        STALE_VERSION: ['TRS-GEN-006', 409],
        VALIDATION: ['TRS-GEN-001', 422],
      } as const;
      const message = error instanceof Error ? error.message : '';
      const problem = mapped[message as keyof typeof mapped];
      if (problem) throw new TreasuryProblem(problem[0], problem[1]);
      const databaseError = error as { code?: string };
      if (databaseError.code === '23505') throw new TreasuryProblem('TRS-GEN-005', 409);
      if (databaseError.code === '23503') throw new TreasuryProblem('TRS-GEN-004', 404);
      if (['22003', '22P02', '23514'].includes(databaseError.code ?? '')) throw new TreasuryProblem('TRS-GEN-001', 422);
      throw error;
    }
  }
}

function routeMatches(route: TransferRoute, source: TransferEndpointType, destination: TransferEndpointType): boolean {
  const exact: Partial<Record<TransferRoute, [TransferEndpointType, TransferEndpointType]>> = {
    CASHBOX_TO_CASHBOX: [TransferEndpointType.CASHBOX, TransferEndpointType.CASHBOX],
    CASHBOX_TO_BANK: [TransferEndpointType.CASHBOX, TransferEndpointType.BANK_ACCOUNT],
    BANK_TO_CASHBOX: [TransferEndpointType.BANK_ACCOUNT, TransferEndpointType.CASHBOX],
    BANK_TO_BANK: [TransferEndpointType.BANK_ACCOUNT, TransferEndpointType.BANK_ACCOUNT],
    CASHBOX_TO_USER: [TransferEndpointType.CASHBOX, TransferEndpointType.USER],
    USER_TO_CASHBOX: [TransferEndpointType.USER, TransferEndpointType.CASHBOX],
    USER_TO_USER: [TransferEndpointType.USER, TransferEndpointType.USER],
  };
  if (exact[route]) return exact[route]![0] === source && exact[route]![1] === destination;
  if (route === TransferRoute.PETTY_CASH) return (source === TransferEndpointType.CASHBOX && destination === TransferEndpointType.USER)
    || (source === TransferEndpointType.USER && destination === TransferEndpointType.CASHBOX);
  return [source, destination].every((type) => [TransferEndpointType.CASHBOX, TransferEndpointType.BANK_ACCOUNT].includes(type));
}

function uniqueMaximal(candidates: TransferPolicy[]): TransferPolicy | undefined {
  const maximal = candidates.filter((candidate) => !candidates.some((other) => other.id !== candidate.id && dominates(other, candidate)));
  return maximal.length === 1 ? maximal[0] : undefined;
}

function dominates(left: TransferPolicy, right: TransferPolicy): boolean {
  let strict = false;
  for (const key of ['branchId', 'treasuryUnitId', 'currency'] as const) {
    const result = optionalNarrower(left[key], right[key]);
    if (!result.allowed) return false;
    strict ||= result.strict;
  }
  const minimum = lowerNarrower(left.amountMinimum, right.amountMinimum);
  const maximum = upperNarrower(left.amountMaximum, right.amountMaximum);
  return minimum.allowed && maximum.allowed && (strict || minimum.strict || maximum.strict);
}

function optionalNarrower(left: string | null, right: string | null) {
  if (right === null) return { allowed: true, strict: left !== null };
  return { allowed: left === right, strict: false };
}
function lowerNarrower(left: string | null, right: string | null) {
  if (right === null) return { allowed: true, strict: left !== null };
  if (left === null) return { allowed: false, strict: false };
  const comparison = compareDecimal(left, right);
  return { allowed: comparison >= 0, strict: comparison > 0 };
}
function upperNarrower(left: string | null, right: string | null) {
  if (right === null) return { allowed: true, strict: left !== null };
  if (left === null) return { allowed: false, strict: false };
  const comparison = compareDecimal(left, right);
  return { allowed: comparison <= 0, strict: comparison < 0 };
}

function deriveTarget(amount: string, rate: string, targetScale: number): { targetAmount: string; roundingDifference: string } {
  const source = decimalParts(amount);
  const multiplier = decimalParts(rate);
  const numerator = source.value * multiplier.value;
  const denominator = 10n ** BigInt(source.scale + multiplier.scale);
  const target = roundDivision(numerator * 10n ** BigInt(targetScale), denominator);
  const difference = roundSignedDivision(numerator * 100_000_000n - target * denominator * 10n ** BigInt(8 - targetScale), denominator);
  return { targetAmount: formatScaled(target, targetScale), roundingDifference: formatScaled(difference, 8) };
}
function containsNull(value: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.some(containsNull);
  return Boolean(value && typeof value === 'object' && Object.values(value as Record<string, unknown>).some(containsNull));
}
function decimalPlaces(value: string): number {
  return value.split('.')[1]?.replace(/0+$/u, '').length ?? 0;
}
function compareDecimal(left: string, right: string): number {
  const a = decimalParts(left); const b = decimalParts(right); const scale = Math.max(a.scale, b.scale);
  const av = a.value * 10n ** BigInt(scale - a.scale); const bv = b.value * 10n ** BigInt(scale - b.scale);
  return av < bv ? -1 : av > bv ? 1 : 0;
}
function decimalParts(value: string): { value: bigint; scale: number } {
  const [whole, fraction = ''] = value.split('.');
  return { value: BigInt(`${whole}${fraction}`), scale: fraction.length };
}
function decimalValue(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const scaled = BigInt(whole) * 1_000_000_000_000n + BigInt(fraction.padEnd(12, '0'));
  return negative ? -scaled : scaled;
}
function decimalDifference(left: string, right: string): string {
  const a = decimalParts(left); const b = decimalParts(right); const scale = Math.max(a.scale, b.scale);
  const difference = a.value * 10n ** BigInt(scale - a.scale) - b.value * 10n ** BigInt(scale - b.scale);
  const formatted = formatScaled(difference < 0n ? -difference : difference, scale);
  return formatted.includes('.') ? formatted.replace(/0+$/u, '').replace(/\.$/u, '') : formatted;
}
function roundDivision(numerator: bigint, denominator: bigint): bigint { return (numerator + denominator / 2n) / denominator; }
function roundSignedDivision(numerator: bigint, denominator: bigint): bigint { return numerator < 0n ? -roundDivision(-numerator, denominator) : roundDivision(numerator, denominator); }
function formatScaled(value: bigint, scale: number): string {
  const negative = value < 0n; const raw = (negative ? -value : value).toString().padStart(scale + 1, '0');
  return `${negative ? '-' : ''}${scale ? `${raw.slice(0, -scale)}.${raw.slice(-scale)}` : raw}`;
}
