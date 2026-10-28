import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp, truncateAll } from './support/db';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [T1, T2, T3, T4, T5, T6, T7] = [1, 2, 3, 4, 5, 6, 7].map(id);
const NOBODY = id(99);
const OLD = '2020-01-01T00:00:00Z';

interface Session {
  token: string;
  id: string;
}
type Row = Record<string, unknown>;

describe('Leaving, removing, deleting a group', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ann: Session; // the owner
  let bob: Session;
  let cat: Session;
  let dan: Session; // a stranger
  let group: string;
  let other: string; // another group: ann owns it, bob is in it
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
  const leave = (who: Session, g = group) =>
    api().post(`/groups/${g}/leave`).set(as(who));
  const removeMember = (who: Session, member: string, g = group) =>
    api().delete(`/groups/${g}/members/${member}`).set(as(who));
  const deleteGroup = (who: Session, g = group) =>
    api().delete(`/groups/${g}`).set(as(who));
  const join = (who: Session, code: string) =>
    api().post('/groups/join').set(as(who)).send({ code });

  async function newGroup(owner: Session, code: string) {
    const res = await api()
      .post('/groups')
      .set(as(owner))
      .send({ name: 'Home' })
      .expect(201);
    await ds.query(`update group_invites set code = $2 where group_id = $1`, [
      res.body.id,
      code,
    ]);
    return res.body.id as string;
  }
  const addMember = (g: string, who: Session) =>
    ds.query(`insert into group_members (group_id, user_id) values ($1, $2)`, [
      g,
      who.id,
    ]);
  const member = async (who: Session, g = group) =>
    (
      await ds.query(
        `select deleted_at, updated_at::text u from group_members where group_id = $1 and user_id = $2`,
        [g, who.id],
      )
    )[0] as { deleted_at: Date | null; u: string } | undefined;
  const task = async (taskId: string) =>
    (
      await ds.query(
        `select id, user_id, group_id, assignee_id, title, deleted_at is not null as deleted,
                client_updated_at > '2025-01-01' as client_fresh,
                updated_at > '2025-01-01' as fresh
         from tasks where id = $1`,
        [taskId],
      )
    )[0] as Row;
  const logCount = async (taskId?: string) =>
    (
      await ds.query(
        taskId
          ? `select count(*)::int n from task_logs where task_id = $1`
          : `select count(*)::int n from task_logs`,
        taskId ? [taskId] : [],
      )
    )[0].n as number;
  // Everything about the rows of the group, to compare before and after.
  const picture = async () => ({
    members: await ds.query(
      `select group_id, user_id, deleted_at, updated_at::text from group_members order by 1, 2`,
    ),
    tasks: await ds.query(`select * from tasks order by id`),
    logs: await ds.query(
      `select * from task_logs order by task_id, user_id, date`,
    ),
    groups: await ds.query(`select * from groups order by id`),
  });

  // Marks and tasks get an old stamp, so that a touch is visible.
  async function backdate() {
    for (const table of ['tasks', 'task_logs', 'group_members']) {
      await ds.query(
        `alter table ${table} disable trigger ${table}_updated_at`,
      );
    }
    try {
      await ds.query(
        `update tasks set updated_at = $1, client_updated_at = $1`,
        [OLD],
      );
      await ds.query(`update task_logs set updated_at = $1`, [OLD]);
    } finally {
      for (const table of ['tasks', 'task_logs', 'group_members']) {
        await ds.query(
          `alter table ${table} enable trigger ${table}_updated_at`,
        );
      }
    }
  }

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
    await addMember(group, bob);
    await addMember(group, cat);
    other = await newGroup(ann, '222222');
    await addMember(other, bob);
    // T1 ann's task for bob, T2 bob's own task for bob, T3 cat's task for everyone, T4 ann's
    // task for cat, T5 ann's task in the other group for bob, T6 bob's personal task, T7 ann's
    // task for bob that is already deleted.
    await ds.query(
      `insert into tasks (id, user_id, group_id, assignee_id, title) values
       ($1, $2, $3, $4, 'T1'), ($5, $4, $3, $4, 'T2'), ($6, $7, $3, null, 'T3'),
       ($8, $2, $3, $7, 'T4'), ($9, $2, $10, $4, 'T5'), ($11, $4, null, null, 'T6'),
       ($12, $2, $3, $4, 'T7')`,
      [T1, ann.id, group, bob.id, T2, T3, cat.id, T4, T5, other, T6, T7],
    );
    await ds.query(`update tasks set deleted_at = now() where id = $1`, [T7]);
    await ds.query(
      `insert into task_logs (task_id, user_id, date, completed) values
       ($1, $2, '2026-01-15', true), ($3, $2, '2026-01-15', true), ($3, $4, '2026-01-15', true),
       ($5, $2, '2026-01-15', true)`,
      [T1, bob.id, T3, cat.id, T5],
    );
    await backdate();
  });

  afterAll(() => app.close());

  describe('without a valid token', () => {
    it('every route is closed', async () => {
      for (const call of [
        () => api().post(`/groups/${group}/leave`),
        () => api().delete(`/groups/${group}/members/${bob.id}`),
        () => api().delete(`/groups/${group}`),
      ]) {
        const res = await call().expect(401);
        expect(res.body.code).toBe('unauthorized');
      }
      expect((await member(bob))?.deleted_at).toBeNull();
    });
  });

  // The same afterwards, whether the person left or was removed.
  const expectBobOut = async () => {
    expect((await member(bob))?.deleted_at).not.toBeNull();
    // Tasks handed to him go back to "nobody yet", and the phones will take the change.
    for (const t of [T1, T2]) {
      expect(await task(t)).toMatchObject({
        assignee_id: null,
        group_id: group,
        deleted: false,
        client_fresh: true,
        fresh: true,
      });
    }
    // His own task stays (he is its author), and his marks stay for the others to see.
    expect(await task(T2)).toMatchObject({ user_id: bob.id, title: 'T2' });
    expect(await logCount(T1)).toBe(1);
    // Nobody else is touched.
    expect(await task(T3)).toMatchObject({ assignee_id: null, fresh: false });
    expect(await task(T4)).toMatchObject({ assignee_id: cat.id, fresh: false });
    expect((await member(ann))?.deleted_at).toBeNull();
    expect((await member(cat))?.deleted_at).toBeNull();
    // Another group of his is not affected at all.
    expect((await member(bob, other))?.deleted_at).toBeNull();
    expect(await task(T5)).toMatchObject({ assignee_id: bob.id, fresh: false });
    expect(await task(T6)).toMatchObject({ user_id: bob.id, fresh: false });
  };

  describe('POST /groups/:id/leave', () => {
    it('lets a member go: 204, the row stays stamped, his tasks are handed back', async () => {
      const res = await leave(bob).expect(204);
      expect(res.text).toBe('');
      await expectBobOut();
    });

    it('does not let the owner: 409 owner_cannot_leave, nothing changes', async () => {
      const before = await picture();
      const res = await leave(ann).expect(409);
      expect(res.body.code).toBe('owner_cannot_leave');
      expect(await picture()).toEqual(before);
    });

    it('answers a stranger, an unknown group and a bad id with 404, and changes nothing', async () => {
      const before = await picture();
      for (const [who, g] of [
        [dan, group],
        [bob, NOBODY],
        [bob, 'nope'],
      ] as const) {
        const res = await leave(who, g).expect(404);
        expect(res.body.code).toBe('not_found');
      }
      expect(await picture()).toEqual(before);
    });

    it('is harmless to repeat: 204 and no new stamp', async () => {
      await leave(bob).expect(204);
      const before = await picture();
      await leave(bob).expect(204);
      expect(await picture()).toEqual(before);
    });

    it('is harmless after the group was deleted', async () => {
      await deleteGroup(ann).expect(204);
      const before = await picture();
      await leave(bob).expect(204);
      expect(await picture()).toEqual(before);
    });

    it('lets the owner of a deleted group call it again without an error', async () => {
      await deleteGroup(ann).expect(204);
      await leave(ann).expect(204);
    });

    it('takes nothing from the groups he is still in', async () => {
      await leave(bob).expect(204);
      expect((await member(bob, other))?.deleted_at).toBeNull();
      await leave(bob, other).expect(204);
      expect(await task(T5)).toMatchObject({ assignee_id: null });
    });

    it('closes the group to him: no code, no rename, no removing', async () => {
      await leave(bob).expect(204);
      await api().get(`/groups/${group}/invite`).set(as(bob)).expect(404);
      await api()
        .patch(`/groups/${group}`)
        .set(as(bob))
        .send({ name: 'x' })
        .expect(404);
      await removeMember(bob, cat.id).expect(404);
      await deleteGroup(bob).expect(404);
    });

    it('lets him come back with the code, as a member again', async () => {
      await leave(bob).expect(204);
      await join(bob, '111111').expect(200);
      expect((await member(bob))?.deleted_at).toBeNull();
    });
  });

  describe('DELETE /groups/:id/members/:memberId', () => {
    it('lets the owner remove a member, with the same effect as leaving', async () => {
      const res = await removeMember(ann, bob.id).expect(204);
      expect(res.text).toBe('');
      await expectBobOut();
    });

    it('does not let a member remove anyone: 403 not_owner, nothing changes', async () => {
      const before = await picture();
      const res = await removeMember(cat, bob.id).expect(403);
      expect(res.body.code).toBe('not_owner');
      await removeMember(bob, bob.id).expect(403);
      expect(await picture()).toEqual(before);
    });

    it('answers a stranger and an unknown group with 404', async () => {
      const before = await picture();
      await removeMember(dan, bob.id).expect(404);
      await removeMember(ann, bob.id, NOBODY).expect(404);
      await removeMember(ann, bob.id, 'nope').expect(404);
      expect(await picture()).toEqual(before);
    });

    it('does not let the owner remove themselves: 409 owner_cannot_leave', async () => {
      const before = await picture();
      const res = await removeMember(ann, ann.id).expect(409);
      expect(res.body.code).toBe('owner_cannot_leave');
      expect(await picture()).toEqual(before);
    });

    it('answers 404 for someone who was never in this group, and does not mix up two groups', async () => {
      const before = await picture();
      await removeMember(ann, dan.id).expect(404);
      await removeMember(ann, NOBODY).expect(404);
      await removeMember(ann, 'nope').expect(404);
      // Bob is in `other` only as far as `other` goes: removing from `group` leaves `other` be.
      await removeMember(ann, bob.id, other).expect(204);
      expect((await member(bob))?.deleted_at).toBeNull();
      expect(await picture()).not.toEqual(before);
    });

    it('is harmless to repeat, and harmless for someone who has already left', async () => {
      await leave(bob).expect(204);
      const before = await picture();
      await removeMember(ann, bob.id).expect(204);
      await removeMember(ann, bob.id).expect(204);
      expect(await picture()).toEqual(before);
    });

    it('does not change the code: the removed person may use it to come back', async () => {
      await removeMember(ann, bob.id).expect(204);
      const code = (
        await api().get(`/groups/${group}/invite`).set(as(ann)).expect(200)
      ).body.code;
      expect(code).toBe('111111');
      await join(bob, code).expect(200);
      expect((await member(bob))?.deleted_at).toBeNull();
    });

    it('takes one person at a time', async () => {
      await removeMember(ann, bob.id).expect(204);
      expect((await member(cat))?.deleted_at).toBeNull();
    });
  });

  describe('DELETE /groups/:id', () => {
    it('lets the owner delete: group, every membership and every live task are stamped deleted', async () => {
      const res = await deleteGroup(ann).expect(204);
      expect(res.text).toBe('');
      const [g] = await ds.query(
        `select deleted_at from groups where id = $1`,
        [group],
      );
      expect(g.deleted_at).not.toBeNull();
      for (const who of [ann, bob, cat]) {
        expect((await member(who))?.deleted_at).not.toBeNull();
      }
      for (const t of [T1, T2, T3, T4]) {
        expect(await task(t)).toMatchObject({
          deleted: true,
          title: '',
          assignee_id: null,
          group_id: group,
          client_fresh: true,
          fresh: true,
        });
      }
    });

    it('keeps the author of each task, and erases the marks of the whole group', async () => {
      await deleteGroup(ann).expect(204);
      expect(await task(T2)).toMatchObject({ user_id: bob.id });
      expect(await task(T3)).toMatchObject({ user_id: cat.id });
      expect(await logCount(T1)).toBe(0);
      expect(await logCount(T3)).toBe(0);
    });

    it('leaves alone the other group, the personal tasks and the marks of both', async () => {
      await deleteGroup(ann).expect(204);
      expect((await member(bob, other))?.deleted_at).toBeNull();
      expect(await task(T5)).toMatchObject({
        deleted: false,
        title: 'T5',
        fresh: false,
      });
      expect(await task(T6)).toMatchObject({
        deleted: false,
        title: 'T6',
        fresh: false,
      });
      expect(await logCount(T5)).toBe(1);
      const [o] = await ds.query(
        `select deleted_at from groups where id = $1`,
        [other],
      );
      expect(o.deleted_at).toBeNull();
    });

    it('does not stamp again a task that was already deleted', async () => {
      await deleteGroup(ann).expect(204);
      expect(await task(T7)).toMatchObject({ deleted: true, fresh: false });
    });

    it('does not let a member: 403 not_owner, nothing changes', async () => {
      const before = await picture();
      const res = await deleteGroup(bob).expect(403);
      expect(res.body.code).toBe('not_owner');
      expect(await picture()).toEqual(before);
    });

    it('answers a stranger, a member who has left, an unknown group and a bad id with 404', async () => {
      await leave(cat).expect(204);
      const before = await picture();
      for (const [who, g] of [
        [dan, group],
        [cat, group],
        [ann, NOBODY],
        [ann, 'nope'],
      ] as const) {
        const res = await deleteGroup(who, g).expect(404);
        expect(res.body.code).toBe('not_found');
      }
      expect(await picture()).toEqual(before);
    });

    it('is harmless to repeat: 204 and no new stamp', async () => {
      await deleteGroup(ann).expect(204);
      const before = await picture();
      await deleteGroup(ann).expect(204);
      expect(await picture()).toEqual(before);
    });

    it('answers a former member 404 once the group is deleted: it is not theirs any more', async () => {
      await deleteGroup(ann).expect(204);
      await deleteGroup(bob).expect(404);
    });

    it('closes everything else on it: code, rename, removing, joining by the old code', async () => {
      await deleteGroup(ann).expect(204);
      await api().get(`/groups/${group}/invite`).set(as(ann)).expect(404);
      await api()
        .post(`/groups/${group}/invite/regenerate`)
        .set(as(ann))
        .expect(404);
      await api()
        .patch(`/groups/${group}`)
        .set(as(ann))
        .send({ name: 'x' })
        .expect(404);
      await removeMember(ann, bob.id).expect(404);
      const res = await join(dan, '111111').expect(400);
      expect(res.body.code).toBe('bad_code');
    });

    it('takes a large group in one go', async () => {
      await ds.query(
        `insert into tasks (id, user_id, group_id, title)
         select ('10000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, $1, $2, 'bulk'
         from generate_series(1, 500) g`,
        [ann.id, group],
      );
      await deleteGroup(ann).expect(204);
      const [{ live }] = await ds.query(
        `select count(*)::int live from tasks where group_id = $1 and deleted_at is null`,
        [group],
      );
      expect(live).toBe(0);
    });
  });
});
