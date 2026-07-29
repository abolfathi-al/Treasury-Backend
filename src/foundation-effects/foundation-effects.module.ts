import { Module } from '@nestjs/common';

import {
  FoundationEffectsRepository,
  FoundationEffectsService,
} from './foundation-effects.service';

@Module({
  providers: [FoundationEffectsRepository, FoundationEffectsService],
  exports: [FoundationEffectsService],
})
export class FoundationEffectsModule {}
