import { Inject, Injectable } from '@nestjs/common';
import { createHmac, randomUUID } from 'node:crypto';

import { digest, opaqueToken } from '../common/http';
import { TreasuryProblem } from '../common/problem';
import {
  AccountRow,
  AuthRepository,
  ChallengeRow,
  SessionRow,
} from './auth.repository';
import { CredentialService } from './credential.service';
import { LoginDto, PasswordRecoveryDto, TotpProofDto } from './auth.dto';

export interface SessionView {
  sessionId: string;
  authenticatedAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  assurance: 'PASSWORD' | 'PASSWORD_TOTP';
  userId: string;
  userDisplayName: string;
  effectivePermissions: string[];
}

export interface SessionContext {
  accountId: string;
  organizationId: string;
  physicalSessionId: string;
  session: SessionView;
  xsrfDigest: string;
  presentedTokenDigest: string;
  matchedCurrent: boolean;
  rotatedSessionToken?: string;
  refreshedXsrfToken?: string;
}

type LoginResult =
  | { status: 202; body: { outcome: 'TOTP_REQUIRED'; challengeId: string; expiresAt: string } }
  | {
      status: 201;
      body: { outcome: 'SESSION_ESTABLISHED'; session: SessionView };
      sessionToken: string;
      xsrfToken: string;
    };

type TotpResult =
  | {
      status: 201;
      body: { outcome: 'SESSION_ESTABLISHED'; session: SessionView };
      sessionToken: string;
      xsrfToken: string;
    }
  | {
      status: 200;
      body: { outcome: 'STEP_UP_VERIFIED'; proofId: string; expiresAt: string };
    };

interface PasswordAttemptReservation {
  id: string;
  generation: number;
}

const PASSWORD_ATTEMPT_LEASE_MS = 2 * 60_000;

@Injectable()
export class AuthService {
  private readonly dummyPasswordHash: Promise<string>;
  private readonly dummyRecoveryHash: Promise<string>;
  private readonly dummyTotpSecret = Buffer.alloc(32, 0x5a);

  constructor(
    @Inject(AuthRepository) private readonly repository: AuthRepository,
    @Inject(CredentialService) private readonly credentials: CredentialService,
  ) {
    this.dummyPasswordHash = this.credentials.hashPassword('not a real treasury password value');
    this.dummyRecoveryHash = this.credentials.hashRecoveryCode(this.credentials.generateRecoveryCode());
  }

  async login(dto: LoginDto, requestId: string): Promise<LoginResult> {
    const normalizedLogin = this.credentials.normalizeLogin(dto.login);
    const bucket = this.throttleBucket(`password:${normalizedLogin}`);
    const reservation = await this.reservePasswordAttempt(bucket);

    let account: AccountRow | null;
    let passwordValid: boolean;
    try {
      account = await this.repository.findAccountByLogin(normalizedLogin);
      const passwordHash = account?.password_hash ?? await this.dummyPasswordHash;
      passwordValid = await this.credentials.verifyPassword(passwordHash, dto.password);
    } catch (error) {
      await this.releasePasswordAttempt(bucket, reservation);
      throw error;
    }
    if (!account || !passwordValid || account.state !== 'ACTIVE') {
      const retryAfter = await this.finalizePasswordFailure(bucket, reservation);
      await this.auditFailure(account, requestId, account ? 'INVALID_OR_UNAVAILABLE' : 'UNKNOWN_LOGIN');
      if (retryAfter > 0) throw this.throttled(retryAfter);
      throw new TreasuryProblem('TRS-AUT-001', 401);
    }

    try {
      return await this.repository.transaction(async (client) => {
        await this.repository.lockAuthBucket(client, 'auth-throttle', bucket);
        await this.repository.clearThrottle(bucket, client);
        if (this.credentials.passwordNeedsRehash(account.password_hash)) {
          await this.repository.updatePasswordHash(
            client,
            account.id,
            await this.credentials.hashPassword(dto.password.normalize('NFC')),
          );
        }
        if (account.privileged || account.totp_ciphertext) {
          if (!this.hasTotp(account)) throw new TreasuryProblem('TRS-AUT-002', 401);
          const challengeId = opaqueToken();
          const expiresAt = new Date(Date.now() + 5 * 60_000);
          await this.repository.createChallenge(client, {
            accountId: account.id,
            tokenDigest: digest(challengeId),
            kind: 'LOGIN',
            expiresAt,
            deviceLabel: dto.deviceLabel,
          });
          await this.repository.audit(client, {
            organizationId: account.organization_id,
            accountId: account.id,
            requestId,
            eventType: 'AUTH_LOGIN_PASSWORD_ACCEPTED',
            outcome: 'CHALLENGE_ISSUED',
          });
          return {
            status: 202 as const,
            body: { outcome: 'TOTP_REQUIRED' as const, challengeId, expiresAt: expiresAt.toISOString() },
          };
        }
        return this.establishSession(client, account, 'PASSWORD', dto.deviceLabel, requestId);
      });
    } catch (error) {
      await this.releasePasswordAttempt(bucket, reservation);
      throw error;
    }
  }

  async verifyTotp(dto: TotpProofDto, requestId: string): Promise<TotpResult> {
    const result = await this.repository.transaction<TotpResult | {
      failure: 'INVALID_TOTP';
      attempts: number;
      expiresAt: Date;
    }>(async (client) => {
      const challenge = await this.repository.findChallengeForUpdate(digest(dto.challengeId), client);
      if (!challenge || !this.challengeUsable(challenge)) {
        throw new TreasuryProblem('TRS-AUT-005', 401);
      }
      const secret = this.decryptTotp(challenge);
      const counter = this.credentials.verifyTotp(
        secret,
        dto.code,
        challenge.totp_last_counter === null ? null : Number(challenge.totp_last_counter),
      );
      if (counter === null) {
        const attempts = challenge.challenge_attempts + 1;
        await this.repository.recordChallengeFailure(client, challenge.challenge_row_id, attempts);
        return { failure: 'INVALID_TOTP', attempts, expiresAt: challenge.challenge_expires_at };
      }

      await this.repository.consumeChallengeAndCounter(
        client,
        challenge.challenge_row_id,
        challenge.id,
        counter,
      );
      if (challenge.challenge_kind === 'LOGIN') {
        return this.establishSession(
          client,
          challenge,
          'PASSWORD_TOTP',
          challenge.device_label ?? undefined,
          requestId,
        );
      }

      const proofId = opaqueToken();
      const expiresAt = new Date(Date.now() + 5 * 60_000);
      await this.repository.createStepUpProof(client, challenge.challenge_row_id, digest(proofId), expiresAt);
      await this.repository.audit(client, {
        organizationId: challenge.organization_id,
        accountId: challenge.id,
        requestId,
        eventType: 'AUTH_STEP_UP_VERIFIED',
        outcome: 'SUCCEEDED',
      });
      return {
        status: 200,
        body: { outcome: 'STEP_UP_VERIFIED', proofId, expiresAt: expiresAt.toISOString() },
      };
    });
    if ('failure' in result) {
      if (result.attempts >= 5) {
        throw this.throttled(Math.max(1, (result.expiresAt.getTime() - Date.now()) / 1000));
      }
      throw new TreasuryProblem('TRS-AUT-002', 401);
    }
    return result;
  }

  async recoverPassword(
    dto: PasswordRecoveryDto,
    requestId: string,
  ): Promise<{ outcome: 'PASSWORD_RESET'; replacementRecoveryCode: string }> {
    const normalizedLogin = this.credentials.normalizeLogin(dto.login);
    const password = this.credentials.validatePassword(dto.newPassword, [normalizedLogin]);
    const bucket = this.throttleBucket(`recovery:${normalizedLogin}`);
    const reservation = await this.reserveRecoveryAttempt(bucket);

    const result = await this.repository.transaction<
      { outcome: 'PASSWORD_RESET'; replacementRecoveryCode: string }
      | { failure: 'INVALID_RECOVERY' }
    >(async (client) => {
      const account = await this.repository.findAccountByLogin(normalizedLogin, client, true);
      const recoveryValid = await this.credentials.verifyRecoveryCode(
        account?.recovery_code_hash ?? await this.dummyRecoveryHash,
        dto.recoveryCode,
      );
      const totpCounter = this.credentials.verifyTotp(
        account && this.hasTotp(account) ? this.decryptTotp(account) : this.dummyTotpSecret,
        dto.totpCode,
        account?.totp_last_counter === null || account?.totp_last_counter === undefined
          ? null
          : Number(account.totp_last_counter),
      );

      if (!account || account.state !== 'ACTIVE' || !recoveryValid || totpCounter === null) {
        return { failure: 'INVALID_RECOVERY' };
      }

      const replacementRecoveryCode = this.credentials.generateRecoveryCode();
      await this.repository.replaceRecoveryCredentials(
        client,
        account.id,
        await this.credentials.hashPassword(password),
        await this.credentials.hashRecoveryCode(replacementRecoveryCode),
        totpCounter,
      );
      await this.repository.revokeAllAccountSecrets(client, account.id);
      await this.repository.lockAuthBucket(client, 'auth-recovery', bucket);
      await this.repository.clearRecoveryAttempts(client, bucket);
      await this.repository.audit(client, {
        organizationId: account.organization_id,
        accountId: account.id,
        requestId,
        eventType: 'AUTH_PASSWORD_RECOVERED',
        outcome: 'SUCCEEDED',
        details: { recoveryVersionIncremented: true },
      });
      return { outcome: 'PASSWORD_RESET', replacementRecoveryCode };
    });
    if ('failure' in result) {
      if (reservation.attempts >= 5) {
        throw this.throttled(Math.max(1, (reservation.expiresAt.getTime() - Date.now()) / 1000));
      }
      throw new TreasuryProblem('TRS-AUT-006', 401);
    }
    return result;
  }

  async authenticateSession(rawToken: string): Promise<SessionContext> {
    const tokenDigest = digest(rawToken);
    const row = await this.repository.findSession(tokenDigest);
    if (!row) throw new TreasuryProblem('TRS-AUT-003', 401);
    const now = new Date();
    const context = this.sessionContext(row, tokenDigest);
    if (!row.matched_current) {
      await this.repository.touchSession(row.id, now);
      context.session.idleExpiresAt = new Date(
        Math.min(now.getTime() + 15 * 60_000, row.absolute_expires_at.getTime()),
      ).toISOString();
      return context;
    }

    const rotationDue = now.getTime() - row.last_rotated_at.getTime() >= 15 * 60_000;
    const epochStale = Number(row.authorized_epoch) !== Number(row.account_authorization_epoch);
    if (rotationDue || epochStale) {
      const xsrfToken = opaqueToken();
      const nextToken = opaqueToken();
      const rotated = await this.repository.rotateSession(
        row.id,
        tokenDigest,
        digest(nextToken),
        digest(xsrfToken),
        now,
      );
      if (rotated) {
        context.physicalSessionId = rotated;
        context.rotatedSessionToken = nextToken;
        context.refreshedXsrfToken = xsrfToken;
        context.session.idleExpiresAt = new Date(
          Math.min(now.getTime() + 15 * 60_000, row.absolute_expires_at.getTime()),
        ).toISOString();
      }
      return context;
    }
    await this.repository.touchSession(row.id, now);
    return context;
  }

  async refreshXsrf(context: SessionContext): Promise<string | null> {
    if (!context.matchedCurrent || context.rotatedSessionToken) return null;
    const xsrfToken = opaqueToken();
    const nextDigest = digest(xsrfToken);
    const refreshed = await this.repository.refreshXsrf(
      context.physicalSessionId,
      context.presentedTokenDigest,
      context.xsrfDigest,
      nextDigest,
      new Date(),
    );
    if (!refreshed) return null;
    context.xsrfDigest = nextDigest;
    return xsrfToken;
  }

  async logout(context: SessionContext, resourceId: string): Promise<void> {
    if (resourceId !== context.session.sessionId) throw new TreasuryProblem('TRS-AUT-003', 401);
    await this.repository.revokeSession(resourceId, context.accountId);
  }

  async issueStepUpChallenge(
    context: SessionContext,
    command: {
      operationId: string;
      method: string;
      path: string;
      bodyDigest: string;
      idempotencyKey: string;
    },
  ): Promise<never> {
    const challengeId = opaqueToken();
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    await this.repository.transaction(async (client) => {
      await this.repository.createChallenge(client, {
        accountId: context.accountId,
        sessionId: context.physicalSessionId,
        tokenDigest: digest(challengeId),
        kind: 'STEP_UP',
        expiresAt,
        httpMethod: command.method,
        httpPath: command.path,
        requestBodyDigest: command.bodyDigest,
        idempotencyKey: command.idempotencyKey,
      });
    });
    throw new TreasuryProblem('TRS-AUT-010', 428, undefined, {
      challengeId,
      expiresAt: expiresAt.toISOString(),
    });
  }

  validateStepUpProof(
    proofId: string,
    context: SessionContext,
    command: {
      operationId: string;
      method: string;
      path: string;
      bodyDigest: string;
      idempotencyKey: string;
    },
  ): Promise<boolean> {
    return this.repository.validateStepUpProof(digest(proofId), {
      organizationId: context.organizationId,
      sessionId: context.physicalSessionId,
      ...command,
    });
  }

  private async establishSession(
    client: Parameters<Parameters<AuthRepository['transaction']>[0]>[0],
    account: AccountRow,
    assurance: 'PASSWORD' | 'PASSWORD_TOTP',
    deviceLabel: string | undefined,
    requestId: string,
  ): Promise<Extract<LoginResult, { status: 201 }>> {
    const now = new Date();
    const sessionToken = opaqueToken();
    const xsrfToken = opaqueToken();
    const sessionId = await this.repository.createSession(client, {
      accountId: account.id,
      tokenDigest: digest(sessionToken),
      xsrfDigest: digest(xsrfToken),
      assurance,
      deviceLabel,
      now,
    });
    await this.repository.audit(client, {
      organizationId: account.organization_id,
      accountId: account.id,
      requestId,
      eventType: 'AUTH_SESSION_ESTABLISHED',
      outcome: 'SUCCEEDED',
    });
    return {
      status: 201,
      body: {
        outcome: 'SESSION_ESTABLISHED',
        session: {
          sessionId,
          authenticatedAt: now.toISOString(),
          idleExpiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
          absoluteExpiresAt: new Date(now.getTime() + 8 * 60 * 60_000).toISOString(),
          assurance,
          userId: account.user_ref_id,
          userDisplayName: account.display_name,
          effectivePermissions: [...account.permissions].sort(),
        },
      },
      sessionToken,
      xsrfToken,
    };
  }

  private sessionContext(row: SessionRow, presentedTokenDigest: string): SessionContext {
    return {
      accountId: row.identity_account_id,
      organizationId: row.organization_id,
      physicalSessionId: row.id,
      xsrfDigest: row.xsrf_digest,
      presentedTokenDigest,
      matchedCurrent: row.matched_current,
      session: {
        sessionId: row.logical_session_id,
        authenticatedAt: row.authenticated_at.toISOString(),
        idleExpiresAt: row.idle_expires_at.toISOString(),
        absoluteExpiresAt: row.absolute_expires_at.toISOString(),
        assurance: row.assurance,
        userId: row.user_ref_id,
        userDisplayName: row.display_name,
        effectivePermissions: [...row.permissions].sort(),
      },
    };
  }

  private hasTotp(account: AccountRow): boolean {
    return Boolean(account.totp_ciphertext && account.totp_iv && account.totp_auth_tag && account.totp_key_version);
  }

  private decryptTotp(account: AccountRow): Buffer {
    if (!this.hasTotp(account)) throw new TreasuryProblem('TRS-AUT-002', 401);
    return this.credentials.decryptTotpSecret({
      ciphertext: account.totp_ciphertext!,
      iv: account.totp_iv!,
      authTag: account.totp_auth_tag!,
      keyVersion: account.totp_key_version!,
    }, this.credentials.runtimeTotpKey(account.totp_key_version!));
  }

  private challengeUsable(challenge: ChallengeRow): boolean {
    return challenge.state === 'ACTIVE'
      && challenge.challenge_consumed_at === null
      && challenge.challenge_attempts < 5
      && challenge.challenge_expires_at.getTime() > Date.now();
  }

  private throttleBucket(subject: string): string {
    const key = Buffer.from(process.env.LOGIN_THROTTLE_HMAC_KEY_BASE64 ?? '', 'base64');
    if (key.length < 32) throw new Error('LOGIN_THROTTLE_HMAC_KEY_BASE64 is invalid');
    return createHmac('sha256', key).update(subject).digest('hex');
  }

  private async reservePasswordAttempt(bucket: string): Promise<PasswordAttemptReservation> {
    return this.repository.transaction(async (client) => {
      await this.repository.lockAuthBucket(client, 'auth-throttle', bucket);
      const current = await this.repository.findThrottle(bucket, client, true);
      const now = Date.now();
      const activeUntil = current?.locked_until ?? current?.delay_until;
      if (activeUntil && activeUntil.getTime() > now) {
        throw this.throttled((activeUntil.getTime() - now) / 1000);
      }

      const expiredLock = current?.locked_until && current.locked_until.getTime() <= now;
      const failureCount = expiredLock ? 0 : current?.failure_count ?? 0;
      const generation = Number(current?.generation ?? 0) + (expiredLock ? 1 : 0);
      await this.repository.setThrottle(
        client,
        bucket,
        failureCount,
        generation,
        current?.delay_until ?? null,
        expiredLock ? null : current?.locked_until ?? null,
      );
      await this.repository.discardStalePasswordReservations(client, bucket, generation);
      const activeReservations = await this.repository.activePasswordReservations(
        client,
        bucket,
        generation,
      );
      if (failureCount + activeReservations.count >= 10) {
        const retryAfter = activeReservations.earliestExpiresAt
          ? (activeReservations.earliestExpiresAt.getTime() - now) / 1000
          : 1;
        throw this.throttled(Math.max(1, retryAfter));
      }
      const reservation = {
        id: randomUUID(),
        generation,
      };
      await this.repository.createPasswordReservation(
        client,
        {
          ...reservation,
          bucketDigest: bucket,
          expiresAt: new Date(now + PASSWORD_ATTEMPT_LEASE_MS),
        },
      );
      return reservation;
    });
  }

  private async finalizePasswordFailure(
    bucket: string,
    reservation: PasswordAttemptReservation,
  ): Promise<number> {
    return this.repository.transaction(async (client) => {
      await this.repository.lockAuthBucket(client, 'auth-throttle', bucket);
      const current = await this.repository.findThrottle(bucket, client, true);
      const owned = await this.repository.consumeActivePasswordReservation(
        client,
        bucket,
        reservation.id,
        reservation.generation,
      );
      if (!owned) {
        await this.repository.deletePasswordReservation(
          client,
          bucket,
          reservation.id,
          reservation.generation,
        );
        return 0;
      }
      if (!current || Number(current.generation) !== reservation.generation) return 0;
      const next = this.nextThrottle(current.failure_count);
      await this.repository.setThrottle(
        client,
        bucket,
        next.failureCount,
        reservation.generation,
        next.delayUntil,
        next.lockedUntil,
      );
      return next.retryAfter;
    });
  }

  private async releasePasswordAttempt(
    bucket: string,
    reservation: PasswordAttemptReservation,
  ): Promise<void> {
    await this.repository.transaction(async (client) => {
      await this.repository.lockAuthBucket(client, 'auth-throttle', bucket);
      await this.repository.deletePasswordReservation(
        client,
        bucket,
        reservation.id,
        reservation.generation,
      );
    });
  }

  private async reserveRecoveryAttempt(bucket: string): Promise<{ attempts: number; expiresAt: Date }> {
    return this.repository.transaction(async (client) => {
      await this.repository.lockAuthBucket(client, 'auth-recovery', bucket);
      const now = new Date();
      const current = await this.repository.findRecoveryAttempts(client, bucket, true);
      const active = current && current.expires_at.getTime() > now.getTime();
      if (active && current.attempts >= 5) {
        throw this.throttled(Math.max(1, (current.expires_at.getTime() - now.getTime()) / 1000));
      }
      const expiresAt = active ? current.expires_at : new Date(now.getTime() + 5 * 60_000);
      const attempts = active ? current.attempts + 1 : 1;
      await this.repository.setRecoveryAttempts(client, bucket, attempts, expiresAt);
      return { attempts, expiresAt };
    });
  }

  private nextThrottle(previousFailures: number): {
    failureCount: number;
    delayUntil: Date | null;
    lockedUntil: Date | null;
    retryAfter: number;
  } {
    const failureCount = previousFailures + 1;
    if (failureCount >= 10) {
      return {
        failureCount: 10,
        delayUntil: null,
        lockedUntil: new Date(Date.now() + 15 * 60_000),
        retryAfter: 15 * 60,
      };
    }
    if (failureCount >= 5) {
      const retryAfter = 2 ** (failureCount - 5);
      return {
        failureCount,
        delayUntil: new Date(Date.now() + retryAfter * 1000),
        lockedUntil: null,
        retryAfter,
      };
    }
    return { failureCount, delayUntil: null, lockedUntil: null, retryAfter: 0 };
  }

  private throttled(retryAfter: number): TreasuryProblem {
    return new TreasuryProblem('TRS-AUT-008', 429, undefined, { retryAfter: Math.ceil(retryAfter) });
  }

  private async auditFailure(account: AccountRow | null, requestId: string, outcome: string): Promise<void> {
    await this.repository.transaction((client) => this.repository.audit(client, {
      organizationId: account?.organization_id,
      accountId: account?.id,
      requestId: requestId || randomUUID(),
      eventType: 'AUTH_LOGIN_FAILED',
      outcome,
    }));
  }
}
