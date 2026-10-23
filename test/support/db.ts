import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { AppModule } from '../../src/app.module';
import { assertLocalDatabase } from './test-env';

// The real AppModule on the test database.
export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  // Check the connection the app really has, not just the URL we meant to give it.
  const { url } = moduleRef.get(DataSource)
    .options as PostgresConnectionOptions;
  try {
    assertLocalDatabase(url!);
  } catch (error) {
    await moduleRef.close();
    throw error;
  }
  const app = moduleRef.createNestApplication();
  app.useLogger(false);
  await app.init();
  return app;
}

// Empties every table except TypeORM's own `migrations` bookkeeping.
export async function truncateAll(dataSource: DataSource) {
  const tables: { tablename: string }[] = await dataSource.query(
    `select tablename from pg_tables where schemaname = 'public' and tablename <> 'migrations'`,
  );
  if (tables.length === 0) return;
  const names = tables.map((t) => `"${t.tablename}"`).join(', ');
  await dataSource.query(`truncate ${names} restart identity cascade`);
}
