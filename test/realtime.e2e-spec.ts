import { Controller, Get, INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Pool } from 'pg';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { PostgresDriver } from 'typeorm/driver/postgres/PostgresDriver';
import WebSocket from 'ws';
import { DeviceId } from '../src/realtime/device-id';
import { RealtimeService } from '../src/realtime/realtime.service';
import { createTestApp, truncateAll } from './support/db';
import {
  Client,
  listenForSockets,
  nextMessage,
  quiet,
} from './support/ws-client';

@Controller('test-device')
class DeviceEchoController {
  @Get()
  echo(@DeviceId() device?: string) {
    return { device: device ?? null };
  }
}

describe('WebSocket /ws', () => {
  let app: INestApplication;
  let ds: DataSource;
  let realtime: RealtimeService;
  let jwt: JwtService;
  let connect: Awaited<ReturnType<typeof listenForSockets>>['connect'];
  let closeAll: () => Promise<void>;

  const signUp = async (email: string) => {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'correct horse' })
      .expect(201);
    const body = res.body as { accessToken: string; user: { id: string } };
    return { token: body.accessToken, id: body.user.id };
  };

  beforeAll(async () => {
    app = await createTestApp([DeviceEchoController]);
    ({ connect, closeAll } = await listenForSockets(app));
    ds = app.get(DataSource);
    realtime = app.get(RealtimeService);
    jwt = app.get(JwtService);
  });

  beforeEach(() => truncateAll(ds));

  afterEach(async () => {
    jest.restoreAllMocks();
    await closeAll();
  });

  afterAll(() => app.close());

  describe('connecting', () => {
    it('answers ping with pong', async () => {
      const ann = await signUp('ann@example.com');
      const c = connect(`?token=${ann.token}`);
      await c.opened;
      c.socket.send('{"t":"ping"}');
      expect(await nextMessage(c)).toBe('{"t":"pong"}');
    });

    it('ignores everything else without answering or closing', async () => {
      const ann = await signUp('ann@example.com');
      const c = connect(`?token=${ann.token}`);
      await c.opened;
      await quiet(); // let the server finish checking the token
      for (const junk of [
        'hello',
        '{',
        'null',
        '5',
        '{"t":"pong"}',
        '{"t":1}',
      ]) {
        c.socket.send(junk);
      }
      c.socket.send(Buffer.from([0, 1, 2]));
      c.socket.send('{"t":"ping"}');
      expect(await nextMessage(c)).toBe('{"t":"pong"}');
      await quiet();
      expect(c.messages).toEqual(['{"t":"pong"}']);
    });

    it('sends nothing by itself after connecting', async () => {
      const ann = await signUp('ann@example.com');
      const c = connect(`?token=${ann.token}`);
      await c.opened;
      await quiet(200);
      expect(c.messages).toEqual([]);
    });

    it.each([
      ['no token', () => ''],
      ['an empty token', () => '?token='],
      ['garbage', () => '?token=not-a-token'],
      [
        'a token signed with another secret',
        () =>
          `?token=${new JwtService({ secret: 'x'.repeat(40) }).sign({ sub: 'a' })}`,
      ],
      [
        'an expired token',
        () =>
          `?token=${jwt.sign({ sub: 'a', exp: Math.floor(Date.now() / 1000) - 10 })}`,
      ],
      ['a token without a user', () => `?token=${jwt.sign({})}`],
    ])('closes with 4401 for %s', async (_name, query) => {
      const c = connect(query());
      expect(await c.closed).toBe(4401);
      // The message comes first: it is what survives a proxy that eats the close.
      expect(c.messages).toEqual(['{"t":"unauthorized"}']);
    });

    it('does not register a refused connection', async () => {
      const c = connect('?token=garbage');
      await c.closed;
      expect(realtime.count('garbage')).toBe(0);
    });

    it('refuses any other path', async () => {
      const ann = await signUp('ann@example.com');
      const c = connect(`?token=${ann.token}`, '/other');
      await expect(c.opened).rejects.toBeDefined();
    });

    it('closes with 1009 on a message over 1 KB, and keeps serving the others', async () => {
      const ann = await signUp('ann@example.com');
      const big = connect(`?token=${ann.token}`);
      const fine = connect(`?token=${ann.token}`);
      await Promise.all([big.opened, fine.opened]);
      await quiet();
      big.socket.send('x'.repeat(1025));
      expect(await big.closed).toBe(1009);
      fine.socket.send('{"t":"ping"}');
      expect(await nextMessage(fine)).toBe('{"t":"pong"}');
      expect(realtime.count(ann.id)).toBe(1);
    });

    it('accepts a message of exactly 1 KB', async () => {
      const ann = await signUp('ann@example.com');
      const c = connect(`?token=${ann.token}`);
      await c.opened;
      await quiet();
      c.socket.send(' '.repeat(1024 - 12) + '{"t":"ping"}');
      expect(await nextMessage(c)).toBe('{"t":"pong"}');
    });
  });

  describe('the registry', () => {
    it('adds a connection and removes it when it closes', async () => {
      const ann = await signUp('ann@example.com');
      const c = connect(`?token=${ann.token}`);
      await c.opened;
      await quiet();
      expect(realtime.count(ann.id)).toBe(1);
      c.socket.close();
      await c.closed;
      await quiet();
      expect(realtime.count(ann.id)).toBe(0);
    });

    it('keeps one list per user, several connections each', async () => {
      const ann = await signUp('ann@example.com');
      const bob = await signUp('bob@example.com');
      const all = [ann, ann, bob].map((u) => connect(`?token=${u.token}`));
      await Promise.all(all.map((c) => c.opened));
      await quiet();
      expect(realtime.count(ann.id)).toBe(2);
      expect(realtime.count(bob.id)).toBe(1);
    });

    it('the 11th connection of a user pushes out the oldest one', async () => {
      const ann = await signUp('ann@example.com');
      const bob = await signUp('bob@example.com');
      const bobs = connect(`?token=${bob.token}`);
      const anns: Client[] = [];
      for (let i = 0; i < 10; i++) {
        anns.push(connect(`?token=${ann.token}`));
        await anns[i].opened;
        await quiet(20);
      }
      await bobs.opened;
      expect(realtime.count(ann.id)).toBe(10);

      const eleventh = connect(`?token=${ann.token}`);
      await eleventh.opened;
      expect(await anns[0].closed).toBe(1008);
      await quiet();
      expect(realtime.count(ann.id)).toBe(10);
      // Everyone else is still connected and answers, Bob is not touched.
      for (const c of [...anns.slice(1), eleventh, bobs]) {
        c.socket.send('{"t":"ping"}');
        expect(await nextMessage(c)).toBe('{"t":"pong"}');
      }
      expect(realtime.count(bob.id)).toBe(1);
    });

    it('closes a connection that has been silent for over 10 minutes', async () => {
      const ann = await signUp('ann@example.com');
      const c = connect(`?token=${ann.token}`);
      await c.opened;
      await quiet();
      const now = Date.now();

      realtime.closeIdle(now + 9 * 60_000);
      await quiet();
      expect(realtime.count(ann.id)).toBe(1);
      expect(c.socket.readyState).toBe(WebSocket.OPEN);

      realtime.closeIdle(now + 11 * 60_000);
      expect(realtime.count(ann.id)).toBe(0);
      expect(await c.closed).toBe(1001);
    });

    it('a ping starts the 10 minutes again; only the silent one is closed', async () => {
      const ann = await signUp('ann@example.com');
      const talker = connect(`?token=${ann.token}`);
      const silent = connect(`?token=${ann.token}`);
      await Promise.all([talker.opened, silent.opened]);
      await quiet();

      const later = Date.now() + 8 * 60_000;
      jest.spyOn(Date, 'now').mockReturnValue(later);
      talker.socket.send('{"t":"ping"}');
      await nextMessage(talker);
      jest.restoreAllMocks();

      realtime.closeIdle(later + 5 * 60_000); // talker: 5 min of silence, silent: 13
      expect(await silent.closed).toBe(1001);
      expect(talker.socket.readyState).toBe(WebSocket.OPEN);
      expect(realtime.count(ann.id)).toBe(1);
    });
  });

  describe('the database', () => {
    it('is never used by connecting, ping, pong, a refused token or closing', async () => {
      const ann = await signUp('ann@example.com');
      // TypeORM takes a connection from this pool for every query, so counting it counts all.
      const pool = (ds.driver as PostgresDriver).master as Pool;
      const connectSpy = jest.spyOn(pool, 'connect');
      const querySpy = jest.spyOn(pool, 'query');

      const good = connect(`?token=${ann.token}`);
      const bad = connect('?token=garbage');
      await good.opened;
      await bad.closed;
      good.socket.send('{"t":"ping"}');
      await nextMessage(good);
      good.socket.send('junk');
      good.socket.close();
      await good.closed;
      await quiet();
      expect(connectSpy).not.toHaveBeenCalled();
      expect(querySpy).not.toHaveBeenCalled();

      // The spies do see a real query, so the silence above means something.
      await ds.query('select 1');
      expect(connectSpy).toHaveBeenCalled();
    });
  });

  describe('ringing (B6.2)', () => {
    const changed = '{"t":"changed"}';

    it('reaches every connection of the user, with the bare message and nothing else', async () => {
      const ann = await signUp('ann@example.com');
      const bob = await signUp('bob@example.com');
      const phone = connect(`?token=${ann.token}&device=phone`);
      const tablet = connect(`?token=${ann.token}&device=tablet`);
      const bobs = connect(`?token=${bob.token}`);
      await Promise.all([phone.opened, tablet.opened, bobs.opened]);
      await quiet();
      realtime.ring([ann.id]);
      expect(await nextMessage(phone)).toBe(changed);
      expect(await nextMessage(tablet)).toBe(changed);
      await quiet();
      expect(phone.messages).toEqual([changed]);
      expect(bobs.messages).toEqual([]);
    });

    it("skips the device named at connection time, not the same person's other device", async () => {
      const ann = await signUp('ann@example.com');
      const phone = connect(`?token=${ann.token}&device=phone`);
      const tablet = connect(`?token=${ann.token}&device=tablet`);
      await Promise.all([phone.opened, tablet.opened]);
      await quiet();
      realtime.ring([ann.id], 'phone');
      expect(await nextMessage(tablet)).toBe(changed);
      await quiet();
      expect(phone.messages).toEqual([]);
    });

    it.each([
      ['a bad name', 'a%20b'],
      ['too long a name', 'x'.repeat(65)],
      ['an empty name', ''],
    ])(
      'a connection with %s counts as nameless and is always rung',
      async (_n, device) => {
        const ann = await signUp('ann@example.com');
        const c = connect(`?token=${ann.token}&device=${device}`);
        await c.opened;
        await quiet();
        realtime.ring([ann.id], device === 'a%20b' ? 'a b' : device || 'x');
        expect(await nextMessage(c)).toBe(changed);
      },
    );

    it('does not ring a connection after it has closed', async () => {
      const ann = await signUp('ann@example.com');
      const c = connect(`?token=${ann.token}`);
      await c.opened;
      await quiet();
      c.socket.close();
      await c.closed;
      await quiet();
      expect(() => realtime.ring([ann.id])).not.toThrow();
      expect(c.messages).toEqual([]);
    });

    it('closes a connection whose token has expired with 4401 instead of ringing it', async () => {
      const ann = await signUp('ann@example.com');
      const old = connect(`?token=${ann.token}&device=old`);
      await old.opened;
      await quiet();
      // The token lasts an hour; the connection is two hours old.
      jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 3_600_000);
      realtime.ring([ann.id]);
      expect(await old.closed).toBe(4401);
      expect(old.messages).toEqual(['{"t":"unauthorized"}']); // not "changed"
      expect(realtime.count(ann.id)).toBe(0);
    });

    it('answers a ping on an expired token with 4401, not with pong', async () => {
      const ann = await signUp('ann@example.com');
      const old = connect(`?token=${ann.token}`);
      await old.opened;
      await quiet();
      jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 3_600_000);
      old.socket.send('{"t":"ping"}');
      expect(await old.closed).toBe(4401);
      expect(old.messages).toEqual(['{"t":"unauthorized"}']); // not "pong"
    });

    it('a connection that opens with a fresh token is not affected by an old one expiring', async () => {
      const ann = await signUp('ann@example.com');
      const fresh = connect(`?token=${ann.token}`);
      await fresh.opened;
      await quiet();
      realtime.ring([ann.id]);
      expect(await nextMessage(fresh)).toBe(changed);
      expect(fresh.socket.readyState).toBe(WebSocket.OPEN);
    });
  });

  describe('the X-Device-Id header', () => {
    const echo = async (header?: string) => {
      const ann = await signUp('ann@example.com');
      const req = request(app.getHttpServer())
        .get('/test-device')
        .set('Authorization', `Bearer ${ann.token}`);
      if (header !== undefined) req.set('X-Device-Id', header);
      return (await req.expect(200)).body as { device: string | null };
    };

    it('is read when it fits', async () => {
      expect(await echo('phone-1')).toEqual({ device: 'phone-1' });
    });

    it.each(['bad name', 'x'.repeat(65), 'телефон'])(
      'is treated as missing when it does not fit (%s)',
      async (header) => {
        expect(
          await echo(
            header.includes('т') ? encodeURIComponent(header) : header,
          ),
        ).toEqual({ device: null });
      },
    );

    it('is missing when not sent', async () => {
      expect(await echo()).toEqual({ device: null });
    });
  });
});
