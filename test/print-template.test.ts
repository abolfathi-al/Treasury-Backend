import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { digest } from '../src/common/http';
import { TreasuryProblem } from '../src/common/problem';
import {
  PrintTemplateCreateDto,
  PrintTemplateDirection,
  PrintTemplateDocumentKind,
  PrintTemplateLanguage,
  PrintTemplatePageProfile,
} from '../src/master-data/print-template.dto';
import { canonicalizeJson } from '../src/master-data/print-template.jcs';
import type { PrintTemplateRepository } from '../src/master-data/print-template.repository';
import { PrintTemplateService } from '../src/master-data/print-template.service';

const id = (last: number) => `00000000-0000-4000-8000-${String(last).padStart(12, '0')}`;

test('RFC 8785 canonical JSON is deterministic and rejects invalid JSON values', () => {
  assert.equal(
    canonicalizeJson({
      z: [3, { '\u20ac': 'Euro', a: true }],
      a: -0,
      exponent: 1e30,
    }),
    '{"a":0,"exponent":1e+30,"z":[3,{"a":true,"€":"Euro"}]}',
  );
  assert.throws(() => canonicalizeJson({ bad: Number.NaN }), /INVALID_JSON/u);
  assert.throws(() => canonicalizeJson({ bad: '\ud800' }), /INVALID_JSON/u);
});

test('Print Template DTO closes choices, identifiers, digest shape, and object body', async () => {
  const valid = plainToInstance(PrintTemplateCreateDto, {
    ...command(),
    code: ' receipt_main ',
  });
  assert.equal(valid.code, 'RECEIPT_MAIN');
  assert.deepEqual(await validate(valid), []);

  const invalid = plainToInstance(PrintTemplateCreateDto, {
    ...command(),
    documentKind: 'UNKNOWN',
    treasuryUnitId: 'raw-id',
    templateBody: [],
    templateDigest: 'A'.repeat(64),
  });
  const properties = new Set((await validate(invalid)).map(({ property }) => property));
  assert.ok(properties.has('documentKind'));
  assert.ok(properties.has('treasuryUnitId'));
  assert.ok(properties.has('templateBody'));
  assert.ok(properties.has('templateDigest'));
});

test('Print Template service normalizes before digest, defaults calibration, and encodes keysets', async () => {
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 33).toString('base64');
  let received: PrintTemplateCreateDto | undefined;
  const service = new PrintTemplateService({
    create: async (
      organizationId: string,
      _actorUserId: string,
      dto: PrintTemplateCreateDto,
    ) => {
      received = dto;
      return {
        id: id(10),
        organizationId,
        ...dto,
        calibrationXmm: dto.calibrationXmm!,
        calibrationYmm: dto.calibrationYmm!,
        templateVersion: 1,
        state: 'DRAFT',
        createdAt: '2026-07-27T00:00:00.000Z',
      };
    },
    list: async () => ({
      items: [{
        id: id(10),
        organizationId: id(1),
        ...command(),
        code: 'RECEIPT_MAIN',
        calibrationXmm: 0,
        calibrationYmm: 0,
        templateVersion: 2,
        state: 'DRAFT',
        createdAt: '2026-07-27T00:00:00.000Z',
      }],
      hasMore: true,
    }),
  } as unknown as PrintTemplateRepository);

  const created = await service.create(
    id(1),
    id(2),
    { ...command(), code: ' receipt_main ' },
    'template-key',
    'request-1',
  );
  assert.equal(received?.code, 'RECEIPT_MAIN');
  assert.equal(created.calibrationXmm, 0);
  assert.equal(created.calibrationYmm, 0);

  const first = await service.list(id(1), id(2), '1');
  assert.ok(first.page.nextCursor);
  const decoded = JSON.parse(
    Buffer.from(first.page.nextCursor!, 'base64url').toString('utf8'),
  );
  assert.deepEqual(decoded, ['RECEIPT_MAIN', 2, id(10)]);
  await assert.rejects(
    service.list(id(1), id(2), undefined, 'broken'),
    (error) => problem(error, 'TRS-GEN-001', 422),
  );
});

test('Print Template service enforces digest and document/reference coherence before SQL', () => {
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 34).toString('base64');
  const service = new PrintTemplateService({} as PrintTemplateRepository);
  for (const dto of [
    { ...command(), templateDigest: '0'.repeat(64) },
    { ...command(), bankId: id(4) },
    {
      ...command(),
      documentKind: PrintTemplateDocumentKind.CHEQUE,
    },
    { ...command(), templateBody: [] as unknown as Record<string, unknown> },
  ]) {
    assert.throws(
      () => service.create(id(1), id(2), dto, 'template-key', 'request-2'),
      (error) => problem(error, 'TRS-GEN-001', 422),
    );
  }
});

test('Print Template service maps authorization, reference, and replay failures exactly', async () => {
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 35).toString('base64');
  for (const [message, code, status] of [
    ['SCOPE_DENIED', 'TRS-GEN-003', 403],
    ['RESOURCE_HIDDEN', 'TRS-GEN-004', 404],
    ['INACTIVE_REFERENCE', 'TRS-MST-001', 409],
    ['VALIDATION', 'TRS-GEN-001', 422],
    ['IDEMPOTENCY_CONFLICT', 'TRS-GEN-007', 409],
  ] as const) {
    const service = new PrintTemplateService({
      create: async () => {
        throw message === 'RESOURCE_HIDDEN' || message === 'INACTIVE_REFERENCE'
          ? new ReferenceError(message)
          : message === 'IDEMPOTENCY_CONFLICT'
            ? new SyntaxError(message)
            : new Error(message);
      },
    } as unknown as PrintTemplateRepository);
    await assert.rejects(
      service.create(id(1), id(2), command(), 'template-key', 'request-3'),
      (error) => problem(error, code, status),
    );
  }
});

function command(): PrintTemplateCreateDto {
  const templateBody = { title: 'Receipt', fields: ['number', 'amount'] };
  return {
    code: 'RECEIPT_MAIN',
    documentKind: PrintTemplateDocumentKind.RECEIPT,
    language: PrintTemplateLanguage.EN,
    direction: PrintTemplateDirection.LTR,
    pageProfile: PrintTemplatePageProfile.A4_PORTRAIT,
    templateBody,
    templateDigest: digest(canonicalizeJson(templateBody)),
  };
}

function problem(error: unknown, code: string, status: number): boolean {
  return error instanceof TreasuryProblem
    && error.getStatus() === status
    && (error.getResponse() as { code?: string }).code === code;
}
