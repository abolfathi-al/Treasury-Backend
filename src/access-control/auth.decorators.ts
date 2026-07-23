import { SetMetadata } from '@nestjs/common';

export const PUBLIC_OPERATION = 'treasury.public';
export const REQUIRED_PERMISSION = 'treasury.permission';
export const STEP_UP_REQUIRED = 'treasury.step-up';

export const PublicOperation = (): MethodDecorator => SetMetadata(PUBLIC_OPERATION, true);
export const RequirePermission = (permission: string): MethodDecorator =>
  SetMetadata(REQUIRED_PERMISSION, permission);
export const RequireStepUp = (): MethodDecorator => SetMetadata(STEP_UP_REQUIRED, true);
