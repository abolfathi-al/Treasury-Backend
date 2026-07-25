import { SetMetadata } from '@nestjs/common';

export const PUBLIC_OPERATION = 'treasury.public';
export const REQUIRED_PERMISSION = 'treasury.permission';
export const AUTHORIZATION_OPERATION = 'treasury.authorization-operation';
export const PERMISSION_SCOPE_MODE = 'treasury.permission-scope-mode';
export const STEP_UP_REQUIRED = 'treasury.step-up';

export type PermissionScopeMode = 'ORGANIZATION_WIDE' | 'ONE_GRANT_RESOURCE';

export const PublicOperation = (): MethodDecorator => SetMetadata(PUBLIC_OPERATION, true);
export const RequirePermission = (
  permission: string,
  operationId: string,
  scopeMode: PermissionScopeMode,
): MethodDecorator => (target, propertyKey, descriptor) => {
  SetMetadata(REQUIRED_PERMISSION, permission)(target, propertyKey, descriptor);
  SetMetadata(AUTHORIZATION_OPERATION, operationId)(target, propertyKey, descriptor);
  SetMetadata(PERMISSION_SCOPE_MODE, scopeMode)(target, propertyKey, descriptor);
};
export const RequireStepUp = (operationId: string): MethodDecorator =>
  SetMetadata(STEP_UP_REQUIRED, operationId);
