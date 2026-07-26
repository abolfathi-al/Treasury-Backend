import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { AccessAdminRepository } from '../src/access-control/access-admin.repository';
import { AccessAdminService } from '../src/access-control/access-admin.service';
import { SessionRevokeScope } from '../src/access-control/access-admin.dto';
import { AuthRepository } from '../src/access-control/auth.repository';
import { AuthService, SessionContext } from '../src/access-control/auth.service';
import { operationPermissionGranted } from '../src/access-control/auth.guard';
import { CredentialService } from '../src/access-control/credential.service';
import { commandDigest, digest } from '../src/common/http';
import { TreasuryProblem } from '../src/common/problem';
import { DatabaseService } from '../src/database/database.service';

const connectionString = process.env.TEST_DATABASE_URL;

test('INC-1B PostgreSQL commands are scoped, replay-safe, atomic, and session-chain aware', {
  skip: connectionString ? false : 'TEST_DATABASE_URL is not configured',
}, async () => {
  process.env.DATABASE_URL = connectionString;
  process.env.COMMAND_DIGEST_HMAC_KEY_BASE64 = Buffer.alloc(32, 11).toString('base64');
  process.env.LOGIN_THROTTLE_HMAC_KEY_BASE64 = Buffer.alloc(32, 12).toString('base64');
  process.env.TOTP_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 13).toString('base64');
  const database = new DatabaseService();
  const credentials = new CredentialService();
  const auth = new AuthService(new AuthRepository(database), credentials);
  const repository = new AccessAdminRepository(database);
  const service = new AccessAdminService(repository, auth);
  try {
    const fixture = await seed(database);
    const actor = sessionContext(fixture);
    const scopedAdmin = await seedScopedAdmin(database, fixture);
    const scopedAuth = await auth.authenticateSession(scopedAdmin.token);
    assert.ok(scopedAuth.session.effectivePermissions.includes('role.manage'));
    assert.deepEqual(scopedAuth.organizationPermissions, []);
    for (const [operationId, permission] of [
      ['listUserRefs', 'access-control.view'],
      ['createUserRef', 'identity-account.manage'],
      ['createIdentityAccount', 'identity-account.manage'],
      ['listIdentityAccounts', 'identity-account.manage'],
      ['listIdentityAccountSessions', 'identity-account.manage'],
      ['revokeIdentitySessions', 'identity-account.manage'],
      ['listRoles', 'access-control.view'],
      ['createRole', 'role.manage'],
    ] as const) {
      assert.equal(
        operationPermissionGranted(
          scopedAuth,
          operationId,
          permission,
          'ORGANIZATION_WIDE',
        ),
        false,
      );
      assert.equal(
        operationPermissionGranted(actor, operationId, permission, 'ORGANIZATION_WIDE'),
        true,
      );
    }
    assert.equal(
      operationPermissionGranted(
        scopedAuth,
        'listAccessGrants',
        'access-control.view',
        'ONE_GRANT_RESOURCE',
      ),
      true,
    );
    assert.equal(
      operationPermissionGranted(
        scopedAuth,
        'createAccessGrant',
        'access-grant.manage',
        'ONE_GRANT_RESOURCE',
      ),
      true,
    );

    const roleBody = {
      code: 'TREASURY_VIEWER',
      name: 'Treasury viewer',
      permissions: ['master-data.view'],
    };
    const roleStep = await step(
      database,
      fixture.actorAccountId,
      fixture.actorSessionId,
      'createRole',
      '/v1/roles',
      roleBody,
      'role-command',
    );
    const role = await service.createRole(
      fixture.organizationId,
      roleBody,
      'role-command',
      'role-request',
      actor,
      roleStep,
    ) as { id: string };
    const roleReplay = await service.createRole(
      fixture.organizationId,
      roleBody,
      'role-command',
      'role-replay',
      actor,
      roleStep,
    ) as { id: string };
    assert.equal(roleReplay.id, role.id);
    assert.equal(
      (await database.pool.query(
        `SELECT count(*)::int AS count FROM roles
         WHERE organization_id = $1 AND code = 'TREASURY_VIEWER'`,
        [fixture.organizationId],
      )).rows[0]!.count,
      1,
    );
    await database.pool.query(`
      UPDATE auth_step_up_proofs SET expires_at = now() - interval '1 second'
      WHERE token_digest = $1
    `, [digest(roleStep.proofId)]);
    assert.equal(
      await new AuthRepository(database).validateStepUpProof(
        digest(roleStep.proofId),
        {
          organizationId: fixture.organizationId,
          operationId: 'createRole',
          sessionId: fixture.actorSessionId,
          method: 'POST',
          path: '/v1/roles',
          bodyDigest: commandDigest('createRole', roleBody),
          idempotencyKey: 'role-command',
        },
      ),
      false,
    );
    await assert.rejects(
      service.createRole(
        fixture.organizationId,
        roleBody,
        'role-command',
        'role-expired-replay',
        actor,
        roleStep,
      ),
      (error) => problem(error, 'TRS-AUT-010', 428),
    );

    const conflictingRole = { ...roleBody, name: 'Changed viewer' };
    const conflictStep = await step(
      database,
      fixture.actorAccountId,
      fixture.actorSessionId,
      'createRole',
      '/v1/roles',
      conflictingRole,
      'role-command',
    );
    await assert.rejects(
      service.createRole(
        fixture.organizationId,
        conflictingRole,
        'role-command',
        'role-conflict',
        actor,
        conflictStep,
      ),
      (error) => problem(error, 'TRS-GEN-007', 409),
    );

    const grantBody = {
      userId: fixture.targetUserId,
      roleId: role.id,
      scope: {
        branchIds: [fixture.branchId],
        documentTypes: ['PAYMENT'],
        methodCategories: ['CASH'],
        currencies: ['USD'],
        amountCeiling: { amount: '100.00', currency: 'USD' },
      },
      validFrom: '2026-01-01T00:00:00.000Z',
      reason: 'Foundation access',
    };
    const oversizedBody = {
      ...grantBody,
      scope: {
        ...grantBody.scope,
        amountCeiling: {
          amount: '1234567890123456789012345678901',
          currency: 'USD',
        },
      },
    };
    const oversizedStep = await step(
      database,
      fixture.actorAccountId,
      fixture.actorSessionId,
      'createAccessGrant',
      '/v1/access-grants',
      oversizedBody,
      'grant-oversized',
    );
    const targetEpochBeforeOversized = await epoch(database, fixture.targetAccountId);
    await assert.rejects(
      service.createAccessGrant(
        fixture.organizationId,
        oversizedBody,
        'grant-oversized',
        'grant-oversized-request',
        actor,
        oversizedStep,
      ),
      (error) => problem(error, 'TRS-GEN-001', 422),
    );
    const oversizedState = await database.pool.query<{
      grants: string;
      idempotency: string;
      proof_consumed: Date | null;
    }>(`
      SELECT
        (SELECT count(*) FROM access_grants WHERE user_ref_id = $1)::text AS grants,
        (SELECT count(*) FROM idempotency_records
         WHERE idempotency_key = 'grant-oversized')::text AS idempotency,
        p.consumed_at AS proof_consumed
      FROM auth_step_up_proofs p WHERE p.token_digest = $2
    `, [fixture.targetUserId, digest(oversizedStep.proofId)]);
    assert.equal(oversizedState.rows[0]!.grants, '0');
    assert.equal(oversizedState.rows[0]!.idempotency, '0');
    assert.equal(oversizedState.rows[0]!.proof_consumed, null);
    assert.equal(await epoch(database, fixture.targetAccountId), targetEpochBeforeOversized);
    const grantStep = await step(
      database,
      fixture.actorAccountId,
      fixture.actorSessionId,
      'createAccessGrant',
      '/v1/access-grants',
      grantBody,
      'grant-command',
    );
    const grant = await service.createAccessGrant(
      fixture.organizationId,
      grantBody,
      'grant-command',
      'grant-request',
      actor,
      grantStep,
    ) as { id: string };
    const grantReplay = await service.createAccessGrant(
      fixture.organizationId,
      grantBody,
      'grant-command',
      'grant-replay',
      actor,
      grantStep,
    ) as { id: string };
    assert.equal(grantReplay.id, grant.id);
    const grantState = await database.pool.query<{
      authorization_epoch: string;
      branches: string;
      currencies: string;
      methods: string;
    }>(`
      SELECT ia.authorization_epoch::text,
             (SELECT count(*) FROM access_grant_branch_scopes
              WHERE access_grant_id = $2)::text AS branches,
             (SELECT count(*) FROM access_grant_currency_scopes
              WHERE access_grant_id = $2)::text AS currencies,
             (SELECT count(*) FROM access_grant_method_category_scopes
              WHERE access_grant_id = $2)::text AS methods
      FROM identity_accounts ia WHERE ia.id = $1
    `, [fixture.targetAccountId, grant.id]);
    assert.deepEqual(grantState.rows[0], {
      authorization_epoch: '1',
      branches: '1',
      currencies: '1',
      methods: '1',
    });

    const duplicateStep = await step(
      database,
      fixture.actorAccountId,
      fixture.actorSessionId,
      'createAccessGrant',
      '/v1/access-grants',
      grantBody,
      'grant-duplicate',
    );
    await assert.rejects(
      service.createAccessGrant(
        fixture.organizationId,
        grantBody,
        'grant-duplicate',
        'grant-duplicate-request',
        actor,
        duplicateStep,
      ),
      (error) => problem(error, 'TRS-AUT-012', 409),
    );
    assert.equal(await epoch(database, fixture.targetAccountId), 1);

    const privilegedBody = {
      userId: fixture.targetUserId,
      roleId: fixture.privilegedRoleId,
      validFrom: '2026-01-01T00:00:00.000Z',
    };
    const ineligibleStep = await step(
      database,
      fixture.actorAccountId,
      fixture.actorSessionId,
      'createAccessGrant',
      '/v1/access-grants',
      privilegedBody,
      'grant-ineligible',
    );
    await assert.rejects(
      service.createAccessGrant(
        fixture.organizationId,
        privilegedBody,
        'grant-ineligible',
        'grant-ineligible-request',
        actor,
        ineligibleStep,
      ),
      (error) => problem(error, 'TRS-GEN-005', 409),
    );
    assert.equal(await epoch(database, fixture.targetAccountId), 1);
    const rollback = await database.pool.query<{
      idempotency: string;
      proof_consumed: Date | null;
    }>(`
      SELECT
        (SELECT count(*) FROM idempotency_records
         WHERE idempotency_key = 'grant-ineligible')::text AS idempotency,
        p.consumed_at AS proof_consumed
      FROM auth_step_up_proofs p WHERE p.token_digest = $1
    `, [digest(ineligibleStep.proofId)]);
    assert.equal(rollback.rows[0]!.idempotency, '0');
    assert.equal(rollback.rows[0]!.proof_consumed, null);

    await database.pool.query(`
      UPDATE identity_accounts
      SET privileged = true, totp_ciphertext = 'ciphertext', totp_iv = 'iv',
          totp_auth_tag = 'tag', totp_key_version = 1
      WHERE id = $1
    `, [fixture.targetAccountId]);
    const eligibleStep = await step(
      database,
      fixture.actorAccountId,
      fixture.actorSessionId,
      'createAccessGrant',
      '/v1/access-grants',
      privilegedBody,
      'grant-privileged',
    );
    await service.createAccessGrant(
      fixture.organizationId,
      privilegedBody,
      'grant-privileged',
      'grant-privileged-request',
      actor,
      eligibleStep,
    );
    assert.equal(await epoch(database, fixture.targetAccountId), 2);

    const rotated = await auth.authenticateSession(fixture.targetToken);
    assert.ok(rotated.rotatedSessionToken);
    assert.equal(rotated.session.sessionId, fixture.targetSessionId);
    assert.ok(rotated.session.effectivePermissions.includes('master-data.view'));
    assert.ok(rotated.session.effectivePermissions.includes('payment.execute'));
    const predecessor = await auth.authenticateSession(fixture.targetToken);
    assert.equal(predecessor.physicalSessionId, rotated.physicalSessionId);
    assert.equal(predecessor.matchedCurrent, false);
    const chain = await database.pool.query<{
      logical_session_id: string;
      identity_account_id: string;
      device_label: string;
      authenticated_at: Date;
      absolute_expires_at: Date;
    }>(`
      SELECT logical_session_id, identity_account_id, device_label,
             authenticated_at, absolute_expires_at
      FROM auth_sessions WHERE logical_session_id = $1 ORDER BY authenticated_at, id
    `, [fixture.targetSessionId]);
    assert.equal(chain.rowCount, 2);
    for (const row of chain.rows) {
      assert.equal(row.logical_session_id, fixture.targetSessionId);
      assert.equal(row.identity_account_id, fixture.targetAccountId);
      assert.equal(row.device_label, 'target-device');
      assert.equal(row.authenticated_at.toISOString(), chain.rows[0]!.authenticated_at.toISOString());
      assert.equal(row.absolute_expires_at.toISOString(), chain.rows[0]!.absolute_expires_at.toISOString());
    }

    const inventory = await repository.listIdentityAccountSessions(
      fixture.organizationId,
      fixture.targetAccountId,
      fixture.targetSessionId,
      50,
    );
    assert.equal(inventory.items.length, 1);
    assert.equal(inventory.items[0]!.id, fixture.targetSessionId);
    assert.equal(inventory.items[0]!.state, 'ACTIVE');
    assert.equal(inventory.items[0]!.current, true);

    const revokeBody = {
      reason: 'Lost device',
      scope: SessionRevokeScope.ONE_SESSION,
      sessionId: fixture.targetSessionId,
    };
    const revokeStep = await step(
      database,
      fixture.actorAccountId,
      fixture.actorSessionId,
      'revokeIdentitySessions',
      `/v1/identity-accounts/${fixture.targetAccountId}/session-revocations`,
      revokeBody,
      'revoke-command',
    );
    const revoked = await service.revokeIdentitySessions(
      fixture.organizationId,
      fixture.targetAccountId,
      revokeBody,
      'revoke-command',
      'revoke-request',
      actor,
      revokeStep,
    ) as { revokedSessionCount: number };
    assert.equal(revoked.revokedSessionCount, 1);
    const revokeReplay = await service.revokeIdentitySessions(
      fixture.organizationId,
      fixture.targetAccountId,
      revokeBody,
      'revoke-command',
      'revoke-replay',
      actor,
      revokeStep,
    ) as { revokedSessionCount: number };
    assert.equal(revokeReplay.revokedSessionCount, 1);
    assert.equal(
      (await database.pool.query(
        'SELECT count(*)::int AS count FROM auth_sessions WHERE logical_session_id = $1',
        [fixture.targetSessionId],
      )).rows[0]!.count,
      2,
    );
    await assert.rejects(
      auth.authenticateSession(rotated.rotatedSessionToken!),
      (error) => problem(error, 'TRS-AUT-003', 401),
    );
  } finally {
    await cleanup(database);
    await database.onModuleDestroy();
  }
});

async function seed(database: DatabaseService) {
  await cleanup(database);
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    const organization = await client.query<{ id: string }>(`
      INSERT INTO organizations (code, legal_name, timezone, base_currency)
      VALUES ('INC1B', 'INC-1B Treasury', 'UTC', 'USD') RETURNING id
    `);
    const organizationId = organization.rows[0]!.id;
    await client.query(`
      INSERT INTO currencies (
        organization_id, code, name, decimal_places, base_currency
      ) VALUES ($1,'USD','US Dollar',2,true)
    `, [organizationId]);
    const branch = await client.query<{ id: string }>(`
      INSERT INTO branches (organization_id, code, name)
      VALUES ($1,'HQ','Headquarters') RETURNING id
    `, [organizationId]);
    const actorUser = await client.query<{ id: string }>(`
      INSERT INTO user_refs (organization_id, subject_key, display_name)
      VALUES ($1,'access-admin','Access Administrator') RETURNING id
    `, [organizationId]);
    const targetUser = await client.query<{ id: string }>(`
      INSERT INTO user_refs (organization_id, subject_key, display_name)
      VALUES ($1,'target','Target User') RETURNING id
    `, [organizationId]);
    const actorAccount = await client.query<{ id: string }>(`
      INSERT INTO identity_accounts (
        user_ref_id, normalized_login, password_hash, privileged,
        totp_ciphertext, totp_iv, totp_auth_tag, totp_key_version
      ) VALUES ($1,'access-admin','hash',true,'ciphertext','iv','tag',1)
      RETURNING id
    `, [actorUser.rows[0]!.id]);
    const targetAccount = await client.query<{ id: string }>(`
      INSERT INTO identity_accounts (user_ref_id, normalized_login, password_hash)
      VALUES ($1,'target','hash') RETURNING id
    `, [targetUser.rows[0]!.id]);
    const adminRole = await client.query<{ id: string }>(`
      INSERT INTO roles (organization_id, code, name)
      VALUES ($1,'ACCESS_ADMIN','Access Administrator') RETURNING id
    `, [organizationId]);
    for (const permission of [
      'access-control.view',
      'access-grant.manage',
      'identity-account.manage',
      'role.manage',
    ]) {
      await client.query(
        'INSERT INTO role_permissions (role_id, permission) VALUES ($1,$2)',
        [adminRole.rows[0]!.id, permission],
      );
    }
    await client.query(`
      INSERT INTO access_grants (
        organization_id, user_ref_id, role_id, scope_type, scope_id, valid_from
      ) VALUES ($1,$2,$3,'ORGANIZATION',$1,'2020-01-01T00:00:00.000Z')
    `, [organizationId, actorUser.rows[0]!.id, adminRole.rows[0]!.id]);
    const privilegedRole = await client.query<{ id: string }>(`
      INSERT INTO roles (organization_id, code, name)
      VALUES ($1,'PAYMENT_EXECUTOR','Payment Executor') RETURNING id
    `, [organizationId]);
    await client.query(
      'INSERT INTO role_permissions (role_id, permission) VALUES ($1,$2)',
      [privilegedRole.rows[0]!.id, 'payment.execute'],
    );
    const actorSession = await client.query<{ id: string }>(`
      INSERT INTO auth_sessions (
        identity_account_id, token_digest, xsrf_digest, authenticated_at,
        last_rotated_at, idle_expires_at, absolute_expires_at, assurance, device_label
      ) VALUES (
        $1,$2,$3,now(),now(),now() + interval '15 minutes',
        now() + interval '8 hours','PASSWORD_TOTP','admin-device'
      ) RETURNING id
    `, [actorAccount.rows[0]!.id, digest('actor-token'), digest('actor-xsrf')]);
    const targetSession = await client.query<{ id: string }>(`
      INSERT INTO auth_sessions (
        identity_account_id, token_digest, xsrf_digest, authenticated_at,
        last_rotated_at, idle_expires_at, absolute_expires_at, assurance, device_label
      ) VALUES (
        $1,$2,$3,now(),now(),now() + interval '15 minutes',
        now() + interval '8 hours','PASSWORD','target-device'
      ) RETURNING id
    `, [targetAccount.rows[0]!.id, digest('target-token'), digest('target-xsrf')]);
    await client.query('COMMIT');
    return {
      organizationId,
      branchId: branch.rows[0]!.id,
      actorUserId: actorUser.rows[0]!.id,
      actorAccountId: actorAccount.rows[0]!.id,
      actorSessionId: actorSession.rows[0]!.id,
      targetUserId: targetUser.rows[0]!.id,
      targetAccountId: targetAccount.rows[0]!.id,
      targetSessionId: targetSession.rows[0]!.id,
      targetToken: 'target-token',
      privilegedRoleId: privilegedRole.rows[0]!.id,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function sessionContext(fixture: Awaited<ReturnType<typeof seed>>): SessionContext {
  const now = new Date();
  return {
    accountId: fixture.actorAccountId,
    organizationId: fixture.organizationId,
    physicalSessionId: fixture.actorSessionId,
    organizationPermissions: [
      'access-control.view',
      'access-grant.manage',
      'identity-account.manage',
      'role.manage',
    ],
    xsrfDigest: digest('actor-xsrf'),
    presentedTokenDigest: digest('actor-token'),
    matchedCurrent: true,
    session: {
      sessionId: fixture.actorSessionId,
      authenticatedAt: now.toISOString(),
      idleExpiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
      absoluteExpiresAt: new Date(now.getTime() + 8 * 60 * 60_000).toISOString(),
      assurance: 'PASSWORD_TOTP',
      userId: fixture.actorUserId,
      userDisplayName: 'Access Administrator',
      effectivePermissions: [
        'access-control.view',
        'access-grant.manage',
        'identity-account.manage',
        'role.manage',
      ],
    },
  };
}

async function seedScopedAdmin(
  database: DatabaseService,
  fixture: Awaited<ReturnType<typeof seed>>,
) {
  const user = await database.pool.query<{ id: string }>(`
    INSERT INTO user_refs (organization_id, subject_key, display_name)
    VALUES ($1,'scoped-admin','Scoped Administrator') RETURNING id
  `, [fixture.organizationId]);
  const account = await database.pool.query<{ id: string }>(`
    INSERT INTO identity_accounts (
      user_ref_id, normalized_login, password_hash, privileged,
      totp_ciphertext, totp_iv, totp_auth_tag, totp_key_version
    ) VALUES ($1,'scoped-admin','hash',true,'ciphertext','iv','tag',1)
    RETURNING id
  `, [user.rows[0]!.id]);
  const role = await database.pool.query<{ id: string }>(`
    INSERT INTO roles (organization_id, code, name)
    VALUES ($1,'SCOPED_ADMIN','Scoped Administrator') RETURNING id
  `, [fixture.organizationId]);
  for (const permission of [
    'access-control.view',
    'access-grant.manage',
    'identity-account.manage',
    'role.manage',
  ]) {
    await database.pool.query(
      'INSERT INTO role_permissions (role_id, permission) VALUES ($1,$2)',
      [role.rows[0]!.id, permission],
    );
  }
  const grant = await database.pool.query<{ id: string }>(`
    INSERT INTO access_grants (
      organization_id, user_ref_id, role_id, scope_type, scope_id, valid_from
    ) VALUES ($1,$2,$3,'ORGANIZATION',$1,'2020-01-01T00:00:00.000Z')
    RETURNING id
  `, [fixture.organizationId, user.rows[0]!.id, role.rows[0]!.id]);
  await database.pool.query(`
    INSERT INTO access_grant_branch_scopes (access_grant_id, branch_id)
    VALUES ($1,$2)
  `, [grant.rows[0]!.id, fixture.branchId]);
  const token = `scoped-${randomUUID()}`;
  await database.pool.query(`
    INSERT INTO auth_sessions (
      identity_account_id, token_digest, xsrf_digest, authenticated_at,
      last_rotated_at, idle_expires_at, absolute_expires_at, assurance, device_label
    ) VALUES (
      $1,$2,$3,now(),now(),now() + interval '15 minutes',
      now() + interval '8 hours','PASSWORD_TOTP','scoped-admin-device'
    )
  `, [account.rows[0]!.id, digest(token), digest('scoped-xsrf')]);
  return { token };
}

async function step(
  database: DatabaseService,
  accountId: string,
  sessionId: string,
  operationId: string,
  path: string,
  body: unknown,
  idempotencyKey: string,
) {
  const proofId = randomUUID();
  const bodyDigest = commandDigest(operationId, body);
  const challenge = await database.pool.query<{ id: string }>(`
    INSERT INTO auth_challenges (
      identity_account_id, session_id, token_digest, kind, http_method,
      http_path, request_body_digest, idempotency_key, expires_at
    ) VALUES ($1,$2,$3,'STEP_UP','POST',$4,$5,$6,now() + interval '5 minutes')
    RETURNING id
  `, [
    accountId,
    sessionId,
    digest(`challenge:${proofId}`),
    path,
    bodyDigest,
    idempotencyKey,
  ]);
  await database.pool.query(`
    INSERT INTO auth_step_up_proofs (challenge_id, token_digest, expires_at)
    VALUES ($1,$2,now() + interval '5 minutes')
  `, [challenge.rows[0]!.id, digest(proofId)]);
  return {
    proofId,
    command: {
      operationId,
      method: 'POST',
      path,
      bodyDigest,
      idempotencyKey,
    },
  };
}

async function epoch(database: DatabaseService, accountId: string): Promise<number> {
  const result = await database.pool.query<{ authorization_epoch: string }>(
    'SELECT authorization_epoch::text FROM identity_accounts WHERE id = $1',
    [accountId],
  );
  return Number(result.rows[0]!.authorization_epoch);
}

async function cleanup(database: DatabaseService): Promise<void> {
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
      'access_grant_currency_scopes',
      'access_grant_method_category_scopes',
      'access_grant_document_type_scopes',
      'access_grant_bank_account_scopes',
      'access_grant_cashbox_scopes',
      'access_grant_treasury_unit_scopes',
      'access_grant_branch_scopes',
      'access_grants',
      'role_permissions',
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
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function problem(error: unknown, code: string, status: number): boolean {
  if (!(error instanceof TreasuryProblem) || error.getStatus() !== status) return false;
  return (error.getResponse() as { code?: string }).code === code;
}
