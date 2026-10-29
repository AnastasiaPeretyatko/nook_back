import { INestApplication } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { PushEvent } from '../src/push/plan-push';
import { LogWriter } from '../src/sync/log-writer';
import { LogRow, parseLog, parseTask, TaskRow } from '../src/sync/push-rows';
import { TaskWriter } from '../src/sync/task-writer';
import { createTestApp, truncateAll } from './support/db';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [T1, T2, T3, T4] = [1, 2, 3, 4].map(id);
const DAY = '2026-01-15';

const task = (fields: Record<string, unknown>): TaskRow => {
  const result = parseTask(fields);
  if (!('row' in result)) throw new Error('bad test row');
  return result.row;
};
const log = (taskId: string, fields: Record<string, unknown> = {}): LogRow => {
  const result = parseLog({
    task_id: taskId,
    date: DAY,
    completed: true,
    ...fields,
  });
  if (!('row' in result)) throw new Error('bad test row');
  return result.row;
};

// What the writers say happened, for push notifications (B7.6): "created", "assigned", "done".
describe('The events the task and mark writers report', () => {
  let app: INestApplication;
  let ds: DataSource;
  let tasks: TaskWriter;
  let logs: LogWriter;
  let ann: string; // owner of G
  let bob: string; // member
  let cat: string; // member
  let dan: string; // not in G
  let G: string;
  let H: string; // another group, Dan's

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
    tasks = app.get(TaskWriter);
    logs = app.get(LogWriter);
  });

  beforeEach(async () => {
    await truncateAll(ds);
    [ann, bob, cat, dan] = await Promise.all(
      ['ann', 'bob', 'cat', 'dan'].map(addUser),
    );
    G = await addGroup(ann, [bob, cat]);
    H = await addGroup(dan, []);
  });

  afterAll(() => app.close());

  async function addUser(name: string) {
    const [row] = await ds.query(
      `insert into users (email, password_hash) values ($1, 'hash') returning id`,
      [`${name}@example.com`],
    );
    return row.id as string;
  }
  async function addGroup(owner: string, members: string[]) {
    const [{ id: group }] = await ds.query(
      `insert into groups (name, owner_id) values ('Дом', $1) returning id`,
      [owner],
    );
    for (const [user, role] of [
      [owner, 'owner'],
      ...members.map((m) => [m, 'member']),
    ]) {
      await ds.query(
        `insert into group_members (group_id, user_id, role) values ($1, $2, $3)`,
        [group, user, role],
      );
    }
    return group as string;
  }

  // One push transaction; returns what the writers said happened, in order.
  const writeTasks = async (userId: string, rows: TaskRow[]) => {
    const events: PushEvent[] = [];
    const rejected = await ds.transaction((m) =>
      tasks.write(m, userId, rows, events),
    );
    return { events, rejected };
  };
  const writeLogs = async (userId: string, rows: LogRow[]) => {
    const events: PushEvent[] = [];
    const rejected = await ds.transaction((m) =>
      logs.write(m, userId, rows, events),
    );
    return { events, rejected };
  };
  const groupTask = (fields: Record<string, unknown>) =>
    task({ group_id: G, title: 'Купить молоко', ...fields });
  const kinds = (events: PushEvent[]) =>
    events.map((e) => `${e.kind}:${e.task.id}`).sort();

  describe('a task is created', () => {
    it('is "created", with the task as it is stored', async () => {
      const { events } = await writeTasks(ann, [
        groupTask({ id: T1, created_at: '2026-01-10T08:30:00Z' }),
      ]);
      expect(events).toEqual([
        {
          kind: 'created',
          task: {
            id: T1,
            groupId: G,
            title: 'Купить молоко',
            authorId: ann,
            assigneeId: null,
            parentId: null,
            status: 'active',
            deleted: false,
            createdAt: Date.parse('2026-01-10T08:30:00Z'),
          },
        },
      ]);
    });

    it('carries who it is for', async () => {
      const { events } = await writeTasks(ann, [
        groupTask({ id: T1, assignee_id: bob }),
      ]);
      expect(events).toHaveLength(1);
      expect(events[0].task.assigneeId).toBe(bob);
    });

    it('is told for a member who is not the author too', async () => {
      const { events } = await writeTasks(bob, [groupTask({ id: T1 })]);
      expect(events.map((e) => [e.kind, e.task.authorId])).toEqual([
        ['created', bob],
      ]);
    });

    it('is one event for each of many tasks, personal ones excluded', async () => {
      const { events } = await writeTasks(ann, [
        groupTask({ id: T1 }),
        groupTask({ id: T2, assignee_id: cat }),
        task({ id: T3, title: 'Личная' }),
        groupTask({ id: T4 }),
      ]);
      expect(kinds(events)).toEqual([
        `created:${T1}`,
        `created:${T2}`,
        `created:${T4}`,
      ]);
    });

    it('says "for everyone" when the assignee named is not in the group (the database drops it)', async () => {
      const { events } = await writeTasks(ann, [
        groupTask({ id: T1, assignee_id: dan }),
      ]);
      expect(events.map((e) => e.task.assigneeId)).toEqual([null]);
    });
  });

  describe('nothing is said when nothing is news', () => {
    it('about a personal task: new, edited, handed on', async () => {
      const first = await writeTasks(ann, [task({ id: T1, title: 'Мне' })]);
      const second = await writeTasks(ann, [
        task({ id: T1, title: 'Мне ещё' }),
      ]);
      expect(first.events).toEqual([]);
      expect(second.events).toEqual([]);
    });

    it('when the same task is sent again', async () => {
      await writeTasks(ann, [groupTask({ id: T1, assignee_id: bob })]);
      const { events } = await writeTasks(ann, [
        groupTask({ id: T1, assignee_id: bob }),
      ]);
      expect(events).toEqual([]);
    });

    it('when only the text is edited', async () => {
      await writeTasks(ann, [groupTask({ id: T1, assignee_id: bob })]);
      const { events } = await writeTasks(ann, [
        groupTask({
          id: T1,
          assignee_id: bob,
          title: 'Другое',
          status: 'archived',
        }),
      ]);
      expect(events).toEqual([]);
    });

    it('about a task of a group the writer is not in: refused, nothing said', async () => {
      const { events, rejected } = await writeTasks(dan, [
        groupTask({ id: T1 }),
      ]);
      expect(rejected).toHaveLength(1);
      expect(events).toEqual([]);
    });

    it('about someone else’s task that a stranger tries to overwrite', async () => {
      await writeTasks(ann, [groupTask({ id: T1 })]);
      const { events, rejected } = await writeTasks(dan, [
        groupTask({ id: T1, assignee_id: bob }),
      ]);
      expect(rejected).toHaveLength(1);
      expect(events).toEqual([]);
    });

    it('about a member who is not the author trying to hand a task on (refused)', async () => {
      await writeTasks(ann, [groupTask({ id: T1 })]);
      const { events, rejected } = await writeTasks(bob, [
        groupTask({ id: T1, assignee_id: cat }),
      ]);
      expect(rejected).toHaveLength(1);
      expect(events).toEqual([]);
    });

    it('about a deleted task that is sent again (it stays deleted)', async () => {
      await writeTasks(ann, [groupTask({ id: T1 })]);
      await ds.query(`update tasks set deleted_at = now() where id = $1`, [T1]);
      const { events } = await writeTasks(ann, [
        groupTask({ id: T1, assignee_id: bob }),
      ]);
      expect(events).toEqual([]);
    });
  });

  describe('a task is handed to someone', () => {
    it.each([
      ['nobody to bob', null, 'bob'],
      ['bob to cat', 'bob', 'cat'],
    ])('%s is "assigned" to the new one', async (_name, from, to) => {
      const who = { bob, cat } as Record<string, string>;
      await writeTasks(ann, [
        groupTask({ id: T1, assignee_id: from ? who[from] : undefined }),
      ]);
      const { events } = await writeTasks(ann, [
        groupTask({ id: T1, assignee_id: who[to] }),
      ]);
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('assigned');
      expect(events[0].task).toMatchObject({
        id: T1,
        authorId: ann,
        assigneeId: who[to],
      });
    });

    it('is told by the owner for a task of another author, with that author named', async () => {
      await writeTasks(bob, [groupTask({ id: T1 })]);
      const { events } = await writeTasks(ann, [
        groupTask({ id: T1, assignee_id: cat }),
      ]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'assigned',
        task: { authorId: bob, assigneeId: cat },
      });
    });

    it.each([
      ['for everyone again', 'bob', undefined],
      [
        'for someone who is not in the group (the database drops it)',
        'bob',
        'dan',
      ],
    ])('is silent when it becomes %s', async (_name, from, to) => {
      const who = { bob, dan } as Record<string, string>;
      await writeTasks(ann, [groupTask({ id: T1, assignee_id: who[from] })]);
      const { events } = await writeTasks(ann, [
        groupTask({ id: T1, assignee_id: to ? who[to] : undefined }),
      ]);
      expect(events).toEqual([]);
    });

    it('hands on a task that was for everyone once it is old, too', async () => {
      await writeTasks(ann, [
        groupTask({ id: T1, created_at: '2020-01-01T00:00:00Z' }),
      ]);
      const { events } = await writeTasks(ann, [
        groupTask({
          id: T1,
          created_at: '2020-01-01T00:00:00Z',
          assignee_id: bob,
        }),
      ]);
      expect(events.map((e) => e.kind)).toEqual(['assigned']);
    });

    it('is "created" and not also "assigned" when a task is made already for someone', async () => {
      const { events } = await writeTasks(ann, [
        groupTask({ id: T1, assignee_id: bob }),
      ]);
      expect(events.map((e) => e.kind)).toEqual(['created']);
    });

    it('is told for each of several in one batch', async () => {
      await writeTasks(ann, [groupTask({ id: T1 }), groupTask({ id: T2 })]);
      const { events } = await writeTasks(ann, [
        groupTask({ id: T1, assignee_id: bob }),
        groupTask({ id: T2, assignee_id: cat }),
        groupTask({ id: T3 }),
      ]);
      expect(kinds(events)).toEqual([
        `assigned:${T1}`,
        `assigned:${T2}`,
        `created:${T3}`,
      ]);
    });
  });

  describe('a mark is made', () => {
    beforeEach(() =>
      writeTasks(ann, [
        groupTask({ id: T1 }),
        groupTask({ id: T2, assignee_id: bob }),
      ]),
    );

    it('is "done" when a mark becomes completed, with who did it and the task as stored', async () => {
      const { events } = await writeLogs(bob, [log(T1)]);
      expect(events).toEqual([
        {
          kind: 'done',
          doneBy: bob,
          task: expect.objectContaining({
            id: T1,
            groupId: G,
            title: 'Купить молоко',
            authorId: ann,
            assigneeId: null,
            deleted: false,
          }),
        },
      ]);
    });

    it('carries who the task is for', async () => {
      const { events } = await writeLogs(bob, [log(T2)]);
      expect(events[0].task.assigneeId).toBe(bob);
    });

    it('is said once for each member who ticks, as they each tick', async () => {
      const first = await writeLogs(bob, [log(T1)]);
      const second = await writeLogs(cat, [log(T1)]);
      expect(first.events.map((e) => e.kind === 'done' && e.doneBy)).toEqual([
        bob,
      ]);
      expect(second.events.map((e) => e.kind === 'done' && e.doneBy)).toEqual([
        cat,
      ]);
    });

    it('is not said again when the same completed mark is sent again', async () => {
      await writeLogs(bob, [log(T1)]);
      const { events } = await writeLogs(bob, [log(T1)]);
      expect(events).toEqual([]);
    });

    it('is not said for a mark that is not completed, nor for taking one back', async () => {
      const open = await writeLogs(bob, [log(T1, { completed: false })]);
      await writeLogs(bob, [log(T1)]);
      const back = await writeLogs(bob, [log(T1, { completed: false })]);
      const stillOpen = await writeLogs(bob, [log(T1, { completed: false })]);
      expect(open.events).toEqual([]);
      expect(back.events).toEqual([]);
      expect(stillOpen.events).toEqual([]);
    });

    it('is said when a mark that was open is completed later', async () => {
      await writeLogs(bob, [log(T1, { completed: false })]);
      const { events } = await writeLogs(bob, [log(T1)]);
      expect(events.map((e) => e.kind)).toEqual(['done']);
    });

    it('is said again when a mark taken back is completed again', async () => {
      await writeLogs(bob, [log(T1)]);
      await writeLogs(bob, [log(T1, { completed: false })]);
      const { events } = await writeLogs(bob, [log(T1)]);
      expect(events.map((e) => e.kind)).toEqual(['done']);
    });

    it('is said for a mark on a new day even when an earlier day was already ticked', async () => {
      await writeLogs(bob, [log(T1, { date: '2026-01-15' })]);
      const { events } = await writeLogs(bob, [
        log(T1, { date: '2026-01-16' }),
      ]);
      expect(events.map((e) => e.kind)).toEqual(['done']);
    });

    it('is not said for a day that was already ticked, whatever other days hold', async () => {
      await writeLogs(bob, [
        log(T1, { date: '2026-01-15' }),
        log(T1, { date: '2026-01-16', completed: false }),
      ]);
      const { events } = await writeLogs(bob, [
        log(T1, { date: '2026-01-15' }),
      ]);
      expect(events).toEqual([]);
    });

    it('is said once for a task ticked on several days in one batch', async () => {
      const { events } = await writeLogs(bob, [
        log(T1, { date: '2026-01-15' }),
        log(T1, { date: '2026-01-16' }),
      ]);
      expect(events).toHaveLength(1);
    });

    it('is said for each of several tasks', async () => {
      const { events } = await writeLogs(bob, [log(T1), log(T2)]);
      expect(kinds(events)).toEqual([`done:${T1}`, `done:${T2}`]);
    });

    it('is not said for a personal task', async () => {
      await writeTasks(bob, [task({ id: T3, title: 'Моя' })]);
      const { events } = await writeLogs(bob, [log(T3)]);
      expect(events).toEqual([]);
    });

    it('is not said when the mark is refused: a stranger, or not the one the task is for', async () => {
      const stranger = await writeLogs(dan, [log(T1)]);
      const notForCat = await writeLogs(cat, [log(T2)]);
      expect(stranger.rejected).toHaveLength(1);
      expect(notForCat.rejected).toHaveLength(1);
      expect(stranger.events).toEqual([]);
      expect(notForCat.events).toEqual([]);
    });

    it('is not said for a deleted task (the mark is dropped quietly)', async () => {
      await ds.query(`update tasks set deleted_at = now() where id = $1`, [T1]);
      const { events } = await writeLogs(bob, [log(T1)]);
      expect(events).toEqual([]);
    });

    it('is said for a task made in the same push', async () => {
      const events: PushEvent[] = [];
      await ds.transaction(async (m: EntityManager) => {
        await tasks.write(m, bob, [groupTask({ id: T3 })], events);
        await logs.write(m, bob, [log(T3)], events);
      });
      expect(events.map((e) => e.kind)).toEqual(['created', 'done']);
    });
  });

  describe('the events are optional and cost no extra queries', () => {
    const counted = async (run: (m: EntityManager) => Promise<unknown>) => {
      let queries = 0;
      await ds.transaction(async (manager) => {
        const counting = Object.create(manager) as EntityManager;
        counting.query = ((sql: string, params?: unknown[]) => {
          queries += 1;
          return manager.query(sql, params);
        }) as EntityManager['query'];
        await run(counting);
      });
      return queries;
    };

    it('the task writer: two queries for personal tasks, three with groups, with or without a collector', async () => {
      const personal = [task({ id: T1 }), task({ id: T2 }), task({ id: T3 })];
      expect(await counted((m) => tasks.write(m, ann, personal))).toBe(2);
      expect(await counted((m) => tasks.write(m, ann, personal, []))).toBe(2);
      const grouped = [groupTask({ id: T4 }), groupTask({ id: id(5) })];
      expect(await counted((m) => tasks.write(m, ann, grouped, []))).toBe(3);
    });

    it('the mark writer: two queries however many marks', async () => {
      await writeTasks(ann, [groupTask({ id: T1 }), groupTask({ id: T2 })]);
      const marks = [log(T1), log(T2), log(T1, { date: '2026-01-16' })];
      expect(await counted((m) => logs.write(m, bob, marks, []))).toBe(2);
      expect(await counted((m) => logs.write(m, bob, marks))).toBe(2);
    });
  });

  it('keeps events of other groups apart', async () => {
    const { events } = await writeTasks(dan, [
      task({ id: T1, title: 'В другой', group_id: H }),
    ]);
    expect(events.map((e) => e.task.groupId)).toEqual([H]);
  });
});
