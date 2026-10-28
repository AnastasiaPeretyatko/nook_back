import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createTestApp, truncateAll } from './support/db';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [T1, T2, T3] = [id(1), id(2), id(3)];
const NOBODY = '00000000-0000-4000-8000-0000000000ff';

describe('Group tables', () => {
  let app: INestApplication;
  let ds: DataSource;

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
  });

  beforeEach(() => truncateAll(ds));

  afterAll(() => app.close());

  async function addUser(email: string) {
    const [row] = await ds.query(
      `insert into users (email, password_hash) values ($1, 'hash') returning id`,
      [email],
    );
    return row.id as string;
  }
  // A group with its owner as a member, as the routes will make it.
  async function addGroup(owner: string, name = 'Home') {
    const [{ id: group }] = await ds.query(
      `insert into groups (name, owner_id) values ($1, $2) returning id`,
      [name, owner],
    );
    await ds.query(
      `insert into group_members (group_id, user_id, role) values ($1, $2, 'owner')`,
      [group, owner],
    );
    return group as string;
  }
  const addMember = (group: string, user: string) =>
    ds.query(`insert into group_members (group_id, user_id) values ($1, $2)`, [
      group,
      user,
    ]);
  const removeMember = (group: string, user: string) =>
    ds.query(
      `update group_members set deleted_at = now() where group_id = $1 and user_id = $2`,
      [group, user],
    );
  function addTask(
    user: string,
    taskId: string,
    fields: Record<string, unknown> = {},
  ) {
    const cols = ['id', 'user_id', ...Object.keys(fields)];
    const params = [taskId, user, ...Object.values(fields)];
    return ds.query(
      `insert into tasks (${cols.join(', ')})
       values (${params.map((_, i) => `$${i + 1}`).join(', ')})`,
      params,
    );
  }
  const addLog = (taskId: string, user: string, date = '2026-01-15') =>
    ds.query(
      `insert into task_logs (task_id, user_id, date, completed) values ($1, $2, $3, true)`,
      [taskId, user, date],
    );
  const count = async (table: string) => {
    const [{ n }] = await ds.query(`select count(*)::int n from ${table}`);
    return n as number;
  };
  const taskRow = async (taskId: string) =>
    (
      await ds.query(`select * from tasks where id = $1`, [taskId])
    )[0] as Record<string, unknown>;
  const canMark = async (taskId: string, user: string) =>
    (await ds.query(`select can_mark_task($1, $2) as ok`, [taskId, user]))[0]
      .ok as boolean | null;

  describe('groups', () => {
    it('makes the id and the stamps itself', async () => {
      const owner = await addUser('ann@example.com');
      const group = await addGroup(owner);
      expect(group).toMatch(/^[0-9a-f-]{36}$/);
      const [row] = await ds.query(`select * from groups`);
      expect(row).toMatchObject({
        name: 'Home',
        owner_id: owner,
        deleted_at: null,
      });
    });

    it('takes a name of 1 to 100 characters and no other', async () => {
      const owner = await addUser('ann@example.com');
      await addGroup(owner, 'x');
      await addGroup(owner, 'x'.repeat(100));
      await expect(addGroup(owner, '')).rejects.toThrow(/groups_name_check/);
      await expect(addGroup(owner, 'x'.repeat(101))).rejects.toThrow(
        /groups_name_check/,
      );
    });

    it('refuses an owner that does not exist', async () => {
      await expect(addGroup(NOBODY)).rejects.toThrow(/groups_owner_id_fkey/);
    });

    it('stamps updated_at on the server clock and moves it on update', async () => {
      const owner = await addUser('ann@example.com');
      await ds.query(
        `insert into groups (name, owner_id, updated_at) values ('g', $1, '2000-01-01')`,
        [owner],
      );
      const [{ before, fresh }] = await ds.query(
        `select updated_at::text before, updated_at > '2020-01-01' fresh from groups`,
      );
      expect(fresh).toBe(true);
      await ds.query(`update groups set name = 'renamed'`);
      const [{ moved }] = await ds.query(
        `select updated_at > $1::timestamptz moved from groups`,
        [before],
      );
      expect(moved).toBe(true);
    });

    it('is removed together with its owner, members, code and tasks', async () => {
      const owner = await addUser('ann@example.com');
      const group = await addGroup(owner);
      await ds.query(
        `insert into group_invites (group_id, code) values ($1, '123456')`,
        [group],
      );
      const bob = await addUser('bob@example.com');
      await addMember(group, bob);
      await addTask(owner, T1, { group_id: group });
      await addTask(bob, T2, { group_id: group });
      await addLog(T1, owner);
      await addLog(T2, bob);
      await ds.query(`delete from users where id = $1`, [owner]);
      for (const table of [
        'groups',
        'group_members',
        'group_invites',
        'tasks',
        'task_logs',
      ])
        expect(await count(table)).toBe(0);
      // Bob’s own account is not touched.
      expect(await count('users')).toBe(1);
    });
  });

  describe('group_members', () => {
    it('defaults to a member who has not left', async () => {
      const owner = await addUser('ann@example.com');
      const bob = await addUser('bob@example.com');
      const group = await addGroup(owner);
      await addMember(group, bob);
      const [row] = await ds.query(
        `select role, deleted_at from group_members where user_id = $1`,
        [bob],
      );
      expect(row).toEqual({ role: 'member', deleted_at: null });
    });

    it('takes the roles owner and member and no other', async () => {
      const owner = await addUser('ann@example.com');
      const bob = await addUser('bob@example.com');
      const group = await addGroup(owner);
      await expect(
        ds.query(
          `insert into group_members (group_id, user_id, role) values ($1, $2, 'admin')`,
          [group, bob],
        ),
      ).rejects.toThrow(/group_members_role_check/);
    });

    it('keeps one row per group and user', async () => {
      const owner = await addUser('ann@example.com');
      const group = await addGroup(owner);
      await expect(addMember(group, owner)).rejects.toThrow(
        /group_members_pkey/,
      );
    });

    it('refuses a group or a user that does not exist', async () => {
      const owner = await addUser('ann@example.com');
      const group = await addGroup(owner);
      await expect(addMember(NOBODY, owner)).rejects.toThrow(
        /group_members_group_id_fkey/,
      );
      await expect(addMember(group, NOBODY)).rejects.toThrow(
        /group_members_user_id_fkey/,
      );
    });

    it('stamps updated_at and moves it on update', async () => {
      const owner = await addUser('ann@example.com');
      const bob = await addUser('bob@example.com');
      const group = await addGroup(owner);
      await ds.query(
        `insert into group_members (group_id, user_id, updated_at) values ($1, $2, '2000-01-01')`,
        [group, bob],
      );
      const [{ before, fresh }] = await ds.query(
        `select updated_at::text before, updated_at > '2020-01-01' fresh
         from group_members where user_id = $1`,
        [bob],
      );
      expect(fresh).toBe(true);
      await removeMember(group, bob);
      const [{ moved }] = await ds.query(
        `select updated_at > $1::timestamptz moved from group_members where user_id = $2`,
        [before, bob],
      );
      expect(moved).toBe(true);
    });

    it('goes away with the user', async () => {
      const owner = await addUser('ann@example.com');
      const bob = await addUser('bob@example.com');
      const group = await addGroup(owner);
      await addMember(group, bob);
      await ds.query(`delete from users where id = $1`, [bob]);
      expect(await count('group_members')).toBe(1);
    });
  });

  describe('group_invites', () => {
    const addCode = (group: string, code: string) =>
      ds.query(`insert into group_invites (group_id, code) values ($1, $2)`, [
        group,
        code,
      ]);

    it('takes exactly six digits', async () => {
      const owner = await addUser('ann@example.com');
      const group = await addGroup(owner);
      await addCode(group, '000000');
      for (const bad of [
        '12345',
        '1234567',
        'abcdef',
        '12a456',
        ' 12345',
        '12345\n',
        '',
      ]) {
        const other = await addGroup(owner, 'other');
        await expect(addCode(other, bad)).rejects.toThrow(
          /group_invites_code_check/,
        );
      }
    });

    it('keeps one code per group and a code for one group only', async () => {
      const owner = await addUser('ann@example.com');
      const one = await addGroup(owner, 'one');
      const two = await addGroup(owner, 'two');
      await addCode(one, '111111');
      await expect(addCode(one, '222222')).rejects.toThrow(
        /group_invites_pkey/,
      );
      await expect(addCode(two, '111111')).rejects.toThrow(
        /group_invites_code_key/,
      );
    });

    it('refuses a group that does not exist', async () => {
      await expect(addCode(NOBODY, '123456')).rejects.toThrow(
        /group_invites_group_id_fkey/,
      );
    });
  });

  describe('group_join_failures', () => {
    it('records a time by itself, one row per attempt', async () => {
      const user = await addUser('ann@example.com');
      for (let i = 0; i < 3; i++)
        await ds.query(
          `insert into group_join_failures (user_id) values ($1)`,
          [user],
        );
      const [{ n, recent }] = await ds.query(
        `select count(*)::int n, bool_and(at > now() - interval '1 minute') recent
         from group_join_failures`,
      );
      expect(n).toBe(3);
      expect(recent).toBe(true);
    });

    it('refuses a user that does not exist, and goes away with the user', async () => {
      await expect(
        ds.query(`insert into group_join_failures (user_id) values ($1)`, [
          NOBODY,
        ]),
      ).rejects.toThrow(/group_join_failures_user_id_fkey/);
      const user = await addUser('ann@example.com');
      await ds.query(`insert into group_join_failures (user_id) values ($1)`, [
        user,
      ]);
      await ds.query(`delete from users where id = $1`, [user]);
      expect(await count('group_join_failures')).toBe(0);
    });
  });

  describe('a task of a group', () => {
    it('refuses a group that does not exist', async () => {
      const user = await addUser('ann@example.com');
      await expect(addTask(user, T1, { group_id: NOBODY })).rejects.toThrow(
        /tasks_group_id_fkey/,
      );
    });

    it('is a one-off task: no repeat, no parent, not the value mode', async () => {
      const user = await addUser('ann@example.com');
      const group = await addGroup(user);
      await addTask(user, T3);
      for (const [name, fields] of [
        ['repeat', { repeat_type: 'daily' }],
        ['parent', { parent_id: T3 }],
        ['value', { tracking_mode: 'value' }],
      ] as const) {
        await expect(
          addTask(user, name === 'repeat' ? T1 : T2, {
            group_id: group,
            ...fields,
          }),
        ).rejects.toThrow(/tasks_group_task_shape/);
      }
      for (const tracking_mode of ['checkbox', 'counter', 'timer'])
        await addTask(
          user,
          id(10 + ['checkbox', 'counter', 'timer'].indexOf(tracking_mode)),
          {
            group_id: group,
            tracking_mode,
          },
        );
    });

    it('leaves personal tasks free to repeat and to have subtasks', async () => {
      const user = await addUser('ann@example.com');
      await addTask(user, T1, {
        repeat_type: 'weekly',
        tracking_mode: 'value',
      });
      await addTask(user, T2, { parent_id: T1 });
      expect(await count('tasks')).toBe(2);
    });

    // The guard trigger empties these assignees first; the constraints are what is left under it.
    async function withoutGuard(run: () => Promise<void>) {
      await ds.query(`alter table tasks disable trigger tasks_guard_group`);
      try {
        await run();
      } finally {
        await ds.query(`alter table tasks enable trigger tasks_guard_group`);
      }
    }

    it('refuses an assignee without a group, when the guard is off', async () => {
      const user = await addUser('ann@example.com');
      await withoutGuard(async () => {
        await expect(addTask(user, T1, { assignee_id: user })).rejects.toThrow(
          /tasks_assignee_needs_group/,
        );
      });
    });

    it('refuses an assignee that does not exist, when the guard is off', async () => {
      const user = await addUser('ann@example.com');
      const group = await addGroup(user);
      await withoutGuard(async () => {
        await expect(
          addTask(user, T1, { group_id: group, assignee_id: NOBODY }),
        ).rejects.toThrow(/tasks_assignee_id_fkey/);
      });
    });

    it('loses its assignee when the assignee’s account goes away, and stays', async () => {
      const ann = await addUser('ann@example.com');
      const bob = await addUser('bob@example.com');
      const group = await addGroup(ann);
      await addMember(group, bob);
      await addTask(ann, T1, { group_id: group, assignee_id: bob });
      expect((await taskRow(T1)).assignee_id).toBe(bob);
      await ds.query(`delete from users where id = $1`, [bob]);
      expect(await taskRow(T1)).toMatchObject({
        assignee_id: null,
        group_id: group,
      });
    });

    it('is removed together with its author', async () => {
      const ann = await addUser('ann@example.com');
      const bob = await addUser('bob@example.com');
      const group = await addGroup(ann);
      await addMember(group, bob);
      await addTask(bob, T1, { group_id: group });
      await ds.query(`delete from users where id = $1`, [bob]);
      expect(await count('tasks')).toBe(0);
      expect(await count('groups')).toBe(1);
    });
  });

  describe('the guard on a task of a group', () => {
    let ann: string;
    let bob: string;
    let cat: string;
    let group: string;
    beforeEach(async () => {
      ann = await addUser('ann@example.com');
      bob = await addUser('bob@example.com');
      cat = await addUser('cat@example.com');
      group = await addGroup(ann);
      await addMember(group, bob);
    });

    it('keeps an assignee who is in the group', async () => {
      await addTask(ann, T1, { group_id: group, assignee_id: bob });
      expect((await taskRow(T1)).assignee_id).toBe(bob);
    });

    it('empties an assignee who is not in the group, instead of refusing the task', async () => {
      await addTask(ann, T1, { group_id: group, assignee_id: cat });
      expect(await taskRow(T1)).toMatchObject({
        assignee_id: null,
        user_id: ann,
      });
    });

    it('empties an assignee who has left', async () => {
      await removeMember(group, bob);
      await addTask(ann, T1, { group_id: group, assignee_id: bob });
      expect((await taskRow(T1)).assignee_id).toBeNull();
    });

    it('empties an assignee named on an update, too', async () => {
      await addTask(ann, T1, { group_id: group });
      await ds.query(`update tasks set assignee_id = $1 where id = $2`, [
        cat,
        T1,
      ]);
      expect((await taskRow(T1)).assignee_id).toBeNull();
      await ds.query(`update tasks set assignee_id = $1 where id = $2`, [
        bob,
        T1,
      ]);
      expect((await taskRow(T1)).assignee_id).toBe(bob);
    });

    it('empties an assignee on a personal task', async () => {
      await addTask(ann, T1, { assignee_id: ann });
      expect((await taskRow(T1)).assignee_id).toBeNull();
    });

    it('does not let the author or the group change after creation', async () => {
      const other = await addGroup(bob, 'other');
      await addTask(ann, T1, { group_id: group });
      await ds.query(
        `update tasks set user_id = $1, group_id = $2, title = 'new' where id = $3`,
        [bob, other, T1],
      );
      expect(await taskRow(T1)).toMatchObject({
        user_id: ann,
        group_id: group,
        title: 'new',
      });
    });

    it('does not let the owner of a personal task change either', async () => {
      await addTask(ann, T1);
      await ds.query(
        `update tasks set user_id = $1, group_id = $2 where id = $3`,
        [bob, group, T1],
      );
      expect(await taskRow(T1)).toMatchObject({ user_id: ann, group_id: null });
    });

    it('keeps the author through an upsert by someone else', async () => {
      await addTask(ann, T1, { group_id: group });
      await ds.query(
        `insert into tasks (id, user_id, title) values ($1, $2, 'taken')
         on conflict (id) do update set user_id = excluded.user_id, title = excluded.title`,
        [T1, bob],
      );
      expect(await taskRow(T1)).toMatchObject({ user_id: ann, title: 'taken' });
    });
  });

  describe('deleting a task of a group', () => {
    it('empties it, lets go of the assignee, keeps the group and the author, and erases every member’s marks', async () => {
      const ann = await addUser('ann@example.com');
      const bob = await addUser('bob@example.com');
      const group = await addGroup(ann);
      await addMember(group, bob);
      await addTask(ann, T1, {
        group_id: group,
        assignee_id: bob,
        title: 'Buy milk',
      });
      await addLog(T1, bob);
      await ds.query(`update tasks set deleted_at = now() where id = $1`, [T1]);
      expect(await taskRow(T1)).toMatchObject({
        title: '',
        assignee_id: null,
        group_id: group,
        user_id: ann,
      });
      expect(await count('task_logs')).toBe(0);
    });

    it('empties a group task that is created already deleted', async () => {
      const ann = await addUser('ann@example.com');
      const group = await addGroup(ann);
      await addTask(ann, T1, {
        group_id: group,
        title: 'x',
        deleted_at: new Date(),
      });
      expect(await taskRow(T1)).toMatchObject({ title: '', group_id: group });
    });
  });

  describe('who may mark a task (can_mark_task)', () => {
    let ann: string;
    let bob: string;
    let cat: string;
    let group: string;
    beforeEach(async () => {
      ann = await addUser('ann@example.com');
      bob = await addUser('bob@example.com');
      cat = await addUser('cat@example.com');
      group = await addGroup(ann);
      await addMember(group, bob);
    });

    it('lets only the owner mark a personal task', async () => {
      await addTask(ann, T1);
      expect(await canMark(T1, ann)).toBe(true);
      expect(await canMark(T1, bob)).toBe(false);
    });

    it('lets every member mark a task for everyone, and nobody else', async () => {
      await addTask(ann, T1, { group_id: group });
      expect(await canMark(T1, ann)).toBe(true);
      expect(await canMark(T1, bob)).toBe(true);
      expect(await canMark(T1, cat)).toBe(false);
    });

    it('lets only the assignee mark a task for someone', async () => {
      await addTask(ann, T1, { group_id: group, assignee_id: bob });
      expect(await canMark(T1, bob)).toBe(true);
      expect(await canMark(T1, ann)).toBe(false);
      expect(await canMark(T1, cat)).toBe(false);
    });

    it('refuses a member who has left', async () => {
      await addTask(ann, T1, { group_id: group });
      await removeMember(group, bob);
      expect(await canMark(T1, bob)).toBe(false);
    });

    it('does not know a task that is not there: null, not false', async () => {
      expect(await canMark(T1, ann)).toBeNull();
    });
  });

  describe('a mark nobody may make', () => {
    let ann: string;
    let bob: string;
    let cat: string;
    let group: string;
    beforeEach(async () => {
      ann = await addUser('ann@example.com');
      bob = await addUser('bob@example.com');
      cat = await addUser('cat@example.com');
      group = await addGroup(ann);
      await addMember(group, bob);
    });

    it('is skipped without an error: another user’s mark on a personal task', async () => {
      await addTask(ann, T1);
      await addLog(T1, bob);
      expect(await count('task_logs')).toBe(0);
      await addLog(T1, ann);
      expect(await count('task_logs')).toBe(1);
    });

    it('is stored for every member of a group task, one per person', async () => {
      await addTask(ann, T1, { group_id: group });
      await addLog(T1, ann);
      await addLog(T1, bob);
      expect(await count('task_logs')).toBe(2);
    });

    it('is skipped for someone outside the group, for a member who left and for the wrong assignee', async () => {
      await addTask(ann, T1, { group_id: group });
      await addTask(ann, T2, { group_id: group, assignee_id: bob });
      await addLog(T1, cat);
      await addLog(T2, ann);
      await removeMember(group, bob);
      await addLog(T1, bob);
      await addLog(T2, bob);
      expect(await count('task_logs')).toBe(0);
    });

    it('is skipped as an upsert too, and does not stop the others of the statement', async () => {
      await addTask(ann, T1, { group_id: group });
      await addTask(ann, T2, { group_id: group, assignee_id: bob });
      await ds.query(
        `insert into task_logs (task_id, user_id, date) values ($1, $2, '2026-01-15'), ($3, $2, '2026-01-15')
         on conflict (task_id, user_id, date) do update set completed = true`,
        [T1, ann, T2],
      );
      const rows = await ds.query(`select task_id from task_logs`);
      expect(rows).toEqual([{ task_id: T1 }]);
    });

    it('is still refused loudly for a task that is not on the server', async () => {
      await expect(addLog(T3, ann)).rejects.toThrow(/task_logs_task_id_fkey/);
    });

    it('is skipped for a deleted group task, as before', async () => {
      await addTask(ann, T1, { group_id: group });
      await ds.query(`update tasks set deleted_at = now() where id = $1`, [T1]);
      await addLog(T1, bob);
      expect(await count('task_logs')).toBe(0);
    });

    it('lets an update that keeps the key of a mark through, even for someone who has left (the touch of a join)', async () => {
      await addTask(ann, T1, { group_id: group });
      await addLog(T1, bob);
      await removeMember(group, bob);
      await ds.query(
        `update task_logs set completed = false where task_id = $1`,
        [T1],
      );
      const [row] = await ds.query(`select completed from task_logs`);
      expect(row.completed).toBe(false);
    });

    it('still skips an update that moves a mark to someone who may not have it', async () => {
      await addTask(ann, T1, { group_id: group });
      await addLog(T1, ann);
      await ds.query(`update task_logs set user_id = $1`, [cat]);
      expect(await ds.query(`select user_id from task_logs`)).toEqual([
        { user_id: ann },
      ]);
      // ... nor to a task of someone else.
      await addTask(bob, T3);
      await ds.query(`update task_logs set task_id = $1`, [T3]);
      expect(await ds.query(`select task_id from task_logs`)).toEqual([
        { task_id: T1 },
      ]);
    });

    it('keeps a member’s old marks when they leave', async () => {
      await addTask(ann, T1, { group_id: group });
      await addLog(T1, bob);
      await removeMember(group, bob);
      expect(await count('task_logs')).toBe(1);
    });
  });
});
