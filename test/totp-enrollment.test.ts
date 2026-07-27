import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AccountRow,
  AuthRepository,
  TotpEnrollmentRow,
} from '../src/access-control/auth.repository';
import { AuthService } from '../src/access-control/auth.service';
import { CredentialService } from '../src/access-control/credential.service';
import { TreasuryProblem } from '../src/common/problem';

test('TOTP enrollment start and completion use one-time encrypted material and consecutive counters', async () => {
  process.env.LOGIN_THROTTLE_HMAC_KEY_BASE64 = Buffer.alloc(32, 51).toString('base64');
  process.env.TOTP_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 52).toString('base64');
  process.env.TOTP_KEY_VERSION = '1';
  const credentials = new CredentialService();
  const currentPassword = 'safe temporary enrollment password 2026';
  const account: AccountRow = {
    id: '00000000-0000-4000-8000-000000000001',
    user_ref_id: '00000000-0000-4000-8000-000000000002',
    organization_id: '00000000-0000-4000-8000-000000000003',
    organization_code: 'TEST',
    display_name: 'Enrollment User',
    user_ref_state: 'ACTIVE',
    normalized_login: 'enrollment.user',
    password_hash: await credentials.hashPassword(currentPassword),
    password_profile_version: 1,
    totp_ciphertext: null,
    totp_iv: null,
    totp_auth_tag: null,
    totp_key_version: null,
    totp_last_counter: null,
    recovery_code_hash: null,
    authorization_epoch: '0',
    privileged: true,
    state: 'INVITED',
    version: 0,
    permissions: [],
  };
  let pending:
    | Parameters<AuthRepository['startTotpEnrollment']>[1]
    | undefined;
  const startRepository = {
    transaction: async (work: (client: never) => Promise<unknown>) => work({} as never),
    lockAuthBucket: async () => undefined,
    findThrottle: async () => null,
    setThrottle: async () => undefined,
    discardStalePasswordReservations: async () => undefined,
    activePasswordReservations: async () => ({ count: 0, earliestExpiresAt: null }),
    createPasswordReservation: async () => undefined,
    findAccountByLogin: async () => account,
    startTotpEnrollment: async (_client: unknown, input: typeof pending) => {
      pending = input;
      return 1;
    },
    clearThrottle: async () => undefined,
    audit: async () => undefined,
  } as unknown as AuthRepository;
  const started = await new AuthService(startRepository, credentials).startTotpEnrollment({
    login: ' Enrollment.User ',
    currentOrTemporaryPassword: currentPassword,
    newPassword: 'a distinct safe replacement phrase 2026',
  }, 'enrollment-start');
  assert.equal(started.outcome, 'TOTP_ENROLLMENT_STARTED');
  assert.match(started.enrollmentId, /^[A-Za-z0-9_-]{43}$/u);
  assert.match(started.secret, /^[A-Z2-7]{52}$/u);
  assert.match(started.otpauthUri, /^otpauth:\/\/totp\//u);
  assert.ok(pending);
  assert.notEqual(pending.enrollmentIdDigest, started.enrollmentId);
  assert.notEqual(pending.encrypted.ciphertext, started.secret);

  const secret = credentials.decryptTotpSecret(
    pending.encrypted,
    Buffer.from(process.env.TOTP_ENCRYPTION_KEY_BASE64, 'base64'),
  );
  const fixedNow = 1_800_000_000_000;
  const counter = Math.floor(fixedNow / 30_000);
  const enrollment: TotpEnrollmentRow = {
    ...account,
    version: 1,
    enrollment_row_id: '00000000-0000-4000-8000-000000000004',
    enrollment_state: 'OPEN',
    enrollment_attempt_count: 0,
    enrollment_expires_at: new Date(fixedNow + 5 * 60_000),
    enrollment_account_version: 1,
    pending_secret_ciphertext: pending.encrypted.ciphertext,
    pending_secret_iv: pending.encrypted.iv,
    pending_secret_auth_tag: pending.encrypted.authTag,
    pending_secret_key_version: pending.encrypted.keyVersion,
  };
  let acceptedCounter: number | undefined;
  const completionRepository = {
    transaction: async (work: (client: never) => Promise<unknown>) => work({} as never),
    findTotpEnrollmentForUpdate: async (enrollmentIdDigest: string) => {
      assert.equal(enrollmentIdDigest, pending!.enrollmentIdDigest);
      return enrollment;
    },
    completeTotpEnrollment: async (
      _client: unknown,
      _enrollment: TotpEnrollmentRow,
      value: number,
    ) => {
      acceptedCounter = value;
    },
  } as unknown as AuthRepository;
  const originalNow = Date.now;
  Date.now = () => fixedNow;
  const completed = await new AuthService(completionRepository, credentials).completeTotpEnrollment({
    enrollmentId: started.enrollmentId,
    firstCode: credentials.totp(secret, counter - 1),
    secondCode: credentials.totp(secret, counter),
  }, 'enrollment-complete').finally(() => {
    Date.now = originalNow;
  });
  assert.equal(completed.outcome, 'TOTP_ENROLLED');
  assert.equal(acceptedCounter, counter);
  assert.ok(completed.recoveryCode.length > 0);
});

test('invalid completion proof is rejected before recovery-code hashing', async () => {
  process.env.LOGIN_THROTTLE_HMAC_KEY_BASE64 = Buffer.alloc(32, 54).toString('base64');
  process.env.TOTP_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 55).toString('base64');
  const credentials = new CredentialService();
  const repository = {
    transaction: async (work: (client: never) => Promise<unknown>) => work({} as never),
    findTotpEnrollmentForUpdate: async () => null,
  } as unknown as AuthRepository;
  const service = new AuthService(repository, credentials);
  let recoveryHashCalls = 0;
  credentials.hashRecoveryCode = async () => {
    recoveryHashCalls += 1;
    return 'unexpected';
  };

  await assert.rejects(
    service.completeTotpEnrollment({
      enrollmentId: 'a'.repeat(43),
      firstCode: '123456',
      secondCode: '654321',
    }, 'invalid-enrollment'),
    (error) => error instanceof TreasuryProblem
      && (error.getResponse() as { code?: string }).code === 'TRS-AUT-005',
  );
  assert.equal(recoveryHashCalls, 0);
});

test('login rejects a stale account snapshot before rehash or session creation', async () => {
  process.env.LOGIN_THROTTLE_HMAC_KEY_BASE64 = Buffer.alloc(32, 56).toString('base64');
  process.env.TOTP_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 57).toString('base64');
  const credentials = new CredentialService();
  const password = 'safe concurrent login password 2026';
  const snapshot: AccountRow = {
    id: '00000000-0000-4000-8000-000000000011',
    user_ref_id: '00000000-0000-4000-8000-000000000012',
    organization_id: '00000000-0000-4000-8000-000000000013',
    organization_code: 'TEST',
    display_name: 'Concurrent User',
    user_ref_state: 'ACTIVE',
    normalized_login: 'concurrent.user',
    password_hash: await credentials.hashPassword(password),
    password_profile_version: 1,
    totp_ciphertext: null,
    totp_iv: null,
    totp_auth_tag: null,
    totp_key_version: null,
    totp_last_counter: null,
    recovery_code_hash: null,
    authorization_epoch: '0',
    privileged: false,
    state: 'ACTIVE',
    version: 0,
    permissions: [],
  };
  let lookupCount = 0;
  let mutationCalls = 0;
  const repository = {
    findAccountByLogin: async () => {
      lookupCount += 1;
      return lookupCount === 1
        ? snapshot
        : { ...snapshot, password_hash: 'rotated', version: 1 };
    },
    transaction: async (work: (client: never) => Promise<unknown>) => work({} as never),
    updatePasswordHash: async () => {
      mutationCalls += 1;
    },
    createSession: async () => {
      mutationCalls += 1;
      return 'unexpected';
    },
  } as unknown as AuthRepository;
  const service = new AuthService(repository, credentials) as unknown as {
    login: AuthService['login'];
    reservePasswordAttempt(): Promise<{ id: string; generation: number }>;
    finalizePasswordFailure(): Promise<number>;
    auditFailure(): Promise<void>;
  };
  service.reservePasswordAttempt = async () => ({ id: 'reservation', generation: 0 });
  service.finalizePasswordFailure = async () => 0;
  service.auditFailure = async () => undefined;

  await assert.rejects(
    service.login({ login: snapshot.normalized_login, password }, 'stale-login'),
    (error) => error instanceof TreasuryProblem
      && (error.getResponse() as { code?: string }).code === 'TRS-AUT-001',
  );
  assert.equal(mutationCalls, 0);
});
