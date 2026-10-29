import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Pool } from 'pg';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { PostgresDriver } from 'typeorm/driver/postgres/PostgresDriver';
import { RealtimeService } from '../src/realtime/realtime.service';
import { createTestApp, truncateAll } from './support/db';
import { Device, PullBody, Rejected } from './support/fake-device';
import { LiveDevice } from './support/live-device';
import {
  CHANGED,
  Client,
  listenForSockets,
  nextMessage,
  quiet,
  Sockets,
} from './support/ws-client';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [T1, T2] = [1, 2].map(id);
const [N1, TAG1] = [21, 22].map(id);
const CODE = '111111';
const DAY = '2026-01-15';
const PASSWORD = 'correct horse';

interface Session {
  token: string;
  id: string;
  email: string;
}

// The "done when" list of stage B6: a change on one phone reaches the other by a ring and one
// pull; after a break the phone connects again and pulls once; nobody outside a group is rung;
// a token that has run out gives 4401; a hundred connections and five hundred rings; and
// connecting, ping and pong never touch the database.
describe('Realtime (the "done when" list of stage B6)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let listen: Sockets;
  let realtime: RealtimeService;
  let jwt: JwtService;
  let G: string;
  let tick = 0;
  let live: LiveDevice[] = [];
  const api = () => request(app.getHttpServer());
  const as = (who: Session) => ({ Authorization: `Bearer ${who.token}` });
  const clock = () =>
    new Date(Date.UTC(2026, 0, 1, 0, 0, ++tick)).toISOString();

  async function signUp(name: string): Promise<Session> {
    const email = `${name}@example.com`;
    const res = await api()
      .post('/auth/register')
      .send({ email, password: PASSWORD })
      .expect(201);
    const body = res.body as { accessToken: string; user: { id: string } };
    return { token: body.accessToken, id: body.user.id, email };
  }
  const freshToken = (who: Session) => async () =>
    (
      (
        await api()
          .post('/auth/login')
          .send({ email: who.email, password: PASSWORD })
          .expect(200)
      ).body as { accessToken: string }
    ).accessToken;

  // A phone of `who` (named `name` to the server), not connected yet.
  const phone = (
    who: Session,
    name: string,
    options: {
      diary?: boolean;
      cycle?: boolean;
      autoReconnect?: boolean;
      token?: string;
    } = {},
  ) => {
    const { autoReconnect, token, ...deviceOptions } = options;
    const device = new Device(
      {
        push: async (body) =>
          (
            await api()
              .post('/sync/push')
              .set(as(who))
              .set('X-Device-Id', name)
              .send(body)
              .expect(200)
          ).body as { rejected: Rejected[] },
        pull: async (query) =>
          (await api().get(`/sync/pull${query}`).set(as(who)).expect(200))
            .body as PullBody,
      },
      clock,
      { userId: who.id, ...deviceOptions },
    );
    const app_ = new LiveDevice(
      device,
      listen,
      name,
      token ?? who.token,
      freshToken(who),
      autoReconnect ?? true,
    );
    live.push(app_);
    return app_;
  };
  const connected = async (...phones: LiveDevice[]) => {
    for (const p of phones) await p.connect();
    return phones;
  };

  const call = (
    method: 'post' | 'patch' | 'delete' | 'put',
    path: string,
    who: Session,
    name: string,
    body?: object,
  ) => {
    const req = api()[method](path).set(as(who)).set('X-Device-Id', name);
    return body ? req.send(body) : req;
  };
  const join = (who: Session, name: string) =>
    call('post', '/groups/join', who, name, { code: CODE }).expect(200);

  let ann: Session; // owner of G
  let bob: Session; // member of G
  let cat: Session;
  let dan: Session; // never in G

  beforeAll(async () => {
    app = await createTestApp();
    app.getHttpServer().setMaxListeners(300);
    ds = app.get(DataSource);
    listen = await listenForSockets(app);
    realtime = app.get(RealtimeService);
    jwt = app.get(JwtService);
  });

  beforeEach(async () => {
    tick = 0;
    live = [];
    await truncateAll(ds);
    ann = await signUp('ann');
    bob = await signUp('bob');
    cat = await signUp('cat');
    dan = await signUp('dan');
    const res = await call('post', '/groups', ann, 'setup', {
      name: 'Home',
    }).expect(201);
    G = (res.body as { id: string }).id;
    await ds.query(`update group_invites set code = $2 where group_id = $1`, [
      G,
      CODE,
    ]);
    await join(bob, 'setup');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    live.forEach((p) => p.disconnect());
    await listen.closeAll();
  });

  afterAll(() => app.close());

  describe('a change on one phone reaches the other by a ring and one pull', () => {
    it('personal tasks and marks', async () => {
      const [phoneA, tablet] = await connected(
        phone(ann, 'phone'),
        phone(ann, 'tablet'),
      );
      const before = tablet.device.pulls;

      phoneA.device.edit(T1, { title: 'Read' });
      phoneA.device.mark(T1, DAY, { completed: true });
      await phoneA.device.sync();
      await tablet.waitUntil(() => tablet.rings === 1);

      expect(tablet.device.pulls).toBe(before + 1);
      expect(tablet.device.snapshot()).toEqual(phoneA.device.snapshot());
      expect(tablet.device.snapshot().tasks).toHaveLength(1);
      // The phone that wrote was not rung about it.
      expect(phoneA.rings).toBe(0);
    });

    it('a deletion', async () => {
      const [phoneA, tablet] = await connected(
        phone(ann, 'phone'),
        phone(ann, 'tablet'),
      );
      phoneA.device.edit(T1, { title: 'Read' });
      await phoneA.device.sync();
      await tablet.waitUntil(() => tablet.rings === 1);
      phoneA.device.remove(T1);
      await phoneA.device.sync();
      await tablet.waitUntil(() => tablet.rings === 2);
      expect(tablet.device.snapshot().tasks).toEqual([]);
    });

    it('the diary and the cycle, when the tablet asks for them', async () => {
      const opts = { diary: true, cycle: true };
      const [phoneA, tablet] = await connected(
        phone(ann, 'phone', opts),
        phone(ann, 'tablet', opts),
      );
      phoneA.device.tag(TAG1, { name: 'Work' });
      phoneA.device.note(N1, { title: 'A day', tag_ids: [TAG1] });
      phoneA.device.day(DAY, { flow: 3 });
      await phoneA.device.sync();
      await tablet.waitUntil(() => tablet.rings >= 1);
      expect(tablet.device.diarySnapshot()).toEqual(
        phoneA.device.diarySnapshot(),
      );
      expect(tablet.device.cycleSnapshot()).toEqual(
        phoneA.device.cycleSnapshot(),
      );
      expect(tablet.device.diarySnapshot().notes).toHaveLength(1);
    });

    it('a task of the group reaches the member, and the member’s mark reaches the author', async () => {
      const [annPhone, bobPhone] = await connected(
        phone(ann, 'ann-phone'),
        phone(bob, 'bob-phone'),
      );
      // Both phones know the group from their first pull.
      await annPhone.device.sync();
      const bobPulls = bobPhone.device.pulls;

      annPhone.device.edit(T1, { title: 'For all', group_id: G });
      await annPhone.device.sync();
      await bobPhone.waitUntil(() => bobPhone.rings === 1);
      expect(bobPhone.device.pulls).toBe(bobPulls + 1);
      expect(bobPhone.device.tasks.get(T1)?.title).toBe('For all');

      bobPhone.device.mark(T1, DAY, { completed: true });
      await bobPhone.device.sync();
      await annPhone.waitUntil(() => annPhone.rings === 1);
      expect(annPhone.device.otherMarksSnapshot()).toEqual([
        [T1, bob.id, DAY, true, null],
      ]);
      // Each was rung only about the other's write.
      expect(bobPhone.rings).toBe(1);
    });

    it('the people of the group: someone joins, someone leaves, someone is removed', async () => {
      const [annPhone, bobPhone, catPhone] = await connected(
        phone(ann, 'ann-phone'),
        phone(bob, 'bob-phone'),
        phone(cat, 'cat-phone'),
      );
      const members = (p: LiveDevice) =>
        p.device.groupSnapshot().members.map((m) => m[1]);

      await join(cat, 'cat-phone');
      await annPhone.waitUntil(() => annPhone.rings === 1);
      await bobPhone.waitUntil(() => bobPhone.rings === 1);
      expect(members(annPhone).sort()).toEqual([ann.id, bob.id, cat.id].sort());
      expect(members(bobPhone).sort()).toEqual([ann.id, bob.id, cat.id].sort());
      // The newcomer's own phone pulls by itself after the call it made.
      await catPhone.device.sync();
      expect(members(catPhone)).toHaveLength(3);

      await call('post', `/groups/${G}/leave`, bob, 'bob-phone').expect(204);
      await annPhone.waitUntil(() => annPhone.rings === 2);
      await catPhone.waitUntil(() => catPhone.rings === 1);
      expect(members(annPhone).sort()).toEqual([ann.id, cat.id].sort());

      await call(
        'delete',
        `/groups/${G}/members/${cat.id}`,
        ann,
        'ann-phone',
      ).expect(204);
      await catPhone.waitUntil(() => catPhone.rings === 2);
      expect(catPhone.device.groupSnapshot().groups).toEqual([]);
      // The phone that asked is not rung; it syncs itself after the call, as the app does.
      await annPhone.device.sync();
      expect(members(annPhone)).toEqual([ann.id]);
    });

    it('leaving, being removed or deleting the group takes the tasks off the other phone', async () => {
      const [annPhone, bobTablet, bobPhone] = await connected(
        phone(ann, 'ann-phone'),
        phone(bob, 'bob-tablet'),
        phone(bob, 'bob-phone'),
      );
      annPhone.device.edit(T1, { title: 'For all', group_id: G });
      annPhone.device.edit(T2, {
        title: 'For Bob',
        group_id: G,
        assignee_id: bob.id,
      });
      await annPhone.device.sync();
      await bobTablet.waitUntil(() => bobTablet.device.tasks.size === 2);
      await bobPhone.waitUntil(() => bobPhone.device.tasks.size === 2);

      // Bob leaves on the phone; the tablet is rung and the group goes off it.
      await call('post', `/groups/${G}/leave`, bob, 'bob-phone').expect(204);
      await bobTablet.waitUntil(() => bobTablet.device.tasks.size === 0);
      expect(bobTablet.device.groupSnapshot().groups).toEqual([]);
      // The phone that left was not rung; it learns on its own next pull.
      expect(bobPhone.device.tasks.size).toBe(2);
      await bobPhone.device.sync();
      expect(bobPhone.device.tasks.size).toBe(0);

      // Back in, then the owner deletes the group.
      await join(bob, 'bob-phone');
      await bobTablet.waitUntil(() => bobTablet.device.tasks.size === 2);
      await call('delete', `/groups/${G}`, ann, 'ann-phone').expect(204);
      await bobTablet.waitUntil(() => bobTablet.device.tasks.size === 0);
      expect(bobTablet.device.groupSnapshot().groups).toEqual([]);
    });

    it('a new name is seen by the people of the group', async () => {
      const [annPhone, bobPhone] = await connected(
        phone(ann, 'ann-phone'),
        phone(bob, 'bob-phone'),
      );
      await call('put', '/me/profile', ann, 'ann-phone', {
        displayName: 'Anna',
        avatarUrl: null,
      }).expect(200);
      await bobPhone.waitUntil(() => bobPhone.rings === 1);
      const names = bobPhone.device
        .groupSnapshot()
        .members.map((m) => [m[1], m[2]]);
      expect(names).toContainEqual([ann.id, 'Anna']);
      expect(annPhone.rings).toBe(0);
    });

    it('a rename of the group', async () => {
      const [, bobPhone] = await connected(
        phone(ann, 'ann-phone'),
        phone(bob, 'bob-phone'),
      );
      await call('patch', `/groups/${G}`, ann, 'ann-phone', {
        name: 'Villa',
      }).expect(204);
      await bobPhone.waitUntil(() => bobPhone.rings === 1);
      expect(bobPhone.device.groupSnapshot().groups[0][1]).toBe('Villa');
    });
  });

  describe('a break', () => {
    // What a restart of the server does: every socket on its side is gone at once.
    const serverBreaks = () => {
      const byUser = Reflect.get(realtime, 'byUser') as Map<
        string,
        Map<{ terminate(): void }, unknown>
      >;
      for (const sockets of byUser.values()) {
        for (const socket of sockets.keys()) socket.terminate();
      }
    };

    it('every phone connects again by itself and pulls once', async () => {
      const [annPhone, tablet, bobPhone] = await connected(
        phone(ann, 'phone'),
        phone(ann, 'tablet'),
        phone(bob, 'bob-phone'),
      );
      const pulls = [annPhone, tablet, bobPhone].map((p) => p.device.pulls);

      serverBreaks();
      await Promise.all(
        [annPhone, tablet, bobPhone].map((p) =>
          p.waitUntil(() => p.connects === 2),
        ),
      );

      expect([annPhone, tablet, bobPhone].map((p) => p.device.pulls)).toEqual(
        pulls.map((n) => n + 1),
      );
      expect(realtime.count(ann.id)).toBe(2);
      expect(realtime.count(bob.id)).toBe(1);
      // And rings work again.
      annPhone.device.edit(T1, { title: 'After the break' });
      await annPhone.device.sync();
      await tablet.waitUntil(() => tablet.rings === 1);
      expect(tablet.device.tasks.get(T1)?.title).toBe('After the break');
    });

    it('a phone that was off hears nothing, then one pull on connecting gives it everything', async () => {
      const [annPhone, tablet] = await connected(
        phone(ann, 'phone'),
        phone(ann, 'tablet', { autoReconnect: false }),
      );
      serverBreaks();
      await annPhone.waitUntil(() => annPhone.connects === 2);
      // The phone came back by itself, the tablet (not allowed to) did not.
      expect(realtime.count(ann.id)).toBe(1);

      annPhone.device.edit(T1, { title: 'While you were away' });
      annPhone.device.edit(T2, { title: 'Two things' });
      await annPhone.device.sync();
      await quiet(100);
      expect(tablet.rings).toBe(0);
      expect(tablet.device.tasks.size).toBe(0);

      const pulls = tablet.device.pulls;
      await tablet.connect();
      expect(tablet.device.pulls).toBe(pulls + 1);
      expect(tablet.device.snapshot()).toEqual(annPhone.device.snapshot());
    });
  });

  describe('nobody outside a group is rung, whatever happens in it', () => {
    it('someone who never joined, who left, and who was removed hear nothing', async () => {
      const eve = await signUp('eve');
      const fay = await signUp('fay');
      await join(cat, 'setup');
      await join(eve, 'setup');

      const [annPhone, evePhone, bobPhone, catPhone, danPhone] =
        await connected(
          phone(ann, 'ann-phone'),
          phone(eve, 'eve-phone'),
          phone(bob, 'bob-phone'),
          phone(cat, 'cat-phone'),
          phone(dan, 'dan-phone'),
        );
      // Bob leaves and Cat is removed; Dan was never in. Their phones keep their sockets.
      await call('post', `/groups/${G}/leave`, bob, 'other').expect(204);
      await call(
        'delete',
        `/groups/${G}/members/${cat.id}`,
        ann,
        'ann-phone',
      ).expect(204);
      // They were told about their own leaving or removal; from now on nothing.
      await bobPhone.waitUntil(() => bobPhone.rings === 1);
      // Cat heard Bob leave (still a member then), and then her own removal.
      await catPhone.waitUntil(() => catPhone.rings === 2);
      const outsiders = [bobPhone, catPhone, danPhone];
      const heard = () => outsiders.map((p) => p.rings);
      const base = heard();
      const raw = outsiders.map((p) => p.client!.messages.length);

      // Everything a group does.
      annPhone.device.edit(T1, { title: 'For all', group_id: G });
      annPhone.device.edit(T2, {
        title: 'For Eve',
        group_id: G,
        assignee_id: eve.id,
      });
      await annPhone.device.sync();
      evePhone.device.mark(T1, DAY, { completed: true });
      evePhone.device.mark(T2, DAY, { completed: true });
      await evePhone.device.sync();
      annPhone.device.edit(T1, { title: 'Renamed task', group_id: G });
      await annPhone.device.sync();
      annPhone.device.remove(T2);
      await annPhone.device.sync();
      await call('patch', `/groups/${G}`, ann, 'ann-phone', {
        name: 'Villa',
      }).expect(204);
      await call(
        'post',
        `/groups/${G}/invite/regenerate`,
        ann,
        'ann-phone',
      ).expect(200);
      await call('put', '/me/profile', ann, 'ann-phone', {
        displayName: 'Anna',
        avatarUrl: null,
      }).expect(200);
      await call('put', '/me/profile', eve, 'eve-phone', {
        displayName: 'Eve',
        avatarUrl: null,
      }).expect(200);
      // A new member comes, then the owner deletes the group.
      const code = (
        await ds.query(`select code from group_invites where group_id = $1`, [
          G,
        ])
      )[0].code as string;
      await call('post', '/groups/join', fay, 'fay-phone', { code }).expect(
        200,
      );
      await call('delete', `/groups/${G}`, ann, 'ann-phone').expect(204);
      await quiet(200);

      // The members were rung (so this is not a test of silence by accident) ...
      expect(evePhone.rings).toBeGreaterThan(3);
      // ... and the three outside were not, on any phone, not even by a raw message.
      expect(heard()).toEqual(base);
      expect(outsiders.map((p) => p.client!.messages.length)).toEqual(raw);
    });

    it("an outsider's own writes do not ring the group, nor does a former member's profile", async () => {
      const [annPhone, , danPhone] = await connected(
        phone(ann, 'ann-phone'),
        phone(bob, 'bob-phone'),
        phone(dan, 'dan-phone'),
      );
      await call('post', `/groups/${G}/leave`, bob, 'bob-phone').expect(204);
      await annPhone.waitUntil(() => annPhone.rings === 1);

      // Dan tries a group task, a mark and a deletion on the group's ids; Bob changes his name.
      danPhone.device.edit(T1, { title: 'Sneak', group_id: G });
      // Push first: a pull first would drop the task of a group Dan is not in before sending it.
      await danPhone.device.sync('push-first');
      await call('put', '/me/profile', bob, 'bob-phone', {
        displayName: 'Bobby',
        avatarUrl: null,
      }).expect(200);
      await call('put', '/me/profile', dan, 'dan-phone', {
        displayName: 'Dan',
        avatarUrl: null,
      }).expect(200);
      await quiet(200);

      expect(annPhone.rings).toBe(1); // only Bob's leaving
      expect(danPhone.device.rejected.map((r) => r.reason)).toEqual([
        'unknown_group',
      ]);
    });
  });

  describe('a token that has run out', () => {
    it('is refused on connecting with 4401', async () => {
      const old = jwt.sign({
        sub: ann.id,
        exp: Math.floor(Date.now() / 1000) - 5,
      });
      const c = listen.connect(`?token=${old}`);
      expect(await c.closed).toBe(4401);
      expect(c.messages).toEqual(['{"t":"unauthorized"}']);
    });

    it('a connection whose token runs out is closed with 4401 instead of rung; the phone gets a new token, connects, and pulls once', async () => {
      const shortLived = jwt.sign({ sub: ann.id }, { expiresIn: 2 });
      const writer = phone(ann, 'phone');
      const tablet = phone(ann, 'tablet', { token: shortLived });
      await connected(writer, tablet);
      const pulls = tablet.device.pulls;

      await quiet(2300); // the token of the tablet is over, its connection is not
      writer.device.edit(T1, { title: 'Late' });
      await writer.device.sync();

      await tablet.waitUntil(() => tablet.connects === 2);
      expect(tablet.unauthorized).toBe(1);
      expect(tablet.rings).toBe(0); // it was told to come back, not rung
      expect(tablet.device.pulls).toBe(pulls + 1);
      expect(tablet.device.tasks.get(T1)?.title).toBe('Late');
    });

    it('a phone that connects with an old token is told by a message, gets a new one, and pulls once', async () => {
      const old = jwt.sign({
        sub: ann.id,
        exp: Math.floor(Date.now() / 1000) - 5,
      });
      const tablet = phone(ann, 'tablet', { token: old });
      await tablet.connect();
      expect(tablet.unauthorized).toBe(1);
      expect(tablet.connects).toBe(1);
      expect(tablet.device.pulls).toBe(1);
      expect(realtime.count(ann.id)).toBe(1);
    });

    it('the same on a ping', async () => {
      const shortLived = jwt.sign({ sub: ann.id }, { expiresIn: 2 });
      const c = await listen.join(shortLived);
      await quiet(2300);
      c.socket.send('{"t":"ping"}');
      expect(await c.closed).toBe(4401);
      expect(c.messages).toEqual(['{"t":"unauthorized"}']);
    });
  });

  describe('many phones', () => {
    it('a hundred connections, five hundred rings at once, and the database untouched', async () => {
      const people: Session[] = [];
      for (let i = 0; i < 20; i++) people.push(await signUp(`p${i}`));
      const pool = (ds.driver as PostgresDriver).master as Pool;
      const connectSpy = jest.spyOn(pool, 'connect');
      const querySpy = jest.spyOn(pool, 'query');

      // 20 people with 5 phones each, all at once.
      const clients: Client[] = await Promise.all(
        people.flatMap((p) =>
          [1, 2, 3, 4, 5].map((n) => listen.join(p.token, `${p.id}-${n}`)),
        ),
      );
      expect(clients).toHaveLength(100);
      for (const p of people) expect(realtime.count(p.id)).toBe(5);

      // A ping on every one of them.
      clients.forEach((c) => c.socket.send('{"t":"ping"}'));
      for (const c of clients)
        expect(await nextMessage(c)).toBe('{"t":"pong"}');

      // 500 rings to everybody; each phone must get all of them, once each.
      const everyone = people.map((p) => p.id);
      const started = Date.now();
      for (let i = 0; i < 500; i++) realtime.ring(everyone);
      for (let waited = 0; waited < 15000; waited += 25) {
        if (clients.every((c) => c.messages.length === 501)) break;
        await quiet(25);
      }
      expect(clients.map((c) => c.messages.length)).toEqual(
        clients.map(() => 501), // the pong and 500 rings
      );
      expect(
        clients.every((c) => c.messages.slice(1).every((m) => m === CHANGED)),
      ).toBe(true);
      expect(Date.now() - started).toBeLessThan(10000);
      expect(clients.every((c) => c.socket.readyState === c.socket.OPEN)).toBe(
        true,
      );

      // Closing them all empties the registry. None of it touched the database.
      clients.forEach((c) => c.socket.close());
      await Promise.all(clients.map((c) => c.closed));
      await quiet(100);
      for (const p of people) expect(realtime.count(p.id)).toBe(0);
      expect(connectSpy).not.toHaveBeenCalled();
      expect(querySpy).not.toHaveBeenCalled();
      await ds.query('select 1');
      expect(connectSpy).toHaveBeenCalled(); // the spy works
    });
  });
});
