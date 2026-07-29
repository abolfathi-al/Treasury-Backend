import { Inject, Injectable } from '@nestjs/common';

import { commandDigest, digest } from '../common/http';
import { TreasuryProblem } from '../common/problem';
import type { DatabaseTransaction } from '../database/database.service';
import { AuthService, SessionContext } from './auth.service';
import { CredentialService } from './credential.service';
import { IdentityAccountCreateDto, UserRefCreateDto } from './identity.dto';
import { IdentityRepository } from './identity.repository';

@Injectable()
export class IdentityService {
  constructor(
    @Inject(IdentityRepository) private readonly repository: IdentityRepository,
    @Inject(CredentialService) private readonly credentials: CredentialService,
    @Inject(AuthService) private readonly authService: AuthService,
  ) {}

  findUserRefState(
    transaction: DatabaseTransaction,
    organizationId: string,
    userId: string,
  ): Promise<{ state: string } | undefined> {
    return this.repository.findUserRefState(transaction, organizationId, userId);
  }

  list(organizationId: string, rawLimit?: string, cursor?: string) {
    return this.repository.listUserRefs(organizationId, this.limit(rawLimit), this.uuidCursor(cursor));
  }

  createUser(organizationId: string, dto: UserRefCreateDto, key: string) {
    return this.mapCreate(() => this.repository.createUserRef(
      organizationId,
      dto,
      this.key(key),
      commandDigest('createUserRef', dto),
    ));
  }

  async createIdentity(
    organizationId: string,
    dto: IdentityAccountCreateDto,
    key: string,
    context: SessionContext,
    stepUp: {
      proofId: string;
      command: {
        operationId: string;
        method: string;
        path: string;
        bodyDigest: string;
        idempotencyKey: string;
      };
    },
  ) {
    const normalizedLogin = this.credentials.normalizeLogin(dto.login);
    const passwordContext = await this.repository.userContext(organizationId, dto.userId);
    const password = this.credentials.validatePassword(dto.temporaryPassword, [
      normalizedLogin,
      ...passwordContext,
    ]);
    const passwordHash = await this.credentials.hashPassword(password);
    const idempotencyKey = this.key(key);
    try {
      return await this.mapCreate(() => this.repository.createIdentityAccount(
        organizationId,
        dto,
        normalizedLogin,
        passwordHash,
        idempotencyKey,
        commandDigest('createIdentityAccount', dto),
        {
          proofDigest: digest(stepUp.proofId),
          sessionId: context.physicalSessionId,
          ...stepUp.command,
        },
      ));
    } catch (error) {
      if (error instanceof RangeError && error.message === 'STEP_UP_INVALID') {
        return this.authService.issueStepUpChallenge(context, stepUp.command);
      }
      throw error;
    }
  }

  private limit(raw?: string): number {
    if (!raw) return 50;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 500) {
      throw new TreasuryProblem('TRS-GEN-001', 422);
    }
    return value;
  }

  private key(value: string | undefined): string {
    if (!value || value.length < 8 || value.length > 128) {
      throw new TreasuryProblem('TRS-GEN-001', 422, 'Idempotency-Key must contain 8 through 128 characters.');
    }
    return value;
  }

  private uuidCursor(value?: string): string | undefined {
    if (value && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
      throw new TreasuryProblem('TRS-GEN-001', 422, 'cursor is malformed.');
    }
    return value;
  }

  private async mapCreate<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof TreasuryProblem) throw error;
      if (error instanceof SyntaxError) throw new TreasuryProblem('TRS-GEN-007', 409);
      if (error instanceof ReferenceError) throw new TreasuryProblem('TRS-GEN-005', 409);
      if ((error as { code?: string }).code === '23505') {
        throw new TreasuryProblem('TRS-GEN-005', 409);
      }
      throw error;
    }
  }
}
