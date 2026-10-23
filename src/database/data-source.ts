import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { validateEnv } from '../config/env.validation';
import { buildDataSourceOptions } from './data-source-options';

// Entry point for the TypeORM CLI only (see the migration:* scripts); the app itself
// connects through DatabaseModule. Runs from the compiled dist/, so `npm run build` first.
try {
  process.loadEnvFile(); // the CLI does not read .env; on Render there is none, the vars are set
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

const { DATABASE_URL } = validateEnv(process.env);

export default new DataSource({
  ...buildDataSourceOptions(DATABASE_URL),
  entities: [__dirname + '/../**/*.entity.js'],
  migrations: [__dirname + '/../migrations/*.js'],
});
