import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { PushSender } from '../src/push/push-sender';
import { PushService } from '../src/push/push.service';
import { createTestApp, truncateAll } from './support/db';
import { Device, PullBody, Rejected } from './support/fake-device';
import { FakeFcm } from './support/fake-fcm';
import { listenForSockets, quiet, Sockets, CHANGED } from './support/ws-client';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [T1, T2, T3] = [1, 2, 3].map(id);
const DAY = '2026-01-15';
const CODE = '111111';
const token = (name: string) => `phone-${name}-`.padEnd(40, 'x');

interface Session {
  token: string;
  id: string;
}

// The "done when" list of stage B7, as stories told through the real routes, with the app's own
// way of syncing (`Device`: pull first, then push what is dirty). The sender to FCM is a fake that
// records what it would have sent.
describe('Push notifications (the "done when" list of stage B7)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let listen: Sockets;
  let pushes: PushService;
  let G: string;
  let tick = 0;
  const fcm = new FakeFcm();
  const users: Record<string, Session> = {};
  const api = () => request(app.getHttpServer());
  const as = (who: string) => ({ Authorization: `Bearer ${users[who].token}` });
  const clock = () =>
    new Date(Date.UTC(2026, 0, 1, 0, 0, ++tick)).toISOString();

  async function signUp(name: string, displayName: string) {
    const res = await api()
      .post('/auth/register')
      .send({ email: `${name}@example.com`, password: 'correct horse' })
      .expect(201);
    const body = res.body as { accessToken: string; user: { id: string } };
    users[name] = { token: body.accessToken, id: body.user.id };
    await api()
      .put('/me/profile')
      .set(as(name))
      .send({ displayName, avatarUrl: null })
      .expect(200);
  }
  const phone = (name: string, n = 1) => token(`${name}${n}`);
  const register = (name: string, n = 1) =>
    api()
      .put('/devices')
      .set(as(name))
      .send({ token: phone(name, n) })
      .expect(204);

  // The app of `who`, on the phone named `device`; every request waits for the notifications that
  // it started, so a test sees them all.
  const appOf = (who: string, device = `${who}-phone`) =>
    new Device(
      {
        push: async (body) => {
          const res = await api()
            .post('/sync/push')
            .set(as(who))
            .set('X-Device-Id', device)
            .send(body)
            .expect(200);
          await pushes.idle();
          return res.body as { rejected: Rejected[] };
        },
        pull: async (query) =>
          (await api().get(`/sync/pull${query}`).set(as(who)).expect(200))
            .body as PullBody,
      },
      clock,
      { userId: users[who].id },
    );

  const nameOf = (to: string) =>
    Object.keys(users)
      .flatMap((n) => [1, 2].map((i) => [`${n}${i}`, phone(n, i)] as const))
      .find(([, t]) => t === to)?.[0] ?? to;
  const told = () => fcm.sent.map((s) => nameOf(s.token)).sort();
  const lines = () =>
    fcm.sent.map((s) => `${nameOf(s.token)}: ${s.message.title}`);

  beforeAll(async () => {
    app = await createTestApp([], 0, (b) =>
      b.overrideProvider(PushSender).useValue(fcm),
    );
    app.getHttpServer().setMaxListeners(200);
    ds = app.get(DataSource);
    pushes = app.get(PushService);
    listen = await listenForSockets(app);
  });

  // Ann owns G with Bob and Cat. Eve joined and left; Fay joined and was removed; Dan never joined.
  // One phone each, two for Bob.
  beforeEach(async () => {
    tick = 0;
    fcm.reset();
    await truncateAll(ds);
    for (const [name, display] of [
      ['ann', 'Аня'],
      ['bob', 'Боб'],
      ['cat', 'Кот'],
      ['dan', 'Дэн'],
      ['eve', 'Ева'],
      ['fay', 'Фая'],
    ]) {
      await signUp(name, display);
    }
    const res = await api()
      .post('/groups')
      .set(as('ann'))
      .send({ name: 'Дом' })
      .expect(201);
    G = (res.body as { id: string }).id;
    await ds.query(`update group_invites set code = $2 where group_id = $1`, [
      G,
      CODE,
    ]);
    for (const m of ['bob', 'cat', 'eve', 'fay']) {
      await api()
        .post('/groups/join')
        .set(as(m))
        .send({ code: CODE })
        .expect(200);
    }
    await api().post(`/groups/${G}/leave`).set(as('eve')).expect(204);
    await api()
      .delete(`/groups/${G}/members/${users.fay.id}`)
      .set(as('ann'))
      .expect(204);
    for (const name of ['ann', 'bob', 'cat', 'dan', 'eve', 'fay']) {
      await register(name);
    }
    await register('bob', 2);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await listen.closeAll();
  });

  afterAll(() => app.close());

  describe('three kinds reach the right phones', () => {
    it('a week of a family: made, ticked, handed on, with both apps syncing the way the app does', async () => {
      const ann = appOf('ann');
      const bob = appOf('bob');
      await ann.sync();
      await bob.sync();

      // Ann makes a task for everyone.
      ann.edit(T1, { title: 'Купить молоко', group_id: G });
      await ann.sync();
      expect(lines()).toEqual([
        'bob1: Новая задача для всех от Аня',
        'bob2: Новая задача для всех от Аня',
        'cat1: Новая задача для всех от Аня',
      ]);

      // Bob's app fetches it and has nothing of its own to send: no echo, no new notification.
      fcm.sent = [];
      await bob.sync();
      expect(bob.tasks.get(T1)?.title).toBe('Купить молоко');
      expect(told()).toEqual([]);

      // Bob ticks it: Ann and Cat are told.
      bob.mark(T1, DAY, { completed: true });
      await bob.sync();
      expect(lines()).toEqual(['ann1: Выполнено: Боб', 'cat1: Выполнено: Боб']);

      // Ann fetches the tick; nothing to send, nothing new said.
      fcm.sent = [];
      await ann.sync();
      expect(ann.otherMarksSnapshot()).toEqual([
        [T1, users.bob.id, DAY, true, null],
      ]);
      expect(told()).toEqual([]);

      // Ann hands another task to Cat, then takes it back for everyone, then edits the title.
      ann.edit(T2, { title: 'Вынести мусор', group_id: G });
      await ann.sync();
      fcm.sent = [];
      ann.edit(T2, { assignee_id: users.cat.id });
      await ann.sync();
      expect(lines()).toEqual(['cat1: Новая задача от Аня']);
      fcm.sent = [];
      ann.edit(T2, { assignee_id: null });
      await ann.sync();
      ann.edit(T2, { title: 'Вынести весь мусор' });
      await ann.sync();
      expect(told()).toEqual([]);

      // Everybody syncs again and again: the stories do not repeat themselves.
      for (let round = 0; round < 3; round++) {
        await bob.sync();
        await ann.sync();
        await bob.sync('push-first');
      }
      expect(told()).toEqual([]);
    });

    it('a task for one person goes to that person and, when done, comes back to whoever handed it out only', async () => {
      const ann = appOf('ann');
      const cat = appOf('cat');
      await ann.sync();
      await cat.sync();
      ann.edit(T1, {
        title: 'Позвонить маме',
        group_id: G,
        assignee_id: users.cat.id,
      });
      await ann.sync();
      expect(lines()).toEqual(['cat1: Новая задача от Аня']);

      // Ann fixing the title of a task that stays Cat's is not a new hand-over.
      fcm.sent = [];
      ann.edit(T1, { title: 'Позвонить маме вечером' });
      await ann.sync();
      expect(told()).toEqual([]);

      await cat.sync();
      cat.mark(T1, DAY, { completed: true });
      await cat.sync();
      expect(lines()).toEqual(['ann1: Выполнено: Кот']);
    });

    it('a push sent twice because the answer was lost tells everyone once', async () => {
      const body = {
        tasks: [{ id: T1, title: 'Для всех', group_id: G }],
        logs: [{ task_id: T1, date: DAY, completed: true }],
      };
      const send = async (who: string) => {
        await api().post('/sync/push').set(as(who)).send(body).expect(200);
        await pushes.idle();
      };
      await send('ann');
      const first = lines().sort();
      expect(first.length).toBeGreaterThan(0);
      await send('ann');
      await send('ann');
      expect(lines().sort()).toEqual(first);
    });

    it('a mark that is not completed, and taking a tick back, say nothing; ticking again is news again', async () => {
      const ann = appOf('ann');
      const bob = appOf('bob');
      await ann.sync();
      ann.edit(T1, { title: 'Для всех', group_id: G });
      await ann.sync();
      await bob.sync();
      fcm.sent = [];

      // A first mark that is not completed is nothing to announce.
      bob.mark(T1, '2026-01-14', { completed: false });
      await bob.sync();
      expect(told()).toEqual([]);

      bob.mark(T1, DAY, { completed: true });
      await bob.sync();
      expect(told()).toEqual(['ann1', 'cat1']);

      // Taking it back is not news.
      fcm.sent = [];
      bob.mark(T1, DAY, { completed: false });
      await bob.sync();
      expect(told()).toEqual([]);

      // Ticking it again is.
      bob.mark(T1, DAY, { completed: true });
      await bob.sync();
      expect(lines()).toEqual(['ann1: Выполнено: Боб', 'cat1: Выполнено: Боб']);
    });

    it('the one who made it, and the one who ticked, are never told about their own doing', async () => {
      const bob = appOf('bob');
      await bob.sync();
      bob.edit(T1, { title: 'Моя задача', group_id: G });
      bob.mark(T1, DAY, { completed: true });
      await bob.sync();
      // Pull first drops nothing; the push carries the task and the mark together.
      expect(told()).not.toContain('bob1');
      expect(told()).not.toContain('bob2');
      expect(lines().sort()).toEqual([
        'ann1: Выполнено: Боб',
        'ann1: Новая задача для всех от Боб',
        'cat1: Выполнено: Боб',
        'cat1: Новая задача для всех от Боб',
      ]);
    });
  });

  describe('a notification and a ring are two different things', () => {
    it('a phone with the app open is rung and, if it has a token, is also notified; the writer’s other phone is only rung', async () => {
      const annTablet = await listen.join(users.ann.token, 'ann-tablet');
      const bobSocket = await listen.join(users.bob.token, 'bob-phone');
      const ann = appOf('ann', 'ann-phone');
      await ann.sync();

      ann.edit(T1, { title: 'Купить хлеб', group_id: G });
      await ann.sync();
      await quiet(120);

      // Rings go to the sockets: Ann's other phone and Bob (not the phone that wrote).
      expect(annTablet.messages).toEqual([CHANGED]);
      expect(bobSocket.messages).toEqual([CHANGED]);
      // Notifications go to people who did not write: Bob's phones and Cat's, not Ann's.
      expect(told()).toEqual(['bob1', 'bob2', 'cat1']);
    });

    it('a person with just one phone registered is told on that one', async () => {
      await ds.query(`delete from device_tokens where user_id = $1`, [
        users.bob.id,
      ]);
      await register('bob', 2);
      const ann = appOf('ann');
      await ann.sync();
      ann.edit(T1, { title: 'Купить хлеб', group_id: G });
      await ann.sync();
      expect(told()).toEqual(['bob2', 'cat1']);
    });
  });

  describe('a phone changes hands', () => {
    it('a phone that Ann has taken over from Bob is told for Ann, and Bob is no longer told on it', async () => {
      // Bob's second phone is registered to Ann now (the last to sign in on a phone owns it).
      await api()
        .put('/devices')
        .set(as('ann'))
        .send({ token: phone('bob', 2) })
        .expect(204);
      const cat = appOf('cat');
      await cat.sync();
      cat.edit(T1, { title: 'От Кота', group_id: G });
      await cat.sync();
      // Ann: her own phone and the one she took over. Bob: only the phone he still has.
      expect(
        fcm.sent.map((s) => [
          nameOf(s.token),
          s.token === phone('bob', 2) ? 'ann' : '',
        ]),
      ).toEqual(
        expect.arrayContaining([
          ['ann1', ''],
          ['bob2', 'ann'],
          ['bob1', ''],
        ]),
      );
      expect(told()).toEqual(['ann1', 'bob1', 'bob2']);
      const toAnn = (
        await ds.query<{ token: string }[]>(
          `select token from device_tokens where user_id = $1`,
          [users.ann.id],
        )
      )
        .map((r) => nameOf(r.token))
        .sort();
      expect(toAnn).toEqual(['ann1', 'bob2']);
    });

    it('Ann signs out on her phone and the phone is no longer hers', async () => {
      await api()
        .delete('/devices')
        .set(as('ann'))
        .send({ token: phone('ann') })
        .expect(204);
      const bob = appOf('bob');
      await bob.sync();
      bob.edit(T1, { title: 'От Боба', group_id: G });
      await bob.sync();
      expect(told()).toEqual(['cat1']);
    });

    it('signing out with someone else’s token does nothing to them', async () => {
      await api()
        .delete('/devices')
        .set(as('dan'))
        .send({ token: phone('ann') })
        .expect(204);
      const bob = appOf('bob');
      await bob.sync();
      bob.edit(T1, { title: 'От Боба', group_id: G });
      await bob.sync();
      expect(told()).toEqual(['ann1', 'cat1']);
    });
  });

  describe('nobody outside the group is told anything, however long the story', () => {
    it('Dan (never in), Eve (left) and Fay (removed) hear nothing through a whole session of group life', async () => {
      const ann = appOf('ann');
      const bob = appOf('bob');
      const cat = appOf('cat');
      for (const a of [ann, bob, cat]) await a.sync();

      ann.edit(T1, { title: 'Для всех', group_id: G });
      ann.edit(T2, {
        title: 'Для Боба',
        group_id: G,
        assignee_id: users.bob.id,
      });
      await ann.sync();
      await bob.sync();
      bob.mark(T1, DAY, { completed: true });
      bob.mark(T2, DAY, { completed: true });
      await bob.sync();
      await cat.sync();
      cat.mark(T1, DAY, { completed: true });
      await cat.sync();
      ann.edit(T2, { assignee_id: users.cat.id });
      await ann.sync();
      await api()
        .patch(`/groups/${G}`)
        .set(as('ann'))
        .send({ name: 'Вилла' })
        .expect(204);
      await api()
        .put('/me/profile')
        .set(as('bob'))
        .send({ displayName: 'Боб Б.', avatarUrl: null })
        .expect(200);
      await api()
        .post(`/groups/${G}/invite/regenerate`)
        .set(as('ann'))
        .expect(200);
      await pushes.idle();

      // The members were told (so the silence below is not an accident) ...
      expect(told().length).toBeGreaterThan(8);
      // ... and the three outside were not told once.
      for (const outsider of ['dan1', 'eve1', 'fay1']) {
        expect(told()).not.toContain(outsider);
      }
    });

    it('their own attempts to write into the group are refused and tell nobody', async () => {
      const ann = appOf('ann');
      await ann.sync();
      ann.edit(T1, { title: 'Для всех', group_id: G });
      await ann.sync();
      fcm.sent = [];
      for (const outsider of ['dan', 'eve', 'fay']) {
        const them = appOf(outsider);
        them.edit(T2, { title: 'Подкинуть', group_id: G });
        them.edit(T1, { assignee_id: users.bob.id, group_id: G });
        them.mark(T1, DAY, { completed: true });
        await them.sync('push-first');
        expect(them.rejected.length).toBeGreaterThan(0);
      }
      expect(told()).toEqual([]);
    });

    it('a member who is not the owner cannot hand over somebody else’s task, so nobody is told it was', async () => {
      const ann = appOf('ann');
      const bob = appOf('bob');
      await ann.sync();
      ann.edit(T1, { title: 'Для всех', group_id: G });
      await ann.sync();
      await bob.sync();
      fcm.sent = [];
      bob.edit(T1, { assignee_id: users.cat.id });
      await bob.sync();
      expect(bob.rejected.map((r) => r.reason)).toEqual(['not_allowed']);
      expect(told()).toEqual([]);
    });

    it('nobody is told about a group that has been deleted, or about one more thing in it', async () => {
      const ann = appOf('ann');
      await ann.sync();
      ann.edit(T1, { title: 'Для всех', group_id: G });
      await ann.sync();
      await api().delete(`/groups/${G}`).set(as('ann')).expect(204);
      fcm.sent = [];
      ann.edit(T2, { title: 'В пустоту', group_id: G });
      await ann.sync('push-first');
      expect(told()).toEqual([]);
    });

    it('joining and leaving never make a notification of their own', async () => {
      const ann = appOf('ann');
      await ann.sync();
      ann.edit(T1, {
        title: 'Для всех',
        group_id: G,
        assignee_id: users.bob.id,
      });
      await ann.sync();
      fcm.sent = [];
      // Dan joins (the group's rows are touched for him), Bob leaves (his tasks go back to nobody).
      await api()
        .post('/groups/join')
        .set(as('dan'))
        .send({ code: CODE })
        .expect(200);
      await api().post(`/groups/${G}/leave`).set(as('bob')).expect(204);
      await pushes.idle();
      expect(told()).toEqual([]);
    });

    it('the phones are never listed, whatever is asked', async () => {
      await api().get('/devices').set(as('ann')).expect(404);
      const pulled = JSON.stringify(
        (await api().get('/sync/pull').set(as('ann')).expect(200)).body,
      );
      const me = JSON.stringify(
        (await api().get('/me').set(as('ann')).expect(200)).body,
      );
      for (const text of [pulled, me]) {
        for (const name of ['ann', 'bob', 'cat', 'dan']) {
          expect(text).not.toContain(phone(name));
        }
      }
    });
  });

  describe('trouble with FCM', () => {
    it('some phones fail, one is gone for good, the rest are told, and the write is kept', async () => {
      fcm.outcomes.set(phone('bob', 1), 'failed');
      fcm.outcomes.set(phone('bob', 2), 'unregistered');
      const ann = appOf('ann');
      await ann.sync();
      ann.edit(T1, { title: 'Для всех', group_id: G });
      await ann.sync();

      expect(ann.rejected).toEqual([]);
      expect(told()).toEqual(['bob1', 'bob2', 'cat1']);
      expect(
        (await ds.query(`select title from tasks where id = $1`, [T1]))[0]
          .title,
      ).toBe('Для всех');

      // The gone phone is not tried again; the one that merely failed is.
      fcm.sent = [];
      ann.edit(T2, { title: 'Ещё', group_id: G });
      await ann.sync();
      expect(told()).toEqual(['bob1', 'cat1']);
    });

    it('FCM down altogether: every write still goes through and every phone stays registered', async () => {
      fcm.fail = true;
      const ann = appOf('ann');
      await ann.sync();
      ann.edit(T1, { title: 'Раз', group_id: G });
      ann.edit(T2, { title: 'Два', group_id: G, assignee_id: users.cat.id });
      await ann.sync();
      expect(ann.rejected).toEqual([]);
      expect((await ds.query(`select count(*)::int n from tasks`))[0].n).toBe(
        2,
      );
      expect(
        (await ds.query(`select count(*)::int n from device_tokens`))[0].n,
      ).toBe(7);
      // And when it is back, the next write is told as usual (the missed ones are not replayed).
      fcm.fail = false;
      ann.edit(T3, { title: 'Три', group_id: G });
      await ann.sync();
      expect(told()).toEqual(['bob1', 'bob2', 'cat1']);
    });
  });

  describe('a big family', () => {
    it('30 people with two phones each: every phone is told once, and no more than 10 at a time', async () => {
      const crowd: string[] = [];
      for (let i = 0; i < 30; i++) {
        const [{ id: userId }] = await ds.query(
          `insert into users (email, password_hash) values ($1, 'hash') returning id`,
          [`crowd${i}@example.com`],
        );
        crowd.push(userId);
        await ds.query(
          `insert into group_members (group_id, user_id) values ($1, $2)`,
          [G, userId],
        );
        for (const n of [1, 2]) {
          await ds.query(
            `insert into device_tokens (token, user_id) values ($1, $2)`,
            [token(`crowd${i}-${n}`), userId],
          );
        }
      }
      fcm.delayMs = 5;
      const ann = appOf('ann');
      await ann.sync();
      ann.edit(T1, { title: 'Для всех', group_id: G });
      await ann.sync();

      const crowdTokens = fcm.sent.filter((s) =>
        s.token.startsWith('phone-crowd'),
      );
      expect(crowdTokens).toHaveLength(60);
      expect(new Set(crowdTokens.map((s) => s.token)).size).toBe(60);
      expect(fcm.maxInflight).toBeGreaterThan(1);
      expect(fcm.maxInflight).toBeLessThanOrEqual(10);
    });

    it('a hundred tasks at once: no phone gets more than ten notifications', async () => {
      const ann = appOf('ann');
      await ann.sync();
      for (let i = 0; i < 100; i++) {
        ann.edit(id(1000 + i), { title: `задача ${i}`, group_id: G });
      }
      await ann.sync();
      for (const phoneName of ['bob1', 'bob2', 'cat1']) {
        expect(
          fcm.sent.filter((s) => nameOf(s.token) === phoneName),
        ).toHaveLength(10);
      }
      expect((await ds.query(`select count(*)::int n from tasks`))[0].n).toBe(
        100,
      );
    });
  });

  describe('a person in two groups', () => {
    it('each notification names its own group and carries its ids', async () => {
      const res = await api()
        .post('/groups')
        .set(as('bob'))
        .send({ name: 'Работа' })
        .expect(201);
      const H = (res.body as { id: string }).id;
      await ds.query(
        `update group_invites set code = '222222' where group_id = $1`,
        [H],
      );
      await api()
        .post('/groups/join')
        .set(as('ann'))
        .send({ code: '222222' })
        .expect(200);

      const ann = appOf('ann');
      await ann.sync();
      ann.edit(T1, { title: 'Дома', group_id: G });
      ann.edit(T2, { title: 'На работе', group_id: H });
      await ann.sync();

      const forBob = fcm.sent
        .filter((s) => s.token === phone('bob', 1))
        .map((s) => [
          s.message.body,
          s.message.data.group_id,
          s.message.data.task_id,
        ])
        .sort();
      expect(forBob).toEqual([
        ['Дома · Дом', G, T1],
        ['На работе · Работа', H, T2],
      ]);
      // Cat is only in G; Dan in neither.
      expect(
        fcm.sent
          .filter((s) => nameOf(s.token) === 'cat1')
          .map((s) => s.message.data.group_id),
      ).toEqual([G]);
      expect(told()).not.toContain('dan1');
    });
  });
});
