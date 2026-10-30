import { PROXY_PORT, TARGET } from './support/proxy-env'; // first: it sets the database address
import { Controller, Get, INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { Client } from 'pg';
import { createTestApp, truncateAll } from './support/db';
import { TcpProxy } from './support/tcp-proxy';
import { TEST_DATABASE_URL } from './support/test-env';

// Routes that touch the database in ways the real ones do not need to.
@Controller('probe')
class ProbeController {
  constructor(private readonly ds: DataSource) {}

  @Get('slow')
  slow() {
    return this.ds.query('select pg_sleep(5)');
  }

  @Get('pid')
  pid() {
    return this.ds.query('select pg_backend_pid() as pid');
  }

  @Get('bad-uuid')
  badUuid() {
    return this.ds.query(`select 'nope'::uuid`);
  }

  @Get('duplicate')
  async duplicate() {
    const insert = () =>
      this.ds.query(
        `insert into users (id, email) values (gen_random_uuid(), 'dup@example.com')`,
      );
    await insert();
    await insert();
  }
}

// What the app does when the database is gone, with the connection really cut (B8.4).
describe('Database unavailable', () => {
  let proxy: TcpProxy;
  let app: INestApplication;
  let ds: DataSource;
  let token: string;
  const api = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const login = () =>
    api()
      .post('/auth/login')
      .send({ email: 'ann@example.com', password: 'correct horse' });

  function expectUnavailable(res: request.Response) {
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      code: 'db_unavailable',
      message: 'Database is unavailable',
    });
    expect(res.headers['retry-after']).toBe('5');
  }

  beforeAll(async () => {
    proxy = new TcpProxy(TARGET.host, TARGET.port, PROXY_PORT);
    await proxy.start();
    app = await createTestApp([ProbeController]);
    ds = app.get(DataSource);
    await truncateAll(ds);
    const res = await api()
      .post('/auth/register')
      .send({ email: 'ann@example.com', password: 'correct horse' })
      .expect(201);
    token = (res.body as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await proxy.stop();
  });

  it('the server is down: 503 db_unavailable with Retry-After, and it comes back by itself', async () => {
    await login().expect(200);
    await proxy.stop();
    expectUnavailable(await login());
    expectUnavailable(await api().get('/sync/pull').set(auth()));
    expectUnavailable(
      await api()
        .post('/sync/push')
        .set(auth())
        .send({ tasks: [{ id: '11111111-1111-4111-8111-111111111111' }] }),
    );
    // Pages that need no database keep working, and a broken token is still a 401, not a 503.
    await api().get('/health').expect(200);
    await api().get('/me').expect(401);

    await proxy.start();
    await login().expect(200);
  });

  it('the link is cut in the middle of a query: 503', async () => {
    const slow = api()
      .get('/probe/slow')
      .set(auth())
      .then((r) => r);
    await new Promise((resolve) => setTimeout(resolve, 300));
    proxy.cut();
    expectUnavailable(await slow);
    await login().expect(200); // the pool drops the dead connection and opens a new one
  });

  it('the server shuts the connection down (57P01): 503', async () => {
    const admin = new Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    try {
      const slow = api()
        .get('/probe/slow')
        .set(auth())
        .then((r) => r);
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Tests run one at a time, so any `pg_sleep(5)` running is this app's.
      const ended = await admin.query(
        `select pg_terminate_backend(pid) from pg_stat_activity
         where state = 'active' and query = 'select pg_sleep(5)'`,
      );
      expect(ended.rowCount).toBeGreaterThanOrEqual(1); // + the leftover of the test above
      expectUnavailable(await slow);
    } finally {
      await admin.end();
    }
    await login().expect(200);
  });

  it('an error of ours in a query stays a 500 (not a database outage)', async () => {
    for (const path of ['bad-uuid', 'duplicate']) {
      const res = await api().get(`/probe/${path}`).set(auth());
      expect(res.status).toBe(500);
      expect((res.body as { code: string }).code).toBe('internal_error');
      expect(res.headers['retry-after']).toBeUndefined();
    }
  });
});
