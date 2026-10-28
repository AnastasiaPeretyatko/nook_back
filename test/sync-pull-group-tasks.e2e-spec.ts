import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp, truncateAll } from './support/db';

type Row = Record<string, unknown>;
interface PullResponse {
  next: string | null;
  has_more: boolean;
  tasks: Row[];
  logs: Row[];
}
interface Session {
  token: string;
  id: string;
}

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [T1, T2, T3, T4, T5, T6] = [1, 2, 3, 4, 5, 6].map(id);
const early = (n: number) =>
  `2026-03-01T10:00:${String(n).padStart(2, '0')}.000000Z`;
const second = (n: number) =>
  `2030-03-01T10:00:${String(n).padStart(2, '0')}.000000Z`;

describe('GET /sync/pull: group tasks and the marks of all members', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ann: Session; // owner of `group`
  let bob: Session; // a member
  let cat: Session; // a member of `other` only
  let dan: Session; // a stranger
  let group: string;
  let other: string;
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
  const pull = async (who: Session, query = '') => {
    const res = await api().get(`/sync/pull${query}`).set(as(who)).expect(200);
    return res.body as PullResponse;
  };
  const newGroup = async (owner: Session, code: string) => {
    const res = await api()
      .post('/groups')
      .set(as(owner))
      .send({ name: 'g' })
      .expect(201);
    await ds.query(`update group_invites set code = $2 where group_id = $1`, [
      res.body.id,
      code,
    ]);
    return res.body.id as string;
  };
  const join = (who: Session, code: string) =>
    api().post('/groups/join').set(as(who)).send({ code }).expect(200);
  const addTask = (
    taskId: string,
    author: Session,
    g: string | null,
    fields: Record<string, unknown> = {},
  ) => {
    const cols = ['id', 'user_id', 'group_id', ...Object.keys(fields)];
    const params = [taskId, author.id, g, ...Object.values(fields)];
    return ds.query(
      `insert into tasks (${cols.join(', ')}) values (${params.map((_, i) => `$${i + 1}`).join(', ')})`,
      params,
    );
  };
  const addLog = (taskId: string, who: Session, date = '2026-01-15') =>
    ds.query(
      `insert into task_logs (task_id, user_id, date, completed) values ($1, $2, $3, true)`,
      [taskId, who.id, date],
    );
  const ids = (rows: Row[]) => rows.map((r) => r.id).sort();
  const marks = (rows: Row[]) =>
    rows
      .map(
        (r) =>
          `${r.task_id as string}|${r.user_id as string}|${r.date as string}`,
      )
      .sort();
  const stamp = async (
    table: string,
    key: string,
    value: string,
    at: string,
  ) => {
    await ds.query(`alter table ${table} disable trigger ${table}_updated_at`);
    try {
      await ds.query(`update ${table} set updated_at = $1 where ${key} = $2`, [
        at,
        value,
      ]);
    } finally {
      await ds.query(`alter table ${table} enable trigger ${table}_updated_at`);
    }
  };

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
    group = await newGroup(ann, '111111');
    await join(bob, '111111');
    other = await newGroup(cat, '222222');
  });

  afterAll(() => app.close());

  describe('the tasks', () => {
    it('shows a member the tasks of the group written by anyone, and their own personal ones', async () => {
      await addTask(T1, ann, group, { title: 'by Ann' });
      await addTask(T2, bob, group, { title: 'by Bob' });
      await addTask(T3, bob, null, { title: 'Bob personal' });
      await addTask(T4, ann, null, { title: 'Ann personal' });
      expect(ids((await pull(bob)).tasks)).toEqual([T1, T2, T3].sort());
      expect(ids((await pull(ann)).tasks)).toEqual([T1, T2, T4].sort());
    });

    it('gives the author in user_id, and the group and the assignee as they are', async () => {
      await addTask(T1, ann, group, { title: 'x', assignee_id: bob.id });
      await addTask(T2, ann, group, { title: 'for all' });
      await addTask(T3, bob, null);
      const tasks = (await pull(bob)).tasks;
      const by = (t: string) => tasks.find((r) => r.id === t)!;
      expect(by(T1)).toMatchObject({
        user_id: ann.id,
        group_id: group,
        assignee_id: bob.id,
      });
      expect(by(T2)).toMatchObject({
        user_id: ann.id,
        group_id: group,
        assignee_id: null,
      });
      expect(by(T3)).toMatchObject({
        user_id: bob.id,
        group_id: null,
        assignee_id: null,
      });
    });

    it('keeps the group’s tasks from a stranger and from members of another group', async () => {
      await addTask(T1, ann, group, { title: 'private to the group' });
      await addTask(T2, cat, other, { title: 'other group' });
      for (const [who, expected] of [
        [dan, []],
        [cat, [T2]],
      ] as const) {
        const res = await pull(who, '?since=');
        expect(ids(res.tasks)).toEqual([...expected]);
        expect(JSON.stringify(res)).not.toContain('private to the group');
      }
      expect(ids((await pull(bob)).tasks)).toEqual([T1]);
    });

    it('shows nothing of the group to someone who has left, the tasks they wrote included', async () => {
      await addTask(T1, ann, group);
      await addTask(T2, bob, group);
      await addTask(T3, bob, null);
      await api().post(`/groups/${group}/leave`).set(as(bob)).expect(204);
      expect(ids((await pull(bob)).tasks)).toEqual([T3]);
    });

    it('shows nothing of the group to someone who was removed', async () => {
      await addTask(T1, ann, group);
      await api()
        .delete(`/groups/${group}/members/${bob.id}`)
        .set(as(ann))
        .expect(204);
      expect((await pull(bob)).tasks).toEqual([]);
    });

    it('stops showing the group’s tasks to everyone once the group is deleted', async () => {
      await addTask(T1, ann, group);
      await addTask(T2, ann, null);
      await api().delete(`/groups/${group}`).set(as(ann)).expect(204);
      expect((await pull(bob)).tasks).toEqual([]);
      expect(ids((await pull(ann)).tasks)).toEqual([T2]);
    });

    it('shows a deleted group task as an empty row, still marked with its group, to the members', async () => {
      await addTask(T1, ann, group, { title: 'Buy milk', assignee_id: bob.id });
      await ds.query(`update tasks set deleted_at = now() where id = $1`, [T1]);
      const [row] = (await pull(bob)).tasks;
      expect(row).toMatchObject({
        id: T1,
        user_id: ann.id,
        group_id: group,
        assignee_id: null,
        title: '',
      });
      expect(row.deleted_at).toEqual(expect.any(String));
    });

    it('shows a returning member the group again', async () => {
      await addTask(T1, ann, group);
      await api().post(`/groups/${group}/leave`).set(as(bob)).expect(204);
      expect((await pull(bob)).tasks).toEqual([]);
      await join(bob, '111111');
      expect(ids((await pull(bob)).tasks)).toEqual([T1]);
    });

    it('does not let a personal task of a member into the group', async () => {
      await addTask(T1, bob, null, { title: 'Bob personal' });
      expect((await pull(ann)).tasks).toEqual([]);
    });

    it('shows a task that moves between members’ views through a change of assignee', async () => {
      await addTask(T1, ann, group, { assignee_id: bob.id });
      const before = await pull(bob);
      await api().post(`/groups/${group}/leave`).set(as(bob)).expect(204);
      // Ann sees the task handed back to nobody, newer than what she pulled before.
      const res = await pull(ann, `?since=${before.next}`);
      expect(res.tasks).toEqual([
        expect.objectContaining({ id: T1, assignee_id: null }),
      ]);
    });
  });

  describe('the marks', () => {
    beforeEach(async () => {
      await addTask(T1, ann, group);
      await addTask(T2, ann, null);
      await addTask(T3, bob, null);
      await addLog(T1, ann);
      await addLog(T1, bob);
      await addLog(T2, ann);
      await addLog(T3, bob);
    });

    it('shows a member the marks of every member on the group’s tasks, and their own on personal ones', async () => {
      expect(marks((await pull(bob)).logs)).toEqual(
        [
          `${T1}|${ann.id}|2026-01-15`,
          `${T1}|${bob.id}|2026-01-15`,
          `${T3}|${bob.id}|2026-01-15`,
        ].sort(),
      );
      expect(marks((await pull(ann)).logs)).toEqual(
        [
          `${T1}|${ann.id}|2026-01-15`,
          `${T1}|${bob.id}|2026-01-15`,
          `${T2}|${ann.id}|2026-01-15`,
        ].sort(),
      );
    });

    it('gives each mark with the user who made it', async () => {
      const mine = (await pull(bob)).logs.filter((l) => l.task_id === T1);
      expect(mine.map((l) => l.user_id).sort()).toEqual(
        [ann.id, bob.id].sort(),
      );
    });

    it('keeps them from a stranger and from members of another group', async () => {
      expect((await pull(dan)).logs).toEqual([]);
      expect((await pull(cat)).logs).toEqual([]);
    });

    it('never shows a personal task’s marks to anyone but its owner', async () => {
      for (const who of [bob, cat, dan]) {
        const text = JSON.stringify((await pull(who)).logs);
        expect(text).not.toContain(T2);
      }
    });

    it('takes the marks of the group away from someone who left, their own marks on it included', async () => {
      await api().post(`/groups/${group}/leave`).set(as(bob)).expect(204);
      expect(marks((await pull(bob)).logs)).toEqual([
        `${T3}|${bob.id}|2026-01-15`,
      ]);
      // The others keep seeing what he marked.
      expect(marks((await pull(ann)).logs)).toContain(
        `${T1}|${bob.id}|2026-01-15`,
      );
    });

    it('shows nothing for a deleted group task: its marks are erased with it', async () => {
      await ds.query(`update tasks set deleted_at = now() where id = $1`, [T1]);
      expect((await pull(bob)).logs.filter((l) => l.task_id === T1)).toEqual(
        [],
      );
    });

    it('shows a new mark of a member to the others', async () => {
      const first = await pull(ann);
      await addLog(T1, bob, '2026-01-16');
      const res = await pull(ann, `?since=${first.next}`);
      expect(marks(res.logs)).toEqual([`${T1}|${bob.id}|2026-01-16`]);
    });
  });

  describe('what a new member receives', () => {
    it('gets the tasks and marks written before they joined, which a watermark would have missed', async () => {
      await addTask(T1, ann, group, { title: 'old' });
      await addTask(T2, ann, group, { title: 'gone' });
      await ds.query(`update tasks set deleted_at = now() where id = $1`, [T2]);
      await addLog(T1, ann);
      await stamp('tasks', 'id', T1, '2020-01-01T00:00:00Z');
      await stamp('tasks', 'id', T2, '2020-01-01T00:00:00Z');
      await stamp('task_logs', 'task_id', T1, '2020-01-01T00:00:00Z');
      // Cat had pulled everything up to now; then she joins the group.
      const watermark = (await pull(cat)).next ?? '2026-01-01T00:00:00Z';
      await join(cat, '111111');
      const res = await pull(cat, `?since=${watermark}`);
      expect(ids(res.tasks)).toEqual([T1]);
      expect(marks(res.logs)).toEqual([`${T1}|${ann.id}|2026-01-15`]);
    });

    it('does not get the tasks of the group after leaving it, whatever the watermark', async () => {
      await addTask(T1, ann, group);
      await api().post(`/groups/${group}/leave`).set(as(bob)).expect(204);
      expect((await pull(bob, '?since=')).tasks).toEqual([]);
      expect((await pull(bob, '?since=2000-01-01T00:00:00Z')).logs).toEqual([]);
    });
  });

  describe('since and pages', () => {
    it('gives only the group rows newer than since, from every member', async () => {
      await addTask(T1, ann, group);
      await addTask(T2, bob, group);
      await addTask(T3, ann, group);
      await stamp('tasks', 'id', T1, early(1));
      await stamp('tasks', 'id', T2, early(2));
      await stamp('tasks', 'id', T3, early(3));
      expect(ids((await pull(bob, `?since=${early(1)}`)).tasks)).toEqual(
        [T2, T3].sort(),
      );
    });

    it('mixes personal and group tasks in the order of their change', async () => {
      await addTask(T1, bob, null);
      await addTask(T2, ann, group);
      await addTask(T3, bob, null);
      await stamp('tasks', 'id', T1, early(3));
      await stamp('tasks', 'id', T2, early(1));
      await stamp('tasks', 'id', T3, early(2));
      expect((await pull(bob)).tasks.map((t) => t.id)).toEqual([T2, T3, T1]);
    });

    it('cuts the group tasks into pages like any other, without splitting equal times', async () => {
      for (const [n, t] of [T1, T2, T3, T4].entries()) {
        await addTask(t, n % 2 ? bob : ann, group);
      }
      await stamp('tasks', 'id', T1, second(1));
      await stamp('tasks', 'id', T2, second(2));
      await stamp('tasks', 'id', T3, second(2));
      await stamp('tasks', 'id', T4, second(3));
      const first = await pull(bob, '?limit=2&since=2030-01-01T00:00:00Z');
      expect(ids(first.tasks)).toEqual([T1, T2, T3].sort());
      expect(first.has_more).toBe(true);
      expect(first.next).toBe(second(2));
      const next = await pull(bob, `?limit=2&since=${first.next}`);
      expect(ids(next.tasks)).toEqual([T4]);
    });

    it('converges: walking small pages gives every task and every mark of the group', async () => {
      for (let i = 0; i < 9; i++) {
        await addTask(id(100 + i), i % 2 ? bob : ann, group);
        await addLog(id(100 + i), ann);
        await addLog(id(100 + i), bob);
      }
      await addTask(T5, bob, null);
      await addLog(T5, bob);
      const tasks = new Set<unknown>();
      const logs = new Set<string>();
      let since = '';
      for (let pages = 0; pages < 60; pages += 1) {
        const res = await pull(bob, `?limit=3${since}`);
        res.tasks.forEach((t) => tasks.add(t.id));
        marks(res.logs).forEach((m) => logs.add(m));
        if (!res.has_more) break;
        since = `&since=${res.next}`;
      }
      expect(tasks.size).toBe(10);
      expect(logs.size).toBe(19);
    });
  });

  it('leaves the answer of someone with no groups as it was', async () => {
    await addTask(T6, dan, null, { title: 'mine' });
    await addLog(T6, dan);
    const res = await pull(dan);
    expect(ids(res.tasks)).toEqual([T6]);
    expect(marks(res.logs)).toEqual([`${T6}|${dan.id}|2026-01-15`]);
    expect(res.tasks[0]).toMatchObject({ group_id: null, assignee_id: null });
  });
});
