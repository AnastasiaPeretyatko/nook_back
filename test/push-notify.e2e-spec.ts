import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { PushSender } from '../src/push/push-sender';
import { PushService } from '../src/push/push.service';
import { CycleWriter } from '../src/sync/cycle-writer';
import { createTestApp, truncateAll } from './support/db';
import { FakeFcm } from './support/fake-fcm';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [T1, T2, T3, T4] = [1, 2, 3, 4].map(id);
const DAY = '2026-01-15';
const CODE = '111111';
const token = (name: string) => `phone-${name}-`.padEnd(40, 'x');

interface Session {
  token: string;
  id: string;
}

// Push notifications after POST /sync/push (B7.7), through the real routes: who is told what, and
// what must never happen.
describe('Push notifications after a push', () => {
  let app: INestApplication;
  let ds: DataSource;
  let fcm: FakeFcm;
  let pushes: PushService;
  let G: string;
  const users: Record<string, Session> = {};
  const api = () => request(app.getHttpServer());
  const as = (who: string) => ({ Authorization: `Bearer ${users[who].token}` });

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

  const push = async (who: string, body: object, status = 200) => {
    const res = await api()
      .post('/sync/push')
      .set(as(who))
      .send(body)
      .expect(status);
    await pushes.idle();
    return res.body as {
      rejected: { table: string; id: string; reason: string }[];
    };
  };
  const groupTask = (fields: Record<string, unknown>) => ({
    group_id: G,
    title: 'Купить молоко',
    ...fields,
  });
  // Which phones got something, as "name+number".
  const nameOf = (to: string) =>
    Object.keys(users)
      .flatMap((n) => [1, 2].map((i) => [`${n}${i}`, phone(n, i)] as const))
      .find(([, t]) => t === to)?.[0] ?? to;
  const told = () => fcm.sent.map((s) => nameOf(s.token)).sort();
  const lastMessage = () => fcm.sent[fcm.sent.length - 1]?.message;

  beforeAll(async () => {
    fcm = new FakeFcm();
    app = await createTestApp([], 0, (b) =>
      b.overrideProvider(PushSender).useValue(fcm),
    );
    app.getHttpServer().setMaxListeners(100);
    ds = app.get(DataSource);
    pushes = app.get(PushService);
  });

  beforeEach(async () => {
    fcm.reset();
    await truncateAll(ds);
    await signUp('ann', 'Аня');
    await signUp('bob', 'Боб');
    await signUp('cat', 'Кот');
    await signUp('dan', 'Дэн');
    await signUp('eve', 'Ева');
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
    for (const m of ['bob', 'cat', 'eve']) {
      await api()
        .post('/groups/join')
        .set(as(m))
        .send({ code: CODE })
        .expect(200);
    }
    await api().post(`/groups/${G}/leave`).set(as('eve')).expect(204);
    // Ann, Cat, Dan, Eve one phone each; Bob two.
    for (const name of ['ann', 'bob', 'cat', 'dan', 'eve'])
      await register(name);
    await register('bob', 2);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(() => app.close());

  describe('a new task', () => {
    it('for everyone: every phone of the others, none of the author’s, none of the outsiders', async () => {
      await push('ann', { tasks: [groupTask({ id: T1 })] });
      expect(told()).toEqual(['bob1', 'bob2', 'cat1']);
      expect(lastMessage()).toEqual({
        title: 'Новая задача для всех от Аня',
        body: 'Купить молоко · Дом',
        data: { group_id: G, task_id: T1 },
      });
    });

    it('for someone: only their phones, and the title says "от"', async () => {
      await push('ann', {
        tasks: [groupTask({ id: T1, assignee_id: users.cat.id })],
      });
      expect(told()).toEqual(['cat1']);
      expect(lastMessage()?.title).toBe('Новая задача от Аня');
    });

    it('made by a member who is not the owner: the owner is told, the maker is not', async () => {
      await push('bob', { tasks: [groupTask({ id: T1 })] });
      expect(told()).toEqual(['ann1', 'cat1']);
      expect(lastMessage()?.title).toBe('Новая задача для всех от Боб');
    });

    it('for the author themself: nobody', async () => {
      await push('ann', {
        tasks: [groupTask({ id: T1, assignee_id: users.ann.id })],
      });
      expect(told()).toEqual([]);
    });

    it('a member without a name is "Участник"', async () => {
      await api()
        .put('/me/profile')
        .set(as('ann'))
        .send({ displayName: null, avatarUrl: null })
        .expect(200);
      await push('ann', { tasks: [groupTask({ id: T1 })] });
      expect(lastMessage()?.title).toBe('Новая задача для всех от Участник');
    });

    it('made on a phone long ago (the backlog): nobody', async () => {
      await push('ann', {
        tasks: [groupTask({ id: T1, created_at: '2020-01-01T00:00:00Z' })],
      });
      expect(told()).toEqual([]);
    });

    it('made just under an hour ago: told', async () => {
      const recent = new Date(Date.now() - 59 * 60_000).toISOString();
      await push('ann', { tasks: [groupTask({ id: T1, created_at: recent })] });
      expect(told()).toEqual(['bob1', 'bob2', 'cat1']);
    });

    it('a long title is cut', async () => {
      await push('ann', {
        tasks: [groupTask({ id: T1, title: 'я'.repeat(900) })],
      });
      expect(lastMessage()?.body).toBe(`${'я'.repeat(199)}… · Дом`);
    });
  });

  describe('a task handed to someone', () => {
    beforeEach(async () => {
      await push('ann', { tasks: [groupTask({ id: T1 })] });
      fcm.sent = [];
    });

    it('tells the new assignee only', async () => {
      await push('ann', {
        tasks: [groupTask({ id: T1, assignee_id: users.cat.id })],
      });
      expect(told()).toEqual(['cat1']);
      expect(lastMessage()).toEqual({
        title: 'Новая задача от Аня',
        body: 'Купить молоко · Дом',
        data: { group_id: G, task_id: T1 },
      });
    });

    it('the owner handing on a member’s task: the text names the author', async () => {
      await push('bob', { tasks: [groupTask({ id: T2 })] });
      fcm.sent = [];
      await push('ann', {
        tasks: [groupTask({ id: T2, assignee_id: users.cat.id })],
      });
      expect(told()).toEqual(['cat1']);
      expect(lastMessage()?.title).toBe('Новая задача от Боб');
    });

    it('handing from one to another tells only the new one', async () => {
      await push('ann', {
        tasks: [groupTask({ id: T1, assignee_id: users.bob.id })],
      });
      fcm.sent = [];
      await push('ann', {
        tasks: [groupTask({ id: T1, assignee_id: users.cat.id })],
      });
      expect(told()).toEqual(['cat1']);
    });

    it('is told however old the task is', async () => {
      await push('ann', {
        tasks: [groupTask({ id: T3, created_at: '2020-01-01T00:00:00Z' })],
      });
      expect(told()).toEqual([]);
      await push('ann', {
        tasks: [
          groupTask({
            id: T3,
            created_at: '2020-01-01T00:00:00Z',
            assignee_id: users.bob.id,
          }),
        ],
      });
      expect(told()).toEqual(['bob1', 'bob2']);
    });

    it('is silent when it goes back to everyone, or to the same person', async () => {
      await push('ann', {
        tasks: [groupTask({ id: T1, assignee_id: users.bob.id })],
      });
      fcm.sent = [];
      await push('ann', {
        tasks: [groupTask({ id: T1, assignee_id: users.bob.id })],
      });
      await push('ann', { tasks: [groupTask({ id: T1 })] });
      expect(told()).toEqual([]);
    });
  });

  describe('a task ticked', () => {
    beforeEach(async () => {
      await push('ann', {
        tasks: [
          groupTask({ id: T1 }),
          groupTask({ id: T2, assignee_id: users.bob.id }),
        ],
      });
      fcm.sent = [];
    });
    const tick = (who: string, taskId: string, completed = true, date = DAY) =>
      push(who, { logs: [{ task_id: taskId, date, completed }] });

    it('for everyone: all the others, the author too, not the one who ticked', async () => {
      await tick('bob', T1);
      expect(told()).toEqual(['ann1', 'cat1']);
      expect(lastMessage()).toEqual({
        title: 'Выполнено: Боб',
        body: 'Купить молоко · Дом',
        data: { group_id: G, task_id: T1 },
      });
    });

    it('for someone: only whoever handed it out', async () => {
      await tick('bob', T2);
      expect(told()).toEqual(['ann1']);
    });

    it('is not told again when the same tick is sent again', async () => {
      await tick('bob', T1);
      fcm.sent = [];
      await tick('bob', T1);
      expect(told()).toEqual([]);
    });

    it('is silent for a mark that is not completed, and for taking one back', async () => {
      await tick('bob', T1, false);
      await tick('bob', T1);
      fcm.sent = [];
      await tick('bob', T1, false);
      expect(told()).toEqual([]);
    });

    it('is told again when a taken-back mark is completed again', async () => {
      await tick('bob', T1);
      await tick('bob', T1, false);
      fcm.sent = [];
      await tick('bob', T1);
      expect(told()).toEqual(['ann1', 'cat1']);
    });

    it('each member who ticks is told about by the others', async () => {
      await tick('bob', T1);
      fcm.sent = [];
      await tick('cat', T1);
      expect(told()).toEqual(['ann1', 'bob1', 'bob2']);
      expect(lastMessage()?.title).toBe('Выполнено: Кот');
    });
  });

  describe('a push that is not news', () => {
    it.each([
      ['an empty request', {}],
      ['a personal task', { tasks: [{ id: T1, title: 'Моя' }] }],
      [
        'a personal mark',
        {
          tasks: [{ id: T1, title: 'Моя' }],
          logs: [{ task_id: T1, date: DAY, completed: true }],
        },
      ],
      [
        'a note, a tag and a cycle day',
        {
          tags: [{ id: id(40), name: 'Работа' }],
          entries: [{ id: id(41), title: 'День' }],
          cycle_days: [{ date: DAY, flow: 2 }],
        },
      ],
    ])(
      '%s tells nobody and does not even ask the database for phones',
      async (_n, body) => {
        const query = jest.spyOn(ds, 'query');
        await push('ann', body);
        expect(told()).toEqual([]);
        const lookups = query.mock.calls.filter(
          (call) =>
            call[2] === undefined && String(call[0]).includes('device_tokens'),
        );
        expect(lookups).toEqual([]);
      },
    );

    it('editing the text of a group task, or sending it again', async () => {
      await push('ann', { tasks: [groupTask({ id: T1 })] });
      fcm.sent = [];
      await push('ann', { tasks: [groupTask({ id: T1 })] });
      await push('ann', { tasks: [groupTask({ id: T1, title: 'Другое' })] });
      expect(told()).toEqual([]);
    });

    it('a task made and deleted by the same push', async () => {
      await push('ann', {
        tasks: [groupTask({ id: T1 })],
        deleted: [{ table: 'tasks', id: T1 }],
      });
      expect(told()).toEqual([]);
    });

    it('a mark on a task that the same push deletes', async () => {
      await push('ann', { tasks: [groupTask({ id: T1 })] });
      fcm.sent = [];
      await push('ann', {
        logs: [{ task_id: T1, date: DAY, completed: true }],
        deleted: [{ table: 'tasks', id: T1 }],
      });
      expect(told()).toEqual([]);
    });

    it('a mark beside a deletion that is refused is still told (the task is not gone)', async () => {
      await push('ann', { tasks: [groupTask({ id: T1 })] });
      fcm.sent = [];
      const res = await push('bob', {
        logs: [{ task_id: T1, date: DAY, completed: true }],
        deleted: [{ table: 'tasks', id: T1 }], // Bob is not its author
      });
      expect(res.rejected).toHaveLength(1);
      expect(told()).toEqual(['ann1', 'cat1']);
    });
  });

  describe('who is never told', () => {
    it('someone who left the group', async () => {
      await push('ann', { tasks: [groupTask({ id: T1 })] });
      await push('bob', {
        logs: [{ task_id: T1, date: DAY, completed: true }],
      });
      expect(told()).not.toContain('eve1');
    });

    it('someone who was removed, from then on', async () => {
      await api()
        .delete(`/groups/${G}/members/${users.cat.id}`)
        .set(as('ann'))
        .expect(204);
      await push('ann', { tasks: [groupTask({ id: T1 })] });
      expect(told()).toEqual(['bob1', 'bob2']);
    });

    it('anyone of a group that is gone', async () => {
      await api().delete(`/groups/${G}`).set(as('ann')).expect(204);
      await push('ann', { tasks: [groupTask({ id: T1 })] }); // refused: the group is gone
      expect(told()).toEqual([]);
    });

    it('an outsider who tries to put a task, a mark or a hand-over into the group', async () => {
      await push('ann', { tasks: [groupTask({ id: T1 })] });
      fcm.sent = [];
      const res = await push('dan', {
        tasks: [
          groupTask({ id: T3 }),
          groupTask({ id: T1, assignee_id: users.bob.id }),
        ],
        logs: [{ task_id: T1, date: DAY, completed: true }],
      });
      expect(res.rejected.length).toBeGreaterThan(0);
      expect(told()).toEqual([]);
    });

    it('a member who tries to hand over somebody else’s task (not the owner)', async () => {
      await push('ann', { tasks: [groupTask({ id: T1 })] });
      fcm.sent = [];
      const res = await push('bob', {
        tasks: [groupTask({ id: T1, assignee_id: users.cat.id })],
      });
      expect(res.rejected).toHaveLength(1);
      expect(told()).toEqual([]);
    });

    it('people of another group, whatever happens in this one', async () => {
      const other = await api()
        .post('/groups')
        .set(as('dan'))
        .send({ name: 'Чужая' })
        .expect(201);
      const H = (other.body as { id: string }).id;
      await push('dan', { tasks: [{ id: T4, group_id: H, title: 'Чужое' }] });
      expect(told()).toEqual([]); // Dan alone in H
      await push('ann', { tasks: [groupTask({ id: T1 })] });
      expect(told()).not.toContain('dan1');
    });
  });

  describe('the phones', () => {
    it('a phone that has changed hands is for its new owner only', async () => {
      await api()
        .put('/devices')
        .set(as('cat'))
        .send({ token: phone('bob', 2) })
        .expect(204);
      await push('ann', { tasks: [groupTask({ id: T1 })] });
      // bob2 now belongs to Cat: Cat is told on both her phones, Bob on his one.
      expect(told()).toEqual(['bob1', 'bob2', 'cat1']);
      await push('ann', {
        tasks: [groupTask({ id: T2, assignee_id: users.bob.id })],
      });
      expect(
        fcm.sent
          .filter((s) => s.message.data.task_id === T2)
          .map((s) => nameOf(s.token)),
      ).toEqual(['bob1']);
    });

    it('a phone that was signed out is not sent to', async () => {
      await api()
        .delete('/devices')
        .set(as('bob'))
        .send({ token: phone('bob', 2) })
        .expect(204);
      await push('ann', { tasks: [groupTask({ id: T1 })] });
      expect(told()).toEqual(['bob1', 'cat1']);
    });

    it('a member with no phone registered costs nothing', async () => {
      await ds.query(`delete from device_tokens where user_id = $1`, [
        users.cat.id,
      ]);
      await push('ann', { tasks: [groupTask({ id: T1 })] });
      expect(told()).toEqual(['bob1', 'bob2']);
    });
  });

  describe('a dead token', () => {
    const tokensLeft = async () =>
      (await ds.query<{ token: string }[]>(`select token from device_tokens`))
        .map((r) => nameOf(r.token))
        .sort();

    it('is deleted when FCM says it is gone, and the other phones stay and are told', async () => {
      fcm.outcomes.set(phone('bob', 1), 'unregistered');
      await push('ann', { tasks: [groupTask({ id: T1 })] });
      expect(told()).toEqual(['bob1', 'bob2', 'cat1']);
      expect(await tokensLeft()).toEqual([
        'ann1',
        'bob2',
        'cat1',
        'dan1',
        'eve1',
      ]);
    });

    it('stays when FCM fails for any other reason', async () => {
      fcm.outcomes.set(phone('bob', 1), 'failed');
      await push('ann', { tasks: [groupTask({ id: T1 })] });
      expect(await tokensLeft()).toEqual([
        'ann1',
        'bob1',
        'bob2',
        'cat1',
        'dan1',
        'eve1',
      ]);
    });

    it('a token that is gone is not sent to the next time', async () => {
      fcm.outcomes.set(phone('bob', 1), 'unregistered');
      await push('ann', { tasks: [groupTask({ id: T1 })] });
      fcm.sent = [];
      await push('ann', { tasks: [groupTask({ id: T2 })] });
      expect(told()).toEqual(['bob2', 'cat1']);
    });
  });

  describe('trouble never touches the write', () => {
    const saved = async (taskId: string) =>
      (await ds.query<unknown[]>(`select 1 from tasks where id = $1`, [taskId]))
        .length;

    it('FCM that is down: the push is saved and answered 200', async () => {
      fcm.fail = true;
      const res = await push('ann', { tasks: [groupTask({ id: T1 })] });
      expect(res.rejected).toEqual([]);
      expect(await saved(T1)).toBe(1);
    });

    it('a database that fails while the phones are looked up: the push is saved and answered 200', async () => {
      const real = ds.query.bind(ds);
      jest
        .spyOn(ds, 'query')
        .mockImplementation(((sql: string, ...rest: unknown[]) =>
          String(sql).includes('from device_tokens d')
            ? Promise.reject(new Error('database went away'))
            : (real as (...a: unknown[]) => unknown)(sql, ...rest)) as never);
      const res = await push('ann', { tasks: [groupTask({ id: T1 })] });
      expect(res.rejected).toEqual([]);
      expect(await saved(T1)).toBe(1);
      expect(told()).toEqual([]);
    });

    it('the answer does not wait for FCM', async () => {
      let release!: () => void;
      fcm.gate = new Promise((resolve) => (release = resolve));
      const res = await api()
        .post('/sync/push')
        .set(as('ann'))
        .send({ tasks: [groupTask({ id: T1 })] })
        .expect(200);
      expect(res.body).toHaveProperty('server_time');
      expect(told()).toEqual([]); // still waiting at Google's door
      release();
      await pushes.idle();
      expect(told()).toEqual(['bob1', 'bob2', 'cat1']);
    });

    it('a push that is rolled back tells nobody', async () => {
      jest
        .spyOn(app.get(CycleWriter), 'write')
        .mockRejectedValue(new Error('database went away'));
      await push(
        'ann',
        {
          tasks: [groupTask({ id: T1 })],
          cycle_days: [{ date: DAY, flow: 1 }],
        },
        500,
      );
      expect(told()).toEqual([]);
      expect(await saved(T1)).toBe(0);
    });

    it('without a Firebase key: nothing is sent and the database is not asked for phones', async () => {
      fcm.enabled = false;
      const query = jest.spyOn(ds, 'query');
      await push('ann', { tasks: [groupTask({ id: T1 })] });
      expect(told()).toEqual([]);
      expect(
        query.mock.calls.filter((call) =>
          String(call[0]).includes('device_tokens d'),
        ),
      ).toEqual([]);
      expect(await saved(T1)).toBe(1);
    });
  });

  describe('a flood', () => {
    it('is cut at 10 notifications a phone for one push, the first ones win', async () => {
      const tasks = Array.from({ length: 15 }, (_, i) =>
        groupTask({ id: id(100 + i), title: `задача ${i}` }),
      );
      await push('ann', { tasks });
      for (const phoneName of ['bob1', 'bob2', 'cat1']) {
        const mine = fcm.sent.filter((s) => nameOf(s.token) === phoneName);
        expect(mine).toHaveLength(10);
      }
      expect(
        fcm.sent.every(
          (s) => !['ann1', 'dan1', 'eve1'].includes(nameOf(s.token)),
        ),
      ).toBe(true);
    });
  });

  it('a task made and ticked in the same push: both are told', async () => {
    await push('bob', {
      tasks: [groupTask({ id: T1 })],
      logs: [{ task_id: T1, date: DAY, completed: true }],
    });
    const titles = fcm.sent
      .filter((s) => nameOf(s.token) === 'ann1')
      .map((s) => s.message.title);
    expect(titles.sort()).toEqual([
      'Выполнено: Боб',
      'Новая задача для всех от Боб',
    ]);
  });
});
