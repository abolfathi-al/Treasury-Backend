import { Controller, Get, Inject, Query, Req } from '@nestjs/common';

import { RequirePermission } from '../access-control/auth.decorators';
import { TreasuryRequest } from '../access-control/auth.guard';
import { CollectionItemQuery } from './collection-items.dto';
import { CollectionItemsService } from './collection-items.service';

@Controller('v1')
export class CollectionItemsController {
  constructor(
    @Inject(CollectionItemsService)
    private readonly service: CollectionItemsService,
  ) {}

  @Get('collection-items')
  @RequirePermission('collection.view', 'listCollectionItems', 'ONE_GRANT_RESOURCE')
  list(
    @Req() request: TreasuryRequest,
    @Query() query: CollectionItemQuery,
  ) {
    return this.service.list(
      request.auth!.organizationId,
      request.auth!.session.userId,
      query,
    );
  }
}
