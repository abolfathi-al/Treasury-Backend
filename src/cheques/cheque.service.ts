import { Inject, Injectable } from '@nestjs/common';

import { commandDigest } from '../common/http';
import { TreasuryProblem } from '../common/problem';
import {
  ChequeBookCreateDto,
  ChequeBookView,
  ChequeLeafCommand,
  ChequeLeafSummary,
  ChequeLeafTransitionDto,
} from './cheque.dto';
import { ChequeRepository } from './cheque.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

@Injectable()
export class ChequeService {
  constructor(@Inject(ChequeRepository) private readonly repository: ChequeRepository) {}

  createChequeBook(
    organizationId: string,
    actorUserId: string,
    dto: ChequeBookCreateDto,
    key: string,
    requestId: string,
  ): Promise<ChequeBookView> {
    const normalized = this.validateCreate(dto);
    this.requiredRequestId(requestId);
    return this.run(() => this.repository.createChequeBook(
      organizationId,
      actorUserId,
      normalized,
      this.key(key),
      commandDigest('createChequeBook', { actorUserId, body: normalized }),
    ));
  }

  transitionCheque(
    organizationId: string,
    actorUserId: string,
    chequeBookId: string,
    rawLeafNumber: string,
    dto: ChequeLeafTransitionDto,
    key: string,
    ifMatch: string,
    requestId: string,
  ): Promise<ChequeLeafSummary> {
    if (!UUID.test(chequeBookId)) this.validation('chequeBookId is malformed.');
    const leafNumber = Number(rawLeafNumber);
    if (!Number.isSafeInteger(leafNumber) || leafNumber < 1) {
      this.validation('leafNumber must be a positive safe integer.');
    }
    if (!Object.values(ChequeLeafCommand).includes(dto.command)) {
      this.validation('Cheque Leaf command is invalid.');
    }
    const reason = typeof dto.reason === 'string' ? dto.reason.trim() : '';
    if (!reason || reason.length > 500) {
      this.validation('reason must contain 1 through 500 characters.');
    }
    const normalized = { command: dto.command, reason };
    const expectedVersion = this.ifMatch(ifMatch);
    this.requiredRequestId(requestId);
    return this.run(() => this.repository.transitionCheque(
      organizationId,
      actorUserId,
      chequeBookId,
      leafNumber,
      normalized,
      this.key(key),
      commandDigest('transitionCheque', {
        actorUserId,
        chequeBookId,
        leafNumber,
        ifMatch,
        body: normalized,
      }),
      expectedVersion,
    ));
  }

  private validateCreate(dto: ChequeBookCreateDto): ChequeBookCreateDto {
    const raw = dto as unknown as Record<string, unknown>;
    const series = typeof dto.series === 'string' ? dto.series.trim() : '';
    if (
      ['custodianUserId', 'notes'].some((field) => raw[field] === null)
      || !UUID.test(dto.bankAccountId)
      || (dto.custodianUserId !== undefined && !UUID.test(dto.custodianUserId))
      || !series
      || series.length > 32
      || !Number.isSafeInteger(dto.firstLeaf)
      || !Number.isSafeInteger(dto.lastLeaf)
      || dto.firstLeaf < 1
      || dto.lastLeaf < dto.firstLeaf
      || dto.lastLeaf - dto.firstLeaf > 499
      || !this.date(dto.receivedDate)
      || (dto.notes !== undefined && (
        typeof dto.notes !== 'string' || dto.notes.length > 1000
      ))
    ) this.validation('Cheque Book command is invalid.');
    return { ...dto, series };
  }

  private date(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }

  private key(value: string | undefined): string {
    if (!value || value.length < 8 || value.length > 128) {
      this.validation('Idempotency-Key must contain 8 through 128 characters.');
    }
    return value;
  }

  private requiredRequestId(value: string | undefined): string {
    if (!value || value.length > 128) {
      this.validation('X-Request-Id must contain 1 through 128 characters.');
    }
    return value;
  }

  private ifMatch(value: string | undefined): number {
    const match = value?.match(/^"([0-9]+)"$/u);
    const version = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(version)) {
      this.validation('If-Match must be one strong numeric version tag.');
    }
    return version;
  }

  private validation(detail: string): never {
    throw new TreasuryProblem('TRS-GEN-001', 422, detail);
  }

  private async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof TreasuryProblem) throw error;
      const message = error instanceof Error ? error.message : '';
      if (message === 'IDEMPOTENCY_CONFLICT') {
        throw new TreasuryProblem('TRS-GEN-007', 409);
      }
      if (message === 'SCOPE_DENIED') throw new TreasuryProblem('TRS-GEN-003', 403);
      if (message === 'RESOURCE_HIDDEN') throw new TreasuryProblem('TRS-GEN-004', 404);
      if (message === 'INACTIVE_REFERENCE') throw new TreasuryProblem('TRS-MST-001', 409);
      if (message === 'BANK_ACCOUNT_UNAVAILABLE') {
        throw new TreasuryProblem('TRS-BNK-001', 409);
      }
      if (message === 'RANGE_OVERLAP') throw new TreasuryProblem('TRS-CHQ-002', 409);
      if (message === 'LEAF_UNAVAILABLE') throw new TreasuryProblem('TRS-CHQ-001', 409);
      if (message === 'ILLEGAL_TRANSITION') throw new TreasuryProblem('TRS-CHQ-003', 409);
      if (message === 'STALE_VERSION') throw new TreasuryProblem('TRS-GEN-006', 409);
      const databaseError = error as { code?: string; constraint?: string };
      if (
        databaseError.constraint === 'cheque_books_range_overlap'
        || databaseError.constraint
          === 'cheque_books_bank_account_id_series_first_leaf_last_leaf_key'
      ) throw new TreasuryProblem('TRS-CHQ-002', 409);
      throw error;
    }
  }
}
