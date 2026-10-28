import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { parseTask } from '../src/sync/push-rows';
import { TaskWriter } from '../src/sync/task-writer';
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
interface PushResponse {
  rejected: { table: string; id: string | null; reason: string }[];
}
interface Session {
  token: string;
  id: string;
}

describe('Sync scenarios (the "done when" list of stage B2)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ann: Session;
  let bob: Session;
  const api = () => request(app.getHttpServer());

  async function signUp(email: string): Promise<Session> {
    const res = await api()
      .post('/auth/register')
      .send({ email, password: 'correct horse' })
      .expect(201);
    const body = res.body as { accessToken: string; user: { id: string } };
    return { token: body.accessToken, id: body.user.id };
  }

  const push = async (who: Session, body: object) => {
    const res = await api()
      .post('/sync/push')
      .set('Authorization', `Bearer ${who.token}`)
      .send(body)
      .expect(200);
    return res.body as PushResponse;
  };
  const pull = async (who: Session, query = '') => {
    const res = await api()
      .get(`/sync/pull${query}`)
      .set('Authorization', `Bearer ${who.token}`)
      .expect(200);
    return res.body as PullResponse;
  };

  // What the client does at the start of a sync: its saved watermark minus 5 seconds.
  const withOverlap = (next: string) =>
    new Date(Date.parse(next) - 5000).toISOString();

  // Everything about a pulled row except the server's own stamp, in a fixed order (the order
  // of a pull follows updated_at, which a repeated push moves).
  const content = (rows: Row[]) =>
    rows
      .map((row) => {
        const rest = { ...row };
        delete rest.updated_at;
        return rest;
      })
      .sort((a, b) =>
        JSON.stringify([a.id ?? a.task_id, a.date]).localeCompare(
          JSON.stringify([b.id ?? b.task_id, b.date]),
        ),
      );

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

  describe('the plan’s checklist', () => {
    it('a push repeated unchanged leaves the same data and refuses nothing', async () => {
      // The app always sends its own times; without them the server would use the clock.
      const stamps = {
        created_at: '2026-01-01T00:00:00Z',
        client_updated_at: '2026-01-02T00:00:00Z',
      };
      const body = {
        tasks: [
          { id: T2, parent_id: T1, title: 'b', ...stamps },
          { id: T1, title: 'a', start_date: '2026-03-01', ...stamps },
        ],
        logs: [
          {
            task_id: T1,
            date: '2026-01-15',
            completed: true,
            value: 2,
            client_updated_at: stamps.client_updated_at,
          },
        ],
        deleted: [{ table: 'tasks', id: T3 }],
      };
      expect((await push(ann, body)).rejected).toEqual([]);
      const first = await pull(ann);
      expect((await push(ann, body)).rejected).toEqual([]);
      const again = await pull(ann);
      expect(content(again.tasks)).toEqual(content(first.tasks));
      expect(content(again.logs)).toEqual(content(first.logs));
      expect(again.tasks).toHaveLength(3);
    });

    it('a subtask that comes before its parent in one batch is saved with its parent', async () => {
      const res = await push(ann, {
        tasks: [
          { id: T3, parent_id: T2, title: 'grandchild' },
          { id: T2, parent_id: T1, title: 'child' },
          { id: T1, title: 'parent' },
        ],
      });
      expect(res.rejected).toEqual([]);
      const tasks = (await pull(ann)).tasks;
      expect(tasks.map((t) => [t.id, t.parent_id])).toEqual(
        expect.arrayContaining([
          [T1, null],
          [T2, T1],
          [T3, T2],
        ]),
      );
    });

    it('a deleted task is emptied and its marks are gone; a mark sent for it later is not written', async () => {
      await push(ann, {
        tasks: [{ id: T1, title: 'Read', repeat_type: 'daily' }],
        logs: [
          { task_id: T1, date: '2026-01-15', completed: true },
          { task_id: T1, date: '2026-01-16', completed: true },
        ],
      });
      await push(ann, { deleted: [{ table: 'tasks', id: T1 }] });

      let state = await pull(ann);
      expect(state.logs).toEqual([]);
      expect(state.tasks).toHaveLength(1);
      expect(state.tasks[0]).toMatchObject({
        id: T1,
        title: '',
        repeat_type: null,
      });
      expect(state.tasks[0].deleted_at).not.toBeNull();

      // A device that has not heard of the deletion sends the task and a mark again.
      const res = await push(ann, {
        tasks: [{ id: T1, title: 'Back again' }],
        logs: [{ task_id: T1, date: '2026-01-17', completed: true }],
      });
      expect(res.rejected).toEqual([]);
      state = await pull(ann);
      expect(state.logs).toEqual([]);
      expect(state.tasks[0]).toMatchObject({ id: T1, title: '' });
      expect(state.tasks[0].deleted_at).not.toBeNull();
    });

    it('pages by has_more reach every row, however small the limit', async () => {
      await push(ann, {
        tasks: Array.from({ length: 7 }, (_, i) => ({ id: id(100 + i) })),
        logs: Array.from({ length: 6 }, (_, i) => ({
          task_id: id(100),
          date: `2026-01-0${i + 1}`,
        })),
      });
      for (const limit of [1, 2, 3, 7, 50]) {
        const tasks = new Set<unknown>();
        const logs = new Set<unknown>();
        let since = '';
        let pages = 0;
        do {
          const res = await pull(ann, `?limit=${limit}${since}`);
          res.tasks.forEach((t) => tasks.add(t.id));
          res.logs.forEach((l) => logs.add(l.date));
          since = res.has_more ? `&since=${res.next}` : '';
          pages += 1;
          if (!since) break;
        } while (pages < 30);
        expect(tasks.size).toBe(7);
        expect(logs.size).toBe(6);
        expect(pages).toBeLessThan(30);
      }
    });

    describe('the overlap of the watermark', () => {
      // A write that started earlier can commit later than one that started after it. The
      // stamp is taken when the row is written, not when it is committed, so the earlier
      // row appears behind a watermark that has already moved past it.
      async function lateCommit() {
        const writer = app.get(TaskWriter);
        const slow = ds.createQueryRunner();
        await slow.connect();
        await slow.startTransaction();
        try {
          const parsed = parseTask({ id: T1, title: 'slow writer' });
          if (!('row' in parsed)) throw new Error('bad test row');
          await writer.write(slow.manager, ann.id, [parsed.row]); // stamped now, not yet visible
          await push(ann, { tasks: [{ id: T2, title: 'fast writer' }] }); // stamped later
          const seen = await pull(ann);
          expect(seen.tasks.map((t) => t.id)).toEqual([T2]); // the slow row is not committed yet
          await slow.commitTransaction();
          return seen.next!;
        } catch (error) {
          await slow.rollbackTransaction();
          throw error;
        } finally {
          await slow.release();
        }
      }

      it('is missed by a client that asks from the exact watermark (why the overlap exists)', async () => {
        const watermark = await lateCommit();
        const res = await pull(ann, `?since=${watermark}`);
        expect(res.tasks).toEqual([]);
      });

      it('is picked up by a client that steps back 5 seconds when it starts a sync', async () => {
        const watermark = await lateCommit();
        const res = await pull(ann, `?since=${withOverlap(watermark)}`);
        expect(res.tasks.map((t) => t.id).sort()).toEqual([T1, T2]);
        expect(res.tasks.find((t) => t.id === T1)).toMatchObject({
          title: 'slow writer',
        });
      });

      it('repeats rows it has already seen without harm', async () => {
        await push(ann, { tasks: [{ id: T1, title: 'seen' }] });
        const first = await pull(ann);
        const again = await pull(ann, `?since=${withOverlap(first.next!)}`);
        expect(content(again.tasks)).toEqual(content(first.tasks));
      });
    });
  });

  describe('Ann and Bob never see or touch each other’s data', () => {
    beforeEach(async () => {
      await push(bob, {
        tasks: [
          { id: T1, title: 'Bob parent' },
          { id: T2, parent_id: T1, title: 'Bob child' },
        ],
        logs: [{ task_id: T1, date: '2026-01-15', completed: true, value: 7 }],
      });
      await push(ann, { tasks: [{ id: T3, title: 'Ann' }] });
    });

    const bobsData = async () => {
      const state = await pull(bob);
      return { tasks: content(state.tasks), logs: content(state.logs) };
    };

    it('does not show them in a pull, from the beginning of time or by name', async () => {
      const everything = await pull(
        ann,
        '?since=2000-01-01T00:00:00Z&limit=1000',
      );
      expect(everything.tasks.map((t) => t.id)).toEqual([T3]);
      expect(everything.logs).toEqual([]);
      // Neither a user_id in the query nor a header changes whose data it is.
      const named = await api()
        .get(`/sync/pull?user_id=${bob.id}`)
        .set('Authorization', `Bearer ${ann.token}`)
        .set('X-User-Id', bob.id)
        .expect(200);
      expect((named.body as PullResponse).tasks.map((t) => t.id)).toEqual([T3]);
    });

    it('does not let Ann change a task of Bob’s by pushing its id', async () => {
      const before = await bobsData();
      const res = await push(ann, {
        tasks: [{ id: T1, title: 'Hijacked', status: 'archived' }],
      });
      expect(res.rejected).toEqual([
        { table: 'tasks', id: T1, reason: 'id_taken' },
      ]);
      expect(await bobsData()).toEqual(before);
    });

    it('does not let Ann put a mark on a task of Bob’s, or change one he has', async () => {
      const before = await bobsData();
      const res = await push(ann, {
        logs: [
          { task_id: T1, date: '2026-01-15', completed: false, value: 99 },
          { task_id: T1, date: '2026-01-20', completed: true },
        ],
      });
      expect(res.rejected.map((r) => r.reason)).toEqual([
        'unknown_task',
        'unknown_task',
      ]);
      expect(await bobsData()).toEqual(before);
      expect((await pull(ann)).logs).toEqual([]);
    });

    it('does not let Ann delete a task of Bob’s', async () => {
      const before = await bobsData();
      const res = await push(ann, { deleted: [{ table: 'tasks', id: T1 }] });
      expect(res.rejected).toEqual([
        { table: 'tasks', id: T1, reason: 'id_taken' },
      ]);
      expect(await bobsData()).toEqual(before);
    });

    it('does not let Ann hang a subtask under a task of Bob’s', async () => {
      const before = await bobsData();
      const res = await push(ann, {
        tasks: [{ id: id(9), parent_id: T1, title: 'Sneaky child' }],
      });
      expect(res.rejected).toEqual([
        { table: 'tasks', id: id(9), reason: 'unknown_parent' },
      ]);
      expect(await bobsData()).toEqual(before);
      expect((await pull(ann)).tasks.map((t) => t.id)).toEqual([T3]);
    });

    it('does not let Ann move Bob’s task under her own by naming its id', async () => {
      const before = await bobsData();
      await push(ann, { tasks: [{ id: T2, parent_id: T3, title: 'Moved' }] });
      expect(await bobsData()).toEqual(before);
    });

    it('does not let a user_id in the body decide whose row it is', async () => {
      await push(ann, {
        tasks: [{ id: id(9), user_id: bob.id, title: 'Claimed for Bob' }],
        logs: [{ task_id: T3, date: '2026-01-15', user_id: bob.id }],
      });
      expect((await pull(bob)).tasks.map((t) => t.id).sort()).toEqual([T1, T2]);
      expect((await pull(ann)).tasks.map((t) => t.id).sort()).toEqual([
        T3,
        id(9),
      ]);
      expect((await pull(bob)).logs).toHaveLength(1); // his own mark, not Ann’s
    });

    it('does not leak anything through the answer to a refused row', async () => {
      const mine = await push(ann, {
        logs: [{ task_id: id(77), date: '2026-01-15' }],
      });
      const his = await push(ann, {
        logs: [{ task_id: T1, date: '2026-01-15' }],
      });
      expect(his.rejected[0].reason).toBe(mine.rejected[0].reason);
    });

    it('keeps the two apart in one table when both use the same day of the same kind of task', async () => {
      await push(ann, {
        logs: [{ task_id: T3, date: '2026-01-15', value: 1 }],
      });
      await push(bob, {
        logs: [{ task_id: T1, date: '2026-01-15', value: 2 }],
      });
      expect((await pull(ann)).logs.map((l) => l.value)).toEqual([1]);
      expect((await pull(bob)).logs.map((l) => l.value)).toEqual([2]);
    });
  });

  describe('two devices of one account exchange data through the server and agree', () => {
    // A small stand-in for the app: it keeps its own copy, remembers what is not sent yet,
    // pulls with the rules of `pullAction` and pushes what is dirty.
    let tick = 0;
    const clock = () =>
      new Date(Date.UTC(2026, 0, 1, 0, 0, ++tick)).toISOString();
    const time = (v: unknown) => Date.parse(v as string);

    class Device {
      tasks = new Map<string, Row>();
      logs = new Map<string, Row>();
      watermark: string | null = null;
      rejected: PushResponse['rejected'] = [];
      private dirtyTasks = new Set<string>();
      private dirtyLogs = new Set<string>();
      private gone = new Set<string>();

      constructor(private readonly who: Session) {}

      edit(taskId: string, fields: Row) {
        this.tasks.set(taskId, {
          ...this.tasks.get(taskId),
          ...fields,
          id: taskId,
          client_updated_at: clock(),
        });
        this.dirtyTasks.add(taskId);
      }

      mark(taskId: string, date: string, fields: Row) {
        const key = `${taskId}|${date}`;
        this.logs.set(key, {
          ...this.logs.get(key),
          ...fields,
          task_id: taskId,
          date,
          client_updated_at: clock(),
        });
        this.dirtyLogs.add(key);
      }

      remove(taskId: string) {
        this.dropTask(taskId);
        this.dirtyTasks.delete(taskId);
        this.gone.add(taskId);
      }

      private dropTask(taskId: string) {
        this.tasks.delete(taskId);
        for (const key of [...this.logs.keys()]) {
          if (key.startsWith(taskId)) {
            this.logs.delete(key);
            this.dirtyLogs.delete(key);
          }
        }
      }

      async sync(
        order: 'pull-first' | 'push-first' = 'pull-first',
        limit = 500,
      ) {
        if (order === 'pull-first') {
          await this.pullAll(limit);
          await this.pushAll();
        } else {
          await this.pushAll();
          await this.pullAll(limit);
        }
      }

      private async pushAll() {
        const chunks = <T>(list: T[]) =>
          Array.from({ length: Math.ceil(list.length / 500) }, (_, i) =>
            list.slice(i * 500, i * 500 + 500),
          );
        const tasks = chunks(
          [...this.dirtyTasks].map((i) => this.tasks.get(i)!),
        );
        const logs = chunks([...this.dirtyLogs].map((k) => this.logs.get(k)!));
        const deleted = chunks(
          [...this.gone].map((i) => ({ table: 'tasks', id: i })),
        );
        for (
          let i = 0;
          i < Math.max(tasks.length, logs.length, deleted.length);
          i++
        ) {
          const res = await push(this.who, {
            tasks: tasks[i] ?? [],
            logs: logs[i] ?? [],
            deleted: deleted[i] ?? [],
          });
          this.rejected.push(...res.rejected);
        }
        this.dirtyTasks.clear();
        this.dirtyLogs.clear();
        this.gone.clear();
      }

      private async pullAll(limit: number) {
        // Overlap once, at the start; follow `next` as it is.
        let since = this.watermark ? withOverlap(this.watermark) : null;
        for (;;) {
          const res = await pull(
            this.who,
            `?limit=${limit}${since ? `&since=${since}` : ''}`,
          );
          res.tasks.forEach((t) => this.mergeTask(t));
          res.logs.forEach((l) => this.mergeLog(l));
          if (res.next) this.watermark = res.next;
          if (!res.has_more) return;
          since = res.next;
        }
      }

      // pullAction: a deletion wins; a clean copy takes whatever comes; a dirty one keeps
      // itself only if it is newer by the device's own clock.
      private mergeTask(remote: Row) {
        const taskId = remote.id as string;
        const local = this.tasks.get(taskId);
        if (remote.deleted_at) {
          if (local) this.dropTask(taskId);
          this.dirtyTasks.delete(taskId);
        } else if (
          !local ||
          !this.dirtyTasks.has(taskId) ||
          time(remote.client_updated_at) > time(local.client_updated_at)
        ) {
          this.tasks.set(taskId, remote);
          this.dirtyTasks.delete(taskId);
        }
      }

      private mergeLog(remote: Row) {
        const key = `${remote.task_id as string}|${remote.date as string}`;
        const local = this.logs.get(key);
        if (
          !local ||
          !this.dirtyLogs.has(key) ||
          time(remote.client_updated_at) > time(local.client_updated_at)
        ) {
          this.logs.set(key, remote);
          this.dirtyLogs.delete(key);
        }
      }

      snapshot() {
        return {
          tasks: [...this.tasks.values()]
            .map((t) => [
              t.id,
              t.parent_id ?? null,
              t.title ?? '',
              t.status ?? 'active',
            ])
            .sort(),
          logs: [...this.logs.values()]
            .map((l) => [
              l.task_id,
              l.date,
              l.completed ?? false,
              l.value ?? null,
            ])
            .sort(),
        };
      }
    }

    let phone: Device;
    let tablet: Device;
    beforeEach(() => {
      tick = 0;
      phone = new Device(ann);
      tablet = new Device(ann);
    });

    it('the tablet receives what the phone made, subtasks and marks included', async () => {
      phone.edit(T2, { parent_id: T1, title: 'child' }); // child before parent
      phone.edit(T1, { title: 'parent' });
      phone.mark(T1, '2026-01-15', { completed: true });
      await phone.sync();
      await tablet.sync();

      expect(tablet.snapshot()).toEqual(phone.snapshot());
      expect(tablet.snapshot().tasks).toEqual([
        [T1, null, 'parent', 'active'],
        [T2, T1, 'child', 'active'],
      ]);
      expect(tablet.snapshot().logs).toEqual([[T1, '2026-01-15', true, null]]);
      expect(phone.rejected).toEqual([]);
    });

    it('edits made on both sides, a deletion and a changed mark all meet in the middle', async () => {
      phone.edit(T1, { title: 'one' });
      phone.edit(T2, { title: 'two' });
      phone.edit(T3, { title: 'three' });
      phone.mark(T1, '2026-01-15', { completed: true });
      phone.mark(T3, '2026-01-15', { completed: true });
      await phone.sync();
      await tablet.sync();

      tablet.edit(T1, { title: 'one (tablet)' });
      tablet.remove(T3);
      tablet.mark(T1, '2026-01-16', { completed: true });
      phone.edit(T2, { title: 'two (phone)' });
      phone.mark(T1, '2026-01-15', { completed: false });

      await tablet.sync();
      await phone.sync();
      await tablet.sync();

      expect(tablet.snapshot()).toEqual(phone.snapshot());
      expect(phone.snapshot()).toEqual({
        tasks: [
          [T1, null, 'one (tablet)', 'active'],
          [T2, null, 'two (phone)', 'active'],
        ],
        logs: [
          [T1, '2026-01-15', false, null],
          [T1, '2026-01-16', true, null],
        ],
      });
    });

    it('a repeated sync with nothing new changes nothing', async () => {
      phone.edit(T1, { title: 'one' });
      phone.mark(T1, '2026-01-15', { completed: true });
      await phone.sync();
      await tablet.sync();
      const before = JSON.stringify(tablet.snapshot());
      await tablet.sync();
      await phone.sync();
      await tablet.sync();
      expect(JSON.stringify(tablet.snapshot())).toBe(before);
      expect(phone.snapshot()).toEqual(tablet.snapshot());
    });

    describe('a deletion beats an edit made elsewhere, whichever device acts first', () => {
      it.each(['pull-first', 'push-first'] as const)(
        'when the editing device syncs %s',
        async (order) => {
          phone.edit(T1, { title: 'one' });
          phone.mark(T1, '2026-01-15', { completed: true });
          await phone.sync();
          await tablet.sync();

          phone.remove(T1);
          tablet.edit(T1, { title: 'edited after the deletion elsewhere' });
          tablet.mark(T1, '2026-01-16', { completed: true });
          await phone.sync();
          await tablet.sync(order);
          await phone.sync();

          expect(tablet.snapshot()).toEqual({ tasks: [], logs: [] });
          expect(phone.snapshot()).toEqual({ tasks: [], logs: [] });
          expect((await pull(ann)).logs).toEqual([]);
        },
      );
    });

    describe('two edits of the same task', () => {
      const setUp = async () => {
        phone.edit(T1, { title: 'start' });
        await phone.sync();
        await tablet.sync();
      };

      it('the later edit wins when the device that made it syncs last', async () => {
        await setUp();
        phone.edit(T1, { title: 'phone, earlier' });
        tablet.edit(T1, { title: 'tablet, later' });
        await phone.sync();
        await tablet.sync();
        await phone.sync();
        expect(phone.snapshot().tasks[0][2]).toBe('tablet, later');
        expect(tablet.snapshot()).toEqual(phone.snapshot());
      });

      it('the later edit wins when the device that made it syncs first', async () => {
        await setUp();
        phone.edit(T1, { title: 'phone, earlier' });
        tablet.edit(T1, { title: 'tablet, later' });
        await tablet.sync();
        await phone.sync();
        await tablet.sync();
        expect(phone.snapshot().tasks[0][2]).toBe('tablet, later');
        expect(tablet.snapshot()).toEqual(phone.snapshot());
      });

      // The server keeps the push that came last and does not compare client_updated_at. So the
      // app has to pull before it pushes: then a stale copy never gets as far as the server.
      it('the server keeps the push that arrived last; a device that pushes before it pulls overwrites a newer edit', async () => {
        await setUp();
        tablet.edit(T1, { title: 'tablet, older' });
        phone.edit(T1, { title: 'phone, newer' });
        await phone.sync();
        await tablet.sync('push-first');
        const [stored] = (await pull(ann)).tasks;
        expect(stored.title).toBe('tablet, older');
      });
    });

    it('a new device receives a large account in several pages', async () => {
      for (let i = 0; i < 600; i++)
        phone.edit(id(1000 + i), { title: `t${i}` });
      for (let i = 0; i < 300; i++) {
        phone.mark(
          id(1000),
          `${2020 + Math.floor(i / 365)}-${String(1 + Math.floor((i % 365) / 31)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
          {
            completed: true,
          },
        );
      }
      await phone.sync();
      expect(phone.rejected).toEqual([]);

      await tablet.sync('pull-first', 200);
      expect(tablet.snapshot().tasks).toHaveLength(600);
      expect(tablet.snapshot()).toEqual(phone.snapshot());
      expect(tablet.snapshot().logs.length).toBe(phone.snapshot().logs.length);
    });

    it('a user’s second account sees none of it', async () => {
      phone.edit(T1, { title: 'private' });
      phone.mark(T1, '2026-01-15', { completed: true });
      await phone.sync();
      const strangers = new Device(bob);
      await strangers.sync();
      expect(strangers.snapshot()).toEqual({ tasks: [], logs: [] });
    });
  });
});
