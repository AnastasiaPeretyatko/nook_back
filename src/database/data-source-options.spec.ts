import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { buildDataSourceOptions } from './data-source-options';

describe('buildDataSourceOptions', () => {
  const options = buildDataSourceOptions(
    'postgresql://u:p@h/d?sslmode=require',
  );

  it('never lets TypeORM change the schema', () => {
    expect(options.synchronize).toBe(false);
  });

  it('keeps a small pool that closes idle connections fast', () => {
    expect(options.poolSize).toBe(5);
    expect(options.extra).toEqual({ idleTimeoutMillis: 10_000 });
  });

  it('waits long enough for a sleeping Neon', () => {
    expect(options.connectTimeoutMS).toBeGreaterThanOrEqual(30_000);
  });

  it('uses snake_case column names', () => {
    expect(options.namingStrategy).toBeInstanceOf(SnakeNamingStrategy);
  });
});
