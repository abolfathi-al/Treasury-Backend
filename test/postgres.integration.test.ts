import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { AuthRepository } from '../src/access-control/auth.repository';
import { AuthService } from '../src/access-control/auth.service';
import { CredentialService } from '../src/access-control/credential.service';
import { IdentityRepository } from '../src/access-control/identity.repository';
import { DatabaseService } from '../src/database/database.service';
import {
  MethodBehaviorCategory,
  MethodDirection,
  MethodReference,
} from '../src/master-data/master-data.dto';
import { MasterDataRepository } from '../src/master-data/master-data.repository';
import { commandDigest, digest, stableJson } from '../src/common/http';
import { MasterDataService } from '../src/master-data/master-data.service';
import { TreasuryProblem } from '../src/common/problem';

const connectionString = process.env.TEST_DATABASE_URL;

test('PostgreSQL idempotency serializes concurrent Method creation and replays one result', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = connectionString;
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 4).toString('base64');
  const database = new DatabaseService();
  const repository = new MasterDataRepository(database);
  try {
    const organizationId = await seedOrganization(database);
    const command = {
      code: 'WIRE',
      name: 'Wire transfer',
      direction: MethodDirection.BOTH,
      behaviorCategory: MethodBehaviorCategory.BANK_TRANSFER,
      requiredReferences: [MethodReference.BANK_ACCOUNT, MethodReference.TRACKING_NUMBER],
      createsFundsInTransit: true,
      requiresApproval: true,
      allowedCurrencies: ['USD'],
      amountLimits: [{ amount: '1000.00', currency: 'USD' }],
      debitMappingRef: 'ledger:wire-debit',
    };
    const [first, second] = await Promise.all([
      repository.createMethod(organizationId, command, 'same-key', digest('same')),
      repository.createMethod(organizationId, command, 'same-key', digest('same')),
    ]);
    assert.equal(first.id, second.id);
    const mappings = await database.pool.query<{ mapping_kind: string; mapping_ref: string }>(`
      SELECT mapping_kind, mapping_ref FROM method_mappings WHERE method_id = $1
    `, [first.id]);
    assert.deepEqual(mappings.rows, [{ mapping_kind: 'DEBIT', mapping_ref: 'ledger:wire-debit' }]);
    const listed = await repository.listMethods(organizationId, 50);
    assert.equal(listed.items[0]!.debitMappingRef, 'ledger:wire-debit');
    assert.equal('creditMappingRef' in listed.items[0]!, false);

    const service = new MasterDataService(repository);
    const keyedCommand = { ...command, code: 'WIRE-KEYED' };
    await service.createMethod(organizationId, keyedCommand, 'keyed-command');
    const rawDigest = digest(stableJson(keyedCommand));
    const keyedDigest = commandDigest('createMethodDefinition', keyedCommand);
    const preciseCommand = { ...command, code: 'WIRE-PRECISE', amountLimits: [{ amount: '1.234', currency: 'USD' }] };
    await assert.rejects(
      service.createMethod(organizationId, preciseCommand, 'precision-key'),
      (error) => error instanceof TreasuryProblem
        && error.getStatus() === 422
        && (error.getResponse() as { code?: string }).code === 'TRS-MST-004',
    );
    assert.notEqual(rawDigest, keyedDigest);
    const stored = await database.pool.query<{ request_digest: string }>(`
      SELECT request_digest FROM idempotency_records
      WHERE organization_id = $1 AND scope = 'createMethodDefinition' AND idempotency_key = 'keyed-command'
    `, [organizationId]);
    assert.equal(stored.rows[0]!.request_digest, keyedDigest);
    assert.notEqual(stored.rows[0]!.request_digest, rawDigest);

    await assert.rejects(
      repository.createMethod(
        organizationId,
        { ...command, name: 'Changed payload' },
        'same-key',
        digest('different'),
      ),
      (error) => error instanceof SyntaxError && error.message === 'IDEMPOTENCY_CONFLICT',
    );
  } finally {
    await database.onModuleDestroy();
  }
});

test('identity command finalizes its exact step-up proof only with the successful transaction', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = connectionString;
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 4).toString('base64');
  process.env.LOGIN_THROTTLE_HMAC_KEY_BASE64 = Buffer.alloc(32, 5).toString('base64');
  const database = new DatabaseService();
  const credentials = new CredentialService();
  const identities = new IdentityRepository(database);
  try {
    const fixture = await seedIdentityCommand(database, credentials);
    const dto = {
      userId: fixture.targetUserId,
      login: 'privileged.invitee',
      temporaryPassword: 'safe temporary identity password 2026',
      privileged: true,
    };
    const bodyDigest = commandDigest('createIdentityAccount', dto);
    const created = await identities.createIdentityAccount(
      fixture.organizationId,
      dto,
      dto.login,
      await credentials.hashPassword(dto.temporaryPassword),
      fixture.idempotencyKey,
      bodyDigest,
      {
        proofDigest: digest(fixture.proofId),
        sessionId: fixture.sessionId,
        method: 'POST',
        path: '/v1/identity-accounts',
        bodyDigest,
      },
    );
    assert.equal(created.state, 'INVITED');
    assert.equal(created.totpEnrolled, false);
    const finalized = await database.pool.query<{ consumed_at: Date | null; request_digest: string }>(`
      SELECT p.consumed_at, i.request_digest
      FROM auth_step_up_proofs p
      CROSS JOIN idempotency_records i
      WHERE p.token_digest = $1 AND i.idempotency_key = $2
    `, [digest(fixture.proofId), fixture.idempotencyKey]);
    assert.ok(finalized.rows[0]!.consumed_at);
    assert.equal(finalized.rows[0]!.request_digest, bodyDigest);
    assert.notEqual(finalized.rows[0]!.request_digest, digest(stableJson(dto)));
    await database.pool.query(`
      UPDATE auth_step_up_proofs SET expires_at = now() - interval '1 second'
      WHERE token_digest = $1
    `, [digest(fixture.proofId)]);
    await assert.rejects(
      identities.createIdentityAccount(
        fixture.organizationId,
        dto,
        dto.login,
        await credentials.hashPassword(dto.temporaryPassword),
        fixture.idempotencyKey,
        bodyDigest,
        {
          proofDigest: digest(fixture.proofId),
          sessionId: fixture.sessionId,
          method: 'POST',
          path: '/v1/identity-accounts',
          bodyDigest,
        },
      ),
      (error) => error instanceof RangeError && error.message === 'STEP_UP_INVALID',
    );

    const auth = new AuthService(new AuthRepository(database), credentials);
    await assert.rejects(
      auth.login({ login: dto.login, password: dto.temporaryPassword }, 'invited-login'),
      (error) => error instanceof TreasuryProblem && error.getStatus() === 401,
    );

    const failed = await createStepUpFixture(
      database,
      fixture.adminAccountId,
      fixture.sessionId,
      'failed-proof',
      'failed-command',
    );
    await assert.rejects(
      identities.createIdentityAccount(
        fixture.organizationId,
        { ...dto, userId: randomUUID(), login: 'missing.user' },
        'missing.user',
        await credentials.hashPassword(dto.temporaryPassword),
        'failed-command',
        failed.bodyDigest,
        {
          proofDigest: digest(failed.proofId),
          sessionId: fixture.sessionId,
          method: 'POST',
          path: '/v1/identity-accounts',
          bodyDigest: failed.bodyDigest,
        },
      ),
      ReferenceError,
    );
    const failedProof = await database.pool.query<{ consumed_at: Date | null }>(
      'SELECT consumed_at FROM auth_step_up_proofs WHERE token_digest = $1',
      [digest(failed.proofId)],
    );
    assert.equal(failedProof.rows[0]!.consumed_at, null);
  } finally {
    await database.onModuleDestroy();
  }
});

async function seedOrganization(database: DatabaseService): Promise<string> {
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    for (const table of [
      'auth_step_up_proofs',
      'auth_challenges',
      'auth_sessions',
      'security_audit_events',
      'auth_password_attempt_reservations',
      'auth_throttle_buckets',
      'auth_recovery_attempts',
      'role_permissions',
      'access_grant_currency_scopes',
      'access_grant_method_category_scopes',
      'access_grant_document_type_scopes',
      'access_grant_bank_account_scopes',
      'access_grant_cashbox_scopes',
      'access_grant_treasury_unit_scopes',
      'access_grant_branch_scopes',
      'access_grants',
      'identity_accounts',
      'roles',
      'user_refs',
      'idempotency_records',
      'method_amount_limits',
      'method_allowed_currencies',
      'method_required_references',
      'method_mappings',
      'method_definitions',
      'treasury_units',
      'branches',
      'currencies',
      'organizations',
    ]) {
      await client.query(`DELETE FROM ${table}`);
    }
    const organization = await client.query<{ id: string }>(`
      INSERT INTO organizations (code, legal_name, timezone, base_currency)
      VALUES ('TEST', 'Test Treasury', 'UTC', 'USD') RETURNING id
    `);
    const organizationId = organization.rows[0]!.id;
    await client.query(`
      INSERT INTO currencies (
        organization_id, code, name, decimal_places, base_currency
      ) VALUES ($1, 'USD', 'US Dollar', 2, true)
    `, [organizationId]);
    await client.query('COMMIT');
    return organizationId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function seedIdentityCommand(database: DatabaseService, credentials: CredentialService) {
  const organizationId = await seedOrganization(database);
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    const admin = await client.query<{ id: string }>(`
      INSERT INTO user_refs (organization_id, subject_key, display_name)
      VALUES ($1,'admin','Administrator') RETURNING id
    `, [organizationId]);
    const target = await client.query<{ id: string }>(`
      INSERT INTO user_refs (organization_id, subject_key, display_name)
      VALUES ($1,'invitee','Privileged Invitee') RETURNING id
    `, [organizationId]);
    const account = await client.query<{ id: string }>(`
      INSERT INTO identity_accounts (user_ref_id, normalized_login, password_hash, privileged)
      VALUES ($1,'admin',$2,true) RETURNING id
    `, [admin.rows[0]!.id, await credentials.hashPassword('safe administrator password 2026')]);
    const session = await client.query<{ id: string }>(`
      INSERT INTO auth_sessions (
        identity_account_id, token_digest, xsrf_digest, authenticated_at, last_rotated_at,
        idle_expires_at, absolute_expires_at, assurance
      ) VALUES ($1,$2,$3,now(),now(),now() + interval '15 minutes',now() + interval '8 hours','PASSWORD_TOTP')
      RETURNING id
    `, [account.rows[0]!.id, digest('admin-session'), digest('admin-xsrf')]);
    await client.query('COMMIT');
    const idempotencyKey = 'identity-command';
    const proofId = 'identity-proof';
    const dto = {
      userId: target.rows[0]!.id,
      login: 'privileged.invitee',
      temporaryPassword: 'safe temporary identity password 2026',
      privileged: true,
    };
    const bodyDigest = commandDigest('createIdentityAccount', dto);
    await createStepUpFixture(
      database,
      account.rows[0]!.id,
      session.rows[0]!.id,
      proofId,
      idempotencyKey,
      bodyDigest,
    );
    return {
      organizationId,
      targetUserId: target.rows[0]!.id,
      adminAccountId: account.rows[0]!.id,
      sessionId: session.rows[0]!.id,
      idempotencyKey,
      proofId,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function createStepUpFixture(
  database: DatabaseService,
  accountId: string,
  sessionId: string,
  proofId: string,
  idempotencyKey: string,
  suppliedBodyDigest = digest('failed-body'),
) {
  const challenge = await database.pool.query<{ id: string }>(`
    INSERT INTO auth_challenges (
      identity_account_id, session_id, token_digest, kind, http_method, http_path,
      request_body_digest, idempotency_key, expires_at
    ) VALUES ($1,$2,$3,'STEP_UP','POST','/v1/identity-accounts',$4,$5,now() + interval '5 minutes')
    RETURNING id
  `, [accountId, sessionId, digest(`challenge:${proofId}`), suppliedBodyDigest, idempotencyKey]);
  await database.pool.query(`
    INSERT INTO auth_step_up_proofs (challenge_id, token_digest, expires_at)
    VALUES ($1,$2,now() + interval '5 minutes')
  `, [challenge.rows[0]!.id, digest(proofId)]);
  return { proofId, bodyDigest: suppliedBodyDigest };
}
