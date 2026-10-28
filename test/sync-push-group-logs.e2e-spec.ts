import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import * as planModule from '../src/sync/plan-log-writes';
import { createTestApp, truncateAll } from './support/db';

type Row = Record<string, unknown>;
interface Session {
  token: string;
  id: string;
}
interface Rejected {
  table: string;
  id: string | null;
  reason: string;
}

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [T1, T2, T3, T4, T5, T6] = [1, 2, 3, 4, 5, 6].map(id);
const DAY = '2026-01-15';

describe('POST /sync/push: marks on tasks of a group', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ann: Session; // owner of G
  let bob: Session; // member
  let cat: Session; // member
  let dan: Session; // not in G
  let eve: Session; // left G
  let G: string;
  const api = () => request(app.getHttpServer());

  async function signUp(email: string): Promise<Session> {
    const res = await api()
      .post('/auth/register')
      .send({ email, password: 'correct horse' })
      .expect(201);
    const body = res.body as { accessToken: string; user: { id: string } };
    return { token: body.accessToken, id: body.user.id };
  }
  const as = (who: Session) => ({ Authorization: `Bearer ${who.token}` });
  const push = async (who: Session, body: object) => {
    const res = await api()
      .post('/sync/push')
      .set(as(who))
      .send(body)
      .expect(200);
    return res.body as { rejected: Rejected[] };
  };
  const mark = (who: Session, taskId: string, extra: Row = {}, date = DAY) =>
    push(who, { logs: [{ task_id: taskId, date, completed: true, ...extra }] });
  const reasons = (r: { rejected: Rejected[] }) =>
    r.rejected.map((x) => `${x.table}:${x.id}:${x.reason}`).sort();
  const marks = async (taskId?: string): Promise<Row[]> =>
    ds.query(
      `select task_id, user_id, date::text as day, completed, value
       from task_logs ${taskId ? 'where task_id = $1' : ''} order by task_id, user_id, date`,
      taskId ? [taskId] : [],
    );
  const who = (rows: Row[]) => rows.map((r) => r.user_id).sort();

  beforeAll(async () => {
    app = await createTestApp();
    app.getHttpServer().setMaxListeners(100);
    ds = app.get(DataSource);
  });

  beforeEach(async () => {
    await truncateAll(ds);
    ann = await signUp('ann@example.com');
    bob = await signUp('bob@example.com');
    cat = await signUp('cat@example.com');
    dan = await signUp('dan@example.com');
    eve = await signUp('eve@example.com');
    const res = await api()
      .post('/groups')
      .set(as(ann))
      .send({ name: 'g' })
      .expect(201);
    G = res.body.id;
    await ds.query(`update group_invites set code = '111111'`);
    for (const m of [bob, cat, eve]) {
      await api()
        .post('/groups/join')
        .set(as(m))
        .send({ code: '111111' })
        .expect(200);
    }
    await api().post(`/groups/${G}/leave`).set(as(eve)).expect(204);
    // T1 for everyone, T2 for Bob, T3 for Cat (all by Ann), T4 Bob's personal task.
    await push(ann, {
      tasks: [
        { id: T1, group_id: G, title: 'for all' },
        { id: T2, group_id: G, title: 'for Bob', assignee_id: bob.id },
        { id: T3, group_id: G, title: 'for Cat', assignee_id: cat.id },
      ],
    });
    await push(bob, { tasks: [{ id: T4, title: 'Bob personal' }] });
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(() => app.close());

  describe('a task for everyone', () => {
    it('takes a mark from each member, the author and the owner alike, one per person', async () => {
      for (const m of [ann, bob, cat]) {
        expect((await mark(m, T1)).rejected).toEqual([]);
      }
      expect(who(await marks(T1))).toEqual([ann.id, bob.id, cat.id].sort());
    });

    it('keeps each person’s mark to themselves: a new version replaces only their own', async () => {
      await mark(bob, T1, { value: 1 });
      await mark(cat, T1, { value: 2 });
      await mark(bob, T1, { value: 10, completed: false });
      const rows = await marks(T1);
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.user_id === bob.id)).toMatchObject({
        value: 10,
        completed: false,
      });
      expect(rows.find((r) => r.user_id === cat.id)).toMatchObject({
        value: 2,
        completed: true,
      });
    });

    it('stores a mark under the token’s user, whatever user_id the row names', async () => {
      await mark(bob, T1, { user_id: cat.id });
      expect(who(await marks(T1))).toEqual([bob.id]);
    });

    it('keeps the marks of one person on different days apart', async () => {
      await mark(bob, T1, {}, '2026-01-15');
      await mark(bob, T1, {}, '2026-01-16');
      expect(await marks(T1)).toHaveLength(2);
    });

    it('shows the others a member’s mark at their next pull, with who made it', async () => {
      await mark(bob, T1, { value: 7 });
      const res = await api().get('/sync/pull').set(as(cat)).expect(200);
      const logs = res.body.logs as Row[];
      expect(logs).toEqual([
        expect.objectContaining({ task_id: T1, user_id: bob.id, value: 7 }),
      ]);
    });

    it('takes a mark on a group task written in the same request', async () => {
      const res = await push(cat, {
        tasks: [{ id: T5, group_id: G, title: 'new' }],
        logs: [{ task_id: T5, date: DAY, completed: true }],
      });
      expect(res.rejected).toEqual([]);
      expect(who(await marks(T5))).toEqual([cat.id]);
    });
  });

  describe('a task for someone', () => {
    it('takes the mark of the one it is for', async () => {
      expect((await mark(bob, T2)).rejected).toEqual([]);
      expect(who(await marks(T2))).toEqual([bob.id]);
    });

    it.each([
      ['the owner', () => ann],
      ['another member', () => cat],
    ])('refuses %s: not_allowed, and stores nothing', async (_n, pick) => {
      const res = await mark(pick(), T2);
      expect(res.rejected).toEqual([
        { table: 'task_logs', id: T2, reason: 'not_allowed' },
      ]);
      expect(await marks(T2)).toEqual([]);
    });

    it('refuses the author too when it is for someone else', async () => {
      await push(cat, {
        tasks: [{ id: T6, group_id: G, assignee_id: bob.id }],
      });
      expect(reasons(await mark(cat, T6))).toEqual([
        `task_logs:${T6}:not_allowed`,
      ]);
    });

    it('follows a change of the assignee: the new one can, the old one cannot, the old mark stays', async () => {
      await mark(bob, T2);
      await push(ann, {
        tasks: [{ id: T2, group_id: G, assignee_id: cat.id }],
      });
      expect(reasons(await mark(bob, T2, {}, '2026-01-16'))).toEqual([
        `task_logs:${T2}:not_allowed`,
      ]);
      expect((await mark(cat, T2)).rejected).toEqual([]);
      expect(who(await marks(T2))).toEqual([bob.id, cat.id].sort());
      expect(await marks(T2)).toHaveLength(2);
    });

    it('is open to everyone again when the assignee leaves', async () => {
      await api().post(`/groups/${G}/leave`).set(as(bob)).expect(204);
      expect((await mark(cat, T2)).rejected).toEqual([]);
    });
  });

  describe('someone who is not allowed in the group', () => {
    it('is told unknown_task, as for a task that does not exist, and stores nothing', async () => {
      const real = await mark(dan, T1);
      const missing = await mark(dan, id(77));
      expect(real.rejected).toEqual([
        { table: 'task_logs', id: T1, reason: 'unknown_task' },
      ]);
      expect(missing.rejected).toEqual([
        { table: 'task_logs', id: id(77), reason: 'unknown_task' },
      ]);
      expect(await marks()).toEqual([]);
    });

    it('is told unknown_task, never not_allowed, for a task that is for someone', async () => {
      expect(reasons(await mark(dan, T2))).toEqual([
        `task_logs:${T2}:unknown_task`,
      ]);
    });

    it('includes a member who has left, whose old marks stay', async () => {
      await mark(bob, T1);
      await api().post(`/groups/${G}/leave`).set(as(bob)).expect(204);
      expect(reasons(await mark(bob, T1, {}, '2026-01-16'))).toEqual([
        `task_logs:${T1}:unknown_task`,
      ]);
      expect(await marks(T1)).toHaveLength(1);
    });

    it('includes someone who never joined, though they were once a member of another group', async () => {
      expect(reasons(await mark(eve, T1))).toEqual([
        `task_logs:${T1}:unknown_task`,
      ]);
    });

    it('is let in again by joining', async () => {
      await api()
        .post('/groups/join')
        .set(as(eve))
        .send({ code: '111111' })
        .expect(200);
      expect((await mark(eve, T1)).rejected).toEqual([]);
    });

    it('cannot mark any task of a group that was deleted', async () => {
      await api().delete(`/groups/${G}`).set(as(ann)).expect(204);
      for (const m of [ann, bob]) {
        expect(reasons(await mark(m, T1))).toEqual([
          `task_logs:${T1}:unknown_task`,
        ]);
      }
    });
  });

  describe('a deleted task of a group', () => {
    it('drops a member’s mark without an error', async () => {
      await push(ann, { deleted: [{ table: 'tasks', id: T1 }] });
      expect((await mark(bob, T1)).rejected).toEqual([]);
      expect(await marks(T1)).toEqual([]);
    });

    it('still turns an outsider away', async () => {
      await push(ann, { deleted: [{ table: 'tasks', id: T1 }] });
      expect(reasons(await mark(dan, T1))).toEqual([
        `task_logs:${T1}:unknown_task`,
      ]);
    });
  });

  describe('a personal task', () => {
    it('takes the owner’s mark', async () => {
      expect((await mark(bob, T4)).rejected).toEqual([]);
      expect(who(await marks(T4))).toEqual([bob.id]);
    });

    it('refuses even a fellow member of a group: unknown_task', async () => {
      expect(reasons(await mark(cat, T4))).toEqual([
        `task_logs:${T4}:unknown_task`,
      ]);
      expect(reasons(await mark(ann, T4))).toEqual([
        `task_logs:${T4}:unknown_task`,
      ]);
      expect(await marks(T4)).toEqual([]);
    });
  });

  describe('a whole request', () => {
    it('writes the good marks and reports every refusal, each by its task', async () => {
      const res = await push(bob, {
        logs: [
          { task_id: T1, date: DAY, completed: true }, // fine
          { task_id: T2, date: DAY, completed: true }, // fine: for Bob
          { task_id: T3, date: DAY, completed: true }, // for Cat
          { task_id: T4, date: DAY, completed: true }, // his own
          { task_id: id(88), date: DAY, completed: true }, // nowhere
          { task_id: T1, date: '2026-02-30' }, // not a day
        ],
      });
      expect(reasons(res)).toEqual(
        [
          `task_logs:${T3}:not_allowed`,
          `task_logs:${id(88)}:unknown_task`,
          `task_logs:${T1}:invalid_row`,
        ].sort(),
      );
      expect((await marks()).map((r) => r.task_id).sort()).toEqual(
        [T1, T2, T4].sort(),
      );
    });

    it('takes 500 marks of a member in one request', async () => {
      const logs = Array.from({ length: 500 }, (_, i) => ({
        task_id: T1,
        date: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10),
        completed: true,
      }));
      const res = await push(cat, { logs });
      expect(res.rejected).toEqual([]);
      expect(await marks(T1)).toHaveLength(500);
    });

    it('is idempotent: the same request twice leaves the same marks', async () => {
      const body = {
        logs: [{ task_id: T1, date: DAY, completed: true, value: 3 }],
      };
      await push(bob, body);
      const first = await marks();
      await push(bob, body);
      expect(await marks()).toEqual(first);
    });
  });

  describe('the last line, in the SQL: a fooled check stores nothing it should not', () => {
    beforeEach(() => {
      jest
        .spyOn(planModule, 'planLogWrites')
        .mockImplementation((rows) => ({ write: rows, rejected: [] }));
    });

    it('an outsider, a member who left and a stranger to a personal task store nothing', async () => {
      await mark(dan, T1);
      await mark(eve, T1);
      await mark(cat, T4);
      expect(await marks()).toEqual([]);
    });

    it('a task for someone stores nothing for anyone else', async () => {
      await mark(ann, T2);
      await mark(cat, T2);
      expect(await marks()).toEqual([]);
    });

    it('the ones who may are still stored', async () => {
      await mark(bob, T2);
      await mark(cat, T1);
      await mark(bob, T4);
      expect(
        (await marks())
          .map((r) => `${r.task_id as string}|${r.user_id as string}`)
          .sort(),
      ).toEqual(
        [`${T2}|${bob.id}`, `${T1}|${cat.id}`, `${T4}|${bob.id}`].sort(),
      );
    });

    it('the query alone holds the rule, without the trigger of the database behind it', async () => {
      await ds.query(
        `alter table task_logs disable trigger task_logs_skip_unmarkable`,
      );
      try {
        await push(ann, {
          deleted: [
            { table: 'tasks', id: T5 },
            { table: 'tasks', id: T1 },
          ],
        });
        await mark(dan, T2);
        await mark(eve, T2);
        await mark(cat, T2); // for Bob
        await mark(ann, T4); // Bob's personal task
        await mark(bob, T1); // deleted
        expect(await marks()).toEqual([]);
        await mark(bob, T2);
        expect(who(await marks())).toEqual([bob.id]);
      } finally {
        await ds.query(
          `alter table task_logs enable trigger task_logs_skip_unmarkable`,
        );
      }
    });

    it('a deleted task stores nothing', async () => {
      await push(ann, { deleted: [{ table: 'tasks', id: T1 }] });
      await mark(bob, T1);
      expect(await marks()).toEqual([]);
    });
  });
});
