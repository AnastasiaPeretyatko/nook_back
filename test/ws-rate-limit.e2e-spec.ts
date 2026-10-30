import { INestApplication } from '@nestjs/common';
import { IncomingMessage } from 'http';
import { AddressInfo } from 'net';
import request from 'supertest';
import { DataSource } from 'typeorm';
import WebSocket from 'ws';
import { MAX_NEW_CONNECTIONS_PER_MINUTE } from '../src/realtime/connection-limiter';
import { createTestApp, truncateAll } from './support/db';

const MAX = MAX_NEW_CONNECTIONS_PER_MINUTE;

interface Outcome {
  // 101 = the socket opened; otherwise the HTTP status of the refusal.
  status: number;
  retryAfter?: string;
  body?: string;
}

// The limit on new socket connections per address (B8.6), with real sockets.
describe('/ws connection limit', () => {
  let app: INestApplication;
  let port: number;
  let token: string;
  let opened: WebSocket[] = [];
  const api = () => request(app.getHttpServer());

  beforeAll(() => {
    process.env.RATE_LIMIT = 'on';
  });
  afterAll(() => {
    process.env.RATE_LIMIT = 'off';
  });

  // A fresh app per test: the counters live in the app's memory.
  async function start(trustProxyHops = 0) {
    app = await createTestApp([], trustProxyHops);
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
    await truncateAll(app.get(DataSource));
    const res = await api()
      .post('/auth/register')
      .send({ email: 'ann@example.com', password: 'correct horse' })
      .expect(201);
    token = (res.body as { accessToken: string }).accessToken;
  }

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const socket of opened) socket.terminate();
    opened = [];
    await app.close();
  });

  const connect = (
    query = `?token=${token}`,
    headers: Record<string, string> = {},
  ) =>
    new Promise<Outcome>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`, {
        headers,
      });
      opened.push(socket);
      socket.on('open', () => resolve({ status: 101 }));
      socket.on('error', () => undefined); // a refusal also ends in an error event
      socket.on('unexpected-response', (_req, res: IncomingMessage) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            retryAfter: res.headers['retry-after'],
            body,
          }),
        );
        res.on('error', reject);
      });
    });
  const connectMany = async (
    n: number,
    ...args: Parameters<typeof connect>
  ) => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push((await connect(...args)).status);
    return out;
  };

  it(`takes ${MAX} new connections a minute from one address, then refuses with a plain 429 before the handshake`, async () => {
    await start();
    expect(await connectMany(MAX)).toEqual(Array(MAX).fill(101));
    const refused = await connect();
    expect(refused.status).toBe(429);
    expect(JSON.parse(refused.body!)).toEqual({
      code: 'too_many_requests',
      message: 'Too many connections, try again later',
    });
    expect(Number(refused.retryAfter)).toBeGreaterThan(0);
    expect(Number(refused.retryAfter)).toBeLessThanOrEqual(60);
  });

  it('counts attempts with a bad token too, so a flood of them is stopped', async () => {
    await start();
    // Each is accepted at the door (the token is judged after it) and sent away with 4401.
    expect(await connectMany(MAX, '?token=garbage')).toEqual(
      Array(MAX).fill(101),
    );
    expect((await connect('?token=garbage')).status).toBe(429);
    expect((await connect()).status).toBe(429); // a good token does not get round it
  });

  it('lets connections in again when the minute is over', async () => {
    await start();
    await connectMany(MAX);
    expect((await connect()).status).toBe(429);
    const later = Date.now() + 61_000;
    jest.spyOn(Date, 'now').mockReturnValue(later);
    expect((await connect()).status).toBe(101);
  });

  it('keeps ten phones of one person well inside the limit', async () => {
    await start();
    expect(await connectMany(10)).toEqual(Array(10).fill(101));
    expect((await connect()).status).toBe(101);
  });

  it('does not count the ordinary requests', async () => {
    await start();
    for (let i = 0; i < 20; i++) await api().get('/health').expect(200);
    expect(await connectMany(MAX)).toEqual(Array(MAX).fill(101));
  });

  it('does not count a connection to another path, which is dropped as before', async () => {
    await start();
    for (let i = 0; i < 5; i++) {
      await new Promise<void>((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/elsewhere`);
        opened.push(socket);
        socket.on('error', () => resolve());
        socket.on('close', () => resolve());
      });
    }
    expect(await connectMany(MAX)).toEqual(Array(MAX).fill(101));
  });

  describe('which address is counted', () => {
    const from = (ip: string) => ({ 'X-Forwarded-For': ip });

    it('with no proxy trusted, a made-up X-Forwarded-For does not get a fresh allowance', async () => {
      await start(0);
      await connectMany(MAX, `?token=${token}`, from('9.9.9.1'));
      expect((await connect(`?token=${token}`, from('9.9.9.2'))).status).toBe(
        429,
      );
    });

    it('behind a trusted proxy, each client address has its own allowance', async () => {
      await start(1);
      await connectMany(MAX, `?token=${token}`, from('9.9.9.1'));
      expect((await connect(`?token=${token}`, from('9.9.9.1'))).status).toBe(
        429,
      );
      expect((await connect(`?token=${token}`, from('9.9.9.2'))).status).toBe(
        101,
      );
    });

    it('behind a trusted proxy, a made-up address added by the client does not help', async () => {
      await start(1);
      // The client puts "1.1.1.1" first; the proxy adds the real address, 9.9.9.1, after it.
      await connectMany(MAX, `?token=${token}`, from('6.6.6.6, 9.9.9.1'));
      expect(
        (await connect(`?token=${token}`, from('7.7.7.7, 9.9.9.1'))).status,
      ).toBe(429);
    });
  });
});
