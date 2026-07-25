import { SetMetadata } from '@nestjs/common';

export const PUBLIC_OPERATION = 'treasury.public';
export const REQUIRED_PERMISSION = 'treasury.permission';
export const AUTHORIZATION_OPERATION = 'treasury.authorization-operation';
export const PERMISSION_SCOPE_MODE = 'treasury.permission-scope-mode';
export const STEP_UP_REQUIRED = 'treasury.step-up';

export type PermissionScopeMode = 'ORGANIZATION_WIDE' | 'ONE_GRANT_RESOURCE';
export interface PermissionRequirement {
  permission: string;
  scopeMode: PermissionScopeMode;
}
export type RequiredPermission = string | readonly PermissionRequirement[];

export const PublicOperation = (): MethodDecorator => SetMetadata(PUBLIC_OPERATION, true);
export function RequirePermission(
  permission: string,
  operationId: string,
  scopeMode: PermissionScopeMode,
): MethodDecorator;
export function RequirePermission(
  permission: readonly PermissionRequirement[],
  operationId: string,
): MethodDecorator;
export function RequirePermission(
  permission: RequiredPermission,
  operationId: string,
  scopeMode?: PermissionScopeMode,
): MethodDecorator {
  return (target, propertyKey, descriptor) => {
    SetMetadata(REQUIRED_PERMISSION, permission)(target, propertyKey, descriptor);
    SetMetadata(AUTHORIZATION_OPERATION, operationId)(target, propertyKey, descriptor);
    if (scopeMode) SetMetadata(PERMISSION_SCOPE_MODE, scopeMode)(target, propertyKey, descriptor);
  };
}
export const RequireStepUp = (operationId: string): MethodDecorator =>
  SetMetadata(STEP_UP_REQUIRED, operationId);
