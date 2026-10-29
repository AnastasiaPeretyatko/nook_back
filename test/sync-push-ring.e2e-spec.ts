import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { WebSocket } from 'ws';
import { DataSource } from 'typeorm';
import { RealtimeService } from '../src/realtime/realtime.service';
import { CycleWriter } from '../src/sync/cycle-writer';
import { LogWriter } from '../src/sync/log-writer';
import { createTestApp, truncateAll } from './support/db';
import { CHANGED, Client, listenForSockets, quiet } from './support/ws-client';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [T1, T2, T3, T4] = [1, 2, 3, 4].map(id); // T1, T2: group G; T3: group H; T4: Dan's own
const [N1, M1, TAG1] = [11, 12, 13].map(id);
const DAY = '2026-01-15';

interface Session {
  token: string;
  id: string;
}

// Rings after POST /sync/push (B6.3): who hears about a write and who does not.
// Groups: G = Ann (owner), Bob, Cat; Eve left G. H = Hal (owner), Ivy. Dan is in nothing.
describe('POST /sync/push rings the phones', () => {
  let app: INestApplication;
  let ds: DataSource;
  let listen: Awaited<ReturnType<typeof listenForSockets>>;
  let G: string;
  let H: string;
  const users: Record<string, Session> = {};
  let phones: Record<string, Client> = {};
  const api = () => request(app.getHttpServer());
  const as = (who: Session) => ({ Authorization: `Bearer ${who.token}` });

  async function signUp(name: string) {
    const res = await api()
      .post('/auth/register')
      .send({ email: `${name}@example.com`, password: 'correct horse' })
      .expect(201);
    const body = res.body as { accessToken: string; user: { id: string } };
    users[name] = { token: body.accessToken, id: body.user.id };
  }
  async function makeGroup(owner: string, members: string[], code: string) {
    const res = await api()
      .post('/groups')
      .set(as(users[owner]))
      .send({ name: 'g' })
      .expect(201);
    const group = (res.body as { id: string }).id;
    await ds.query(`update group_invites set code = $2 where group_id = $1`, [
      group,
      code,
    ]);
    for (const m of members) {
      await api()
        .post('/groups/join')
        .set(as(users[m]))
        .send({ code })
        .expect(200);
    }
    return group;
  }

  const push = async (
    who: string,
    body: object,
    device?: string,
    status = 200,
  ) => {
    const req = api().post('/sync/push').set(as(users[who])).send(body);
    if (device) req.set('X-Device-Id', device);
    return (await req.expect(status)).body as {
      rejected: { table: string; id: string | null; reason: string }[];
    };
  };

  // Who got a message, after giving the server a moment to send it. Each is exactly one ring.
  const heard = async () => {
    await quiet(120);
    const got = Object.entries(phones).filter(([, c]) => c.messages.length > 0);
    for (const [, c] of got) expect(c.messages).toEqual([CHANGED]);
    return got.map(([name]) => name).sort();
  };

  beforeAll(async () => {
    app = await createTestApp();
    app.getHttpServer().setMaxListeners(100);
    ds = app.get(DataSource);
    listen = await listenForSockets(app);
    await truncateAll(ds);
    for (const n of ['ann', 'bob', 'cat', 'dan', 'eve', 'hal', 'ivy']) {
      await signUp(n);
    }
    G = await makeGroup('ann', ['bob', 'cat', 'eve'], '111111');
    H = await makeGroup('hal', ['ivy'], '222222');
    await api().post(`/groups/${G}/leave`).set(as(users.eve)).expect(204);
  });

  beforeEach(async () => {
    await ds.query(
      `truncate tasks, task_logs, diary_entries, note_tags, cycle_days cascade`,
    );
    await ds.query(`delete from note_moods where user_id is not null`);
    // Ann has two phones, everyone else one.
    phones = {
      'ann-phone': await listen.join(users.ann.token, 'ann-phone'),
      'ann-tablet': await listen.join(users.ann.token, 'ann-tablet'),
      bob: await listen.join(users.bob.token, 'bob-phone'),
      cat: await listen.join(users.cat.token, 'cat-phone'),
      dan: await listen.join(users.dan.token, 'dan-phone'),
      eve: await listen.join(users.eve.token, 'eve-phone'),
      hal: await listen.join(users.hal.token, 'hal-phone'),
      ivy: await listen.join(users.ivy.token, 'ivy-phone'),
    };
    // The group tasks the tests write marks to and delete.
    await push('ann', {
      tasks: [
        { id: T1, group_id: G, title: 'for all' },
        { id: T2, group_id: G, title: 'for Bob', assignee_id: users.bob.id },
      ],
    });
    await push('hal', { tasks: [{ id: T3, group_id: H, title: 'in H' }] });
    await quiet(120);
    for (const c of Object.values(phones)) c.messages.length = 0;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await listen.closeAll();
  });

  afterAll(() => app.close());

  describe('personal data', () => {
    it("rings the writer's other phone, not the one that wrote, and nobody else", async () => {
      await push(
        'ann',
        { tasks: [{ id: id(40), title: 'mine' }] },
        'ann-phone',
      );
      expect(await heard()).toEqual(['ann-tablet']);
    });

    it.each([
      ['no X-Device-Id', undefined],
      ['an X-Device-Id that does not fit', 'not a valid id!'],
    ])('rings both phones of the writer with %s', async (_n, device) => {
      await push('ann', { tasks: [{ id: id(40), title: 'mine' }] }, device);
      expect(await heard()).toEqual(['ann-phone', 'ann-tablet']);
    });

    it("rings the other phone of the writer when the name is another person's phone", async () => {
      await push(
        'ann',
        { tasks: [{ id: id(40), title: 'mine' }] },
        'bob-phone',
      );
      expect(await heard()).toEqual(['ann-phone', 'ann-tablet']);
    });

    it.each([
      ['a task', { tasks: [{ id: id(40), title: 'x' }] }],
      [
        'a mark on a personal task',
        {
          tasks: [{ id: id(40), title: 'x' }],
          logs: [{ task_id: id(40), date: DAY, completed: true }],
        },
      ],
      ['a mood', { moods: [{ id: M1, name: 'Mine', emoji: '🙂' }] }],
      ['a tag', { tags: [{ id: TAG1, name: 'Work' }] }],
      ['a note', { entries: [{ id: N1, title: 'A day' }] }],
      ['a cycle day', { cycle_days: [{ date: DAY, flow: 2 }] }],
      [
        'a deletion of a task nobody has seen',
        { deleted: [{ table: 'tasks', id: id(41) }] },
      ],
      [
        'a deletion of a note',
        { deleted: [{ table: 'diary_entries', id: id(42) }] },
      ],
      [
        'a deletion of a tag',
        { deleted: [{ table: 'note_tags', id: id(43) }] },
      ],
      [
        'a deletion of a mood',
        { deleted: [{ table: 'note_moods', id: id(44) }] },
      ],
    ])('rings the other phone about %s', async (_n, body) => {
      await push('ann', body, 'ann-phone');
      expect(await heard()).toEqual(['ann-tablet']);
    });

    it('rings about a note even if one of its labels was dropped', async () => {
      const res = await push(
        'ann',
        { entries: [{ id: N1, title: 'A day', tag_ids: [id(99)] }] },
        'ann-phone',
      );
      expect(res.rejected.map((r) => r.reason)).toEqual(['unknown_label']);
      expect(await heard()).toEqual(['ann-tablet']);
    });

    it('rings a request that mixes good rows with a refused one, once', async () => {
      const res = await push(
        'ann',
        {
          tasks: [{ id: id(40), title: 'mine' }, { id: 'junk' }],
          tags: [{ id: TAG1, name: 'Work' }],
        },
        'ann-phone',
      );
      expect(res.rejected.map((r) => r.reason)).toEqual(['invalid_row']);
      expect(await heard()).toEqual(['ann-tablet']);
    });
  });

  describe('nothing written, nothing rung', () => {
    it.each([
      ['an empty request', {}],
      ['empty lists', { tasks: [], logs: [], deleted: [] }],
      [
        'only rows that fail the check',
        { tasks: [{ id: 'junk' }], logs: [{}], deleted: [{ table: 'tasks' }] },
      ],
    ])('%s', async (_n, body) => {
      await push('ann', body);
      expect(await heard()).toEqual([]);
    });

    it("everything refused: another person's task id, a mark on a task that is not yours", async () => {
      await push('dan', { tasks: [{ id: T4, title: 'Dan' }] });
      await quiet(100);
      for (const c of Object.values(phones)) c.messages.length = 0;
      const res = await push('ann', {
        tasks: [{ id: T4, title: 'stolen' }],
        logs: [{ task_id: T4, date: DAY, completed: true }],
        deleted: [{ table: 'tasks', id: T4 }],
      });
      expect(res.rejected.map((r) => r.reason).sort()).toEqual([
        'id_taken',
        'id_taken',
        'unknown_task',
      ]);
      expect(await heard()).toEqual([]);
    });
  });

  describe('tasks and marks of a group', () => {
    it("a new group task rings the members, the writer's other phone, not the writer's phone, and not strangers", async () => {
      await push(
        'ann',
        { tasks: [{ id: id(50), group_id: G, title: 'new' }] },
        'ann-phone',
      );
      expect(await heard()).toEqual(['ann-tablet', 'bob', 'cat']);
    });

    it('a mark by a member rings the others, including the owner', async () => {
      await push(
        'bob',
        { logs: [{ task_id: T1, date: DAY, completed: true }] },
        'bob-phone',
      );
      expect(await heard()).toEqual(['ann-phone', 'ann-tablet', 'cat']);
    });

    it('deleting a group task rings the members', async () => {
      await push('ann', { deleted: [{ table: 'tasks', id: T1 }] }, 'ann-phone');
      expect(await heard()).toEqual(['ann-tablet', 'bob', 'cat']);
    });

    it('a request about two groups rings both and a request about G does not ring H', async () => {
      await push(
        'ann',
        { logs: [{ task_id: T1, date: DAY, completed: true }] },
        'ann-phone',
      );
      expect(await heard()).toEqual(['ann-tablet', 'bob', 'cat']);
      for (const c of Object.values(phones)) c.messages.length = 0;
      await push(
        'hal',
        {
          logs: [{ task_id: T3, date: DAY, completed: true }],
        },
        'hal-phone',
      );
      expect(await heard()).toEqual(['ivy']);
    });

    it('someone who left is not rung', async () => {
      await push('ann', { tasks: [{ id: id(50), group_id: G, title: 'new' }] });
      expect(await heard()).not.toContain('eve');
    });

    it('a member removed by the owner is not rung', async () => {
      await api()
        .delete(`/groups/${G}/members/${users.cat.id}`)
        .set(as(users.ann))
        .expect(204);
      for (const c of Object.values(phones)) c.messages.length = 0;
      await push(
        'ann',
        { tasks: [{ id: id(50), group_id: G, title: 'new' }] },
        'ann-phone',
      );
      expect(await heard()).toEqual(['ann-tablet', 'bob']);
      // The groups are shared by all tests: put Cat back.
      await ds.query(
        `update group_members set deleted_at = null where group_id = $1 and user_id = $2`,
        [G, users.cat.id],
      );
    });

    it("the device name is the writer's own: another person's phone with the same name is still rung", async () => {
      const twin = await listen.join(users.bob.token, 'ann-phone');
      phones.twin = twin;
      await push(
        'ann',
        { tasks: [{ id: id(50), group_id: G, title: 'new' }] },
        'ann-phone',
      );
      expect(await heard()).toEqual(['ann-tablet', 'bob', 'cat', 'twin']);
    });

    it('a member who is not connected costs nothing and the others still hear', async () => {
      phones.cat.socket.terminate();
      await phones.cat.closed;
      await quiet(50);
      await push(
        'ann',
        { tasks: [{ id: id(50), group_id: G, title: 'new' }] },
        'ann-phone',
      );
      expect(await heard()).toEqual(['ann-tablet', 'bob']);
    });

    it("a mixed request (personal and group) rings the writer's other phone once", async () => {
      await push(
        'ann',
        {
          tags: [{ id: TAG1, name: 'Work' }],
          tasks: [{ id: id(50), group_id: G, title: 'new' }],
        },
        'ann-phone',
      );
      expect(await heard()).toEqual(['ann-tablet', 'bob', 'cat']);
    });
  });

  describe('strangers cannot ring a group', () => {
    it.each([
      [
        'a mark on its task',
        { logs: [{ task_id: T1, date: DAY, completed: true }] },
      ],
      ['a deletion of its task', { deleted: [{ table: 'tasks', id: T1 }] }],
      ['an overwrite of its task', { tasks: [{ id: T1, title: 'mine now' }] }],
      [
        'a new task in the group',
        () => ({ tasks: [{ id: id(50), group_id: G, title: 'sneak in' }] }),
      ],
    ])('Dan trying %s rings nobody', async (_n, body) => {
      // G exists only once the tests run, so a body may be a function.
      const res = await push('dan', typeof body === 'function' ? body() : body);
      expect(res.rejected.length).toBeGreaterThan(0);
      expect(await heard()).toEqual([]);
    });

    it('someone who left cannot ring the group', async () => {
      await push('eve', {
        logs: [{ task_id: T1, date: DAY, completed: true }],
      });
      expect(await heard()).toEqual([]);
    });

    it("a member's refused rows for another group's task ring nobody there, even beside a good write", async () => {
      await push(
        'ann',
        {
          tags: [{ id: TAG1, name: 'Work' }],
          logs: [{ task_id: T3, date: DAY, completed: true }],
        },
        'ann-phone',
      );
      expect(await heard()).toEqual(['ann-tablet']);
    });

    it('the query itself refuses to ring a group the writer is not in, if the check before it is fooled', async () => {
      // The writer sent a mark on H's task and the writer of marks (wrongly) says it saved it.
      jest.spyOn(app.get(LogWriter), 'write').mockResolvedValue([]);
      await push(
        'ann',
        { logs: [{ task_id: T3, date: DAY, completed: true }] },
        'ann-phone',
      );
      expect(await heard()).toEqual(['ann-tablet']);
    });
  });

  describe('the database', () => {
    it('is asked about members only when somebody else is connected', async () => {
      const query = jest.spyOn(ds, 'query');
      // The writers' queries go through here too, with their transaction as the third argument.
      const outsideTransactions = () =>
        query.mock.calls.filter((call) => call[2] === undefined);
      const groupLookups = () =>
        outsideTransactions().filter(([sql]) =>
          String(sql).includes('group_members'),
        ).length;

      await push(
        'ann',
        { tasks: [{ id: id(50), group_id: G, title: 'new' }] },
        'ann-phone',
      );
      expect(groupLookups()).toBe(1);

      // Everyone but Ann leaves; her own phones need no lookup.
      for (const [name, c] of Object.entries(phones)) {
        if (!name.startsWith('ann')) c.socket.terminate();
      }
      await Promise.all(
        Object.entries(phones)
          .filter(([n]) => !n.startsWith('ann'))
          .map(([, c]) => c.closed),
      );
      await quiet(50);
      query.mockClear();
      await push(
        'ann',
        { tasks: [{ id: id(51), group_id: G, title: 'again' }] },
        'ann-phone',
      );
      expect(groupLookups()).toBe(0);
    });

    it('is not asked about members for personal data', async () => {
      const query = jest.spyOn(ds, 'query');
      await push('ann', { tags: [{ id: TAG1, name: 'Work' }] });
      expect(query.mock.calls.filter((call) => call[2] === undefined)).toEqual(
        [],
      );
    });
  });

  describe('failures', () => {
    it('a rolled-back push rings nobody', async () => {
      jest
        .spyOn(app.get(CycleWriter), 'write')
        .mockRejectedValue(new Error('database went away'));
      await push(
        'ann',
        {
          tasks: [{ id: id(50), group_id: G, title: 'new' }],
          cycle_days: [{ date: DAY, flow: 1 }],
        },
        'ann-phone',
        500,
      );
      expect(await heard()).toEqual([]);
      const saved = await ds.query(`select 1 from tasks where id = $1`, [
        id(50),
      ]);
      expect(saved).toEqual([]);
    });

    it.each(['ring', 'connectedUserIds'] as const)(
      'a failing %s does not fail the push, and the data is saved',
      async (method) => {
        jest.spyOn(app.get(RealtimeService), method).mockImplementation(() => {
          throw new Error('boom');
        });
        const res = await push(
          'ann',
          { tasks: [{ id: id(50), group_id: G, title: 'new' }] },
          'ann-phone',
        );
        expect(res.rejected).toEqual([]);
        const saved = await ds.query(`select 1 from tasks where id = $1`, [
          id(50),
        ]);
        expect(saved).toHaveLength(1);
      },
    );

    it('a broken phone does not stop the others or the push', async () => {
      // The server's side of Bob's connection lives in the registry (private).
      const byUser = Reflect.get(app.get(RealtimeService), 'byUser') as Map<
        string,
        Map<WebSocket, unknown>
      >;
      const [bobsSocket] = byUser.get(users.bob.id)!.keys();
      jest.spyOn(bobsSocket, 'send').mockImplementation(() => {
        throw new Error('socket is not open');
      });
      await push(
        'ann',
        { tasks: [{ id: id(50), group_id: G, title: 'new' }] },
        'ann-phone',
      );
      expect(await heard()).toEqual(['ann-tablet', 'cat']);
    });
  });
});
