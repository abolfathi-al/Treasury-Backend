import { Inject, Injectable } from '@nestjs/common';

import { commandDigest } from '../common/http';
import { TreasuryProblem } from '../common/problem';
import type { DatabaseTransaction } from '../database/database.service';
import {
  BranchCreateDto,
  CurrencyCreateDto,
  MethodCreateDto,
  PartyCreateDto,
  PartyKind,
  PartyPage,
  PartyView,
  TreasuryUnitCreateDto,
} from './master-data.dto';
import { MasterDataRepository } from './master-data.repository';
import { validateMethodSemantics } from './method-policy';

@Injectable()
export class MasterDataService {
  constructor(@Inject(MasterDataRepository) private readonly repository: MasterDataRepository) {}

  findCurrencyDecimalPlaces(
    transaction: DatabaseTransaction,
    organizationId: string,
    currencyCodes: string[],
  ): Promise<Array<{ currency: string; decimalPlaces: number }>> {
    return this.repository.findCurrencyDecimalPlaces(
      transaction,
      organizationId,
      currencyCodes,
    );
  }

  async organization(organizationId: string): Promise<Record<string, unknown>> {
    const organization = await this.repository.organization(organizationId);
    if (!organization) throw new TreasuryProblem('TRS-GEN-004', 404);
    return organization;
  }

  listBranches(organizationId: string, limit?: string, cursor?: string) {
    return this.repository.listBranches(organizationId, this.limit(limit), this.uuidCursor(cursor));
  }

  createBranch(organizationId: string, dto: BranchCreateDto, key: string) {
    return this.mapCreate(() => this.repository.createBranch(
      organizationId,
      dto,
      this.key(key),
      commandDigest('createBranch', dto),
    ));
  }

  listTreasuryUnits(organizationId: string, limit?: string, cursor?: string) {
    return this.repository.listTreasuryUnits(organizationId, this.limit(limit), this.uuidCursor(cursor));
  }

  createTreasuryUnit(organizationId: string, dto: TreasuryUnitCreateDto, key: string) {
    return this.mapCreate(() => this.repository.createTreasuryUnit(
      organizationId,
      dto,
      this.key(key),
      commandDigest('createTreasuryUnit', dto),
    ));
  }

  listCurrencies(organizationId: string, limit?: string, cursor?: string) {
    return this.repository.listCurrencies(organizationId, this.limit(limit), this.currencyCursor(cursor));
  }

  createCurrency(organizationId: string, dto: CurrencyCreateDto, key: string) {
    return this.mapCreate(() => this.repository.createCurrency(
      organizationId,
      dto,
      this.key(key),
      commandDigest('createCurrency', dto),
    ));
  }

  listParties(organizationId: string, limit?: string, cursor?: string): Promise<PartyPage> {
    return this.repository.listParties(organizationId, this.limit(limit), this.uuidCursor(cursor));
  }

  createParty(
    organizationId: string,
    dto: PartyCreateDto,
    key: string,
  ): Promise<PartyView> {
    if (
      dto.partyKinds.length === 0
      || new Set(dto.partyKinds).size !== dto.partyKinds.length
      || dto.partyKinds.some((kind) => !Object.values(PartyKind).includes(kind))
    ) {
      throw new TreasuryProblem('TRS-GEN-001', 422, 'partyKinds must contain unique supported values.');
    }
    return this.mapCreate(() => this.repository.createParty(
      organizationId,
      dto,
      this.key(key),
      commandDigest('createParty', dto),
    ));
  }

  listMethods(organizationId: string, limit?: string, cursor?: string) {
    return this.repository.listMethods(organizationId, this.limit(limit), this.uuidCursor(cursor));
  }

  createMethod(organizationId: string, dto: MethodCreateDto, key: string) {
    validateMethodSemantics(dto);
    return this.mapCreate(() => this.repository.createMethod(
      organizationId,
      dto,
      this.key(key),
      commandDigest('createMethodDefinition', dto),
    ));
  }

  private limit(raw?: string): number {
    if (!raw) return 50;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 500) {
      throw new TreasuryProblem('TRS-GEN-001', 422, 'limit must be an integer from 1 through 500.');
    }
    return value;
  }

  private key(value: string | undefined): string {
    if (!value || value.length < 8 || value.length > 128) {
      throw new TreasuryProblem('TRS-GEN-001', 422, 'Idempotency-Key must contain 8 through 128 characters.');
    }
    return value;
  }

  private uuidCursor(value?: string): string | undefined {
    if (value && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
      throw new TreasuryProblem('TRS-GEN-001', 422, 'cursor is malformed.');
    }
    return value;
  }

  private currencyCursor(value?: string): string | undefined {
    if (value && !/^[A-Z0-9]{3,8}$/u.test(value)) {
      throw new TreasuryProblem('TRS-GEN-001', 422, 'cursor is malformed.');
    }
    return value;
  }

  private async mapCreate<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof TreasuryProblem) throw error;
      if (error instanceof SyntaxError && error.message === 'IDEMPOTENCY_CONFLICT') {
        throw new TreasuryProblem('TRS-GEN-007', 409);
      }
      if (error instanceof ReferenceError) throw new TreasuryProblem('TRS-MST-001', 409);
      if (error instanceof RangeError && error.message === 'AMOUNT_PRECISION') {
        throw new TreasuryProblem('TRS-MST-004', 422);
      }
      if (error instanceof RangeError) throw new TreasuryProblem('TRS-MST-005', 423);
      if ((error as { code?: string }).code === '23505') {
        throw new TreasuryProblem('TRS-MST-002', 409);
      }
      throw error;
    }
  }
}
