import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp, truncateAll } from './support/db';

const ID = '11111111-1111-4111-8111-111111111111';

// What the body of POST /sync/push may look like, before any row is looked at.
describe('POST /sync/push body', () => {
  let app: INestApplication;
  let ds: DataSource;
  let token: string;
  const api = () => request(app.getHttpServer());
  const push = (body: object | string) =>
    api()
      .post('/sync/push')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json')
      .send(body);

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
  });

  beforeEach(async () => {
    await truncateAll(ds);
    const res = await api()
      .post('/auth/register')
      .send({ email: 'ann@example.com', password: 'correct horse' })
      .expect(201);
    token = (res.body as { accessToken: string }).accessToken;
  });

  afterAll(() => app.close());

  it('accepts a body with only some of the lists, or none', async () => {
    await push({ tasks: [{ id: ID }] }).expect(200);
    await push({}).expect(200);
  });

  it('does not fail the request for a bad row', async () => {
    const res = await push({
      tasks: [{ id: ID }, { id: 'abc' }, null, 5, { id: ID, status: 'done' }],
      logs: ['x'],
      deleted: [{}],
    }).expect(200);
    expect((res.body as { rejected: unknown[] }).rejected).toHaveLength(6);
  });

  it('refuses a list that is not a list', async () => {
    for (const body of [
      { tasks: {} },
      { logs: 'x' },
      { deleted: 5 },
      { entries: 1 },
    ]) {
      const res = await push(body).expect(400);
      expect(res.body.code).toBe('validation_failed');
    }
  });

  it.each(['tasks', 'logs', 'deleted', 'entries', 'cycle_days'])(
    'takes exactly 500 rows in %s and refuses 501 with batch_too_large',
    async (list) => {
      await push({ [list]: Array.from({ length: 500 }, () => ({})) }).expect(
        200,
      );
      const res = await push({
        [list]: Array.from({ length: 501 }, () => ({})),
      }).expect(400);
      expect(res.body.code).toBe('batch_too_large');
    },
  );

  it('takes a body well over the default 100 KB, up to 5 MB', async () => {
    // ~2 MB: 500 tasks with a 4000-character description each.
    const tasks = Array.from({ length: 500 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      description: 'x'.repeat(4000),
    }));
    const res = await push({ tasks }).expect(200);
    expect(res.body.rejected).toEqual([]);
    const [{ n }] = await ds.query(`select count(*)::int n from tasks`);
    expect(n).toBe(500);
  });

  it('refuses a body over 5 MB with 413 payload_too_large', async () => {
    const res = await push({
      tasks: [{ id: ID, title: 'x'.repeat(5 * 1024 * 1024) }],
    });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('payload_too_large');
  });

  it('keeps the small limit on every other route', async () => {
    const res = await api()
      .post('/auth/login')
      .send({ email: 'a@example.com', password: 'x'.repeat(200_000) });
    expect(res.status).toBe(413);
  });

  it('answers broken JSON with 400, in the usual shape', async () => {
    const res = await push('{"tasks": [').expect(400);
    expect(res.body).toHaveProperty('code');
    expect(res.body).toHaveProperty('message');
  });

  it('is closed without a token', async () => {
    await api().post('/sync/push').send({}).expect(401);
  });
});
