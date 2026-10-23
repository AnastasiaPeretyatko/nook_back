import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createTestApp, truncateAll } from './support/db';
import { assertLocalDatabase } from './support/test-env';

describe('Test database', () => {
  let app: INestApplication;
  let ds: DataSource;

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
  });

  afterAll(() => app.close());

  it('is connected to the local test database, not a real one', async () => {
    const [row] = await ds.query(`select current_database() as db`);
    expect(row.db).toBe('nook_test');
  });

  it('has the migrations applied', async () => {
    const rows = await ds.query(`select name from migrations`);
    expect(rows.map((r: { name: string }) => r.name)).toContain(
      'SetUpdatedAtFunction1792758277932',
    );
  });

  describe('set_updated_at trigger', () => {
    beforeEach(async () => {
      await ds.query(`drop table if exists trigger_probe`);
      await ds.query(
        `create table trigger_probe (id int primary key, updated_at timestamptz)`,
      );
      await ds.query(`
        create trigger trigger_probe_updated_at before insert or update on trigger_probe
        for each row execute function set_updated_at()`);
    });

    afterEach(() => ds.query(`drop table if exists trigger_probe`));

    it('ignores a client-supplied updated_at', async () => {
      await ds.query(`insert into trigger_probe values (1, '2000-01-01')`);
      const [row] = await ds.query(
        `select updated_at > '2020-01-01' as fresh from trigger_probe`,
      );
      expect(row.fresh).toBe(true);
    });

    it('gives a later stamp to a later write inside one transaction', async () => {
      await ds.transaction(async (m) => {
        await m.query(`insert into trigger_probe (id) values (1)`);
        await m.query(`select pg_sleep(0.05)`);
        await m.query(`insert into trigger_probe (id) values (2)`);
      });
      const [row] = await ds.query(`
        select (select updated_at from trigger_probe where id = 2)
             > (select updated_at from trigger_probe where id = 1) as later`);
      expect(row.later).toBe(true);
    });
  });

  it('truncateAll empties tables but keeps the migrations record', async () => {
    await ds.query(`create table if not exists wipe_probe (id int)`);
    await ds.query(`insert into wipe_probe values (1)`);
    await truncateAll(ds);
    const [{ n }] = await ds.query(`select count(*)::int n from wipe_probe`);
    const [{ m }] = await ds.query(`select count(*)::int m from migrations`);
    await ds.query(`drop table wipe_probe`);
    expect(n).toBe(0);
    expect(m).toBeGreaterThan(0);
  });

  it('refuses a non-local database URL', () => {
    expect(() =>
      assertLocalDatabase('postgresql://u:p@ep-cool-123.neon.tech/db'),
    ).toThrow(/non-local/);
    expect(() =>
      assertLocalDatabase('postgresql://u:p@localhost:54330/db'),
    ).not.toThrow();
  });
});
