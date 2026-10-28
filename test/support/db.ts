import { INestApplication, Type } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { AppModule } from '../../src/app.module';
import { configureBodyLimit, configureProxy } from '../../src/app.setup';
import { assertLocalDatabase } from './test-env';

// The real AppModule on the test database. `controllers` adds test-only routes that still
// pass through the app's global guard, pipe and filter.
export async function createTestApp(
  controllers: Type[] = [],
  trustProxyHops = 0,
  configure: (builder: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
): Promise<INestApplication> {
  const moduleRef = await configure(
    Test.createTestingModule({ imports: [AppModule], controllers }),
  ).compile();
  // Check the connection the app really has, not just the URL we meant to give it.
  const { url } = moduleRef.get(DataSource)
    .options as PostgresConnectionOptions;
  try {
    assertLocalDatabase(url!);
  } catch (error) {
    await moduleRef.close();
    throw error;
  }
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureProxy(app, trustProxyHops);
  configureBodyLimit(app);
  app.useLogger(false);
  await app.init();
  return app;
}

// Empties every table except TypeORM's own `migrations` bookkeeping. The eight starter moods
// belong to nobody and come with the schema (a migration inserts them), so they are put back.
export async function truncateAll(dataSource: DataSource) {
  const tables: { tablename: string }[] = await dataSource.query(
    `select tablename from pg_tables where schemaname = 'public' and tablename <> 'migrations'`,
  );
  if (tables.length === 0) return;
  const hasMoods = tables.some((t) => t.tablename === 'note_moods');
  const starters: unknown[] = hasMoods
    ? await dataSource.query(
        `select id, name, emoji, created_at, client_updated_at from note_moods where user_id is null`,
      )
    : [];
  const names = tables.map((t) => `"${t.tablename}"`).join(', ');
  await dataSource.query(`truncate ${names} restart identity cascade`);
  if (starters.length > 0) {
    await dataSource.query(
      `insert into note_moods (id, user_id, name, emoji, created_at, client_updated_at)
       select id, null, name, emoji, created_at, client_updated_at
       from json_to_recordset($1::json) as r(
         id uuid, name text, emoji text, created_at timestamptz, client_updated_at timestamptz
       )`,
      [JSON.stringify(starters)],
    );
  }
}
