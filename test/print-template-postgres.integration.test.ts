import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';

import { digest } from '../src/common/http';
import { TreasuryProblem } from '../src/common/problem';
import { DatabaseService } from '../src/database/database.service';
import {
  PrintTemplateCreateDto,
  PrintTemplateDirection,
  PrintTemplateDocumentKind,
  PrintTemplateLanguage,
  PrintTemplatePageProfile,
} from '../src/master-data/print-template.dto';
import { canonicalizeJson } from '../src/master-data/print-template.jcs';
import { PrintTemplateRepository } from '../src/master-data/print-template.repository';
import { PrintTemplateService } from '../src/master-data/print-template.service';

const connectionString = process.env.TEST_DATABASE_URL;
const missingId = '00000000-0000-4000-8000-999999999999';

test('INC-1F PostgreSQL create/list is scoped, replay-safe, semantic, and serialized', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = connectionString;
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 36).toString('base64');
  const database = new DatabaseService();
  const service = new PrintTemplateService(new PrintTemplateRepository(database));
  try {
    const fixture = await seed(database);

    const versions = await Promise.all([
      service.create(
        fixture.organizationId,
        fixture.adminUserId,
        command(' concurrent ', { marker: 1 }),
        'concurrent-template-1',
        'request-concurrent-1',
      ),
      service.create(
        fixture.organizationId,
        fixture.adminUserId,
        command('CONCURRENT', { marker: 2 }),
        'concurrent-template-2',
        'request-concurrent-2',
      ),
    ]);
    assert.deepEqual(
      versions.map(({ templateVersion }) => templateVersion).sort(),
      [1, 2],
    );
    assert.ok(versions.every(({ state }) => state === 'DRAFT'));
    assert.ok(versions.every(({ calibrationXmm }) => calibrationXmm === 0));

    const global = await service.create(
      fixture.organizationId,
      fixture.adminUserId,
      command('GLOBAL_RECEIPT', { global: true }),
      'global-template-key',
      'request-global',
    );
    await assert.rejects(
      service.create(
        fixture.organizationId,
        fixture.adminUserId,
        command('GLOBAL_RECEIPT', { global: 'changed' }),
        'global-template-key',
        'request-global-conflict',
      ),
      (error) => problem(error, 'TRS-GEN-007', 409),
    );
    const unit = await service.create(
      fixture.organizationId,
      fixture.scopedUserId,
      command('UNIT_RECEIPT', { unit: true }, { treasuryUnitId: fixture.unitAId }),
      'unit-template-key',
      'request-unit',
    );
    for (const [code, treasuryUnitId] of [
      ['SCOPED_GLOBAL_DENIED', undefined],
      ['SCOPED_UNIT_DENIED', fixture.unitBId],
    ] as const) {
      await assert.rejects(
        service.create(
          fixture.organizationId,
          fixture.scopedUserId,
          command(code, { denied: true }, { treasuryUnitId }),
          `${code.toLowerCase()}-key`,
          `${code.toLowerCase()}-request`,
        ),
        (error) => problem(error, 'TRS-GEN-003', 403),
      );
    }
    const deniedVersions = await database.pool.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM print_templates
      WHERE organization_id = $1
        AND code IN ('SCOPED_GLOBAL_DENIED', 'SCOPED_UNIT_DENIED')
    `, [fixture.organizationId]);
    assert.equal(deniedVersions.rows[0]!.count, '0');

    await service.create(
      fixture.organizationId,
      fixture.adminUserId,
      command('HIDDEN_UNIT', { unit: 'B' }, { treasuryUnitId: fixture.unitBId }),
      'hidden-unit-key',
      'request-hidden-unit',
    );

    const scopedPage = await service.list(
      fixture.organizationId,
      fixture.scopedUserId,
    );
    assert.ok(scopedPage.items.some(({ id }) => id === global.id));
    assert.ok(scopedPage.items.some(({ id }) => id === unit.id));
    assert.ok(!scopedPage.items.some(({ code }) => code === 'HIDDEN_UNIT'));
    assert.equal(
      scopedPage.items.find(({ id }) => id === unit.id)?.treasuryUnit?.label,
      'Payments Unit',
    );
    assert.ok(scopedPage.items.every((item) => (
      item.treasuryUnitId === undefined || item.treasuryUnit?.id === item.treasuryUnitId
    )));
    const alienOrganizationPage = await service.list(
      missingId,
      fixture.adminUserId,
    );
    assert.deepEqual(alienOrganizationPage.items, []);
    assert.doesNotMatch(
      JSON.stringify(alienOrganizationPage),
      /Main Treasury Unit|Payments Unit|Receipts Unit|First Bank|Second Bank/u,
    );
    await assert.rejects(
      service.create(
        missingId,
        fixture.adminUserId,
        command('OTHER_ORG', {}),
        'other-org-key',
        'request-other-org',
      ),
      (error) => problem(error, 'TRS-GEN-004', 404),
    );

    const firstPage = await service.list(
      fixture.organizationId,
      fixture.adminUserId,
      '1',
    );
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.page.hasMore, true);
    const secondPage = await service.list(
      fixture.organizationId,
      fixture.adminUserId,
      '1',
      firstPage.page.nextCursor,
    );
    assert.notEqual(firstPage.items[0]!.id, secondPage.items[0]!.id);

    const actorOne = await service.create(
      fixture.organizationId,
      fixture.adminUserId,
      command('ACTOR_BOUND', { actor: 'shared-payload' }),
      'actor-shared-key',
      'request-actor-1',
    );
    const actorTwo = await service.create(
      fixture.organizationId,
      fixture.otherAdminUserId,
      command('ACTOR_BOUND', { actor: 'shared-payload' }),
      'actor-shared-key',
      'request-actor-2',
    );
    assert.notEqual(actorOne.id, actorTwo.id);
    assert.deepEqual(
      [actorOne.templateVersion, actorTwo.templateVersion],
      [1, 2],
    );

    const cheque = await service.create(
      fixture.organizationId,
      fixture.adminUserId,
      command('CHEQUE_MAIN', { cheque: true }, {
        documentKind: PrintTemplateDocumentKind.CHEQUE,
        treasuryUnitId: fixture.unitAId,
        bankId: fixture.bankAId,
        chequeBookId: fixture.chequeBookAId,
        pageProfile: PrintTemplatePageProfile.CHEQUE_CUSTOM,
      }),
      'cheque-template-key',
      'request-cheque',
    );
    assert.deepEqual(cheque.bank, { id: fixture.bankAId, label: 'First Bank' });
    assert.deepEqual(cheque.treasuryUnit, {
      id: fixture.unitAId,
      label: 'Payments Unit',
    });
    assert.deepEqual(cheque.chequeBook, {
      id: fixture.chequeBookAId,
      label: 'SERIES-A',
    });
    assert.notEqual(cheque.bank.label, cheque.bank.id);
    assert.notEqual(cheque.chequeBook.label, cheque.chequeBook.id);

    await assert.rejects(
      service.create(
        fixture.organizationId,
        fixture.adminUserId,
        command('CHEQUE_MISMATCH', {}, {
          documentKind: PrintTemplateDocumentKind.CHEQUE,
          bankId: fixture.bankAId,
          chequeBookId: fixture.chequeBookBId,
          pageProfile: PrintTemplatePageProfile.CHEQUE_CUSTOM,
        }),
        'cheque-mismatch-key',
        'request-cheque-mismatch',
      ),
      (error) => problem(error, 'TRS-GEN-001', 422),
    );
    await assert.rejects(
      service.create(
        fixture.organizationId,
        fixture.adminUserId,
        command('CHEQUE_HIDDEN', {}, {
          documentKind: PrintTemplateDocumentKind.CHEQUE,
          bankId: missingId,
          pageProfile: PrintTemplatePageProfile.CHEQUE_CUSTOM,
        }),
        'cheque-hidden-key',
        'request-cheque-hidden',
      ),
      (error) => problem(error, 'TRS-GEN-004', 404),
    );
    await database.pool.query(
      `UPDATE banks SET state = 'INACTIVE' WHERE id = $1`,
      [fixture.bankBId],
    );
    await assert.rejects(
      service.create(
        fixture.organizationId,
        fixture.adminUserId,
        command('CHEQUE_INACTIVE', {}, {
          documentKind: PrintTemplateDocumentKind.CHEQUE,
          bankId: fixture.bankBId,
          pageProfile: PrintTemplatePageProfile.CHEQUE_CUSTOM,
        }),
        'cheque-inactive-key',
        'request-cheque-inactive',
      ),
      (error) => problem(error, 'TRS-MST-001', 409),
    );
    await database.pool.query(
      `UPDATE treasury_units SET state = 'INACTIVE' WHERE id = $1`,
      [fixture.unitBId],
    );
    await assert.rejects(
      service.create(
        fixture.organizationId,
        fixture.adminUserId,
        command('UNIT_INACTIVE', {}, { treasuryUnitId: fixture.unitBId }),
        'unit-inactive-key',
        'request-unit-inactive',
      ),
      (error) => problem(error, 'TRS-MST-001', 409),
    );
    await database.pool.query(
      `UPDATE cheque_books SET state = 'SUSPENDED' WHERE id = $1`,
      [fixture.chequeBookBId],
    );
    await assert.rejects(
      service.create(
        fixture.organizationId,
        fixture.adminUserId,
        command('BOOK_INACTIVE', {}, {
          documentKind: PrintTemplateDocumentKind.CHEQUE,
          chequeBookId: fixture.chequeBookBId,
          pageProfile: PrintTemplatePageProfile.CHEQUE_CUSTOM,
        }),
        'book-inactive-key',
        'request-book-inactive',
      ),
      (error) => problem(error, 'TRS-MST-001', 409),
    );
    await database.pool.query(
      `UPDATE banks SET state = 'INACTIVE' WHERE id = $1`,
      [fixture.bankAId],
    );
    await assert.rejects(
      service.create(
        fixture.organizationId,
        fixture.adminUserId,
        command('CHEQUE_MAIN', { cheque: true }, {
          documentKind: PrintTemplateDocumentKind.CHEQUE,
          treasuryUnitId: fixture.unitAId,
          bankId: fixture.bankAId,
          chequeBookId: fixture.chequeBookAId,
          pageProfile: PrintTemplatePageProfile.CHEQUE_CUSTOM,
        }),
        'cheque-template-key',
        'request-cheque-replay-inactive',
      ),
      (error) => problem(error, 'TRS-MST-001', 409),
    );

    await database.pool.query(
      `UPDATE access_grants SET state = 'REVOKED' WHERE id = $1`,
      [fixture.scopedGrantId],
    );
    await assert.rejects(
      service.create(
        fixture.organizationId,
        fixture.scopedUserId,
        command('UNIT_RECEIPT', { unit: true }, { treasuryUnitId: fixture.unitAId }),
        'unit-template-key',
        'request-unit-replay',
      ),
      (error) => problem(error, 'TRS-GEN-003', 403),
    );
    await assert.rejects(
      database.pool.query(
        `UPDATE print_templates SET template_body = '{"changed":true}' WHERE id = $1`,
        [global.id],
      ),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
  } finally {
    await cleanup(database);
    await database.onModuleDestroy();
  }
});

function command(
  code: string,
  templateBody: Record<string, unknown>,
  scope: Partial<PrintTemplateCreateDto> = {},
): PrintTemplateCreateDto {
  return {
    code,
    documentKind: PrintTemplateDocumentKind.RECEIPT,
    language: PrintTemplateLanguage.EN,
    direction: PrintTemplateDirection.LTR,
    pageProfile: PrintTemplatePageProfile.A4_PORTRAIT,
    templateBody,
    templateDigest: digest(canonicalizeJson(templateBody)),
    ...scope,
  };
}

async function seed(database: DatabaseService) {
  await cleanup(database);
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    const organization = await client.query<{ id: string }>(`
      INSERT INTO organizations (code, legal_name, timezone, base_currency)
      VALUES ('PRINT', 'Print Template Test', 'UTC', 'USD')
      RETURNING id
    `);
    const organizationId = organization.rows[0]!.id;
    await client.query(`
      INSERT INTO currencies (
        organization_id, code, name, decimal_places, base_currency
      ) VALUES ($1, 'USD', 'US Dollar', 2, true)
    `, [organizationId]);
    const units = await client.query<{ id: string; code: string }>(`
      INSERT INTO treasury_units (
        organization_id, code, name, default_currency
      ) VALUES
        ($1, 'PAY', 'Payments Unit', 'USD'),
        ($1, 'RECEIVE', 'Receipts Unit', 'USD')
      RETURNING id, code
    `, [organizationId]);
    const unitIds = new Map(units.rows.map((unit) => [unit.code, unit.id]));

    const bankType = await client.query<{ id: string }>(`
      INSERT INTO bank_types (organization_id, code, display_name)
      VALUES ($1, 'COMMERCIAL', 'Commercial') RETURNING id
    `, [organizationId]);
    const banks = await client.query<{ id: string; code: string }>(`
      INSERT INTO banks (
        organization_id, bank_type_id, code, display_name, country_code
      ) VALUES
        ($1,$2,'FIRST','First Bank','US'),
        ($1,$2,'SECOND','Second Bank','US')
      RETURNING id, code
    `, [organizationId, bankType.rows[0]!.id]);
    const bankIds = new Map(banks.rows.map((bank) => [bank.code, bank.id]));
    const accounts = await client.query<{ id: string; bank_id: string }>(`
      INSERT INTO bank_accounts (
        organization_id, bank_id, account_type, account_number, currency,
        legal_owner_name, opening_date, cheque_enabled,
        can_receive, can_pay, can_transfer, state, version
      ) VALUES
        ($1,$2,'CURRENT','A-1','USD','Print Test','2026-07-27',true,true,true,true,'ACTIVE',1),
        ($1,$3,'CURRENT','B-1','USD','Print Test','2026-07-27',true,true,true,true,'ACTIVE',1)
      RETURNING id, bank_id
    `, [organizationId, bankIds.get('FIRST'), bankIds.get('SECOND')]);
    const accountIds = new Map(accounts.rows.map((account) => [account.bank_id, account.id]));
    const books = await client.query<{ id: string; series: string }>(`
      INSERT INTO cheque_books (
        organization_id, bank_account_id, series, first_leaf, last_leaf,
        received_date, state
      ) VALUES
        ($1,$2,'SERIES-A',1,50,'2026-07-27','ACTIVE'),
        ($1,$3,'SERIES-B',51,100,'2026-07-27','ACTIVE')
      RETURNING id, series
    `, [
      organizationId,
      accountIds.get(bankIds.get('FIRST')!),
      accountIds.get(bankIds.get('SECOND')!),
    ]);
    const bookIds = new Map(books.rows.map((book) => [book.series, book.id]));

    const users = await client.query<{ id: string; subject_key: string }>(`
      INSERT INTO user_refs (organization_id, subject_key, display_name)
      VALUES
        ($1, 'print-admin', 'Print Admin'),
        ($1, 'print-scoped', 'Print Scoped'),
        ($1, 'print-other-admin', 'Print Other Admin')
      RETURNING id, subject_key
    `, [organizationId]);
    const userIds = new Map(users.rows.map((user) => [user.subject_key, user.id]));
    const roles = await client.query<{ id: string; code: string }>(`
      INSERT INTO roles (organization_id, code, name)
      VALUES
        ($1, 'PRINT_ADMIN', 'Print Admin'),
        ($1, 'PRINT_SCOPED', 'Print Scoped')
      RETURNING id, code
    `, [organizationId]);
    const roleIds = new Map(roles.rows.map((role) => [role.code, role.id]));
    await client.query(`
      INSERT INTO role_permissions (role_id, permission)
      VALUES
        ($1, 'print-template.view'), ($1, 'print-template.manage'),
        ($2, 'print-template.view'), ($2, 'print-template.manage')
    `, [roleIds.get('PRINT_ADMIN'), roleIds.get('PRINT_SCOPED')]);
    await client.query(`
      INSERT INTO access_grants (
        organization_id, user_ref_id, role_id, scope_id
      ) VALUES
        ($1,$2,$4,$1),
        ($1,$3,$4,$1)
    `, [
      organizationId,
      userIds.get('print-admin'),
      userIds.get('print-other-admin'),
      roleIds.get('PRINT_ADMIN'),
    ]);
    const scopedGrant = await client.query<{ id: string }>(`
      INSERT INTO access_grants (
        organization_id, user_ref_id, role_id, scope_id
      ) VALUES ($1,$2,$3,$1)
      RETURNING id
    `, [
      organizationId,
      userIds.get('print-scoped'),
      roleIds.get('PRINT_SCOPED'),
    ]);
    await client.query(`
      INSERT INTO access_grant_treasury_unit_scopes (
        access_grant_id, treasury_unit_id
      ) VALUES ($1,$2)
    `, [scopedGrant.rows[0]!.id, unitIds.get('PAY')]);
    await client.query('COMMIT');
    return {
      organizationId,
      unitAId: unitIds.get('PAY')!,
      unitBId: unitIds.get('RECEIVE')!,
      bankAId: bankIds.get('FIRST')!,
      bankBId: bankIds.get('SECOND')!,
      chequeBookAId: bookIds.get('SERIES-A')!,
      chequeBookBId: bookIds.get('SERIES-B')!,
      adminUserId: userIds.get('print-admin')!,
      scopedUserId: userIds.get('print-scoped')!,
      otherAdminUserId: userIds.get('print-other-admin')!,
      scopedGrantId: scopedGrant.rows[0]!.id,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function cleanup(database: DatabaseService): Promise<void> {
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    for (const table of [
      'print_templates',
      'cheque_events',
      'cheque_leaves',
      'cheque_books',
      'pos_terminals',
      'payment_gateways',
      'access_grant_bank_account_scopes',
      'bank_accounts',
      'bank_branches',
      'banks',
      'bank_types',
      'cashbox_handover_instruments',
      'cashbox_handover_money',
      'cashbox_handovers',
      'cashbox_assignments',
      'auth_step_up_proofs',
      'auth_challenges',
      'auth_sessions',
      'security_audit_events',
      'auth_password_attempt_reservations',
      'auth_throttle_buckets',
      'auth_recovery_attempts',
      'access_grant_cashbox_scopes',
      'cashbox_currency_controls',
      'cashboxes',
      'access_grant_currency_scopes',
      'access_grant_method_category_scopes',
      'access_grant_document_type_scopes',
      'access_grant_treasury_unit_scopes',
      'access_grant_branch_scopes',
      'access_grants',
      'role_permissions',
      'totp_enrollment_challenges',
      'identity_accounts',
      'roles',
      'idempotency_records',
      'party_kinds',
      'parties',
      'method_amount_limits',
      'method_allowed_currencies',
      'method_required_references',
      'method_mappings',
      'method_definitions',
      'user_refs',
      'treasury_units',
      'branches',
      'currencies',
      'organizations',
    ]) await client.query(`DELETE FROM ${table}`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function problem(error: unknown, code: string, status: number): boolean {
  return error instanceof TreasuryProblem
    && error.getStatus() === status
    && (error.getResponse() as { code?: string }).code === code;
}
