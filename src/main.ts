import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}

void bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
