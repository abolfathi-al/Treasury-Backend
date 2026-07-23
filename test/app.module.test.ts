import test from 'node:test';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module';

test('boots the root Nest application context', async () => {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });

  await app.close();
});
