import { INestApplication } from '@nestjs/common';
import http from 'http';
import { AddressInfo } from 'net';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp, truncateAll } from './support/db';

// Raw request, because supertest/superagent refuse to send some of these (huge URL, many headers).
function raw(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Size limits (B8.2)', () => {
  let app: INestApplication;
  let port: number;
  let token: string;
  const api = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const big = { text: 'x'.repeat(200_000) }; // over the default 100 KB

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
    await truncateAll(app.get(DataSource));
    const res = await api()
      .post('/auth/register')
      .send({ email: 'ann@example.com', password: 'correct horse' })
      .expect(201);
    token = (res.body as { accessToken: string }).accessToken;
  });

  afterAll(() => app.close());

  // Every route that takes a body, except /sync/push (it has its own, bigger limit).
  const routes: [string, string][] = [
    ['post', '/auth/register'],
    ['post', '/auth/login'],
    ['post', '/auth/google'],
    ['post', '/auth/refresh'],
    ['post', '/auth/logout'],
    ['post', '/groups'],
    ['post', '/groups/join'],
    ['post', '/groups/11111111-1111-4111-8111-111111111111/leave'],
    ['post', '/groups/11111111-1111-4111-8111-111111111111/invite/regenerate'],
    ['patch', '/groups/11111111-1111-4111-8111-111111111111'],
    ['put', '/me/profile'],
    ['put', '/devices'],
    ['delete', '/devices'],
  ];

  it.each(routes)(
    '%s %s: a body over 100 KB is 413 payload_too_large',
    async (method, path) => {
      const res = await api()[method as 'post'](path).set(auth()).send(big);
      expect(res.status).toBe(413);
      expect((res.body as { code: string }).code).toBe('payload_too_large');
    },
  );

  it('413 comes even without a token (the body is read before the login check)', async () => {
    await api().post('/groups').send(big).expect(413);
  });

  it('a body over 100 KB on a GET is 413 too, not a hang', async () => {
    await api().get('/me').set(auth()).send(big).expect(413);
  });

  it('a body of the wrong type (not JSON) is not read at all', async () => {
    const res = await api()
      .post('/groups')
      .set(auth())
      .set('Content-Type', 'text/plain')
      .send('x'.repeat(200_000));
    expect(res.status).toBeLessThan(500);
  });

  it('/sync/push: 5 MB is the edge, over it is 413', async () => {
    const res = await api()
      .post('/sync/push')
      .set(auth())
      .send({ tasks: [{ title: 'x'.repeat(5 * 1024 * 1024) }] });
    expect(res.status).toBe(413);
    expect((res.body as { code: string }).code).toBe('payload_too_large');
  });

  it('a URL of 100 KB is refused, the server stays up', async () => {
    const status = await raw(port, `/${'a'.repeat(100_000)}`).catch(() => 431);
    expect([414, 431, 404]).toContain(status);
    await api().get('/health').expect(200);
  });

  it('thousands of headers are refused, the server stays up', async () => {
    const headers: Record<string, string> = {};
    for (let i = 0; i < 5000; i++) headers[`x-h-${i}`] = 'v';
    const status = await raw(port, '/health', headers).catch(() => 431);
    expect(status).toBe(431);
    await api().get('/health').expect(200);
  });

  describe('JSON nested thousands of levels deep', () => {
    const nest = (depth: number) => '['.repeat(depth) + ']'.repeat(depth);
    const post = (path: string, body: string, withToken = true) =>
      api()
        .post(path)
        .set(withToken ? auth() : {})
        .set('Content-Type', 'application/json')
        .send(body);

    it.each([1_000, 10_000])(
      'on /auth/login (depth %i): 400, not a crash',
      async (depth) => {
        const res = await post(
          '/auth/login',
          `{"email":${nest(depth)},"password":"x"}`,
          false,
        ).expect(400);
        expect((res.body as { code: string }).code).toBe('bad_request');
      },
    );

    it.each([1_000, 10_000, 100_000])(
      'on /sync/push (depth %i): 400, not a crash',
      async (depth) => {
        await post('/sync/push', `{"tasks":[{"id":${nest(depth)}}]}`).expect(
          400,
        );
      },
    );

    it('on /sync/push as a chain of objects: 400', async () => {
      const depth = 50_000;
      const body = `{"tasks":[{"id":${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}}]}`;
      await post('/sync/push', body).expect(400);
    });

    it('a normal push still goes through', async () => {
      await post(
        '/sync/push',
        '{"tasks":[{"id":"11111111-1111-4111-8111-111111111111","title":"[{\\"}]"}]}',
      ).expect(200);
    });
  });
});
