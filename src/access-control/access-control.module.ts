import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { AccessAdminController } from './access-admin.controller';
import { AccessAdminRepository } from './access-admin.repository';
import { AccessAdminService } from './access-admin.service';
import { AccessAuthorizationRepository } from './access-authorization.repository';
import { AccessAuthorizationService } from './access-authorization.service';
import { CredentialService } from './credential.service';
import { IdentityController } from './identity.controller';
import { IdentityRepository } from './identity.repository';
import { IdentityService } from './identity.service';

@Module({
  controllers: [AuthController, IdentityController, AccessAdminController],
  providers: [
    AccessAdminService,
    AccessAdminRepository,
    AccessAuthorizationRepository,
    AccessAuthorizationService,
    AuthService,
    AuthRepository,
    CredentialService,
    IdentityService,
    IdentityRepository,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [
    AccessAuthorizationService,
    AuthService,
    CredentialService,
    IdentityService,
  ],
})
export class AccessControlModule {}
