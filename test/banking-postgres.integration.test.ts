import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BankAccountType,
  type BankAccountCreateDto,
} from '../src/banking/banking.dto';
import { BankingRepository } from '../src/banking/banking.repository';
import { BankingService } from '../src/banking/banking.service';
import { TreasuryProblem } from '../src/common/problem';
import { DatabaseService } from '../src/database/database.service';

const connectionString = process.env.TEST_DATABASE_URL;

test('INC-1E PostgreSQL resources are semantic, scoped, replay-safe, and constrained', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = connectionString;
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 29).toString('base64');
  const database = new DatabaseService();
  const service = new BankingService(new BankingRepository(database));
  try {
    const fixture = await seed(database);
    const bankType = await service.createBankType(
      fixture.organizationId,
      fixture.adminUserId,
      { code: ' commercial ', displayName: 'Commercial Bank' },
      'bank-type-commercial',
      'request-bank-type',
    );
    assert.equal(bankType.code, 'COMMERCIAL');
    assert.equal((await service.createBankType(
      fixture.organizationId,
      fixture.adminUserId,
      { code: 'commercial', displayName: 'Commercial Bank' },
      'bank-type-commercial',
      'request-bank-type-replay',
    )).id, bankType.id);
    await assert.rejects(
      service.createBankType(
        fixture.organizationId,
        fixture.adminUserId,
        { code: 'commercial', displayName: 'Changed' },
        'bank-type-commercial',
        'request-bank-type-conflict',
      ),
      (error) => problem(error, 'TRS-GEN-007', 409),
    );
    await assert.rejects(
      service.createBankType(
        fixture.organizationId,
        fixture.adminUserId,
        { code: ' commercial ', displayName: 'Duplicate' },
        'bank-type-duplicate',
        'request-bank-type-duplicate',
      ),
      (error) => problem(error, 'TRS-MST-002', 409),
    );

    const secondType = await service.createBankType(
      fixture.organizationId,
      fixture.adminUserId,
      { code: 'CENTRAL', displayName: 'Central Bank' },
      'bank-type-central',
      'request-bank-type-central',
    );
    const firstPage = await service.listBankTypes(
      fixture.organizationId,
      fixture.adminUserId,
      '1',
    );
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.page.hasMore, true);
    assert.ok(firstPage.page.nextCursor);
    const secondPage = await service.listBankTypes(
      fixture.organizationId,
      fixture.adminUserId,
      '1',
      firstPage.page.nextCursor,
    );
    assert.deepEqual(
      [...firstPage.items, ...secondPage.items].map(({ id }) => id).sort(),
      [bankType.id, secondType.id].sort(),
    );

    const bank = await service.createBank(
      fixture.organizationId,
      fixture.adminUserId,
      {
        bankTypeId: bankType.id,
        code: ' test-bank ',
        displayName: 'Test Bank',
        countryCode: ' us ',
        nationalBankCode: ' national.1 ',
        swiftCode: ' testus33 ',
      },
      'bank-create-test',
      'request-bank',
    );
    assert.equal(bank.code, 'TEST-BANK');
    assert.equal(bank.countryCode, 'US');
    assert.deepEqual(bank.bankType, {
      id: bankType.id,
      code: 'COMMERCIAL',
      displayName: 'Commercial Bank',
    });
    const bankBranch = await service.createBankBranch(
      fixture.organizationId,
      fixture.adminUserId,
      {
        bankId: bank.id,
        code: ' 001 ',
        name: 'Main Banking Branch',
        city: 'New York',
      },
      'bank-branch-main',
      'request-bank-branch',
    );
    assert.equal(bankBranch.code, '001');
    assert.equal(bankBranch.bank.displayName, 'Test Bank');

    const account = await service.createBankAccount(
      fixture.organizationId,
      fixture.scopedUserId,
      accountDto(fixture, bank.id, bankBranch.id, '100-001', true),
      'account-create-main',
      'request-account',
    );
    assert.equal(account.state, 'ACTIVE');
    assert.equal(account.version, 1);
    assert.equal(account.bank.displayName, 'Test Bank');
    assert.equal(account.organizationBranch?.name, 'Headquarters');
    assert.equal(account.treasuryUnit?.name, 'Branchless Collections');
    assert.deepEqual(account.withdrawalCeiling, {
      amount: '10.50000000',
      currency: 'USD',
    });
    assert.equal(account.closingDate, undefined);

    await database.pool.query(`
      INSERT INTO access_grant_bank_account_scopes (access_grant_id, bank_account_id)
      VALUES ($1,$2)
    `, [fixture.scopedGrantId, account.id]);
    await assert.rejects(
      service.createBankAccount(
        fixture.organizationId,
        fixture.scopedUserId,
        accountDto(fixture, bank.id, bankBranch.id, '100-001', true),
        'account-create-main',
        'request-account-replay-after-rescope',
      ),
      (error) => problem(error, 'TRS-GEN-003', 403),
    );
    assert.deepEqual(
      (await service.listBankAccounts(
        fixture.organizationId,
        fixture.scopedUserId,
      )).items.map(({ id }) => id),
      [account.id],
    );

    const terminal = await service.createPosTerminal(
      fixture.organizationId,
      fixture.scopedUserId,
      {
        bankAccountId: account.id,
        terminalNumber: 'POS-001',
        merchantNumber: 'MERCHANT-001',
        treasuryUnitId: fixture.endpointUnitId,
        currency: 'USD',
        settlementCycle: 'DAILY',
        providerLabel: 'Test Acquirer',
      },
      'pos-terminal-main',
      'request-pos',
    );
    assert.equal(terminal.bankAccount.bank.displayName, 'Test Bank');
    assert.equal(terminal.organizationBranch?.name, 'Headquarters');
    assert.equal(terminal.treasuryUnit.name, 'Headquarters Collections');

    const gateway = await service.createPaymentGateway(
      fixture.organizationId,
      fixture.scopedUserId,
      {
        bankAccountId: account.id,
        providerCode: ' provider.one ',
        merchantId: 'MERCHANT-001',
        terminalId: 'GATEWAY-001',
        treasuryUnitId: fixture.endpointUnitId,
        currency: 'USD',
        settlementCycle: 'DAILY',
      },
      'payment-gateway-main',
      'request-gateway',
    );
    assert.equal(gateway.providerCode, 'PROVIDER.ONE');
    assert.equal(gateway.bankAccount.accountNumber, '100-001');
    assert.deepEqual(
      (await service.listPosTerminals(
        fixture.organizationId,
        fixture.scopedUserId,
      )).items.map(({ id }) => id),
      [terminal.id],
    );
    assert.deepEqual(
      (await service.listPaymentGateways(
        fixture.organizationId,
        fixture.scopedUserId,
      )).items.map(({ id }) => id),
      [gateway.id],
    );

    const unavailableAccount = await service.createBankAccount(
      fixture.organizationId,
      fixture.adminUserId,
      accountDto(fixture, bank.id, bankBranch.id, '100-002', false),
      'account-unavailable',
      'request-account-unavailable',
    );
    await assert.rejects(
      service.createPosTerminal(
        fixture.organizationId,
        fixture.adminUserId,
        {
          bankAccountId: unavailableAccount.id,
          terminalNumber: 'POS-DENIED',
          merchantNumber: 'MERCHANT-DENIED',
          treasuryUnitId: fixture.endpointUnitId,
          currency: 'USD',
          settlementCycle: 'DAILY',
        },
        'pos-unavailable-account',
        'request-pos-unavailable',
      ),
      (error) => problem(error, 'TRS-BNK-001', 409),
    );
    await assert.rejects(
      database.pool.query(`
        UPDATE bank_accounts
        SET account_type = 'SAVINGS'
        WHERE id = $1
      `, [account.id]),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
    await assert.rejects(
      database.pool.query(`
        UPDATE bank_accounts
        SET withdrawal_ceiling = 10.501
        WHERE id = $1
      `, [account.id]),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );

    await database.pool.query(
      `UPDATE bank_types SET state = 'INACTIVE' WHERE id = $1`,
      [bankType.id],
    );
    await assert.rejects(
      service.createBank(
        fixture.organizationId,
        fixture.adminUserId,
        {
          bankTypeId: bankType.id,
          code: 'test-bank',
          displayName: 'Test Bank',
          countryCode: 'US',
          nationalBankCode: 'NATIONAL.1',
          swiftCode: 'TESTUS33',
        },
        'bank-create-test',
        'request-bank-replay-after-reference-change',
      ),
      (error) => problem(error, 'TRS-MST-001', 409),
    );
  } finally {
    await cleanup(database);
    await database.onModuleDestroy();
  }
});

function accountDto(
  fixture: {
    organizationBranchId: string;
    branchlessUnitId: string;
  },
  bankId: string,
  bankBranchId: string,
  accountNumber: string,
  receive: boolean,
): BankAccountCreateDto {
  return {
    bankId,
    bankBranchId,
    organizationBranchId: fixture.organizationBranchId,
    treasuryUnitId: fixture.branchlessUnitId,
    accountType: BankAccountType.CURRENT,
    accountNumber,
    iban: `US00${accountNumber.replaceAll('-', '')}`,
    maskedCardNumber: '**** 1234',
    currency: 'USD',
    legalOwnerName: 'Treasury Test',
    chequeEnabled: true,
    capabilities: { receive, pay: true, transfer: true },
    withdrawalCeiling: { amount: '10.50', currency: 'USD' },
    openingDate: '2026-07-26',
    accountingDimensions: { generalAccount: 'BANK' },
  };
}

async function seed(database: DatabaseService) {
  await cleanup(database);
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    const organization = await client.query<{ id: string }>(`
      INSERT INTO organizations (code, legal_name, timezone, base_currency)
      VALUES ('BANKING', 'Banking Test', 'UTC', 'USD')
      RETURNING id
    `);
    const organizationId = organization.rows[0]!.id;
    await client.query(`
      INSERT INTO currencies (
        organization_id, code, name, decimal_places, base_currency
      ) VALUES ($1, 'USD', 'US Dollar', 2, true)
    `, [organizationId]);
    const branch = await client.query<{ id: string }>(`
      INSERT INTO branches (organization_id, code, name)
      VALUES ($1, 'HQ', 'Headquarters') RETURNING id
    `, [organizationId]);
    const unit = await client.query<{ id: string }>(`
      INSERT INTO treasury_units (
        organization_id, branch_id, code, name, default_currency
      ) VALUES ($1,NULL,'COLLECT','Branchless Collections','USD') RETURNING id
    `, [organizationId]);
    const endpointUnit = await client.query<{ id: string }>(`
      INSERT INTO treasury_units (
        organization_id, branch_id, code, name, default_currency
      ) VALUES ($1,$2,'HQ_COLLECT','Headquarters Collections','USD') RETURNING id
    `, [organizationId, branch.rows[0]!.id]);
    const users = await client.query<{ id: string; subject_key: string }>(`
      INSERT INTO user_refs (organization_id, subject_key, display_name)
      VALUES
        ($1, 'banking-admin', 'Banking Admin'),
        ($1, 'banking-scoped', 'Banking Scoped')
      RETURNING id, subject_key
    `, [organizationId]);
    const userId = new Map(users.rows.map((user) => [user.subject_key, user.id]));
    const adminRole = await client.query<{ id: string }>(`
      INSERT INTO roles (organization_id, code, name)
      VALUES ($1, 'BANKING_ADMIN', 'Banking Admin') RETURNING id
    `, [organizationId]);
    const scopedRole = await client.query<{ id: string }>(`
      INSERT INTO roles (organization_id, code, name)
      VALUES ($1, 'BANKING_SCOPED', 'Banking Scoped') RETURNING id
    `, [organizationId]);
    await client.query(`
      INSERT INTO role_permissions (role_id, permission)
      SELECT $1, permission
      FROM operation_permissions
      WHERE permission IN (
        'bank-type.view', 'bank-type.manage', 'bank.view', 'bank.manage',
        'bank-branch.view', 'bank-branch.manage', 'bank-account.view',
        'bank-account.manage', 'pos-terminal.view', 'pos-terminal.manage',
        'payment-gateway.view', 'payment-gateway.manage'
      )
    `, [adminRole.rows[0]!.id]);
    await client.query(`
      INSERT INTO role_permissions (role_id, permission)
      VALUES
        ($1, 'bank-account.view'), ($1, 'bank-account.manage'),
        ($1, 'pos-terminal.view'), ($1, 'pos-terminal.manage'),
        ($1, 'payment-gateway.view'), ($1, 'payment-gateway.manage')
    `, [scopedRole.rows[0]!.id]);
    await client.query(`
      INSERT INTO access_grants (
        organization_id, user_ref_id, role_id, scope_id
      ) VALUES ($1,$2,$3,$1)
    `, [organizationId, userId.get('banking-admin'), adminRole.rows[0]!.id]);
    const scopedGrant = await client.query<{ id: string }>(`
      INSERT INTO access_grants (
        organization_id, user_ref_id, role_id, scope_id
      ) VALUES ($1,$2,$3,$1)
      RETURNING id
    `, [organizationId, userId.get('banking-scoped'), scopedRole.rows[0]!.id]);
    await client.query(`
      INSERT INTO access_grant_branch_scopes (access_grant_id, branch_id)
      VALUES ($1,$2)
    `, [scopedGrant.rows[0]!.id, branch.rows[0]!.id]);
    await client.query(`
      INSERT INTO access_grant_treasury_unit_scopes (access_grant_id, treasury_unit_id)
      VALUES ($1,$2), ($1,$3)
    `, [
      scopedGrant.rows[0]!.id,
      unit.rows[0]!.id,
      endpointUnit.rows[0]!.id,
    ]);
    await client.query(`
      INSERT INTO access_grant_currency_scopes (
        access_grant_id, organization_id, currency
      ) VALUES ($1,$2,'USD')
    `, [scopedGrant.rows[0]!.id, organizationId]);
    await client.query('COMMIT');
    return {
      organizationId,
      organizationBranchId: branch.rows[0]!.id,
      branchlessUnitId: unit.rows[0]!.id,
      endpointUnitId: endpointUnit.rows[0]!.id,
      adminUserId: userId.get('banking-admin')!,
      scopedUserId: userId.get('banking-scoped')!,
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
