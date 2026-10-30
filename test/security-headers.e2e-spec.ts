import { Controller, Get, INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp, truncateAll } from './support/db';

// A route that fails the way an unknown bug does.
@Controller('boom')
class BoomController {
  @Get()
  boom(): never {
    throw new Error('something unexpected');
  }
}

describe('Security headers (B8.1)', () => {
  let app: INestApplication;
  const api = () => request(app.getHttpServer());

  let token: string;

  beforeAll(async () => {
    app = await createTestApp([BoomController]);
    await truncateAll(app.get(DataSource));
    const res = await api()
      .post('/auth/register')
      .send({ email: 'ann@example.com', password: 'correct horse' })
      .expect(201);
    token = (res.body as { accessToken: string }).accessToken;
  });

  afterAll(() => app.close());

  // What every answer of the server must carry, whatever the status.
  function expectProtected(headers: Record<string, string | undefined>) {
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['strict-transport-security']).toMatch(/^max-age=\d+/);
    expect(headers['content-security-policy']).toContain("default-src 'self'");
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(headers['cross-origin-resource-policy']).toBe('same-origin');
    // Names the framework, which helps nobody but an attacker.
    expect(headers['x-powered-by']).toBeUndefined();
    // No CORS: only the phone app calls this, and it is not a web page.
    expect(
      Object.keys(headers).filter((h) => h.startsWith('access-control-')),
    ).toEqual([]);
  }

  describe('on every kind of answer', () => {
    it('200: a plain page', async () => {
      const res = await api().get('/health').expect(200);
      expectProtected(res.headers);
    });

    it('201: a created account', async () => {
      const res = await api()
        .post('/auth/register')
        .send({ email: 'bob@example.com', password: 'correct horse' })
        .expect(201);
      expectProtected(res.headers);
    });

    it('204: an empty answer', async () => {
      const res = await api()
        .put('/devices')
        .set('Authorization', `Bearer ${token}`)
        .send({ token: 'phone-token-0123456789-abcdefghij' })
        .expect(204);
      expectProtected(res.headers);
    });

    it('400: a request that does not pass the check', async () => {
      const res = await api().post('/auth/login').send({}).expect(400);
      expectProtected(res.headers);
    });

    it('401: no token', async () => {
      const res = await api().get('/me').expect(401);
      expectProtected(res.headers);
    });

    it('404: an unknown route', async () => {
      const res = await api().get('/nope').expect(404);
      expectProtected(res.headers);
    });

    it('413: a body that is too big (answered by the body parser, before any route)', async () => {
      const res = await api()
        .post('/auth/login')
        .send({ email: 'a@example.com', password: 'x'.repeat(200_000) })
        .expect(413);
      expectProtected(res.headers);
    });

    it('500: an unexpected error, still without a word about the framework', async () => {
      jest.spyOn(console, 'error').mockImplementation();
      const res = await api()
        .get('/boom')
        .set('Authorization', `Bearer ${token}`)
        .expect(500);
      expectProtected(res.headers);
      expect(res.body).toEqual({
        code: 'internal_error',
        message: 'Internal server error',
      });
    });
  });

  it('429: too many attempts', async () => {
    process.env.RATE_LIMIT = 'on';
    const limited = await createTestApp();
    try {
      let last = 0;
      let headers: Record<string, string | undefined> = {};
      for (let i = 0; i < 12 && last !== 429; i++) {
        const res = await request(limited.getHttpServer())
          .post('/auth/login')
          .send({ email: 'nobody@example.com', password: 'wrong password' });
        last = res.status;
        headers = res.headers;
      }
      expect(last).toBe(429);
      expectProtected(headers);
    } finally {
      process.env.RATE_LIMIT = 'off';
      await limited.close();
    }
  });

  describe('no CORS', () => {
    it('a page on another site gets no permission, on a plain call or on a preflight', async () => {
      const plain = await api()
        .get('/health')
        .set('Origin', 'https://evil.example')
        .expect(200);
      expect(plain.headers['access-control-allow-origin']).toBeUndefined();

      const preflight = await api()
        .options('/sync/push')
        .set('Origin', 'https://evil.example')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'authorization,content-type');
      expect(
        Object.keys(preflight.headers).filter((h) =>
          h.startsWith('access-control-'),
        ),
      ).toEqual([]);
    });
  });
});
