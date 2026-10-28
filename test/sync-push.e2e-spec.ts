import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { DeletionWriter } from '../src/sync/deletion-writer';
import { createTestApp, truncateAll } from './support/db';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [T1, T2, T3, T4] = [id(1), id(2), id(3), id(4)];

interface PushResponse {
  rejected: { table: string; id: string | null; reason: string }[];
  server_time: string;
}

describe('POST /sync/push', () => {
  let app: INestApplication;
  let ds: DataSource;
  let throwInDeletions = false;
  let ann: { token: string; id: string };
  let bob: { token: string; id: string };
  const api = () => request(app.getHttpServer());

  async function signUp(email: string) {
    const res = await api()
      .post('/auth/register')
      .send({ email, password: 'correct horse' })
      .expect(201);
    const body = res.body as { accessToken: string; user: { id: string } };
    return { token: body.accessToken, id: body.user.id };
  }

  const push = async (who: { token: string }, body: object, status = 200) => {
    const res = await api()
      .post('/sync/push')
      .set('Authorization', `Bearer ${who.token}`)
      .send(body)
      .expect(status);
    return res.body as PushResponse;
  };
  const reasons = (r: PushResponse) =>
    r.rejected.map((x) => `${x.table}:${x.id}:${x.reason}`).sort();

  // The writers run for real; only the last one can be made to fail on demand.
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
    ds = app.get(DataSource);
  });

  beforeEach(async () => {
    throwInDeletions = false;
    await truncateAll(ds);
    ann = await signUp('ann@example.com');
    bob = await signUp('bob@example.com');
  });

  afterAll(() => app.close());

  const tasksOf = (userId: string): Promise<Record<string, unknown>[]> =>
    ds.query(
      `select id, parent_id, title, deleted_at is not null as deleted
       from tasks where user_id = $1 order by id`,
      [userId],
    );
  const logsOf = (userId: string): Promise<Record<string, unknown>[]> =>
    ds.query(
      `select task_id, date::text as day, completed from task_logs
       where user_id = $1 order by task_id, date`,
      [userId],
    );

  it('answers 200 with nothing refused and the server time', async () => {
    const res = await push(ann, { tasks: [{ id: T1, title: 'Read' }] });
    expect(res.rejected).toEqual([]);
    expect(res.server_time).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(Math.abs(Date.parse(res.server_time) - Date.now())).toBeLessThan(
      60_000,
    );
  });

  it('writes tasks, marks and deletions of one request, in that order', async () => {
    const res = await push(ann, {
      tasks: [
        { id: T2, parent_id: T1, title: 'Subtask' }, // before its parent
        { id: T1, title: 'Parent' },
        { id: T3, title: 'Soon gone' },
      ],
      logs: [
        { task_id: T1, date: '2026-01-15', completed: true },
        { task_id: T3, date: '2026-01-15', completed: true }, // erased by the deletion below
      ],
      deleted: [{ table: 'tasks', id: T3 }],
    });
    expect(res.rejected).toEqual([]);
    expect(await tasksOf(ann.id)).toEqual([
      { id: T1, parent_id: null, title: 'Parent', deleted: false },
      { id: T2, parent_id: T1, title: 'Subtask', deleted: false },
      { id: T3, parent_id: null, title: '', deleted: true },
    ]);
    expect(await logsOf(ann.id)).toEqual([
      { task_id: T1, day: '2026-01-15', completed: true },
    ]);
  });

  it('takes the same push twice and leaves the same data', async () => {
    const body = {
      tasks: [
        { id: T2, parent_id: T1, title: 'b' },
        { id: T1, title: 'a' },
      ],
      logs: [{ task_id: T1, date: '2026-01-15', completed: true, value: 2 }],
      deleted: [{ table: 'tasks', id: T3 }],
    };
    expect((await push(ann, body)).rejected).toEqual([]);
    const snapshot = async () => [await tasksOf(ann.id), await logsOf(ann.id)];
    const first = await snapshot();
    expect((await push(ann, body)).rejected).toEqual([]);
    expect(await snapshot()).toEqual(first);
  });

  describe('a bad row does not stop the rest', () => {
    it('reports each refusal and writes the good rows around it', async () => {
      const res = await push(ann, {
        tasks: [
          { id: T1, title: 'Good' },
          { id: T2, status: 'done' }, // invalid row
          { id: T3, group_id: id(50) }, // groups come later
          { id: T4, parent_id: id(77) }, // parent nowhere
          null, // not even an object
        ],
        logs: [
          { task_id: T1, date: '2026-01-15', completed: true },
          { task_id: T1, date: '2026-02-30' }, // not a day
          { task_id: id(9), date: '2026-01-15' }, // no such task
        ],
        deleted: [{ table: 'tasks', id: 'abc' }],
      });
      expect(res.rejected).toEqual(
        expect.arrayContaining([
          { table: 'tasks', id: T2, reason: 'invalid_row' },
          { table: 'tasks', id: T3, reason: 'groups_not_supported' },
          { table: 'tasks', id: T4, reason: 'unknown_parent' },
          { table: 'tasks', id: null, reason: 'invalid_row' },
          { table: 'task_logs', id: T1, reason: 'invalid_row' },
          { table: 'task_logs', id: id(9), reason: 'unknown_task' },
          { table: 'deleted', id: null, reason: 'invalid_row' },
        ]),
      );
      expect(res.rejected).toHaveLength(7);
      expect((await tasksOf(ann.id)).map((t) => t.id)).toEqual([T1]);
      expect(await logsOf(ann.id)).toEqual([
        { task_id: T1, day: '2026-01-15', completed: true },
      ]);
    });

    it('refuses the list the server does not keep yet (the cycle), naming each row', async () => {
      const res = await push(ann, {
        cycle_days: [{ id: T1 }, { date: '2026-01-01' }, 5],
        tasks: [{ id: T4 }],
      });
      expect(reasons(res)).toEqual(
        [
          `cycle_days:${T1}:unsupported_table`,
          `cycle_days:null:unsupported_table`,
          `cycle_days:null:unsupported_table`,
        ].sort(),
      );
      expect((await tasksOf(ann.id)).map((t) => t.id)).toEqual([T4]);
    });

    it('refuses a deletion in a table that is not supported', async () => {
      const res = await push(ann, {
        deleted: [{ table: 'cycle_days', id: T1 }],
      });
      expect(res.rejected).toEqual([
        { table: 'cycle_days', id: T1, reason: 'unsupported_table' },
      ]);
    });
  });

  describe('who the rows belong to', () => {
    it('writes every row under the token, whatever user_id the body names', async () => {
      await push(ann, {
        tasks: [{ id: T1, user_id: bob.id }],
        logs: [{ task_id: T1, date: '2026-01-15', user_id: bob.id }],
      });
      expect((await tasksOf(ann.id)).map((t) => t.id)).toEqual([T1]);
      expect(await tasksOf(bob.id)).toEqual([]);
      expect(await logsOf(bob.id)).toEqual([]);
      expect(await logsOf(ann.id)).toHaveLength(1);
    });

    it("leaves Bob's data alone when Ann names his ids", async () => {
      await push(bob, {
        tasks: [
          { id: T1, title: "Bob's" },
          { id: T2, title: 'Also his' },
        ],
        logs: [{ task_id: T1, date: '2026-01-15', completed: true }],
      });

      const res = await push(ann, {
        tasks: [
          { id: T1, title: 'Hijacked' },
          { id: T3, parent_id: T2 },
        ],
        logs: [{ task_id: T1, date: '2026-01-15', completed: false }],
        deleted: [{ table: 'tasks', id: T2 }],
      });

      expect(reasons(res)).toEqual(
        [
          `tasks:${T1}:id_taken`,
          `tasks:${T3}:unknown_parent`,
          `task_logs:${T1}:unknown_task`,
          `tasks:${T2}:id_taken`,
        ].sort(),
      );
      expect(await tasksOf(bob.id)).toEqual([
        { id: T1, parent_id: null, title: "Bob's", deleted: false },
        { id: T2, parent_id: null, title: 'Also his', deleted: false },
      ]);
      expect(await logsOf(bob.id)).toEqual([
        { task_id: T1, day: '2026-01-15', completed: true },
      ]);
      expect(await tasksOf(ann.id)).toEqual([]);
    });
  });

  describe('a failure inside the transaction', () => {
    it('writes nothing at all, and answers 500 internal_error', async () => {
      throwInDeletions = true;
      const res = await api()
        .post('/sync/push')
        .set('Authorization', `Bearer ${ann.token}`)
        .send({
          tasks: [{ id: T1 }],
          logs: [{ task_id: T1, date: '2026-01-15' }],
          deleted: [{ table: 'tasks', id: T2 }],
        })
        .expect(500);
      expect(res.body).toEqual({
        code: 'internal_error',
        message: 'Internal server error',
      });
      expect(await tasksOf(ann.id)).toEqual([]);
      expect(await logsOf(ann.id)).toEqual([]);
    });

    it('lets the same push through once the failure is gone', async () => {
      const body = {
        tasks: [{ id: T1 }],
        deleted: [{ table: 'tasks', id: T2 }],
      };
      throwInDeletions = true;
      await push(ann, body, 500);
      throwInDeletions = false;
      expect((await push(ann, body)).rejected).toEqual([]);
      expect(await tasksOf(ann.id)).toHaveLength(2);
    });
  });

  describe('an empty push', () => {
    it('does not open a transaction at all', async () => {
      const spy = jest.spyOn(ds, 'transaction');
      try {
        await push(ann, {});
        await push(ann, { tasks: [], logs: [], deleted: [] });
        await push(ann, { tasks: [null] }); // only a bad row: nothing to write either
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('takes the X-Device-Id header and does not mind it', async () => {
    await api()
      .post('/sync/push')
      .set('Authorization', `Bearer ${ann.token}`)
      .set('X-Device-Id', 'phone-1')
      .send({ tasks: [{ id: T1 }] })
      .expect(200);
    expect(await tasksOf(ann.id)).toHaveLength(1);
  });

  it('takes the full 500 rows of every list in one request', async () => {
    const tasks = Array.from({ length: 500 }, (_, i) => ({
      id: id(i + 1),
      parent_id: i === 0 ? null : id(i),
    })).reverse();
    const logs = Array.from({ length: 500 }, (_, i) => ({
      task_id: id(1),
      date: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10),
    }));
    const deleted = Array.from({ length: 500 }, (_, i) => ({
      table: 'tasks',
      id: id(1000 + i),
    }));
    const started = Date.now();
    const res = await push(ann, { tasks, logs, deleted });
    expect(res.rejected).toEqual([]);
    expect((await tasksOf(ann.id)).length).toBe(1000);
    expect((await logsOf(ann.id)).length).toBe(500);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
