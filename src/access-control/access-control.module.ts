import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { CredentialService } from './credential.service';
import { IdentityController } from './identity.controller';
import { IdentityRepository } from './identity.repository';
import { IdentityService } from './identity.service';

@Module({
  controllers: [AuthController, IdentityController],
  providers: [
    AuthService,
    AuthRepository,
    CredentialService,
    IdentityService,
    IdentityRepository,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthService, CredentialService],
})
export class AccessControlModule {}
