import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp, truncateAll } from './support/db';

interface ErrorBody {
  code: string;
  message: string;
}

describe('Rate limiting', () => {
  let app: INestApplication;
  const api = () => request(app.getHttpServer());
  const wrongLogin = (forwardedFor?: string) => {
    const call = api()
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: 'wrong password' });
    return forwardedFor ? call.set('X-Forwarded-For', forwardedFor) : call;
  };
  const statuses = async (count: number, call: (i: number) => request.Test) => {
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push((await call(i)).status);
    return out;
  };

  beforeAll(() => {
    process.env.RATE_LIMIT = 'on';
  });
  afterAll(() => {
    process.env.RATE_LIMIT = 'off';
  });
  // A fresh app per test: the counters live in the app's memory.
  afterEach(() => app.close());

  async function start(trustProxyHops = 0) {
    app = await createTestApp([], trustProxyHops);
    await truncateAll(app.get(DataSource));
  }

  it('allows 10 login attempts a minute from one address, then answers 429', async () => {
    await start();
    expect(await statuses(10, () => wrongLogin())).toEqual(Array(10).fill(401));
    const blocked = await wrongLogin().expect(429);
    expect(blocked.body as ErrorBody).toEqual({
      code: 'too_many_requests',
      message: 'Too many requests, try again later',
    });
    // Named throttlers add their name to the header: Retry-After-burst.
    expect(Number(blocked.headers['retry-after-burst'])).toBeGreaterThan(0);
  });

  it('counts each route separately', async () => {
    await start();
    await statuses(11, () => wrongLogin());
    await api()
      .post('/auth/register')
      .send({ email: 'ann@example.com', password: 'correct horse' })
      .expect(201);
  });

  it('also caps an address at 60 attempts an hour on a route, however slowly', async () => {
    await start();
    const realNow = Date.now();
    let offset = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => realNow + offset);
    try {
      for (let minute = 0; minute < 6; minute++) {
        expect(await statuses(10, () => wrongLogin())).toEqual(
          Array(10).fill(401),
        );
        offset += 61_000; // the one-minute window resets, the one-hour window does not
      }
      await wrongLogin().expect(429);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('limits the other routes more loosely: 120 a minute', async () => {
    await start();
    const { accessToken } = (
      await api()
        .post('/auth/register')
        .send({ email: 'ann@example.com', password: 'correct horse' })
        .expect(201)
    ).body as { accessToken: string };
    const me = () =>
      api().get('/me').set('Authorization', `Bearer ${accessToken}`);
    expect(new Set(await statuses(120, me))).toEqual(new Set([200]));
    await me().expect(429);
  });

  it('counts a request before checking its token, so guessing is limited too', async () => {
    await start();
    const results = await statuses(121, () => api().get('/me'));
    expect(new Set(results.slice(0, 120))).toEqual(new Set([401]));
    expect(results[120]).toBe(429);
  });

  it('never limits /health', async () => {
    await start();
    expect(new Set(await statuses(150, () => api().get('/health')))).toEqual(
      new Set([200]),
    );
  });

  describe('behind a proxy', () => {
    it('ignores X-Forwarded-For when no proxy is trusted: one forged address does not help', async () => {
      await start(0);
      const results = await statuses(11, (i) => wrongLogin(`10.0.0.${i}`));
      expect(results.slice(0, 10)).toEqual(Array(10).fill(401));
      expect(results[10]).toBe(429);
    });

    it('with one trusted proxy, tells clients apart by the address the proxy saw', async () => {
      await start(1);
      await statuses(10, () => wrongLogin('203.0.113.1'));
      await wrongLogin('203.0.113.1').expect(429);
      await wrongLogin('203.0.113.2').expect(401); // another client, own counter
    });

    it('with one trusted proxy, forged earlier entries in the header do not give a fresh counter', async () => {
      await start(1);
      // The proxy appends the real client address last; the client controls what comes before.
      const results = await statuses(11, (i) =>
        wrongLogin(`198.51.100.${i}, 203.0.113.1`),
      );
      expect(results.slice(0, 10)).toEqual(Array(10).fill(401));
      expect(results[10]).toBe(429);
    });
  });
});
