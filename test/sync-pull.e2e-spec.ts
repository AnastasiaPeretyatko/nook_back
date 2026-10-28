import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp, truncateAll } from './support/db';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [T1, T2, T3] = [id(1), id(2), id(3)];

type Row = Record<string, unknown>;
interface PullResponse {
  next: string | null;
  has_more: boolean;
  tasks: Row[];
  logs: Row[];
}

describe('GET /sync/pull', () => {
  let app: INestApplication;
  let ds: DataSource;
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

  const push = (who: { token: string }, body: object) =>
    api()
      .post('/sync/push')
      .set('Authorization', `Bearer ${who.token}`)
      .send(body)
      .expect(200);

  const pull = async (who: { token: string }, query = '', status = 200) => {
    const res = await api()
      .get(`/sync/pull${query}`)
      .set('Authorization', `Bearer ${who.token}`)
      .expect(status);
    return res.body as PullResponse;
  };

  // Gives rows chosen times, to build exact situations (the server normally stamps them itself).
  async function stamp(table: string, key: string, value: string, at: string) {
    await ds.query(`alter table ${table} disable trigger ${table}_updated_at`);
    await ds.query(`update ${table} set updated_at = $1 where ${key} = $2`, [
      at,
      value,
    ]);
    await ds.query(`alter table ${table} enable trigger ${table}_updated_at`);
  }
  const second = (n: number, micros = '000000') =>
    `2026-03-01T10:00:${String(n).padStart(2, '0')}.${micros}Z`;
  const ids = (rows: Row[]) => rows.map((r) => r.id);

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
  });

  beforeEach(async () => {
    await truncateAll(ds);
    ann = await signUp('ann@example.com');
    bob = await signUp('bob@example.com');
  });

  afterAll(() => app.close());

  it('is closed without a token', async () => {
    await api().get('/sync/pull').expect(401);
  });

  it('gives an empty user an empty answer', async () => {
    expect(await pull(ann)).toEqual({
      next: null,
      has_more: false,
      tasks: [],
      logs: [],
    });
  });

  it('answers only with tasks and marks unless the diary or the cycle is asked for', async () => {
    const res = await pull(ann, '?include=tasks');
    expect(Object.keys(res).sort()).toEqual([
      'has_more',
      'logs',
      'next',
      'tasks',
    ]);
  });

  describe('the shape of a row', () => {
    it('gives a task with the keys of taskToRow plus user_id, updated_at, deleted_at', async () => {
      await push(ann, {
        tasks: [
          {
            id: T1,
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
            start_date: '2026-03-01',
            created_at: '2026-01-15T10:00:00.123456Z',
            client_updated_at: '2026-01-15T10:00:01.654321Z',
          },
        ],
      });
      const [task] = (await pull(ann)).tasks;
      const { updated_at, ...rest } = task;
      expect(rest).toEqual({
        id: T1,
        user_id: ann.id,
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
        start_date: '2026-03-01',
        created_at: '2026-01-15T10:00:00.123456Z',
        client_updated_at: '2026-01-15T10:00:01.654321Z',
        deleted_at: null,
        group_id: null,
        assignee_id: null,
      });
      expect(updated_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
    });

    it('gives a mark with the keys of logToRow plus user_id and updated_at', async () => {
      await push(ann, {
        tasks: [{ id: T1 }],
        logs: [
          {
            task_id: T1,
            date: '2026-01-15',
            completed: true,
            value: 2.5,
            completed_at: '2026-01-15T10:00:00.5Z',
            client_updated_at: '2026-01-15T10:00:01Z',
          },
        ],
      });
      const [log] = (await pull(ann)).logs;
      const { updated_at, ...rest } = log;
      expect(rest).toEqual({
        task_id: T1,
        user_id: ann.id,
        date: '2026-01-15',
        completed: true,
        value: 2.5,
        completed_at: '2026-01-15T10:00:00.500000Z',
        client_updated_at: '2026-01-15T10:00:01.000000Z',
      });
      expect(updated_at).toMatch(/\.\d{6}Z$/);
    });

    it('keeps days as plain text, whatever the zone of the server', async () => {
      await push(ann, {
        tasks: [{ id: T1, start_date: '2026-03-01' }],
        logs: [{ task_id: T1, date: '2026-12-31' }],
      });
      const res = await pull(ann);
      expect(res.tasks[0].start_date).toBe('2026-03-01');
      expect(res.logs[0].date).toBe('2026-12-31');
    });

    it('tells about a deleted task with an empty row and deleted_at, and no marks', async () => {
      await push(ann, {
        tasks: [{ id: T1, title: 'Read' }],
        logs: [{ task_id: T1, date: '2026-01-15', completed: true }],
      });
      await push(ann, { deleted: [{ table: 'tasks', id: T1 }] });
      const res = await pull(ann);
      expect(res.logs).toEqual([]);
      expect(res.tasks).toHaveLength(1);
      expect(res.tasks[0]).toMatchObject({
        id: T1,
        title: '',
        parent_id: null,
      });
      expect(res.tasks[0].deleted_at).toMatch(/^\d{4}-.*\.\d{6}Z$/);
    });

    it('keeps the microseconds of updated_at exactly as the database has them', async () => {
      await push(ann, { tasks: [{ id: T1 }] });
      await stamp('tasks', 'id', T1, '2026-03-01T10:00:00.123457Z');
      const res = await pull(ann);
      expect(res.tasks[0].updated_at).toBe('2026-03-01T10:00:00.123457Z');
      expect(res.next).toBe('2026-03-01T10:00:00.123457Z');
    });
  });

  describe('whose rows', () => {
    it('gives each user only their own tasks and marks', async () => {
      await push(ann, {
        tasks: [{ id: T1 }],
        logs: [{ task_id: T1, date: '2026-01-15' }],
      });
      await push(bob, {
        tasks: [{ id: T2 }],
        logs: [{ task_id: T2, date: '2026-01-15' }],
      });

      const forAnn = await pull(ann);
      expect(ids(forAnn.tasks)).toEqual([T1]);
      expect(forAnn.logs.map((l) => l.task_id)).toEqual([T1]);
      const forBob = await pull(bob);
      expect(ids(forBob.tasks)).toEqual([T2]);
      expect(forBob.logs.map((l) => l.task_id)).toEqual([T2]);
    });

    it("does not show Bob's rows even when Ann asks from the beginning of time", async () => {
      await push(bob, { tasks: [{ id: T1 }, { id: T2 }] });
      const res = await pull(ann, '?since=2000-01-01T00:00:00Z&limit=1000');
      expect(res).toEqual({
        next: '2000-01-01T00:00:00Z',
        has_more: false,
        tasks: [],
        logs: [],
      });
    });

    it("does not let a tombstone of Bob's task reach Ann", async () => {
      await push(bob, { deleted: [{ table: 'tasks', id: T1 }] });
      expect((await pull(ann)).tasks).toEqual([]);
    });
  });

  describe('since', () => {
    beforeEach(async () => {
      await push(ann, { tasks: [{ id: T1 }, { id: T2 }, { id: T3 }] });
      await stamp('tasks', 'id', T1, second(1));
      await stamp('tasks', 'id', T2, second(2));
      await stamp('tasks', 'id', T3, second(3));
    });

    it('gives everything without it, oldest first, and next is the newest time', async () => {
      const res = await pull(ann);
      expect(ids(res.tasks)).toEqual([T1, T2, T3]);
      expect(res.next).toBe(second(3));
      expect(res.has_more).toBe(false);
    });

    it('treats an empty value like none', async () => {
      expect(ids((await pull(ann, '?since=')).tasks)).toEqual([T1, T2, T3]);
    });

    it('gives only what is strictly newer', async () => {
      expect(ids((await pull(ann, `?since=${second(2)}`)).tasks)).toEqual([T3]);
    });

    it('is one microsecond sharp', async () => {
      expect(
        ids((await pull(ann, `?since=${second(2, '000000')}`)).tasks),
      ).toEqual([T3]);
      expect(
        ids((await pull(ann, `?since=${second(1, '999999')}`)).tasks),
      ).toEqual([T2, T3]);
    });

    it('gives nothing new, and next stays where it was asked from', async () => {
      const res = await pull(ann, `?since=${second(3)}`);
      expect(res).toEqual({
        next: second(3),
        has_more: false,
        tasks: [],
        logs: [],
      });
    });

    it('gives a task again once it changed', async () => {
      const before = (await pull(ann)).next!;
      await push(ann, { tasks: [{ id: T1, title: 'Changed' }] });
      const res = await pull(ann, `?since=${before}`);
      expect(res.tasks).toMatchObject([{ id: T1, title: 'Changed' }]);
    });

    it('gives a mark again once it changed', async () => {
      await push(ann, { logs: [{ task_id: T1, date: '2026-01-15' }] });
      const before = (await pull(ann)).next!;
      await push(ann, {
        logs: [{ task_id: T1, date: '2026-01-15', completed: true }],
      });
      const res = await pull(ann, `?since=${before}`);
      expect(res.logs).toMatchObject([{ task_id: T1, completed: true }]);
      expect(res.tasks).toEqual([]);
    });

    it('refuses a value that is not a UTC moment', async () => {
      for (const bad of [
        'yesterday',
        '2026-03-01',
        '2026-03-01T10:00:00',
        '2026-03-01T10:00:00+03:00',
        '2026-02-30T10:00:00Z',
        '2026-03-01T25:00:00Z',
        '1',
      ]) {
        const res = await pull(ann, `?since=${encodeURIComponent(bad)}`, 400);
        expect((res as unknown as { code: string }).code).toBe(
          'validation_failed',
        );
      }
    });

    it('refuses two values', async () => {
      await pull(ann, `?since=${second(1)}&since=${second(2)}`, 400);
    });
  });

  describe('pages', () => {
    // Five tasks one second apart: s1 < s2 < s3 < s4 < s5.
    const five = [id(11), id(12), id(13), id(14), id(15)];
    beforeEach(async () => {
      await push(ann, { tasks: five.map((i) => ({ id: i })) });
      for (const [i, taskId] of five.entries()) {
        await stamp('tasks', 'id', taskId, second(i + 1));
      }
    });

    it('cuts at the limit and says there is more', async () => {
      const res = await pull(ann, '?limit=2');
      expect(ids(res.tasks)).toEqual([five[0], five[1]]);
      expect(res.has_more).toBe(true);
      expect(res.next).toBe(second(2));
    });

    it('is not cut when the limit is exactly the number of rows', async () => {
      const res = await pull(ann, '?limit=5');
      expect(ids(res.tasks)).toEqual(five);
      expect(res.has_more).toBe(false);
      expect(res.next).toBe(second(5));
    });

    it('walks all the pages with next as it is, seeing every row once', async () => {
      const seen: unknown[] = [];
      let since = '';
      let pages = 0;
      for (;;) {
        const res = await pull(ann, `?limit=2${since}`);
        seen.push(...ids(res.tasks));
        pages += 1;
        if (!res.has_more) break;
        since = `&since=${res.next}`;
        expect(pages).toBeLessThan(10);
      }
      expect(seen).toEqual(five);
      expect(pages).toBe(3);
    });

    it('does not lose rows that share the time of the last row of a page', async () => {
      // s1, s2, s2, s2, s3: a page of 2 ends in the middle of the three that share s2.
      await stamp('tasks', 'id', five[2], second(2));
      await stamp('tasks', 'id', five[3], second(2));
      await stamp('tasks', 'id', five[4], second(3));
      const first = await pull(ann, '?limit=2');
      expect(ids(first.tasks)).toEqual(
        expect.arrayContaining([five[0], five[1], five[2], five[3]]),
      );
      expect(first.tasks).toHaveLength(4);
      expect(first.has_more).toBe(true);
      expect(first.next).toBe(second(2));
      const second_ = await pull(ann, `?limit=2&since=${first.next}`);
      expect(ids(second_.tasks)).toEqual([five[4]]);
      expect(second_.has_more).toBe(false);
    });

    it('does not loop when all rows of a page share one time', async () => {
      for (const taskId of five) await stamp('tasks', 'id', taskId, second(7));
      const res = await pull(ann, '?limit=2');
      expect(res.tasks).toHaveLength(5);
      expect(res.has_more).toBe(false);
      expect(res.next).toBe(second(7));
    });

    it('limits tasks and marks separately', async () => {
      await push(ann, {
        logs: [1, 2, 3].map((d) => ({
          task_id: five[0],
          date: `2026-01-0${d}`,
        })),
      });
      for (const d of [1, 2, 3]) {
        await ds.query(
          `alter table task_logs disable trigger task_logs_updated_at`,
        );
        await ds.query(`update task_logs set updated_at = $1 where date = $2`, [
          second(10 + d),
          `2026-01-0${d}`,
        ]);
        await ds.query(
          `alter table task_logs enable trigger task_logs_updated_at`,
        );
      }
      const res = await pull(ann, '?limit=4');
      expect(res.tasks).toHaveLength(4);
      expect(res.logs).toHaveLength(3);
    });

    it('continues from the earliest cut table, so neither skips a row', async () => {
      // Tasks end at s5 when cut after 2 (s2); marks are cut after 2 as well, but later (s12).
      await push(ann, {
        logs: [1, 2, 3].map((d) => ({
          task_id: five[0],
          date: `2026-01-0${d}`,
        })),
      });
      await ds.query(
        `alter table task_logs disable trigger task_logs_updated_at`,
      );
      for (const d of [1, 2, 3]) {
        await ds.query(`update task_logs set updated_at = $1 where date = $2`, [
          second(10 + d),
          `2026-01-0${d}`,
        ]);
      }
      await ds.query(
        `alter table task_logs enable trigger task_logs_updated_at`,
      );

      const res = await pull(ann, '?limit=2');
      expect(res.has_more).toBe(true);
      expect(res.tasks).toHaveLength(2);
      expect(res.logs).toHaveLength(2);
      expect(res.next).toBe(second(2)); // the tasks' last time, the earlier of the two
    });

    it('does not let an uncut table with an older last time pull next back', async () => {
      // Tasks are cut after s2; the only mark is older (s1) and complete. next must stay s2.
      await push(ann, { logs: [{ task_id: five[0], date: '2026-01-01' }] });
      await stamp('task_logs', 'task_id', five[0], second(1));
      const res = await pull(ann, '?limit=2');
      expect(res.has_more).toBe(true);
      expect(res.logs).toHaveLength(1);
      expect(res.next).toBe(second(2));
    });

    it('converges: walking the pages gives every task and every mark', async () => {
      await push(ann, {
        logs: [1, 2, 3, 4, 5].map((d) => ({
          task_id: five[0],
          date: `2026-01-0${d}`,
        })),
      });
      const tasks = new Set<unknown>();
      const logs = new Set<unknown>();
      let since = '';
      for (let pages = 0; pages < 20; pages += 1) {
        const res = await pull(ann, `?limit=2${since}`);
        res.tasks.forEach((t) => tasks.add(t.id));
        res.logs.forEach((l) => logs.add(l.date));
        if (!res.has_more) break;
        since = `&since=${res.next}`;
      }
      expect([...tasks].sort()).toEqual(five);
      expect(logs.size).toBe(5);
    });
  });

  describe('limit', () => {
    it('is 500 when not given', async () => {
      await push(ann, {
        tasks: Array.from({ length: 500 }, (_, i) => ({ id: id(i + 1) })),
      });
      await push(ann, { tasks: [{ id: id(501) }] });
      const res = await pull(ann);
      expect(res.tasks).toHaveLength(500);
      expect(res.has_more).toBe(true);
    });

    it('accepts 1 and 1000', async () => {
      await push(ann, { tasks: [{ id: T1 }, { id: T2 }] });
      expect((await pull(ann, '?limit=1')).tasks).toHaveLength(1);
      expect((await pull(ann, '?limit=1000')).tasks).toHaveLength(2);
    });

    it('treats an empty value as not given', async () => {
      await push(ann, { tasks: [{ id: T1 }] });
      expect((await pull(ann, '?limit=')).tasks).toHaveLength(1);
    });

    it('refuses 0, 1001, a fraction, a negative number and text', async () => {
      for (const bad of ['0', '1001', '1.5', '-1', 'abc', '10x']) {
        const res = await pull(ann, `?limit=${bad}`, 400);
        expect((res as unknown as { code: string }).code).toBe(
          'validation_failed',
        );
      }
    });
  });

  describe('include', () => {
    it('accepts any mix of tasks, diary and cycle', async () => {
      for (const ok of [
        'tasks',
        'diary',
        'cycle',
        'tasks,diary',
        'diary,cycle,tasks',
      ]) {
        await pull(ann, `?include=${ok}`);
      }
      await pull(ann, '?include=');
    });

    it('refuses anything else', async () => {
      for (const bad of [
        'groups',
        'tasks,,diary',
        'tasks,foo',
        'Tasks',
        ' tasks',
      ]) {
        await pull(ann, `?include=${encodeURIComponent(bad)}`, 400);
      }
    });
  });

  it('gives back what a push of two devices left, in one picture', async () => {
    // Phone and tablet both push into the same account, and either one pulls the other's work.
    await push(ann, { tasks: [{ id: T1, title: 'From the phone' }] });
    await push(ann, {
      tasks: [{ id: T2, parent_id: T1, title: 'From the tablet' }],
      logs: [{ task_id: T1, date: '2026-01-15', completed: true }],
    });
    const res = await pull(ann);
    expect(res.tasks.map((t) => [t.id, t.parent_id, t.title])).toEqual([
      [T1, null, 'From the phone'],
      [T2, T1, 'From the tablet'],
    ]);
    expect(res.logs).toHaveLength(1);
  });
});
