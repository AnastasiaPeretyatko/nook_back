import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { LogRow, parseLog, parseTask, TaskRow } from '../src/sync/push-rows';
import { LogWriter } from '../src/sync/log-writer';
import { TaskWriter } from '../src/sync/task-writer';
import { createTestApp, truncateAll } from './support/db';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [T1, T2, T3] = [id(1), id(2), id(3)];

// Rows go through the same check as in a real push.
const task = (fields: Record<string, unknown>): TaskRow => {
  const result = parseTask(fields);
  if (!('row' in result)) throw new Error('bad test row');
  return result.row;
};
const log = (
  taskId: string,
  date: string,
  fields: Record<string, unknown> = {},
): LogRow => {
  const result = parseLog({ task_id: taskId, date, ...fields });
  if (!('row' in result)) throw new Error('bad test row');
  return result.row;
};

describe('LogWriter', () => {
  let app: INestApplication;
  let ds: DataSource;
  let tasks: TaskWriter;
  let logs: LogWriter;
  let ann: string;
  let bob: string;

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
    tasks = app.get(TaskWriter);
    logs = app.get(LogWriter);
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

  const addTask = (userId: string, taskId: string) =>
    ds.transaction((m) => tasks.write(m, userId, [task({ id: taskId })]));
  const write = (userId: string, rows: LogRow[]) =>
    ds.transaction((m) => logs.write(m, userId, rows));

  // Days and moments are read back as text: a JS Date would lose the day's zone or the microseconds.
  const allLogs = (): Promise<Record<string, unknown>[]> =>
    ds.query(
      `select task_id, user_id, date::text as day, completed, value,
              completed_at::text as completed_at, client_updated_at::text as client_updated_at
       from task_logs order by task_id, user_id, date`,
    );

  it('writes a mark with every field, under the caller', async () => {
    await addTask(ann, T1);
    const rejected = await write(ann, [
      log(T1, '2026-01-15', {
        completed: true,
        value: 2.5,
        completed_at: '2026-01-15T10:00:00.123456Z',
        client_updated_at: '2026-01-15T10:00:01.654321Z',
      }),
    ]);
    expect(rejected).toEqual([]);
    expect(await allLogs()).toEqual([
      {
        task_id: T1,
        user_id: ann,
        day: '2026-01-15',
        completed: true,
        value: 2.5,
        completed_at: '2026-01-15 10:00:00.123456+00',
        client_updated_at: '2026-01-15 10:00:01.654321+00',
      },
    ]);
  });

  it('stamps updated_at on the server, whatever the client says', async () => {
    await addTask(ann, T1);
    await write(ann, [
      log(T1, '2026-01-15', { client_updated_at: '2000-01-01T00:00:00Z' }),
    ]);
    const [{ fresh }] = await ds.query(
      `select updated_at > '2020-01-01' fresh from task_logs`,
    );
    expect(fresh).toBe(true);
  });

  it('does nothing for an empty list', async () => {
    expect(await write(ann, [])).toEqual([]);
  });

  describe('updating', () => {
    it('replaces the mark of the same task, user and day instead of adding one', async () => {
      await addTask(ann, T1);
      await write(ann, [log(T1, '2026-01-15', { completed: true, value: 1 })]);
      await write(ann, [
        log(T1, '2026-01-15', { completed: false, value: null }),
      ]);
      const rows = await allLogs();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ completed: false, value: null });
    });

    it('clears completed_at when the new version has none', async () => {
      await addTask(ann, T1);
      await write(ann, [
        log(T1, '2026-01-15', {
          completed: true,
          completed_at: '2026-01-15T10:00:00Z',
        }),
      ]);
      await write(ann, [log(T1, '2026-01-15', { completed: false })]);
      expect((await allLogs())[0].completed_at).toBeNull();
    });

    it('moves updated_at forward', async () => {
      await addTask(ann, T1);
      await write(ann, [log(T1, '2026-01-15')]);
      const [{ before }] = await ds.query(
        `select updated_at::text before from task_logs`,
      );
      await write(ann, [log(T1, '2026-01-15', { completed: true })]);
      const [{ moved }] = await ds.query(
        `select updated_at > $1::timestamptz moved from task_logs`,
        [before],
      );
      expect(moved).toBe(true);
    });

    it('is idempotent: the same batch twice leaves the same rows and refuses nothing', async () => {
      await addTask(ann, T1);
      const rows = [
        log(T1, '2026-01-15', { completed: true }),
        log(T1, '2026-01-16', { value: 3 }),
      ];
      expect(await write(ann, rows)).toEqual([]);
      const first = await allLogs();
      expect(await write(ann, rows)).toEqual([]);
      expect(await allLogs()).toEqual(first);
    });

    it('keeps one mark per day: another day is another mark', async () => {
      await addTask(ann, T1);
      await write(ann, [log(T1, '2026-01-15'), log(T1, '2026-01-16')]);
      expect(await allLogs()).toHaveLength(2);
    });
  });

  describe('whose task it is', () => {
    it("refuses a mark in someone else's task, and writes nothing", async () => {
      await addTask(bob, T1);
      const rejected = await write(ann, [
        log(T1, '2026-01-15', { completed: true }),
      ]);
      expect(rejected).toEqual([
        { table: 'task_logs', id: T1, reason: 'unknown_task' },
      ]);
      expect(await allLogs()).toEqual([]);
    });

    it("does not touch Bob's mark when Ann sends one for the same task and day", async () => {
      await addTask(bob, T1);
      await write(bob, [log(T1, '2026-01-15', { completed: true, value: 1 })]);
      await write(ann, [
        log(T1, '2026-01-15', { completed: false, value: 99 }),
      ]);
      expect(await allLogs()).toEqual([
        expect.objectContaining({ user_id: bob, completed: true, value: 1 }),
      ]);
    });

    it('refuses a mark of a task that does not exist', async () => {
      const rejected = await write(ann, [log(T1, '2026-01-15')]);
      expect(rejected).toEqual([
        { table: 'task_logs', id: T1, reason: 'unknown_task' },
      ]);
    });

    it('reports a foreign task exactly like a missing one', async () => {
      await addTask(bob, T1);
      const foreign = await write(ann, [log(T1, '2026-01-15')]);
      const missing = await write(ann, [log(T2, '2026-01-15')]);
      expect(foreign.map((r) => r.reason)).toEqual(
        missing.map((r) => r.reason),
      );
    });

    it('lets two users each keep their own marks on their own tasks', async () => {
      await addTask(ann, T1);
      await addTask(bob, T2);
      await write(ann, [log(T1, '2026-01-15')]);
      await write(bob, [log(T2, '2026-01-15')]);
      expect((await allLogs()).map((r) => r.user_id).sort()).toEqual(
        [ann, bob].sort(),
      );
    });

    it("still keeps Ann's mark out of Bob's task if the check misses it (a race)", async () => {
      await addTask(bob, T1);
      await ds.transaction(async (manager) => {
        // The look-up claims T1 is Ann's, as if the task changed hands a moment ago.
        const blind = Object.create(manager) as typeof manager;
        blind.query = ((sql: string, params?: unknown[]) =>
          sql.includes('from tasks where id = any')
            ? Promise.resolve([{ id: T1, user_id: ann, deleted: false }])
            : manager.query(sql, params)) as typeof manager.query;
        await logs.write(blind, ann, [
          log(T1, '2026-01-15', { completed: true }),
        ]);
      });
      expect(await allLogs()).toEqual([]);
    });
  });

  describe('deleted tasks', () => {
    it('does not write a mark of a deleted task, and does not complain', async () => {
      await addTask(ann, T1);
      await ds.query(`update tasks set deleted_at = now() where id = $1`, [T1]);
      expect(
        await write(ann, [log(T1, '2026-01-15', { completed: true })]),
      ).toEqual([]);
      expect(await allLogs()).toEqual([]);
    });

    it('does not bring back a mark that was erased with its task', async () => {
      await addTask(ann, T1);
      await write(ann, [log(T1, '2026-01-15', { completed: true })]);
      await ds.query(`update tasks set deleted_at = now() where id = $1`, [T1]);
      expect(await allLogs()).toEqual([]);
      await write(ann, [log(T1, '2026-01-15', { completed: true })]);
      expect(await allLogs()).toEqual([]);
    });

    it('writes the other marks of the same batch', async () => {
      await addTask(ann, T1);
      await addTask(ann, T2);
      await ds.query(`update tasks set deleted_at = now() where id = $1`, [T1]);
      await write(ann, [log(T1, '2026-01-15'), log(T2, '2026-01-15')]);
      expect((await allLogs()).map((r) => r.task_id)).toEqual([T2]);
    });
  });

  describe('bad marks next to good ones', () => {
    it('writes the good ones and reports each refusal by task', async () => {
      await addTask(ann, T1);
      await addTask(bob, T2);
      const rejected = await write(ann, [
        log(T1, '2026-01-15'),
        log(T2, '2026-01-15'),
        log(T3, '2026-01-15'),
      ]);
      expect(rejected.map((r) => `${r.id}:${r.reason}`).sort()).toEqual([
        `${T2}:unknown_task`,
        `${T3}:unknown_task`,
      ]);
      expect((await allLogs()).map((r) => r.task_id)).toEqual([T1]);
    });
  });

  describe('with the tasks of the same push', () => {
    it('takes a mark of a task created earlier in the same transaction', async () => {
      const rejected = await ds.transaction(async (m) => {
        await tasks.write(m, ann, [task({ id: T1 })]);
        return logs.write(m, ann, [log(T1, '2026-01-15', { completed: true })]);
      });
      expect(rejected).toEqual([]);
      expect(await allLogs()).toHaveLength(1);
    });

    it('drops a mark of a task refused earlier in the same push', async () => {
      await addTask(bob, T1);
      const rejected = await ds.transaction(async (m) => {
        const refused = await tasks.write(m, ann, [task({ id: T1 })]);
        expect(refused.map((r) => r.reason)).toEqual(['id_taken']);
        return logs.write(m, ann, [log(T1, '2026-01-15')]);
      });
      expect(rejected.map((r) => r.reason)).toEqual(['unknown_task']);
      expect(await allLogs()).toEqual([]);
    });
  });

  describe('duplicates in one batch', () => {
    it('keeps the last version instead of failing the statement', async () => {
      await addTask(ann, T1);
      await write(ann, [
        log(T1, '2026-01-15', { value: 1 }),
        log(T1, '2026-01-15', { value: 2 }),
      ]);
      expect((await allLogs()).map((r) => r.value)).toEqual([2]);
    });
  });

  it('writes 500 marks in one go', async () => {
    await addTask(ann, T1);
    const rows = Array.from({ length: 500 }, (_, i) =>
      log(T1, new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10)),
    );
    expect(await write(ann, rows)).toEqual([]);
    expect(await allLogs()).toHaveLength(500);
  });

  it('rolls back with the push transaction', async () => {
    await addTask(ann, T1);
    await expect(
      ds.transaction(async (m) => {
        await logs.write(m, ann, [log(T1, '2026-01-15')]);
        throw new Error('later step failed');
      }),
    ).rejects.toThrow('later step failed');
    expect(await allLogs()).toEqual([]);
  });
});
