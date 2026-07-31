import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { TreasuryProblem } from '../src/common/problem';
import {
  ReportingRepository,
  ReportScopeSnapshot,
} from '../src/reporting/reporting.repository';
import { ReportingService } from '../src/reporting/reporting.service';

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001';
const ACTOR_ID = '00000000-0000-4000-8000-000000000002';
const SOURCE_ID = '00000000-0000-4000-8000-000000000003';

process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 11).toString('base64');

function scope(version = 0): ReportScopeSnapshot[] {
  return [{
    grantId: '00000000-0000-4000-8000-000000000010',
    grantVersion: version,
    roleId: '00000000-0000-4000-8000-000000000011',
    roleVersion: 0,
    organizationWide: true,
    validFrom: '2026-01-01T00:00:00.000Z',
    validTo: null,
    branches: [],
    treasuryUnits: [],
    cashboxes: [],
    bankAccounts: [],
    currencies: [],
  }];
}

function repositoryMock() {
  let currentScope = scope();
  let sourceWatermark = 'receipts:initial';
  let contextVisible = true;
  let mutateDuringContext = false;
  const calls: Array<{ reportKey: string; input: unknown }> = [];
  const repository = {
    currentScope: async () => currentScope,
    context: async () => {
      if (!contextVisible) return undefined;
      const context = {
        organization: { id: ORGANIZATION_ID, label: 'Treasury Example' },
        timezone: 'Asia/Tehran',
        branch: null,
        treasuryUnit: null,
        cashbox: null,
        bankAccount: null,
        user: null,
        party: null,
        method: null,
        currency: null,
      };
      if (mutateDuringContext) {
        sourceWatermark = 'changed-during-context';
        mutateDuringContext = false;
      }
      return context;
    },
    list: async (reportKey: string, input: unknown) => {
      calls.push({ reportKey, input });
      return {
        items: [],
        keys: [{ businessDate: '2026-07-30', id: SOURCE_ID }],
        hasMore: true,
      };
    },
    sourceWatermark: async (reportKey: string) => `${reportKey}:${sourceWatermark}`,
  };
  return {
    repository: repository as unknown as ReportingRepository,
    calls,
    deny: () => { currentScope = []; },
    hideContext: () => { contextVisible = false; },
    changeScope: () => { currentScope = scope(1); },
    changeSource: () => { sourceWatermark = 'changed'; },
    changeSourceDuringContext: () => { mutateDuringContext = true; },
  };
}

function problem(code: string, status: number) {
  return (error: unknown) => error instanceof TreasuryProblem
    && error.getStatus() === status
    && (error.getResponse() as { code?: string }).code === code;
}

test('runOperationalReport denies a caller without one current report grant', async () => {
  const mock = repositoryMock();
  mock.deny();
  const service = new ReportingService(mock.repository);
  await assert.rejects(
    service.run(ORGANIZATION_ID, ACTOR_ID, 'receipts', {}),
    problem('TRS-GEN-003', 403),
  );
  assert.equal(mock.calls.length, 0);
});

test('runOperationalReport denies an unauthorized scoped filter before listing or echoing it', async () => {
  const mock = repositoryMock();
  mock.hideContext();
  const guessedBankAccountId = '00000000-0000-4000-8000-000000000099';
  const service = new ReportingService(mock.repository);
  await assert.rejects(
    service.run(ORGANIZATION_ID, ACTOR_ID, 'receipts', {
      bankAccountId: guessedBankAccountId,
    }),
    problem('TRS-GEN-003', 403),
  );
  assert.equal(mock.calls.length, 0);
});

test('runOperationalReport rejects unowned keys, filters, formats, and ranges', async () => {
  const service = new ReportingService(repositoryMock().repository);
  await assert.rejects(
    service.run(ORGANIZATION_ID, ACTOR_ID, 'payments', {}),
    problem('TRS-RPT-001', 400),
  );
  await assert.rejects(
    service.run(ORGANIZATION_ID, ACTOR_ID, 'funds-in-transit', {
      cashboxId: '00000000-0000-4000-8000-000000000012',
    }),
    problem('TRS-RPT-001', 400),
  );
  await assert.rejects(
    service.run(ORGANIZATION_ID, ACTOR_ID, 'receipts', { format: 'PDF' }),
    problem('TRS-RPT-001', 400),
  );
  await assert.rejects(
    service.run(ORGANIZATION_ID, ACTOR_ID, 'receipts', { state: 'CLEARED' }),
    problem('TRS-RPT-001', 400),
  );
  await assert.rejects(
    service.run(ORGANIZATION_ID, ACTOR_ID, 'received-cheques', {
      dueDateFrom: '2026-08-01',
      dueDateTo: '2026-07-31',
    }),
    problem('TRS-GEN-001', 422),
  );
});

test('runOperationalReport binds cursor to caller, scope, report, filters, mode and asOf', async () => {
  const mock = repositoryMock();
  const service = new ReportingService(mock.repository);
  const first = await service.run(ORGANIZATION_ID, ACTOR_ID, 'receipts', {
    state: ['CANCELLED'],
    currencyMode: 'BASE_SOURCE_SNAPSHOT',
    limit: '1',
  });
  assert.equal(first.freshness, 'READ_AFTER_WRITE');
  assert.equal(first.appliedAuthorizationScope[0]?.values[0]?.label, 'Treasury Example');
  assert.ok(first.page.nextCursor);

  const second = await service.run(ORGANIZATION_ID, ACTOR_ID, 'receipts', {
    state: ['CANCELLED'],
    currencyMode: 'BASE_SOURCE_SNAPSHOT',
    limit: '1',
    cursor: first.page.nextCursor,
  });
  assert.equal(second.page.asOf, first.page.asOf);

  await assert.rejects(
    service.run(ORGANIZATION_ID, ACTOR_ID, 'received-cheques', {
      state: ['CANCELLED'],
      currencyMode: 'BASE_SOURCE_SNAPSHOT',
      limit: '1',
      cursor: first.page.nextCursor,
    }),
    problem('TRS-GEN-001', 422),
  );
  mock.changeScope();
  await assert.rejects(
    service.run(ORGANIZATION_ID, ACTOR_ID, 'receipts', {
      state: ['CANCELLED'],
      currencyMode: 'BASE_SOURCE_SNAPSHOT',
      limit: '1',
      cursor: first.page.nextCursor,
    }),
    problem('TRS-GEN-001', 422),
  );
});

test('runOperationalReport rejects a cursor after owner facts change', async () => {
  const mock = repositoryMock();
  const service = new ReportingService(mock.repository);
  const first = await service.run(ORGANIZATION_ID, ACTOR_ID, 'receipts', {
    limit: '1',
  });
  assert.ok(first.page.nextCursor);

  mock.changeSource();
  await assert.rejects(
    service.run(ORGANIZATION_ID, ACTOR_ID, 'receipts', {
      limit: '1',
      cursor: first.page.nextCursor,
    }),
    problem('TRS-RPT-002', 503),
  );
});

test('runOperationalReport rejects when semantic context changes inside the read window', async () => {
  const mock = repositoryMock();
  mock.changeSourceDuringContext();
  const service = new ReportingService(mock.repository);
  await assert.rejects(
    service.run(ORGANIZATION_ID, ACTOR_ID, 'receipts', {}),
    problem('TRS-RPT-002', 503),
  );
  assert.equal(mock.calls.length, 1);
});

test('all four INC-2E keys stay synchronous and read-only', async () => {
  const mock = repositoryMock();
  const service = new ReportingService(mock.repository);
  for (const reportKey of [
    'receipts',
    'received-cheques',
    'issued-cheques',
    'funds-in-transit',
  ]) {
    const page = await service.run(ORGANIZATION_ID, ACTOR_ID, reportKey, {});
    assert.equal(page.reportKey, reportKey);
    assert.equal(page.freshness, 'READ_AFTER_WRITE');
  }
  const repository = await readFile('src/reporting/reporting.repository.ts', 'utf8');
  assert.doesNotMatch(repository, /\.insert\(|\.update\(|\.delete\(|pool\.query/u);
  assert.doesNotMatch(repository, /effect\.direction = 'CREDIT'/u);
  const reportScope = repository.slice(
    repository.indexOf('private oneGrantScope'),
    repository.indexOf('private scopeRefs'),
  );
  assert.doesNotMatch(
    reportScope,
    /document_type|method_category|amount_ceiling|baseAmount|baseCurrency/u,
  );
  assert.match(
    repository,
    /current owner runtime has no issued-cheque\/payment aggregate/u,
  );
});

test('cheque state validation follows the pinned received and issued lifecycles', async () => {
  const service = new ReportingService(repositoryMock().repository);
  for (const state of ['REPLACED', 'CLEARANCE_REVERSED', 'PAID_EXCEPTION']) {
    const page = await service.run(ORGANIZATION_ID, ACTOR_ID, 'issued-cheques', { state });
    assert.equal(page.reportKey, 'issued-cheques');
  }
  for (const state of ['AVAILABLE', 'RESERVED', 'CONSUMED']) {
    await assert.rejects(
      service.run(ORGANIZATION_ID, ACTOR_ID, 'issued-cheques', { state }),
      problem('TRS-RPT-001', 400),
    );
  }
});

test('due status uses only pinned terminal states for each cheque lifecycle', () => {
  const repository = new ReportingRepository({} as never) as unknown as {
    dueStatus(
      kind: 'RECEIVED_CHEQUE' | 'ISSUED_CHEQUE',
      state: string,
      dueDate: string,
      businessDate: string,
    ): string;
  };
  assert.equal(
    repository.dueStatus('RECEIVED_CHEQUE', 'CLEARED', '2026-07-29', '2026-07-30'),
    'OVERDUE',
  );
  assert.equal(
    repository.dueStatus('RECEIVED_CHEQUE', 'CANCELLED', '2026-07-31', '2026-07-30'),
    'TERMINAL',
  );
  assert.equal(
    repository.dueStatus('ISSUED_CHEQUE', 'REPLACED', '2026-07-29', '2026-07-30'),
    'OVERDUE',
  );
  assert.equal(
    repository.dueStatus(
      'ISSUED_CHEQUE',
      'PAID_EXCEPTION',
      '2026-07-31',
      '2026-07-30',
    ),
    'TERMINAL',
  );
});

test('semantic filter labels never fall back to a UUID', async () => {
  const service = new ReportingService(repositoryMock().repository);
  const uuidRef = '00000000-0000-4000-8000-000000000088';
  const page = await service.run(ORGANIZATION_ID, ACTOR_ID, 'receipts', {
    projectRef: uuidRef,
    costCenterRef: uuidRef,
  });
  assert.equal(page.appliedFilters.project?.id, uuidRef);
  assert.equal(page.appliedFilters.project?.label, 'Project');
  assert.equal(page.appliedFilters.costCenter?.id, uuidRef);
  assert.equal(page.appliedFilters.costCenter?.label, 'Cost center');
});
