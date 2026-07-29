import { Inject, Injectable } from '@nestjs/common';

import { commandDigest, digest } from '../common/http';
import { TreasuryProblem } from '../common/problem';
import {
  PrintTemplateCreateDto,
  PrintTemplateDirection,
  PrintTemplateDocumentKind,
  PrintTemplateLanguage,
  PrintTemplatePage,
  PrintTemplatePageProfile,
  PrintTemplateView,
} from './print-template.dto';
import { canonicalizeJson } from './print-template.jcs';
import {
  PrintTemplateCursor,
  PrintTemplateRepository,
} from './print-template.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CODE = /^[A-Z][A-Z0-9_-]{1,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

@Injectable()
export class PrintTemplateService {
  constructor(
    @Inject(PrintTemplateRepository)
    private readonly repository: PrintTemplateRepository,
  ) {}

  async list(
    organizationId: string,
    actorUserId: string,
    rawLimit?: string,
    rawCursor?: string,
  ): Promise<PrintTemplatePage> {
    const limit = this.limit(rawLimit);
    const result = await this.run(() => this.repository.list(
      organizationId,
      actorUserId,
      limit,
      this.cursor(rawCursor),
    ));
    const last = result.items.at(-1);
    return {
      items: result.items,
      page: {
        limit,
        hasMore: result.hasMore,
        ...(result.hasMore && last ? {
          nextCursor: this.encodeCursor({
            code: last.code,
            templateVersion: last.templateVersion,
            id: last.id,
          }),
        } : {}),
        asOf: new Date().toISOString(),
      },
    };
  }

  create(
    organizationId: string,
    actorUserId: string,
    dto: PrintTemplateCreateDto,
    key: string,
    requestId: string,
  ): Promise<PrintTemplateView> {
    const normalized = this.validateCreate(dto);
    this.requiredRequestId(requestId);
    return this.run(() => this.repository.create(
      organizationId,
      actorUserId,
      normalized,
      this.key(key),
      commandDigest('createPrintTemplate', {
        actorUserId,
        body: {
          ...normalized,
          templateBody: canonicalizeJson(normalized.templateBody),
        },
      }),
    ));
  }

  private validateCreate(dto: PrintTemplateCreateDto): PrintTemplateCreateDto {
    const raw = dto as unknown as Record<string, unknown>;
    if (
      ['treasuryUnitId', 'bankId', 'chequeBookId', 'calibrationXmm', 'calibrationYmm']
        .some((field) => raw[field] === null)
    ) this.validation('Optional properties must be omitted instead of null.');

    const code = typeof dto.code === 'string' ? dto.code.trim().toUpperCase() : '';
    const references = [dto.treasuryUnitId, dto.bankId, dto.chequeBookId]
      .filter((value): value is string => value !== undefined);
    const calibrationXmm = dto.calibrationXmm ?? 0;
    const calibrationYmm = dto.calibrationYmm ?? 0;
    if (
      !CODE.test(code)
      || !Object.values(PrintTemplateDocumentKind).includes(dto.documentKind)
      || !Object.values(PrintTemplateLanguage).includes(dto.language)
      || !Object.values(PrintTemplateDirection).includes(dto.direction)
      || !Object.values(PrintTemplatePageProfile).includes(dto.pageProfile)
      || references.some((reference) => !UUID.test(reference))
      || !Number.isFinite(calibrationXmm)
      || calibrationXmm < -100
      || calibrationXmm > 100
      || !Number.isFinite(calibrationYmm)
      || calibrationYmm < -100
      || calibrationYmm > 100
      || !dto.templateBody
      || typeof dto.templateBody !== 'object'
      || Array.isArray(dto.templateBody)
      || !SHA256.test(dto.templateDigest)
      || (
        dto.documentKind === PrintTemplateDocumentKind.CHEQUE
          ? !dto.bankId && !dto.chequeBookId
          : dto.bankId !== undefined || dto.chequeBookId !== undefined
      )
    ) this.validation('Print Template command is invalid.');

    let canonicalBody: string;
    try {
      canonicalBody = canonicalizeJson(dto.templateBody);
    } catch {
      this.validation('templateBody must be a valid JSON object.');
    }
    if (digest(canonicalBody) !== dto.templateDigest) {
      this.validation('templateDigest does not match templateBody.');
    }

    return {
      code,
      documentKind: dto.documentKind,
      ...(dto.treasuryUnitId ? { treasuryUnitId: dto.treasuryUnitId } : {}),
      ...(dto.bankId ? { bankId: dto.bankId } : {}),
      ...(dto.chequeBookId ? { chequeBookId: dto.chequeBookId } : {}),
      language: dto.language,
      direction: dto.direction,
      pageProfile: dto.pageProfile,
      calibrationXmm,
      calibrationYmm,
      templateBody: dto.templateBody,
      templateDigest: dto.templateDigest,
    };
  }

  private limit(raw?: string): number {
    if (!raw) return 50;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 500) {
      this.validation('limit must be an integer from 1 through 500.');
    }
    return value;
  }

  private cursor(value?: string): PrintTemplateCursor | undefined {
    if (!value) return undefined;
    try {
      if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error();
      const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
      if (
        !Array.isArray(decoded)
        || decoded.length !== 3
        || typeof decoded[0] !== 'string'
        || !CODE.test(decoded[0])
        || !Number.isSafeInteger(decoded[1])
        || (decoded[1] as number) < 1
        || typeof decoded[2] !== 'string'
        || !UUID.test(decoded[2])
      ) throw new Error();
      return {
        code: decoded[0],
        templateVersion: decoded[1] as number,
        id: decoded[2],
      };
    } catch {
      this.validation('cursor is malformed.');
    }
  }

  private encodeCursor(cursor: PrintTemplateCursor): string {
    return Buffer.from(JSON.stringify([
      cursor.code,
      cursor.templateVersion,
      cursor.id,
    ])).toString('base64url');
  }

  private key(value: string | undefined): string {
    if (!value || value.length < 8 || value.length > 128) {
      this.validation('Idempotency-Key must contain 8 through 128 characters.');
    }
    return value;
  }

  private requiredRequestId(value: string | undefined): void {
    if (!value || value.length > 128) {
      this.validation('X-Request-Id must contain 1 through 128 characters.');
    }
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
      if (message === 'VALIDATION') throw new TreasuryProblem('TRS-GEN-001', 422);
      const databaseError = error as { code?: string };
      if (
        databaseError.code === '23514'
        || databaseError.code === '22P02'
        || databaseError.code === '22003'
      ) throw new TreasuryProblem('TRS-GEN-001', 422);
      if (databaseError.code === '23503') {
        throw new TreasuryProblem('TRS-GEN-004', 404);
      }
      throw error;
    }
  }
}
