import { Module } from '@nestjs/common';

import {
  CollectionEffectsRepository,
  CollectionEffectsService,
} from './collection-effects.service';
import { CollectionItemsController } from './collection-items.controller';
import { CollectionItemsRepository } from './collection-items.repository';
import { CollectionItemsService } from './collection-items.service';

@Module({
  controllers: [CollectionItemsController],
  providers: [
    CollectionEffectsRepository,
    CollectionEffectsService,
    CollectionItemsRepository,
    CollectionItemsService,
  ],
  exports: [CollectionEffectsService],
})
export class CollectionEffectsModule {}
