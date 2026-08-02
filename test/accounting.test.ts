import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validate } from 'class-validator';

import { buildArtifacts, type FrozenAccountingPayload } from '../src/accounting-integration/accounting-artifacts';
import { ExportAcknowledgementDto } from '../src/accounting-integration/accounting.dto';
import {
  exportAuthorizationContext,
  type AccountingExportRow,
  type AccountingRepository,
} from '../src/accounting-integration/accounting.repository';
import { AccountingService } from '../src/accounting-integration/accounting.service';
import type { AccessAuthorizationService } from '../src/access-control/access-authorization.service';
import { TreasuryProblem } from '../src/common/problem';
import type { DatabaseService } from '../src/database/database.service';
import type { FoundationEffectsService } from '../src/foundation-effects/foundation-effects.service';

const payload: FrozenAccountingPayload = {
  createdAt: '2026-08-02T00:00:00.000Z',
  contractVersion: '1',
  exportKind: 'GENERAL_LEDGER',
  organization: { id: 'org', code: 'ORG', name: 'Treasury' },
  accountingSystem: { id: 'system', code: 'ERP', name: 'ERP' },
  source: {
    id: 'payment',
    version: 7,
    businessNumber: 'PAY-0001',
    businessDate: '2026-08-02',
    baseCurrency: 'IRR',
    totalBaseAmount: '100.00000000',
  },
  fiscalPeriod: { externalKey: '2026-08', sourceVersion: '2', sourceDigest: 'a'.repeat(64) },
  mappings: [{
    localType: 'METHOD_DEFINITION',
    localId: 'method',
    mappingType: 'GENERAL_ACCOUNT',
    externalKey: '1101',
    externalParentKey: null,
    sourceVersion: '2',
  }],
  lines: [{
    lineNumber: 1,
    methodName: 'Cash',
    amount: '100.00000000',
    currency: 'IRR',
    baseAmount: '100.00000000',
    description: 'Supplier payment',
  }],
};

test('Accounting artifacts are deterministic stored ZIP/XLSX payloads', () => {
  const first = buildArtifacts(payload);
  const second = buildArtifacts(payload);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map(({ representation }) => representation), ['CSV_ZIP_MANIFEST', 'XLSX']);
  for (const artifact of first) {
    assert.equal(artifact.bytes.readUInt32LE(0), 0x04034b50);
    assert.match(artifact.payloadDigest, /^[a-f0-9]{64}$/u);
    assert.equal(artifact.rowDigests.length, 1);
  }
});

test('Accounting spreadsheet text cannot become a CSV formula', () => {
  const [csvZip] = buildArtifacts({
    ...payload,
    lines: [{ ...payload.lines[0]!, methodName: '=WEBSERVICE("https://invalid")' }],
  });
  assert.ok(csvZip!.bytes.includes(Buffer.from("'=WEBSERVICE")));
});

test('Accounting acknowledgement rejects blank required evidence', async () => {
  const body = Object.assign(new ExportAcknowledgementDto(), {
    outcome: 'ACCEPTED',
    externalDocumentId: '',
    responseDigest: 'b'.repeat(64),
    acknowledgedAt: '2026-08-02T12:00:00.000Z',
  });
  assert.ok((await validate(body)).some(({ property }) => property === 'externalDocumentId'));
});

test('Unsupported accounting source fails before persistence', () => {
  const service = new AccountingService(
    {} as DatabaseService,
    {} as AccountingRepository,
    {} as AccessAuthorizationService,
    {} as FoundationEffectsService,
  );
  assert.throws(
    () => service.createExport('org', 'actor', {
      accountingSystemId: '00000000-0000-4000-8000-000000000001',
      sourceType: 'RECEIPT' as never,
      sourceId: '00000000-0000-4000-8000-000000000002',
      sourceVersion: 1,
      exportKind: 'GENERAL_LEDGER',
    }, 'accounting-key', 'request-id'),
    (error: unknown) => error instanceof TreasuryProblem
      && (error.getResponse() as { code?: string }).code === 'TRS-GEN-001',
  );
});

test('Accounting export authorization uses frozen source anchors', () => {
  assert.deepEqual(exportAuthorizationContext({
    branchId: 'branch',
    treasuryUnitId: 'unit',
    documentType: 'PAYMENT',
    baseCurrency: 'IRR',
    aggregateBaseAmount: '100.00000000',
  } as AccountingExportRow), {
    branchId: 'branch',
    treasuryUnitId: 'unit',
    cashboxIds: [],
    bankAccountIds: [],
    currencies: [],
    methodCategories: [],
    documentType: 'PAYMENT',
    amount: '100.00000000',
    amountCurrency: 'IRR',
  });
});

test('Accounting acknowledgement queue uses one repeatable-read snapshot', async () => {
  let transactionConfig: unknown;
  const transaction = {};
  const service = new AccountingService(
    {
      db: {
        transaction: async (
          work: (value: unknown) => Promise<unknown>,
          config: unknown,
        ) => {
          transactionConfig = config;
          return work(transaction);
        },
      },
    } as DatabaseService,
    { exportViews: async () => [] } as unknown as AccountingRepository,
    {
      accountingScopeFingerprint: async () => 'a'.repeat(64),
      listVisibleAccountingExportIds: async () => [],
    } as unknown as AccessAuthorizationService,
    {} as FoundationEffectsService,
  );
  const page = await service.listExports('org', 'actor', { limit: '10' });
  assert.deepEqual(page.items, []);
  assert.deepEqual(transactionConfig, {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  });
});

test('INC-3D migration owns immutable export, acknowledgement, and posting-lock evidence', async () => {
  const migration = await readFile('migrations/0020_accounting_export_ack.sql', 'utf8');
  for (const table of [
    'accounting_systems',
    'accounting_imports',
    'fiscal_periods',
    'accounting_mappings',
    'accounting_exports',
    'accounting_export_artifacts',
    'accounting_export_row_results',
    'accounting_export_attempts',
    'accounting_acknowledgements',
    'posting_locks',
  ]) assert.match(migration, new RegExp(`CREATE TABLE ${table}`, 'u'));
  assert.match(migration, /content bytea NOT NULL/u);
  assert.match(migration, /base_currency varchar\(8\) NOT NULL/u);
  assert.match(migration, /accounting_export_artifacts_append_only/u);
  assert.match(migration, /accounting_acknowledgements_append_only/u);
  assert.match(migration, /payment_documents_posting_lock/u);
  assert.match(migration, /payment_line_evidence_posting_lock/u);
});
