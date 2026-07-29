import { Module } from '@nestjs/common';

import {
  CollectionEffectsRepository,
  CollectionEffectsService,
} from './collection-effects.service';

@Module({
  providers: [CollectionEffectsRepository, CollectionEffectsService],
  exports: [CollectionEffectsService],
})
export class CollectionEffectsModule {}
