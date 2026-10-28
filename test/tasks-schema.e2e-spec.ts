import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createTestApp, truncateAll } from './support/db';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
const NOBODY = '00000000-0000-4000-8000-000000000000';

describe('Task tables', () => {
  let app: INestApplication;
  let ds: DataSource;

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
  });

  beforeEach(() => truncateAll(ds));

  afterAll(() => app.close());

  async function addUser(email = 'a@example.com') {
    const [row] = await ds.query(
      `insert into users (email, password_hash) values ($1, 'hash') returning id`,
      [email],
    );
    return row.id as string;
  }

  // Raw SQL fragments after the id/user: `extra` is e.g. `, title`, `values` the matching values.
  function addTask(
    userId: string,
    id: string,
    fields: Record<string, unknown> = {},
  ) {
    const cols = ['id', 'user_id', ...Object.keys(fields)];
    const params = [id, userId, ...Object.values(fields)];
    return ds.query(
      `insert into tasks (${cols.join(', ')})
       values (${params.map((_, i) => `$${i + 1}`).join(', ')})`,
      params,
    );
  }

  const addLog = (taskId: string, userId: string, date = '2026-01-15') =>
    ds.query(
      `insert into task_logs (task_id, user_id, date, completed) values ($1, $2, $3, true)`,
      [taskId, userId, date],
    );

  const count = async (table: string) => {
    const [{ n }] = await ds.query(`select count(*)::int n from ${table}`);
    return n as number;
  };

  describe('tasks', () => {
    it('fills in the defaults of a bare task', async () => {
      const user = await addUser();
      await addTask(user, UUID_A);
      const [row] = await ds.query(`select * from tasks`);
      expect(row).toMatchObject({
        title: '',
        description: null,
        status: 'active',
        repeat_type: null,
        tracking_mode: 'checkbox',
        parent_id: null,
        deleted_at: null,
      });
    });

    it('refuses an unknown status, repeat type and tracking mode', async () => {
      const user = await addUser();
      await expect(addTask(user, UUID_A, { status: 'done' })).rejects.toThrow(
        /tasks_status_check/,
      );
      await expect(
        addTask(user, UUID_A, { repeat_type: 'yearly' }),
      ).rejects.toThrow(/tasks_repeat_type_check/);
      await expect(
        addTask(user, UUID_A, { tracking_mode: 'stopwatch' }),
      ).rejects.toThrow(/tasks_tracking_mode_check/);
    });

    it('accepts every allowed status, repeat type and tracking mode', async () => {
      const user = await addUser();
      let n = 0;
      const id = () =>
        `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
      for (const status of ['active', 'paused', 'archived'])
        await addTask(user, id(), { status });
      for (const repeat_type of ['daily', 'weekly', 'monthly', 'custom'])
        await addTask(user, id(), { repeat_type });
      for (const tracking_mode of ['checkbox', 'counter', 'timer', 'value'])
        await addTask(user, id(), { tracking_mode });
      expect(await count('tasks')).toBe(11);
    });

    it('refuses a task of a user that does not exist', async () => {
      await expect(addTask(NOBODY, UUID_A)).rejects.toThrow(
        /tasks_user_id_fkey/,
      );
    });

    it('refuses the same id twice', async () => {
      const user = await addUser();
      await addTask(user, UUID_A);
      await expect(addTask(user, UUID_A)).rejects.toThrow(/tasks_pkey/);
    });

    it('stores a day as a plain date, not a moment', async () => {
      const user = await addUser();
      await addTask(user, UUID_A, { start_date: '2026-03-01' });
      const [{ d }] = await ds.query(`select start_date::text as d from tasks`);
      expect(d).toBe('2026-03-01');
    });

    it('stamps updated_at on the server clock, ignoring the value given', async () => {
      const user = await addUser();
      await addTask(user, UUID_A, { updated_at: '2000-01-01' });
      const [row] = await ds.query(
        `select updated_at > '2020-01-01' as fresh from tasks`,
      );
      expect(row.fresh).toBe(true);
    });

    it('moves updated_at forward on every update', async () => {
      const user = await addUser();
      await addTask(user, UUID_A);
      // Compared inside Postgres: a JS Date only has milliseconds.
      const [{ before }] = await ds.query(
        `select updated_at::text as before from tasks`,
      );
      await ds.query(`update tasks set title = 'x'`);
      const [{ moved }] = await ds.query(
        `select updated_at > $1::timestamptz as moved from tasks`,
        [before],
      );
      expect(moved).toBe(true);
    });

    it('is removed together with its user, marks included', async () => {
      const user = await addUser();
      await addTask(user, UUID_A);
      await addLog(UUID_A, user);
      await ds.query(`delete from users where id = $1`, [user]);
      expect(await count('tasks')).toBe(0);
      expect(await count('task_logs')).toBe(0);
    });
  });

  describe('parent_id', () => {
    it('refuses a parent that does not exist', async () => {
      const user = await addUser();
      await expect(
        addTask(user, UUID_A, { parent_id: UUID_B }),
      ).rejects.toThrow(/tasks_parent_id_fkey/);
    });

    it('lets a subtask come before its parent inside one transaction', async () => {
      const user = await addUser();
      await ds.transaction(async (m) => {
        await m.query(
          `insert into tasks (id, user_id, parent_id) values ($1, $2, $3)`,
          [UUID_B, user, UUID_A],
        );
        await m.query(`insert into tasks (id, user_id) values ($1, $2)`, [
          UUID_A,
          user,
        ]);
      });
      expect(await count('tasks')).toBe(2);
    });

    it('still refuses at commit if the parent never arrives', async () => {
      const user = await addUser();
      await expect(
        ds.transaction((m) =>
          m.query(
            `insert into tasks (id, user_id, parent_id) values ($1, $2, $3)`,
            [UUID_B, user, UUID_A],
          ),
        ),
      ).rejects.toThrow(/tasks_parent_id_fkey/);
      expect(await count('tasks')).toBe(0);
    });

    it('removes subtasks together with a really deleted parent', async () => {
      const user = await addUser();
      await addTask(user, UUID_A);
      await addTask(user, UUID_B, { parent_id: UUID_A });
      await ds.query(`delete from tasks where id = $1`, [UUID_A]);
      expect(await count('tasks')).toBe(0);
    });
  });

  describe('task_logs', () => {
    it('refuses a mark of a task that does not exist', async () => {
      const user = await addUser();
      await expect(addLog(UUID_A, user)).rejects.toThrow(
        /task_logs_task_id_fkey/,
      );
    });

    it('refuses a mark of a user that does not exist', async () => {
      const user = await addUser();
      await addTask(user, UUID_A);
      // The trigger that skips marks nobody may make would swallow this one before the key looks.
      await ds.query(
        `alter table task_logs disable trigger task_logs_skip_unmarkable`,
      );
      try {
        await expect(addLog(UUID_A, NOBODY)).rejects.toThrow(
          /task_logs_user_id_fkey/,
        );
      } finally {
        await ds.query(
          `alter table task_logs enable trigger task_logs_skip_unmarkable`,
        );
      }
    });

    it('keeps one mark per task, user and day', async () => {
      const ann = await addUser('ann@example.com');
      const bob = await addUser('bob@example.com');
      // A group task, so that both can mark it (a personal task takes only its owner's marks).
      const [{ id: group }] = await ds.query(
        `insert into groups (name, owner_id) values ('g', $1) returning id`,
        [ann],
      );
      await ds.query(
        `insert into group_members (group_id, user_id, role)
         values ($1, $2, 'owner'), ($1, $3, 'member')`,
        [group, ann, bob],
      );
      await addTask(ann, UUID_A, { group_id: group });
      await addLog(UUID_A, ann);
      await expect(addLog(UUID_A, ann)).rejects.toThrow(/task_logs_pkey/);
      // Another day, or another user on the same day, is a different mark.
      await addLog(UUID_A, ann, '2026-01-16');
      await addLog(UUID_A, bob);
      expect(await count('task_logs')).toBe(3);
    });

    it('defaults to not completed, with no value and no tick time', async () => {
      const user = await addUser();
      await addTask(user, UUID_A);
      await ds.query(
        `insert into task_logs (task_id, user_id, date) values ($1, $2, '2026-01-15')`,
        [UUID_A, user],
      );
      const [row] = await ds.query(`select * from task_logs`);
      expect(row).toMatchObject({
        completed: false,
        value: null,
        completed_at: null,
      });
    });

    it('stamps updated_at on the server clock and moves it on update', async () => {
      const user = await addUser();
      await addTask(user, UUID_A);
      await ds.query(
        `insert into task_logs (task_id, user_id, date, updated_at)
         values ($1, $2, '2026-01-15', '2000-01-01')`,
        [UUID_A, user],
      );
      const [{ before, fresh }] = await ds.query(
        `select updated_at::text before, updated_at > '2020-01-01' fresh from task_logs`,
      );
      expect(fresh).toBe(true);
      await ds.query(`update task_logs set value = 3`);
      const [{ moved }] = await ds.query(
        `select updated_at > $1::timestamptz moved from task_logs`,
        [before],
      );
      expect(moved).toBe(true);
    });
  });

  describe('deleting a task', () => {
    const FULL = {
      parent_id: UUID_B,
      title: 'Read',
      description: 'ten pages',
      status: 'paused',
      repeat_type: 'weekly',
      repeat_interval: 2,
      repeat_days_mask: 5,
      tracking_mode: 'counter',
      target_duration_minutes: 30,
      target_value: 10.5,
      icon_key: 'book',
      color_key: 'violet',
      scheduled_time_minutes: 600,
      end_time_minutes: 660,
      start_date: '2026-03-01',
    };

    async function addFullTask(user: string) {
      await addTask(user, UUID_B);
      await addTask(user, UUID_A, FULL);
    }

    const blanked = {
      parent_id: null,
      title: '',
      description: null,
      status: 'active',
      repeat_type: null,
      repeat_interval: null,
      repeat_days_mask: null,
      tracking_mode: 'checkbox',
      target_duration_minutes: null,
      target_value: null,
      icon_key: null,
      color_key: null,
      scheduled_time_minutes: null,
      end_time_minutes: null,
      start_date: null,
    };

    it('empties the task and erases its marks, keeping only id, owner and deleted_at', async () => {
      const user = await addUser();
      await addFullTask(user);
      await addLog(UUID_A, user);
      await addLog(UUID_A, user, '2026-01-16');
      await ds.query(`update tasks set deleted_at = now() where id = $1`, [
        UUID_A,
      ]);
      const [row] = await ds.query(`select * from tasks where id = $1`, [
        UUID_A,
      ]);
      expect(row).toMatchObject({ ...blanked, user_id: user });
      expect(row.deleted_at).not.toBeNull();
      expect(await count('task_logs')).toBe(0);
    });

    it('leaves other tasks and their marks alone', async () => {
      const user = await addUser();
      await addFullTask(user);
      await addLog(UUID_A, user);
      await addLog(UUID_B, user);
      await ds.query(`update tasks set deleted_at = now() where id = $1`, [
        UUID_A,
      ]);
      const [other] = await ds.query(
        `select title, deleted_at from tasks where id = $1`,
        [UUID_B],
      );
      expect(other.deleted_at).toBeNull();
      const logs = await ds.query(`select task_id from task_logs`);
      expect(logs).toEqual([{ task_id: UUID_B }]);
    });

    it('moves updated_at forward, so other devices pull the deletion', async () => {
      const user = await addUser();
      await addFullTask(user);
      const [{ before }] = await ds.query(
        `select updated_at::text before from tasks where id = $1`,
        [UUID_A],
      );
      await ds.query(`update tasks set deleted_at = now() where id = $1`, [
        UUID_A,
      ]);
      const [{ moved }] = await ds.query(
        `select updated_at > $1::timestamptz moved from tasks where id = $2`,
        [before, UUID_A],
      );
      expect(moved).toBe(true);
    });

    it('stays empty when a device that missed the deletion pushes the task again', async () => {
      const user = await addUser();
      await addFullTask(user);
      await ds.query(`update tasks set deleted_at = now() where id = $1`, [
        UUID_A,
      ]);
      // The same upsert the push will use: it names the data columns, not deleted_at.
      await ds.query(
        `insert into tasks (id, user_id, title, status, repeat_type)
         values ($1, $2, 'Back again', 'paused', 'daily')
         on conflict (id) do update
           set title = excluded.title, status = excluded.status,
               repeat_type = excluded.repeat_type`,
        [UUID_A, user],
      );
      const [row] = await ds.query(`select * from tasks where id = $1`, [
        UUID_A,
      ]);
      expect(row).toMatchObject(blanked);
      expect(row.deleted_at).not.toBeNull();
    });

    it('does not erase the marks of an existing task when a deleted row with its id loses the insert', async () => {
      // A BEFORE INSERT trigger runs before the conflict is noticed; it must not touch the marks.
      const user = await addUser();
      await addTask(user, UUID_A);
      await addLog(UUID_A, user);
      const other = await addUser('other@example.com');
      await ds.query(
        `insert into tasks (id, user_id, deleted_at) values ($1, $2, now())
         on conflict (id) do nothing`,
        [UUID_A, other],
      );
      expect(await count('task_logs')).toBe(1);
    });

    it('empties a task that is created already deleted (a tombstone)', async () => {
      const user = await addUser();
      await addTask(user, UUID_A, {
        ...FULL,
        parent_id: null,
        deleted_at: '2026-01-01',
      });
      const [row] = await ds.query(`select * from tasks`);
      expect(row).toMatchObject(blanked);
      expect(row.deleted_at).not.toBeNull();
    });

    it('does not touch a task that is not deleted', async () => {
      const user = await addUser();
      await addFullTask(user);
      await ds.query(`update tasks set title = 'Read more' where id = $1`, [
        UUID_A,
      ]);
      const [row] = await ds.query(
        `select title, repeat_type from tasks where id = $1`,
        [UUID_A],
      );
      expect(row).toEqual({ title: 'Read more', repeat_type: 'weekly' });
    });
  });

  describe('a mark of a deleted task', () => {
    async function addDeletedTask(user: string) {
      await addTask(user, UUID_A);
      await ds.query(`update tasks set deleted_at = now() where id = $1`, [
        UUID_A,
      ]);
    }

    it('is skipped without an error', async () => {
      const user = await addUser();
      await addDeletedTask(user);
      await addLog(UUID_A, user);
      expect(await count('task_logs')).toBe(0);
    });

    it('is skipped when it comes as an upsert too', async () => {
      const user = await addUser();
      await addDeletedTask(user);
      await ds.query(
        `insert into task_logs (task_id, user_id, date, completed)
         values ($1, $2, '2026-01-15', true)
         on conflict (task_id, user_id, date) do update set completed = excluded.completed`,
        [UUID_A, user],
      );
      expect(await count('task_logs')).toBe(0);
    });

    it('does not stop the other marks of the same statement', async () => {
      const user = await addUser();
      await addDeletedTask(user);
      await addTask(user, UUID_C);
      await ds.query(
        `insert into task_logs (task_id, user_id, date, completed)
         values ($1, $3, '2026-01-15', true), ($2, $3, '2026-01-15', true)`,
        [UUID_A, UUID_C, user],
      );
      const logs = await ds.query(`select task_id from task_logs`);
      expect(logs).toEqual([{ task_id: UUID_C }]);
    });

    it('is stored as usual for a task that is not deleted', async () => {
      const user = await addUser();
      await addTask(user, UUID_A);
      await addLog(UUID_A, user);
      expect(await count('task_logs')).toBe(1);
    });
  });
});
