import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';

// Shared by the app (DatabaseModule) and the migration CLI, so both connect the same way.
// TLS is not set here: pg reads it from `?sslmode=` in the URL (Neon's strings carry it).
export function buildDataSourceOptions(url: string): PostgresConnectionOptions {
  return {
    type: 'postgres',
    url,
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
    // gen_random_uuid() is built into Postgres 13+; do not try to install an extension for it.
    uuidExtension: 'pgcrypto',
    installExtensions: false,
    // Small pool and quick idle close: Neon free sleeps after 5 min without queries.
    poolSize: 5,
    // A sleeping Neon needs seconds to wake on the first connection.
    connectTimeoutMS: 30_000,
    extra: { idleTimeoutMillis: 10_000 },
  };
}
