import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AccountRow,
  AuthRepository,
  ChallengeRow,
  SessionRow,
} from '../src/access-control/auth.repository';
import { AuthService } from '../src/access-control/auth.service';
import { CredentialService } from '../src/access-control/credential.service';
import { TreasuryProblem } from '../src/common/problem';

const ids = {
  account: '00000000-0000-4000-8000-000000000101',
  user: '00000000-0000-4000-8000-000000000102',
  organization: '00000000-0000-4000-8000-000000000103',
  session: '00000000-0000-4000-8000-000000000104',
  successor: '00000000-0000-4000-8000-000000000105',
  challenge: '00000000-0000-4000-8000-000000000106',
};

function configureAuthEnvironment(seed: number): void {
  process.env.LOGIN_THROTTLE_HMAC_KEY_BASE64 = Buffer.alloc(32, seed).toString('base64');
  process.env.TOTP_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, seed + 1).toString('base64');
  process.env.TOTP_KEY_VERSION = '1';
}

async function accountFixture(
  credentials: CredentialService,
  overrides: Partial<AccountRow> = {},
): Promise<{ account: AccountRow; password: string; recoveryCode: string; secret: Buffer }> {
  const password = 'safe auth hardening password 2026';
  const recoveryCode = credentials.generateRecoveryCode();
  const secret = Buffer.alloc(32, 71);
  const encrypted = credentials.encryptTotpSecret(
    secret,
    Buffer.from(process.env.TOTP_ENCRYPTION_KEY_BASE64!, 'base64'),
    1,
  );
  return {
    password,
    recoveryCode,
    secret,
    account: {
      id: ids.account,
      user_ref_id: ids.user,
      organization_id: ids.organization,
      organization_code: 'TEST',
      display_name: 'کاربر آزمون امنیت',
      user_ref_state: 'ACTIVE',
      normalized_login: 'auth.user',
      password_hash: await credentials.hashPassword(password),
      password_profile_version: 1,
      totp_ciphertext: encrypted.ciphertext,
      totp_iv: encrypted.iv,
      totp_auth_tag: encrypted.authTag,
      totp_key_version: encrypted.keyVersion,
      totp_last_counter: null,
      recovery_code_hash: await credentials.hashRecoveryCode(recoveryCode),
      authorization_epoch: '0',
      privileged: false,
      state: 'ACTIVE',
      version: 0,
      permissions: [],
      ...overrides,
    },
  };
}

test('password recovery accepts only the current TOTP time step', async () => {
  configureAuthEnvironment(61);
  const credentials = new CredentialService();
  const fixture = await accountFixture(credentials);
  let acceptedCounter: number | null = null;
  const repository = {
    transaction: async (work: (client: never) => Promise<unknown>) => work({} as never),
    findAccountByLogin: async () => fixture.account,
    replaceRecoveryCredentials: async (
      _client: unknown,
      _accountId: string,
      _passwordHash: string,
      _recoveryHash: string,
      counter: number | null,
    ) => {
      acceptedCounter = counter;
    },
    revokeAllAccountSecrets: async () => undefined,
    lockAuthBucket: async () => undefined,
    clearRecoveryAttempts: async () => undefined,
    audit: async () => undefined,
  } as unknown as AuthRepository;
  const service = new AuthService(repository, credentials) as unknown as {
    recoverPassword: AuthService['recoverPassword'];
    reserveRecoveryAttempt(): Promise<{ attempts: number; expiresAt: Date }>;
  };
  service.reserveRecoveryAttempt = async () => ({
    attempts: 1,
    expiresAt: new Date(Date.now() + 5 * 60_000),
  });

  const originalNow = Date.now;
  const fixedNow = 1_800_000_015_000;
  const counter = Math.floor(fixedNow / 30_000);
  Date.now = () => fixedNow;
  try {
    await assert.rejects(
      service.recoverPassword({
        login: fixture.account.normalized_login,
        newPassword: 'safe rejected recovery password 2026',
        method: 'AUTHENTICATOR',
        totpCode: credentials.totp(fixture.secret, counter - 1),
      }, 'previous-totp-recovery'),
      (error) => error instanceof TreasuryProblem
        && (error.getResponse() as { code?: string }).code === 'TRS-AUT-006',
    );
    const recovered = await service.recoverPassword({
      login: fixture.account.normalized_login,
      newPassword: 'safe accepted recovery password 2026',
      method: 'AUTHENTICATOR',
      totpCode: credentials.totp(fixture.secret, counter),
    }, 'current-totp-recovery');
    assert.equal(recovered.outcome, 'PASSWORD_RESET');
    assert.equal(acceptedCounter, counter);

    acceptedCounter = counter;
    const savedCodeRecovered = await service.recoverPassword({
      login: fixture.account.normalized_login,
      newPassword: 'safe saved code recovery password 2026',
      method: 'RECOVERY_CODE',
      recoveryCode: fixture.recoveryCode,
    }, 'saved-code-recovery');
    assert.equal(savedCodeRecovered.outcome, 'PASSWORD_RESET');
    assert.equal(acceptedCounter, null);

    await assert.rejects(
      service.recoverPassword({
        login: fixture.account.normalized_login,
        newPassword: 'safe ambiguous recovery password 2026',
        method: 'AUTHENTICATOR',
        totpCode: credentials.totp(fixture.secret, counter),
        recoveryCode: fixture.recoveryCode,
      }, 'ambiguous-recovery'),
      (error) => error instanceof TreasuryProblem
        && (error.getResponse() as { code?: string }).code === 'TRS-AUT-006',
    );
  } finally {
    Date.now = originalNow;
  }
});

test('login fails closed when any TOTP secret tuple component is missing', async () => {
  configureAuthEnvironment(63);
  const credentials = new CredentialService();
  const fixture = await accountFixture(credentials, { totp_ciphertext: null });
  let sessionOrChallengeCreated = false;
  const repository = {
    findAccountByLogin: async () => fixture.account,
    transaction: async (work: (client: never) => Promise<unknown>) => work({} as never),
    lockAuthBucket: async () => undefined,
    clearThrottle: async () => undefined,
    createChallenge: async () => {
      sessionOrChallengeCreated = true;
    },
    createSession: async () => {
      sessionOrChallengeCreated = true;
      return ids.session;
    },
  } as unknown as AuthRepository;
  const service = new AuthService(repository, credentials) as unknown as {
    login: AuthService['login'];
    reservePasswordAttempt(): Promise<{ id: string; generation: number }>;
    releasePasswordAttempt(): Promise<void>;
  };
  service.reservePasswordAttempt = async () => ({ id: 'reservation', generation: 0 });
  service.releasePasswordAttempt = async () => undefined;

  await assert.rejects(
    service.login({
      login: fixture.account.normalized_login,
      password: fixture.password,
    }, 'partial-totp-login'),
    (error) => error instanceof TreasuryProblem
      && (error.getResponse() as { code?: string }).code === 'TRS-AUT-002',
  );
  assert.equal(sessionOrChallengeCreated, false);
});

test('non-ACTIVE UserRef is rejected throughout pre-session authentication', async () => {
  configureAuthEnvironment(65);
  const credentials = new CredentialService();
  const fixture = await accountFixture(credentials, { user_ref_state: 'SUSPENDED' });
  const challenge: ChallengeRow = {
    ...fixture.account,
    challenge_row_id: ids.challenge,
    challenge_kind: 'LOGIN',
    challenge_attempts: 0,
    challenge_expires_at: new Date(Date.now() + 5 * 60_000),
    challenge_consumed_at: null,
    challenge_session_id: null,
    http_method: null,
    http_path: null,
    request_body_digest: null,
    idempotency_key: null,
    device_label: null,
  };
  const repository = {
    findAccountByLogin: async () => fixture.account,
    transaction: async (work: (client: never) => Promise<unknown>) => work({} as never),
    findChallengeForUpdate: async () => challenge,
  } as unknown as AuthRepository;
  const service = new AuthService(repository, credentials) as unknown as {
    login: AuthService['login'];
    startTotpEnrollment: AuthService['startTotpEnrollment'];
    verifyTotp: AuthService['verifyTotp'];
    recoverPassword: AuthService['recoverPassword'];
    reservePasswordAttempt(): Promise<{ id: string; generation: number }>;
    finalizePasswordFailure(): Promise<number>;
    reserveRecoveryAttempt(): Promise<{ attempts: number; expiresAt: Date }>;
    auditFailure(): Promise<void>;
  };
  service.reservePasswordAttempt = async () => ({ id: 'reservation', generation: 0 });
  service.finalizePasswordFailure = async () => 0;
  service.reserveRecoveryAttempt = async () => ({
    attempts: 1,
    expiresAt: new Date(Date.now() + 5 * 60_000),
  });
  service.auditFailure = async () => undefined;

  await assert.rejects(
    service.login({
      login: fixture.account.normalized_login,
      password: fixture.password,
    }, 'suspended-login'),
    (error) => error instanceof TreasuryProblem
      && (error.getResponse() as { code?: string }).code === 'TRS-AUT-001',
  );
  await assert.rejects(
    service.startTotpEnrollment({
      login: fixture.account.normalized_login,
      currentOrTemporaryPassword: fixture.password,
      newPassword: 'safe suspended enrollment password 2026',
    }, 'suspended-enrollment'),
    (error) => error instanceof TreasuryProblem
      && (error.getResponse() as { code?: string }).code === 'TRS-AUT-001',
  );
  await assert.rejects(
    service.verifyTotp({
      challengeId: 'challenge',
      code: '123456',
    }, 'suspended-challenge'),
    (error) => error instanceof TreasuryProblem
      && (error.getResponse() as { code?: string }).code === 'TRS-AUT-005',
  );

  const counter = Math.floor(Date.now() / 30_000);
  await assert.rejects(
    service.recoverPassword({
      login: fixture.account.normalized_login,
      newPassword: 'safe suspended recovery password 2026',
      method: 'AUTHENTICATOR',
      totpCode: credentials.totp(fixture.secret, counter),
    }, 'suspended-recovery'),
    (error) => error instanceof TreasuryProblem
      && (error.getResponse() as { code?: string }).code === 'TRS-AUT-006',
  );
});

function sessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  const now = Date.now();
  return {
    id: ids.session,
    presented_id: ids.session,
    logical_session_id: ids.session,
    identity_account_id: ids.account,
    organization_id: ids.organization,
    user_ref_id: ids.user,
    display_name: 'کاربر نشست',
    assurance: 'PASSWORD_TOTP',
    device_label: null,
    authenticated_at: new Date(now - 60_000),
    last_seen_at: new Date(now - 1_000),
    last_rotated_at: new Date(now - 1_000),
    idle_expires_at: new Date(now + 15 * 60_000),
    absolute_expires_at: new Date(now + 8 * 60 * 60_000),
    xsrf_digest: 'xsrf-digest',
    token_digest: 'token-digest',
    previous_token_digest: null,
    previous_valid_until: null,
    previous_xsrf_digest: null,
    matched_current: true,
    authorized_epoch: '0',
    account_authorization_epoch: '0',
    permissions: [],
    organization_permissions: [],
    ...overrides,
  };
}

test('session authentication rejects a revocation that wins the touch CAS race', async () => {
  configureAuthEnvironment(67);
  const credentials = new CredentialService();
  const active = sessionRow();
  let lookups = 0;
  const repository = {
    findSession: async () => {
      lookups += 1;
      return lookups === 1 ? active : null;
    },
    touchSession: async () => false,
  } as unknown as AuthRepository;

  await assert.rejects(
    new AuthService(repository, credentials).authenticateSession('presented-token'),
    (error) => error instanceof TreasuryProblem
      && (error.getResponse() as { code?: string }).code === 'TRS-AUT-003',
  );
  assert.equal(lookups, 2);
});

test('session authentication re-resolves a valid predecessor after a competing rotation', async () => {
  configureAuthEnvironment(69);
  const credentials = new CredentialService();
  const initial = sessionRow({
    last_rotated_at: new Date(Date.now() - 16 * 60_000),
  });
  const successor = sessionRow({
    id: ids.successor,
    presented_id: ids.session,
    matched_current: false,
  });
  let lookups = 0;
  let touchedSessionId: string | null = null;
  const repository = {
    findSession: async () => {
      lookups += 1;
      return lookups === 1 ? initial : successor;
    },
    rotateSession: async () => null,
    touchSession: async (sessionId: string) => {
      touchedSessionId = sessionId;
      return true;
    },
  } as unknown as AuthRepository;

  const context = await new AuthService(repository, credentials)
    .authenticateSession('presented-token');
  assert.equal(context.matchedCurrent, false);
  assert.equal(context.physicalSessionId, ids.successor);
  assert.equal(context.rotatedSessionToken, undefined);
  assert.equal(touchedSessionId, ids.successor);
  assert.equal(lookups, 2);
});

test('session authentication passes the presented proof into the atomic touch', async () => {
  configureAuthEnvironment(70);
  const credentials = new CredentialService();
  const active = sessionRow();
  let touchArguments: unknown[] = [];
  const repository = {
    findSession: async () => active,
    touchSession: async (...args: unknown[]) => {
      touchArguments = args;
      return true;
    },
  } as unknown as AuthRepository;

  await new AuthService(repository, credentials)
    .authenticateSession('presented-token');

  assert.equal(touchArguments[0], active.id);
  assert.equal(touchArguments[1], active.presented_id);
  assert.equal(typeof touchArguments[2], 'string');
  assert.ok(touchArguments[3] instanceof Date);
});
