import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import * as planModule from '../src/sync/plan-task-writes';
import { DeletionWriter } from '../src/sync/deletion-writer';
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
const [T1, T2, T3, T4, T5] = [1, 2, 3, 4, 5].map(id);
const NOBODY = id(99);

describe('POST /sync/push: tasks of a group', () => {
  let app: INestApplication;
  let ds: DataSource;
  let throwInDeletions = false;
  let ann: Session; // owner of G
  let bob: Session; // member of G and of H
  let cat: Session; // member of G
  let dan: Session; // owner of H, not in G
  let eve: Session; // left G
  let G: string;
  let H: string;
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
  const push = async (who: Session, body: object, status = 200) => {
    const res = await api()
      .post('/sync/push')
      .set(as(who))
      .send(body)
      .expect(status);
    return res.body as { rejected: Rejected[] };
  };
  const reasons = (r: { rejected: Rejected[] }) =>
    r.rejected.map((x) => `${x.table}:${x.id}:${x.reason}`).sort();
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
  const row = async (taskId: string) =>
    (
      await ds.query(
        `select id, user_id, group_id, assignee_id, title, status, tracking_mode, repeat_type,
                deleted_at is not null as deleted, updated_at::text u
         from tasks where id = $1`,
        [taskId],
      )
    )[0] as Row | undefined;
  const count = async () =>
    (await ds.query(`select count(*)::int n from tasks`))[0].n as number;

  beforeAll(async () => {
    app = await createTestApp([], 0, (builder) =>
      builder.overrideProvider(DeletionWriter).useFactory({
        factory: () => ({
          write: (...args: Parameters<DeletionWriter['write']>) => {
            if (throwInDeletions) throw new Error('database went away');
            return new DeletionWriter().write(...args);
          },
        }),
      }),
    );
    app.getHttpServer().setMaxListeners(100);
    ds = app.get(DataSource);
  });

  beforeEach(async () => {
    throwInDeletions = false;
    await truncateAll(ds);
    ann = await signUp('ann@example.com');
    bob = await signUp('bob@example.com');
    cat = await signUp('cat@example.com');
    dan = await signUp('dan@example.com');
    eve = await signUp('eve@example.com');
    G = await newGroup(ann, '111111');
    H = await newGroup(dan, '222222');
    for (const who of [bob, cat, eve]) await join(who, '111111');
    await join(bob, '222222');
    await api().post(`/groups/${G}/leave`).set(as(eve)).expect(204);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(() => app.close());

  describe('a new task', () => {
    it('is written under the caller as its author, in the group', async () => {
      const res = await push(bob, {
        tasks: [{ id: T1, group_id: G, title: 'Buy milk' }],
      });
      expect(res.rejected).toEqual([]);
      expect(await row(T1)).toMatchObject({
        user_id: bob.id,
        group_id: G,
        title: 'Buy milk',
        assignee_id: null,
        deleted: false,
      });
    });

    it('takes the owner and every member alike', async () => {
      for (const [n, who] of [ann, bob, cat].entries()) {
        await push(who, { tasks: [{ id: id(10 + n), group_id: G }] });
        expect((await row(id(10 + n)))?.user_id).toBe(who.id);
      }
    });

    it('ignores a user_id in the row: the author is the token’s user', async () => {
      await push(bob, { tasks: [{ id: T1, group_id: G, user_id: ann.id }] });
      expect((await row(T1))?.user_id).toBe(bob.id);
    });

    it('keeps an assignee who is in the group', async () => {
      await push(ann, {
        tasks: [
          { id: T1, group_id: G, assignee_id: bob.id },
          { id: T2, group_id: G, assignee_id: ann.id },
        ],
      });
      expect((await row(T1))?.assignee_id).toBe(bob.id);
      expect((await row(T2))?.assignee_id).toBe(ann.id);
    });

    it('drops, without a refusal, an assignee who is not in the group, who left, or does not exist', async () => {
      const res = await push(ann, {
        tasks: [
          { id: T1, group_id: G, assignee_id: dan.id },
          { id: T2, group_id: G, assignee_id: eve.id },
          { id: T3, group_id: G, assignee_id: NOBODY },
        ],
      });
      expect(res.rejected).toEqual([]);
      for (const t of [T1, T2, T3]) {
        expect(await row(t)).toMatchObject({ group_id: G, assignee_id: null });
      }
    });

    it('drops an assignee named on a personal task', async () => {
      await push(ann, { tasks: [{ id: T1, assignee_id: bob.id }] });
      expect(await row(T1)).toMatchObject({
        group_id: null,
        assignee_id: null,
      });
    });

    describe('is refused as unknown_group', () => {
      it.each([
        ['someone outside the group', () => dan],
        ['someone who left it', () => eve],
      ])('for %s, and nothing is written', async (_name, who) => {
        const res = await push(who(), { tasks: [{ id: T1, group_id: G }] });
        expect(res.rejected).toEqual([
          { table: 'tasks', id: T1, reason: 'unknown_group' },
        ]);
        expect(await count()).toBe(0);
      });

      it('for a group that does not exist, the same as for one they are not in', async () => {
        const missing = await push(dan, {
          tasks: [{ id: T1, group_id: NOBODY }],
        });
        const foreign = await push(dan, { tasks: [{ id: T2, group_id: G }] });
        expect(missing.rejected[0].reason).toBe('unknown_group');
        expect(foreign.rejected[0].reason).toBe('unknown_group');
        expect(Object.keys(missing.rejected[0])).toEqual(
          Object.keys(foreign.rejected[0]),
        );
      });

      it('for a deleted group, even for its former owner', async () => {
        await api().delete(`/groups/${G}`).set(as(ann)).expect(204);
        const res = await push(ann, { tasks: [{ id: T1, group_id: G }] });
        expect(reasons(res)).toEqual([`tasks:${T1}:unknown_group`]);
      });

      it('for an owner of another group naming this one', async () => {
        const res = await push(dan, { tasks: [{ id: T1, group_id: G }] });
        expect(reasons(res)).toEqual([`tasks:${T1}:unknown_group`]);
      });
    });

    describe('is refused as invalid_row when it is not a one-off task', () => {
      it.each([
        ['a repeat', { repeat_type: 'daily' }],
        ['a parent', { parent_id: T5 }],
        ['the value mode', { tracking_mode: 'value' }],
      ])('with %s', async (_name, extra) => {
        await push(ann, { tasks: [{ id: T5 }] });
        const res = await push(ann, {
          tasks: [
            { id: T1, group_id: G, ...extra },
            { id: T2, group_id: G },
          ],
        });
        expect(reasons(res)).toEqual([`tasks:${T1}:invalid_row`]);
        expect(await row(T1)).toBeUndefined();
        expect(await row(T2)).toBeDefined();
      });
    });

    it('cannot be a parent: a subtask under it is refused', async () => {
      const res = await push(ann, {
        tasks: [
          { id: T1, group_id: G },
          { id: T2, parent_id: T1 },
        ],
      });
      expect(reasons(res)).toEqual([`tasks:${T2}:unknown_parent`]);
      expect(await row(T1)).toBeDefined();
      expect(await row(T2)).toBeUndefined();
    });

    it('the later of two rows with one id wins', async () => {
      await push(bob, {
        tasks: [
          { id: T1, group_id: G, title: 'first' },
          { id: T1, group_id: G, title: 'second' },
        ],
      });
      expect((await row(T1))?.title).toBe('second');
    });

    it('takes 500 group tasks in one push', async () => {
      const tasks = Array.from({ length: 500 }, (_, i) => ({
        id: id(1000 + i),
        group_id: G,
        title: `t${i}`,
      }));
      const res = await push(cat, { tasks });
      expect(res.rejected).toEqual([]);
      expect(await count()).toBe(500);
    });

    it('rolls back with the rest of the push, and a retry works', async () => {
      throwInDeletions = true;
      const body = {
        tasks: [{ id: T1, group_id: G }],
        deleted: [{ table: 'tasks', id: T2 }],
      };
      await push(bob, body, 500);
      expect(await count()).toBe(0);
      throwInDeletions = false;
      expect((await push(bob, body)).rejected).toEqual([]);
      expect(await row(T1)).toBeDefined();
    });
  });

  describe('a task that exists', () => {
    beforeEach(async () => {
      await push(bob, {
        tasks: [
          { id: T1, group_id: G, title: 'by Bob', assignee_id: cat.id },
          { id: T2, group_id: G, title: 'also Bob' },
        ],
      });
    });

    it('is changed by its author, who stays its author and in its group', async () => {
      const before = (await row(T1))?.u;
      const res = await push(bob, {
        tasks: [{ id: T1, group_id: G, title: 'renamed', assignee_id: ann.id }],
      });
      expect(res.rejected).toEqual([]);
      const after = await row(T1);
      expect(after).toMatchObject({
        title: 'renamed',
        user_id: bob.id,
        group_id: G,
        assignee_id: ann.id,
      });
      expect(after?.u).not.toBe(before);
    });

    it('is changed by the owner of the group, and the author stays', async () => {
      const res = await push(ann, {
        tasks: [
          { id: T1, group_id: G, title: 'by the owner', assignee_id: null },
        ],
      });
      expect(res.rejected).toEqual([]);
      expect(await row(T1)).toMatchObject({
        title: 'by the owner',
        user_id: bob.id,
        assignee_id: null,
        group_id: G,
      });
    });

    it('is not changed by another member: not_allowed, and nothing changes', async () => {
      const before = await row(T1);
      const res = await push(cat, {
        tasks: [{ id: T1, group_id: G, title: 'hijacked', assignee_id: null }],
      });
      expect(res.rejected).toEqual([
        { table: 'tasks', id: T1, reason: 'not_allowed' },
      ]);
      expect(await row(T1)).toEqual(before);
    });

    it('is none of the business of someone outside the group: id_taken', async () => {
      const before = await row(T1);
      for (const who of [dan, eve]) {
        const res = await push(who, {
          tasks: [{ id: T1, group_id: G, title: 'x' }],
        });
        expect(res.rejected).toEqual([
          { table: 'tasks', id: T1, reason: 'id_taken' },
        ]);
      }
      expect(await row(T1)).toEqual(before);
    });

    it('is closed to its own author once they have left the group', async () => {
      await api().post(`/groups/${G}/leave`).set(as(bob)).expect(204);
      const before = await row(T1);
      const res = await push(bob, {
        tasks: [{ id: T1, group_id: G, title: 'x' }],
      });
      expect(res.rejected).toEqual([
        { table: 'tasks', id: T1, reason: 'id_taken' },
      ]);
      expect(await row(T1)).toEqual(before);
    });

    it('keeps its group whatever group the row names', async () => {
      // Bob is in H too; the row asks to move the task there.
      await push(bob, { tasks: [{ id: T1, group_id: H, title: 'moved?' }] });
      expect(await row(T1)).toMatchObject({ group_id: G, title: 'moved?' });
    });

    it('is judged by its own group, not by the one the row names', async () => {
      // Dan owns H, but the task is in G, where he is nobody.
      const res = await push(dan, {
        tasks: [{ id: T1, group_id: H, title: 'x' }],
      });
      expect(reasons(res)).toEqual([`tasks:${T1}:id_taken`]);
      // Cat owns nothing, and names a group where she is a member: still not hers to change.
      await join(cat, '222222');
      const again = await push(cat, { tasks: [{ id: T1, group_id: H }] });
      expect(reasons(again)).toEqual([`tasks:${T1}:not_allowed`]);
    });

    it('stays in its group, with its assignee, when the row names no group', async () => {
      await push(bob, {
        tasks: [{ id: T1, title: 'no group named', assignee_id: cat.id }],
      });
      expect(await row(T1)).toMatchObject({
        group_id: G,
        assignee_id: cat.id,
        title: 'no group named',
      });
    });

    it.each([
      ['a repeat', { repeat_type: 'weekly' }],
      ['the value mode', { tracking_mode: 'value' }],
      ['a parent', { parent_id: T2 }],
    ])(
      'cannot be made into something a group does not take (%s)',
      async (_name, extra) => {
        const before = await row(T1);
        const res = await push(bob, {
          tasks: [{ id: T1, group_id: G, ...extra }],
        });
        expect(reasons(res)).toEqual([`tasks:${T1}:invalid_row`]);
        expect(await row(T1)).toEqual(before);
      },
    );

    it('cannot be made into something a group does not take even when the row names no group', async () => {
      const before = await row(T1);
      const res = await push(bob, {
        tasks: [{ id: T1, repeat_type: 'daily' }],
      });
      expect(reasons(res)).toEqual([`tasks:${T1}:invalid_row`]);
      expect(await row(T1)).toEqual(before);
    });

    it('is not undone by a late push of the same task once it is deleted', async () => {
      await push(bob, { deleted: [{ table: 'tasks', id: T1 }] });
      const before = await row(T1);
      for (const who of [bob, ann]) {
        const res = await push(who, {
          tasks: [{ id: T1, group_id: G, title: 'back' }],
        });
        expect(res.rejected).toEqual([]);
      }
      expect(await row(T1)).toEqual(before);
      const res = await push(cat, {
        tasks: [{ id: T1, group_id: G, title: 'back' }],
      });
      expect(reasons(res)).toEqual([`tasks:${T1}:not_allowed`]);
    });

    it('lets the members see the change at their next pull, the author unchanged', async () => {
      await push(ann, {
        tasks: [{ id: T2, group_id: G, title: 'owner edit' }],
      });
      const res = await api().get('/sync/pull').set(as(cat)).expect(200);
      const t = (res.body.tasks as Row[]).find((r) => r.id === T2);
      expect(t).toMatchObject({
        title: 'owner edit',
        user_id: bob.id,
        group_id: G,
      });
    });
  });

  describe('a personal task', () => {
    it('stays personal when the row names a group', async () => {
      await push(bob, { tasks: [{ id: T1, title: 'mine' }] });
      await push(bob, {
        tasks: [{ id: T1, group_id: G, title: 'still mine' }],
      });
      expect(await row(T1)).toMatchObject({
        group_id: null,
        title: 'still mine',
      });
    });

    it('is another user’s: id_taken, named as a group task or not', async () => {
      await push(dan, { tasks: [{ id: T1, title: 'Dan' }] });
      for (const extra of [{}, { group_id: G }]) {
        const res = await push(ann, { tasks: [{ id: T1, ...extra }] });
        expect(reasons(res)).toEqual([`tasks:${T1}:id_taken`]);
      }
      expect((await row(T1))?.title).toBe('Dan');
    });

    it('cannot hang under a task of a group', async () => {
      await push(ann, { tasks: [{ id: T1, group_id: G }] });
      const res = await push(ann, { tasks: [{ id: T2, parent_id: T1 }] });
      expect(reasons(res)).toEqual([`tasks:${T2}:unknown_parent`]);
    });
  });

  describe('deleting', () => {
    beforeEach(async () => {
      await push(bob, {
        tasks: [{ id: T1, group_id: G, title: 'by Bob', assignee_id: cat.id }],
      });
      await ds.query(
        `insert into task_logs (task_id, user_id, date, completed) values ($1, $2, '2026-01-15', true)`,
        [T1, cat.id],
      );
    });
    const del = (who: Session, taskId = T1) =>
      push(who, { deleted: [{ table: 'tasks', id: taskId }] });

    it('lets the author, who is in the group: the task is emptied, the group kept, the marks erased', async () => {
      const res = await del(bob);
      expect(res.rejected).toEqual([]);
      expect(await row(T1)).toMatchObject({
        deleted: true,
        title: '',
        group_id: G,
        user_id: bob.id,
        assignee_id: null,
      });
      expect(
        (await ds.query(`select count(*)::int n from task_logs`))[0].n,
      ).toBe(0);
    });

    it('lets the owner of the group, and the author stays', async () => {
      expect((await del(ann)).rejected).toEqual([]);
      expect(await row(T1)).toMatchObject({
        deleted: true,
        user_id: bob.id,
        group_id: G,
      });
    });

    it('does not let another member: not_allowed, nothing changes', async () => {
      const before = await row(T1);
      const res = await del(cat);
      expect(res.rejected).toEqual([
        { table: 'tasks', id: T1, reason: 'not_allowed' },
      ]);
      expect(await row(T1)).toEqual(before);
      expect(
        (await ds.query(`select count(*)::int n from task_logs`))[0].n,
      ).toBe(1);
    });

    it('does not let someone outside the group, or the author who has left: id_taken', async () => {
      await api().post(`/groups/${G}/leave`).set(as(bob)).expect(204);
      const before = await row(T1);
      for (const who of [dan, eve, bob]) {
        const res = await del(who);
        expect(res.rejected).toEqual([
          { table: 'tasks', id: T1, reason: 'id_taken' },
        ]);
      }
      expect(await row(T1)).toEqual(before);
    });

    it('is harmless to repeat, for the author and for the owner, and changes no stamp', async () => {
      await del(bob);
      const before = await row(T1);
      expect((await del(bob)).rejected).toEqual([]);
      expect((await del(ann)).rejected).toEqual([]);
      expect(await row(T1)).toEqual(before);
    });

    it('still refuses another member once the task is gone, and an outsider', async () => {
      await del(bob);
      expect(reasons(await del(cat))).toEqual([`tasks:${T1}:not_allowed`]);
      expect(reasons(await del(dan))).toEqual([`tasks:${T1}:id_taken`]);
    });

    it('judges each task of one request on its own', async () => {
      await push(cat, { tasks: [{ id: T2, group_id: G }] });
      const res = await push(cat, {
        deleted: [
          { table: 'tasks', id: T1 }, // Bob's: not hers
          { table: 'tasks', id: T2 }, // hers
          { table: 'tasks', id: T3 }, // nobody's yet: a tombstone
        ],
      });
      expect(reasons(res)).toEqual([`tasks:${T1}:not_allowed`]);
      expect((await row(T1))?.deleted).toBe(false);
      expect((await row(T2))?.deleted).toBe(true);
      expect(await row(T3)).toMatchObject({
        deleted: true,
        group_id: null,
        user_id: cat.id,
      });
    });

    it('wins over a write of the same task in the same request', async () => {
      const res = await push(bob, {
        tasks: [{ id: T1, group_id: G, title: 'edit' }],
        deleted: [{ table: 'tasks', id: T1 }],
      });
      expect(res.rejected).toEqual([]);
      expect(await row(T1)).toMatchObject({ deleted: true, title: '' });
    });

    it('is refused for everyone once the group is deleted', async () => {
      await api().delete(`/groups/${G}`).set(as(ann)).expect(204);
      for (const who of [ann, bob, cat]) {
        expect(reasons(await del(who))).toEqual([`tasks:${T1}:id_taken`]);
      }
    });

    it('a tombstone laid by the id of a future group task keeps that task from appearing', async () => {
      await del(bob, T4);
      const res = await push(bob, {
        tasks: [{ id: T4, group_id: G, title: 'late' }],
      });
      expect(res.rejected).toEqual([]);
      expect(await row(T4)).toMatchObject({
        deleted: true,
        group_id: null,
        title: '',
      });
    });
  });

  describe('the last line, in the SQL: a fooled check changes nothing it should not', () => {
    // The plan is replaced by one that lets every row through, as if the checks before the
    // database had been fooled.
    beforeEach(async () => {
      await push(bob, { tasks: [{ id: T1, group_id: G, title: 'by Bob' }] });
      await push(dan, { tasks: [{ id: T2, title: 'personal of Dan' }] });
      jest
        .spyOn(planModule, 'planTaskWrites')
        .mockImplementation((rows) => ({ write: rows, rejected: [] }));
    });

    it('a stranger cannot change a task of the group', async () => {
      await push(dan, { tasks: [{ id: T1, group_id: G, title: 'hijacked' }] });
      expect((await row(T1))?.title).toBe('by Bob');
    });

    it('a stranger cannot put a new task into the group', async () => {
      await push(dan, { tasks: [{ id: T3, group_id: G, title: 'planted' }] });
      expect(await row(T3)).toBeUndefined();
    });

    it('someone who left cannot change their own old task', async () => {
      await api().post(`/groups/${G}/leave`).set(as(bob)).expect(204);
      await push(bob, { tasks: [{ id: T1, group_id: G, title: 'back door' }] });
      expect((await row(T1))?.title).toBe('by Bob');
    });

    it('the same when the row names no group at all: the update itself asks who is in the group', async () => {
      await api().post(`/groups/${G}/leave`).set(as(bob)).expect(204);
      await push(bob, { tasks: [{ id: T1, title: 'back door' }] });
      await push(dan, { tasks: [{ id: T1, title: 'stranger' }] });
      await push(cat, { tasks: [{ id: T1, title: 'member' }] });
      expect((await row(T1))?.title).toBe('by Bob');
      await push(ann, { tasks: [{ id: T1, title: 'owner' }] });
      expect((await row(T1))?.title).toBe('owner');
    });

    it('another member cannot change it, the owner can', async () => {
      await push(cat, { tasks: [{ id: T1, group_id: G, title: 'by Cat' }] });
      expect((await row(T1))?.title).toBe('by Bob');
      await push(ann, { tasks: [{ id: T1, group_id: G, title: 'by Ann' }] });
      expect(await row(T1)).toMatchObject({ title: 'by Ann', user_id: bob.id });
    });

    it('nobody changes the personal task of another user', async () => {
      await push(ann, { tasks: [{ id: T2, title: 'taken' }] });
      await push(ann, { tasks: [{ id: T2, group_id: G, title: 'taken' }] });
      expect(await row(T2)).toMatchObject({
        title: 'personal of Dan',
        user_id: dan.id,
      });
    });

    it('the owner of one group cannot reach a task of another', async () => {
      await push(dan, { tasks: [{ id: T1, group_id: H, title: 'cross' }] });
      expect((await row(T1))?.title).toBe('by Bob');
    });
  });
});
