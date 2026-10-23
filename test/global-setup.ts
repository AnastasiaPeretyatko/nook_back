import { join } from 'path';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/database/data-source-options';
import { assertLocalDatabase, TEST_DATABASE_URL } from './support/test-env';

// Runs once before all e2e tests: brings the test database to the latest schema.
export default async function globalSetup() {
  assertLocalDatabase(TEST_DATABASE_URL);
  // TypeORM loads migration files with plain require, which cannot read .ts on its own.
  require('ts-node/register/transpile-only');

  const dataSource = new DataSource({
    ...buildDataSourceOptions(TEST_DATABASE_URL),
    migrations: [join(__dirname, '../src/migrations/*.ts')],
  });
  try {
    await dataSource.initialize();
  } catch (error) {
    throw new Error(
      `Could not set up the test database: ${(error as Error).message}\nIs it running? Start it with: npm run test:db:up`,
    );
  }
  await dataSource.runMigrations();
  await dataSource.destroy();
}
