import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DeletionWriter } from '../src/sync/deletion-writer';
import { LogWriter } from '../src/sync/log-writer';
import {
  DeletedRow,
  LogRow,
  parseDeleted,
  parseLog,
  parseTask,
  TaskRow,
} from '../src/sync/push-rows';
import { TaskWriter } from '../src/sync/task-writer';
import { createTestApp, truncateAll } from './support/db';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [T1, T2, T3] = [id(1), id(2), id(3)];

// Rows go through the same check as in a real push.
const ok = <T>(result: { row: T } | { id: string | null }): T => {
  if (!('row' in result)) throw new Error('bad test row');
  return result.row;
};
const task = (fields: Record<string, unknown>): TaskRow =>
  ok(parseTask(fields));
const log = (taskId: string, date: string): LogRow =>
  ok(parseLog({ task_id: taskId, date, completed: true }));
const gone = (table: string, rowId: string): DeletedRow =>
  ok(parseDeleted({ table, id: rowId }));

describe('DeletionWriter', () => {
  let app: INestApplication;
  let ds: DataSource;
  let tasks: TaskWriter;
  let logs: LogWriter;
  let deletions: DeletionWriter;
  let ann: string;
  let bob: string;

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
    tasks = app.get(TaskWriter);
    logs = app.get(LogWriter);
    deletions = app.get(DeletionWriter);
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

  const addTask = (userId: string, taskId: string, fields = {}) =>
    ds.transaction((m) =>
      tasks.write(m, userId, [
        task({ id: taskId, title: 'Read', repeat_type: 'daily', ...fields }),
      ]),
    );
  const addLog = (userId: string, taskId: string, date: string) =>
    ds.transaction((m) => logs.write(m, userId, [log(taskId, date)]));
  const remove = (userId: string, rows: DeletedRow[]) =>
    ds.transaction((m) => deletions.write(m, userId, rows));

  const taskRow = async (taskId: string) => {
    const rows: Record<string, unknown>[] = await ds.query(
      `select * from tasks where id = $1`,
      [taskId],
    );
    return rows[0];
  };
  const logCount = async () =>
    (await ds.query(`select count(*)::int n from task_logs`))[0].n as number;

  it('marks a task deleted, empties it and erases its marks', async () => {
    await addTask(ann, T1, { description: 'ten pages', icon_key: 'book' });
    await addLog(ann, T1, '2026-01-15');
    await addLog(ann, T1, '2026-01-16');

    expect(await remove(ann, [gone('tasks', T1)])).toEqual([]);

    const row = await taskRow(T1);
    expect(row).toMatchObject({
      user_id: ann,
      title: '',
      description: null,
      repeat_type: null,
      icon_key: null,
    });
    expect(row.deleted_at).not.toBeNull();
    expect(await logCount()).toBe(0);
  });

  it('moves updated_at forward, so other devices pull the deletion', async () => {
    await addTask(ann, T1);
    const [{ before }] = await ds.query(
      `select updated_at::text before from tasks`,
    );
    await remove(ann, [gone('tasks', T1)]);
    const [{ moved }] = await ds.query(
      `select updated_at > $1::timestamptz moved from tasks`,
      [before],
    );
    expect(moved).toBe(true);
  });

  it('leaves other tasks and their marks alone', async () => {
    await addTask(ann, T1);
    await addTask(ann, T2);
    await addLog(ann, T2, '2026-01-15');
    await remove(ann, [gone('tasks', T1)]);
    expect((await taskRow(T2)).title).toBe('Read');
    expect((await taskRow(T2)).deleted_at).toBeNull();
    expect(await logCount()).toBe(1);
  });

  it('does not delete the subtasks of a deleted task (the app sends those itself)', async () => {
    await addTask(ann, T1);
    await addTask(ann, T2, { parent_id: T1 });
    await remove(ann, [gone('tasks', T1)]);
    expect((await taskRow(T2)).deleted_at).toBeNull();
  });

  describe('repeating a deletion', () => {
    it('changes nothing: neither deleted_at nor updated_at', async () => {
      await addTask(ann, T1);
      await remove(ann, [gone('tasks', T1)]);
      const [before] = await ds.query(
        `select deleted_at::text d, updated_at::text u from tasks`,
      );
      expect(await remove(ann, [gone('tasks', T1)])).toEqual([]);
      const [after] = await ds.query(
        `select deleted_at::text d, updated_at::text u from tasks`,
      );
      expect(after).toEqual(before);
    });

    it('takes the same id twice in one batch', async () => {
      await addTask(ann, T1);
      expect(await remove(ann, [gone('tasks', T1), gone('tasks', T1)])).toEqual(
        [],
      );
      expect((await taskRow(T1)).deleted_at).not.toBeNull();
    });
  });

  describe('an id the server has not seen', () => {
    it('becomes a tombstone owned by the caller', async () => {
      expect(await remove(ann, [gone('tasks', T1)])).toEqual([]);
      const row = await taskRow(T1);
      expect(row).toMatchObject({ user_id: ann, title: '', parent_id: null });
      expect(row.deleted_at).not.toBeNull();
    });

    it('keeps a task that arrives later from another device deleted', async () => {
      await remove(ann, [gone('tasks', T1)]);
      expect(await addTask(ann, T1, { title: 'Late' })).toEqual([]);
      const row = await taskRow(T1);
      expect(row).toMatchObject({ title: '', repeat_type: null });
      expect(row.deleted_at).not.toBeNull();
    });

    it('keeps the marks of a task that was deleted before it arrived out', async () => {
      await remove(ann, [gone('tasks', T1)]);
      await addLog(ann, T1, '2026-01-15');
      expect(await logCount()).toBe(0);
    });
  });

  describe("another user's tasks", () => {
    it("refuses Bob's task as id_taken and leaves it, and its marks, untouched", async () => {
      await addTask(bob, T1, { title: "Bob's" });
      await addLog(bob, T1, '2026-01-15');

      const rejected = await remove(ann, [gone('tasks', T1)]);

      expect(rejected).toEqual([
        { table: 'tasks', id: T1, reason: 'id_taken' },
      ]);
      expect(await taskRow(T1)).toMatchObject({
        user_id: bob,
        title: "Bob's",
        deleted_at: null,
      });
      expect(await logCount()).toBe(1);
    });

    it("refuses Bob's task even when Bob already deleted it", async () => {
      await addTask(bob, T1);
      await remove(bob, [gone('tasks', T1)]);
      const [before] = await ds.query(`select updated_at::text u from tasks`);
      const rejected = await remove(ann, [gone('tasks', T1)]);
      expect(rejected.map((r) => r.reason)).toEqual(['id_taken']);
      expect(await taskRow(T1)).toMatchObject({ user_id: bob });
      expect(await ds.query(`select updated_at::text u from tasks`)).toEqual([
        before,
      ]);
    });

    it('deletes her own task and refuses his in the same batch', async () => {
      await addTask(ann, T1);
      await addTask(bob, T2);
      const rejected = await remove(ann, [
        gone('tasks', T1),
        gone('tasks', T2),
      ]);
      expect(rejected).toEqual([
        { table: 'tasks', id: T2, reason: 'id_taken' },
      ]);
      expect((await taskRow(T1)).deleted_at).not.toBeNull();
      expect((await taskRow(T2)).deleted_at).toBeNull();
    });
  });

  describe('other tables', () => {
    it('refuses them as unsupported_table, naming the table and the id', async () => {
      const rejected = await remove(ann, [
        gone('diary_entries', T1),
        gone('task_logs', T2),
        gone('whatever', T3),
      ]);
      expect(rejected).toEqual([
        { table: 'diary_entries', id: T1, reason: 'unsupported_table' },
        { table: 'task_logs', id: T2, reason: 'unsupported_table' },
        { table: 'whatever', id: T3, reason: 'unsupported_table' },
      ]);
    });

    it('does not create anything for them', async () => {
      await remove(ann, [gone('diary_entries', T1)]);
      expect(await ds.query(`select id from tasks`)).toEqual([]);
    });

    it('still deletes the tasks listed beside them', async () => {
      await addTask(ann, T1);
      const rejected = await remove(ann, [
        gone('diary_entries', T2),
        gone('tasks', T1),
      ]);
      expect(rejected.map((r) => r.reason)).toEqual(['unsupported_table']);
      expect((await taskRow(T1)).deleted_at).not.toBeNull();
    });

    it('does not mix up the table name by case', async () => {
      const rejected = await remove(ann, [gone('Tasks', T1)]);
      expect(rejected.map((r) => r.reason)).toEqual(['unsupported_table']);
    });
  });

  describe('within one push', () => {
    it('deletes a task written earlier in the same transaction', async () => {
      await ds.transaction(async (m) => {
        await tasks.write(m, ann, [task({ id: T1, title: 'New' })]);
        await logs.write(m, ann, [log(T1, '2026-01-15')]);
        await deletions.write(m, ann, [gone('tasks', T1)]);
      });
      expect(await taskRow(T1)).toMatchObject({ title: '' });
      expect((await taskRow(T1)).deleted_at).not.toBeNull();
      expect(await logCount()).toBe(0);
    });
  });

  it('does nothing for an empty list', async () => {
    expect(await remove(ann, [])).toEqual([]);
  });

  it('deletes 500 tasks in one go', async () => {
    const ids = Array.from({ length: 500 }, (_, i) => id(i + 1));
    expect(
      await remove(
        ann,
        ids.map((i) => gone('tasks', i)),
      ),
    ).toEqual([]);
    const [{ n }] = await ds.query(
      `select count(*)::int n from tasks where deleted_at is not null`,
    );
    expect(n).toBe(500);
  });

  it('rolls back with the push transaction', async () => {
    await addTask(ann, T1);
    await expect(
      ds.transaction(async (m) => {
        await deletions.write(m, ann, [gone('tasks', T1)]);
        throw new Error('later step failed');
      }),
    ).rejects.toThrow('later step failed');
    expect((await taskRow(T1)).deleted_at).toBeNull();
  });
});
