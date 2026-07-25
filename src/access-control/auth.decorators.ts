import { SetMetadata } from '@nestjs/common';

export const PUBLIC_OPERATION = 'treasury.public';
export const REQUIRED_PERMISSION = 'treasury.permission';
export const AUTHORIZATION_OPERATION = 'treasury.authorization-operation';
export const STEP_UP_REQUIRED = 'treasury.step-up';

export const PublicOperation = (): MethodDecorator => SetMetadata(PUBLIC_OPERATION, true);
export const RequirePermission = (
  permission: string,
  operationId?: string,
): MethodDecorator => (target, propertyKey, descriptor) => {
  SetMetadata(REQUIRED_PERMISSION, permission)(target, propertyKey, descriptor);
  if (operationId) {
    SetMetadata(AUTHORIZATION_OPERATION, operationId)(target, propertyKey, descriptor);
  }
};
export const RequireStepUp = (operationId: string): MethodDecorator =>
  SetMetadata(STEP_UP_REQUIRED, operationId);
