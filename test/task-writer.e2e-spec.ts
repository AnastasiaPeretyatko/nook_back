import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { parseTask, TaskRow } from '../src/sync/push-rows';
import { TaskWriter } from '../src/sync/task-writer';
import { createTestApp, truncateAll } from './support/db';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [A, B, C, D] = [id(1), id(2), id(3), id(4)];

// Rows go through the same check as in a real push.
const task = (fields: Record<string, unknown>): TaskRow => {
  const result = parseTask(fields);
  if (!('row' in result)) throw new Error('bad test row');
  return result.row;
};

describe('TaskWriter', () => {
  let app: INestApplication;
  let ds: DataSource;
  let writer: TaskWriter;
  let ann: string;
  let bob: string;

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
    writer = app.get(TaskWriter);
  });

  beforeEach(async () => {
    await truncateAll(ds);
    ann = await addUser('ann@example.com');
    bob = await addUser('bob@example.com');
  });

  afterAll(() => app.close());

  async function addUser(email: string) {
    const [row] = await ds.query(
      `insert into users (email, password_hash) values ($1, 'hash') returning id`,
      [email],
    );
    return row.id as string;
  }

  // One push transaction, as the route will run it.
  const write = (userId: string, rows: TaskRow[]) =>
    ds.transaction((manager) => writer.write(manager, userId, rows));

  const taskRow = async (taskId: string) => {
    const rows: Record<string, unknown>[] = await ds.query(
      `select * from tasks where id = $1`,
      [taskId],
    );
    return rows[0];
  };
  const count = async () =>
    (await ds.query(`select count(*)::int n from tasks`))[0].n as number;

  it('writes a new task with every field, under the caller', async () => {
    const rejected = await write(ann, [
      task({
        id: A,
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
        created_at: '2026-01-15T10:00:00.123456Z',
        client_updated_at: '2026-01-15T10:00:01.654321Z',
      }),
    ]);
    expect(rejected).toEqual([]);
    expect(await taskRow(A)).toMatchObject({
      user_id: ann,
      parent_id: null,
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
      deleted_at: null,
    });
    // Days and microseconds survive exactly (read back as text, not through a JS Date).
    const [{ d, created, client }] = await ds.query(
      `select start_date::text as d, created_at::text created, client_updated_at::text client
       from tasks`,
    );
    expect(d).toBe('2026-03-01');
    expect(created).toBe('2026-01-15 10:00:00.123456+00');
    expect(client).toBe('2026-01-15 10:00:01.654321+00');
  });

  it('stamps updated_at on the server, whatever the client says', async () => {
    await write(ann, [
      task({ id: A, client_updated_at: '2000-01-01T00:00:00Z' }),
    ]);
    const [{ fresh }] = await ds.query(
      `select updated_at > '2020-01-01' fresh from tasks`,
    );
    expect(fresh).toBe(true);
  });

  it('does nothing for an empty list', async () => {
    expect(await write(ann, [])).toEqual([]);
    expect(await count()).toBe(0);
  });

  describe('updating', () => {
    it('overwrites the data of its own task but keeps created_at', async () => {
      await write(ann, [
        task({ id: A, title: 'old', created_at: '2026-01-01T00:00:00Z' }),
      ]);
      await write(ann, [
        task({
          id: A,
          title: 'new',
          status: 'archived',
          created_at: '2026-02-02T00:00:00Z',
          client_updated_at: '2026-02-02T00:00:00Z',
        }),
      ]);
      const [{ created }] = await ds.query(
        `select created_at::text created from tasks`,
      );
      expect(await taskRow(A)).toMatchObject({
        title: 'new',
        status: 'archived',
      });
      expect(created).toBe('2026-01-01 00:00:00+00');
      expect(await count()).toBe(1);
    });

    it('clears a field the new version no longer has', async () => {
      await write(ann, [
        task({ id: A, description: 'x', repeat_type: 'daily' }),
      ]);
      await write(ann, [task({ id: A })]);
      expect(await taskRow(A)).toMatchObject({
        description: null,
        repeat_type: null,
      });
    });

    it('moves updated_at forward', async () => {
      await write(ann, [task({ id: A })]);
      const [{ before }] = await ds.query(
        `select updated_at::text before from tasks`,
      );
      await write(ann, [task({ id: A, title: 'x' })]);
      const [{ moved }] = await ds.query(
        `select updated_at > $1::timestamptz moved from tasks`,
        [before],
      );
      expect(moved).toBe(true);
    });

    it('is idempotent: the same batch twice leaves the same rows and refuses nothing', async () => {
      const rows = [task({ id: A, title: 'a' }), task({ id: B, parent_id: A })];
      expect(await write(ann, rows)).toEqual([]);
      const first = await ds.query(
        `select id, parent_id, title, created_at::text c from tasks order by id`,
      );
      expect(await write(ann, rows)).toEqual([]);
      expect(
        await ds.query(
          `select id, parent_id, title, created_at::text c from tasks order by id`,
        ),
      ).toEqual(first);
    });
  });

  describe("another user's tasks", () => {
    it('does not touch a task that belongs to someone else, and reports id_taken', async () => {
      await write(bob, [task({ id: A, title: "Bob's" })]);
      const rejected = await write(ann, [task({ id: A, title: 'Hijacked' })]);
      expect(rejected).toEqual([{ table: 'tasks', id: A, reason: 'id_taken' }]);
      expect(await taskRow(A)).toMatchObject({ user_id: bob, title: "Bob's" });
    });

    it("still leaves Bob's task alone if the check misses it (a race between check and write)", async () => {
      await write(bob, [task({ id: A, title: "Bob's" })]);
      await ds.transaction(async (manager) => {
        // The look-up claims A does not exist, as if Bob's task appeared a moment later.
        const blind = Object.create(manager) as typeof manager;
        blind.query = ((sql: string, params?: unknown[]) =>
          sql.includes('with recursive')
            ? Promise.resolve([])
            : manager.query(sql, params)) as typeof manager.query;
        await writer.write(blind, ann, [task({ id: A, title: 'Hijacked' })]);
      });
      expect(await taskRow(A)).toMatchObject({ user_id: bob, title: "Bob's" });
    });

    it("does not touch Bob's task even when Ann tries to delete-and-revive it", async () => {
      await write(bob, [task({ id: A, title: "Bob's" })]);
      await ds.query(`update tasks set deleted_at = now() where id = $1`, [A]);
      expect(await write(ann, [task({ id: A, title: 'Mine' })])).toEqual([
        { table: 'tasks', id: A, reason: 'id_taken' },
      ]);
      expect(await taskRow(A)).toMatchObject({ user_id: bob, title: '' });
    });

    it("refuses a subtask under someone else's task, as an unknown parent", async () => {
      await write(bob, [task({ id: A })]);
      const rejected = await write(ann, [task({ id: B, parent_id: A })]);
      expect(rejected).toEqual([
        { table: 'tasks', id: B, reason: 'unknown_parent' },
      ]);
      expect(await count()).toBe(1);
    });

    it('lets two users each have their own tasks in one table', async () => {
      await write(ann, [task({ id: A })]);
      await write(bob, [task({ id: B })]);
      const rows = await ds.query(`select id, user_id from tasks order by id`);
      expect(rows).toEqual([
        { id: A, user_id: ann },
        { id: B, user_id: bob },
      ]);
    });
  });

  describe('subtasks', () => {
    it('takes a subtask that comes before its parent in the same batch', async () => {
      const rejected = await write(ann, [
        task({ id: B, parent_id: A }),
        task({ id: A }),
      ]);
      expect(rejected).toEqual([]);
      expect((await taskRow(B)).parent_id).toBe(A);
    });

    it('takes a subtask of a task saved earlier', async () => {
      await write(ann, [task({ id: A })]);
      expect(await write(ann, [task({ id: B, parent_id: A })])).toEqual([]);
    });

    it('refuses a subtask with no parent anywhere, and its descendants', async () => {
      const rejected = await write(ann, [
        task({ id: D, parent_id: C }),
        task({ id: C, parent_id: B }),
        task({ id: B, parent_id: A }),
        task({ id: id(9) }),
      ]);
      expect(rejected.map((r) => `${r.id}:${r.reason}`).sort()).toEqual([
        `${B}:unknown_parent`,
        `${C}:unknown_parent`,
        `${D}:unknown_parent`,
      ]);
      expect(await count()).toBe(1);
    });

    it('refuses a task that is its own parent', async () => {
      expect(await write(ann, [task({ id: A, parent_id: A })])).toEqual([
        { table: 'tasks', id: A, reason: 'parent_cycle' },
      ]);
      expect(await count()).toBe(0);
    });

    it('refuses a loop inside the batch', async () => {
      const rejected = await write(ann, [
        task({ id: A, parent_id: B }),
        task({ id: B, parent_id: A }),
      ]);
      expect(rejected.map((r) => r.reason)).toEqual([
        'parent_cycle',
        'parent_cycle',
      ]);
      expect(await count()).toBe(0);
    });

    it('refuses a move that would close a loop through saved tasks, and leaves them as they were', async () => {
      await write(ann, [task({ id: A }), task({ id: B, parent_id: A })]);
      const rejected = await write(ann, [task({ id: A, parent_id: B })]);
      expect(rejected).toEqual([
        { table: 'tasks', id: A, reason: 'parent_cycle' },
      ]);
      expect((await taskRow(A)).parent_id).toBeNull();
      expect((await taskRow(B)).parent_id).toBe(A);
    });

    it('refuses a move that would close a loop through a long saved chain', async () => {
      // D under C under B under A; moving A under D closes the loop two saved tasks away.
      await write(ann, [
        task({ id: A }),
        task({ id: B, parent_id: A }),
        task({ id: C, parent_id: B }),
        task({ id: D, parent_id: C }),
      ]);
      expect(await write(ann, [task({ id: A, parent_id: D })])).toEqual([
        { table: 'tasks', id: A, reason: 'parent_cycle' },
      ]);
      expect((await taskRow(A)).parent_id).toBeNull();
    });

    it('lets a subtask move to another parent', async () => {
      await write(ann, [
        task({ id: A }),
        task({ id: B }),
        task({ id: C, parent_id: A }),
      ]);
      expect(await write(ann, [task({ id: C, parent_id: B })])).toEqual([]);
      expect((await taskRow(C)).parent_id).toBe(B);
    });
  });

  describe('groups', () => {
    it('refuses a group task for now, and writes the rest', async () => {
      const rejected = await write(ann, [
        task({ id: A, group_id: id(50) }),
        task({ id: B }),
      ]);
      expect(rejected).toEqual([
        { table: 'tasks', id: A, reason: 'groups_not_supported' },
      ]);
      expect(await count()).toBe(1);
    });
  });

  describe('deleted tasks', () => {
    async function writeAndDelete(userId: string, taskId: string) {
      await write(userId, [
        task({ id: taskId, title: 'Read', repeat_type: 'daily' }),
      ]);
      await ds.query(`update tasks set deleted_at = now() where id = $1`, [
        taskId,
      ]);
    }

    it('stays deleted and empty when a device that missed it sends the task again', async () => {
      await writeAndDelete(ann, A);
      expect(
        await write(ann, [
          task({ id: A, title: 'Back again', repeat_type: 'daily' }),
        ]),
      ).toEqual([]);
      const row = await taskRow(A);
      expect(row).toMatchObject({ title: '', repeat_type: null });
      expect(row.deleted_at).not.toBeNull();
    });

    it('leaves a deleted task untouched, updated_at included', async () => {
      await writeAndDelete(ann, A);
      const [{ before }] = await ds.query(
        `select updated_at::text before from tasks`,
      );
      await write(ann, [task({ id: A, title: 'x' })]);
      const [{ same }] = await ds.query(
        `select updated_at = $1::timestamptz same from tasks`,
        [before],
      );
      expect(same).toBe(true);
    });

    it('still takes a subtask under a deleted parent', async () => {
      await writeAndDelete(ann, A);
      expect(await write(ann, [task({ id: B, parent_id: A })])).toEqual([]);
    });
  });

  describe('bad rows next to good ones', () => {
    it('writes the good rows and reports every refusal', async () => {
      const rejected = await write(ann, [
        task({ id: A }),
        task({ id: B, parent_id: id(77) }),
        task({ id: C, group_id: id(50) }),
        task({ id: D, parent_id: A }),
      ]);
      expect(rejected.map((r) => `${r.id}:${r.reason}`).sort()).toEqual([
        `${B}:unknown_parent`,
        `${C}:groups_not_supported`,
      ]);
      const rows = await ds.query(`select id from tasks order by id`);
      expect(rows.map((r: { id: string }) => r.id)).toEqual([A, D]);
    });
  });

  describe('duplicates in one batch', () => {
    it('keeps the last version instead of failing the statement', async () => {
      await write(ann, [
        task({ id: A, title: 'first' }),
        task({ id: A, title: 'second' }),
      ]);
      expect((await taskRow(A)).title).toBe('second');
    });
  });

  describe('text the database could choke on', () => {
    it('stores half an emoji as U+FFFD instead of failing the push', async () => {
      await write(ann, [task({ id: A, title: 'a\ud83d' }), task({ id: B })]);
      expect((await taskRow(A)).title).toBe('a�');
      expect(await count()).toBe(2);
    });

    it('keeps quotes, backslashes, newlines and emoji exactly', async () => {
      const title = 'He said "hi" \\ \n tab\t 😀 ё';
      await write(ann, [task({ id: A, title })]);
      expect((await taskRow(A)).title).toBe(title);
    });
  });

  it('writes 500 tasks, each under the previous one, in one go', async () => {
    const rows = Array.from({ length: 500 }, (_, i) =>
      task({ id: id(i + 1), parent_id: i === 0 ? null : id(i) }),
    ).reverse();
    expect(await write(ann, rows)).toEqual([]);
    expect(await count()).toBe(500);
  });

  it('rolls everything back with the push transaction', async () => {
    await expect(
      ds.transaction(async (manager) => {
        await writer.write(manager, ann, [task({ id: A })]);
        throw new Error('later step failed');
      }),
    ).rejects.toThrow('later step failed');
    expect(await count()).toBe(0);
  });
});
