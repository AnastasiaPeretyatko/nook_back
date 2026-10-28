import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { DeletionWriter } from '../src/sync/deletion-writer';
import { createTestApp, truncateAll } from './support/db';

interface PushResponse {
  rejected: { table: string; id: string | null; reason: string }[];
  server_time: string;
}
interface Session {
  token: string;
  id: string;
}

const days = (n: number) => {
  const start = Date.UTC(2025, 0, 1);
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    flow: i % 5,
    symptoms: [i % 9],
  }));
};

describe('POST /sync/push with the cycle', () => {
  let app: INestApplication;
  let ds: DataSource;
  let throwInDeletions = false;
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

  const push = async (who: Session, body: object, status = 200) => {
    const res = await api()
      .post('/sync/push')
      .set('Authorization', `Bearer ${who.token}`)
      .send(body)
      .expect(status);
    return res.body as PushResponse;
  };
  const reasons = (r: PushResponse) =>
    r.rejected.map((x) => `${x.table}:${x.id}:${x.reason}`).sort();

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

  const cycleOf = (userId: string): Promise<Record<string, unknown>[]> =>
    ds.query(
      `select date::text as day, flow, mood, symptoms, discharge, sex, pill, note
       from cycle_days where user_id = $1 order by date`,
      [userId],
    );
  const count = async () =>
    (await ds.query(`select count(*)::int n from cycle_days`))[0].n as number;

  it('writes days, empty ones too, and refuses nothing', async () => {
    const res = await push(ann, {
      cycle_days: [
        {
          date: '2026-01-15',
          flow: 3,
          mood: 2,
          symptoms: [5, 1],
          discharge: 4,
          sex: 1,
          pill: true,
          note: 'hi',
        },
        { date: '2026-01-16' },
      ],
    });
    expect(res.rejected).toEqual([]);
    expect(await cycleOf(ann.id)).toEqual([
      {
        day: '2026-01-15',
        flow: 3,
        mood: 2,
        symptoms: [1, 5],
        discharge: 4,
        sex: 1,
        pill: true,
        note: 'hi',
      },
      {
        day: '2026-01-16',
        flow: 0,
        mood: null,
        symptoms: [],
        discharge: null,
        sex: null,
        pill: false,
        note: null,
      },
    ]);
  });

  it('an empty day sent later replaces the filled one and stays a row', async () => {
    await push(ann, { cycle_days: [{ date: '2026-01-15', flow: 3, mood: 2 }] });
    await push(ann, { cycle_days: [{ date: '2026-01-15' }] });
    expect(await cycleOf(ann.id)).toEqual([
      expect.objectContaining({ flow: 0, mood: null, symptoms: [] }),
    ]);
  });

  it('is idempotent: the same push twice leaves the same rows', async () => {
    const body = { cycle_days: days(20) };
    expect((await push(ann, body)).rejected).toEqual([]);
    const first = await cycleOf(ann.id);
    expect((await push(ann, body)).rejected).toEqual([]);
    expect(await cycleOf(ann.id)).toEqual(first);
    expect(first).toHaveLength(20);
  });

  describe('bad days', () => {
    it('refuses them by the day and writes the good ones beside them', async () => {
      const res = await push(ann, {
        cycle_days: [
          { date: '2026-01-15', flow: 1 },
          { date: '2026-01-16', flow: 9 },
          { date: '2026-01-17', symptoms: [1, 99] },
          { date: '2026-01-18', pill: 'yes' },
          { date: '2026-01-19', flow: 2 },
        ],
      });
      expect(reasons(res)).toEqual([
        'cycle_days:2026-01-16:invalid_row',
        'cycle_days:2026-01-17:invalid_row',
        'cycle_days:2026-01-18:invalid_row',
      ]);
      expect((await cycleOf(ann.id)).map((d) => d.day)).toEqual([
        '2026-01-15',
        '2026-01-19',
      ]);
    });

    it('reports a day that cannot be read with a null id, and never echoes the client string', async () => {
      const res = await push(ann, {
        cycle_days: [
          { date: '2026-02-30' },
          { flow: 1 },
          5,
          null,
          { date: 'x'.repeat(50) },
        ],
      });
      expect(res.rejected).toEqual(
        Array(5).fill({
          table: 'cycle_days',
          id: null,
          reason: 'invalid_row',
        }),
      );
      expect(await count()).toBe(0);
    });

    it('a bad day beside other lists does not stop them', async () => {
      const res = await push(ann, {
        cycle_days: [{ date: '2026-01-15', flow: 9 }],
        tasks: [{ id: '00000000-0000-4000-8000-000000000001' }],
      });
      expect(reasons(res)).toEqual(['cycle_days:2026-01-15:invalid_row']);
      expect(await ds.query(`select count(*)::int n from tasks`)).toEqual([
        { n: 1 },
      ]);
    });

    it('a push with only bad days writes nothing', async () => {
      await push(ann, { cycle_days: [{ date: '2026-01-15', flow: 9 }] });
      expect(await count()).toBe(0);
    });
  });

  describe('whose days they are', () => {
    it('writes under the token, whatever user_id the day names', async () => {
      await push(ann, {
        cycle_days: [{ date: '2026-01-15', flow: 2, user_id: bob.id }],
      });
      expect(await cycleOf(ann.id)).toHaveLength(1);
      expect(await cycleOf(bob.id)).toEqual([]);
    });

    it("Ann's day with Bob's user_id does not touch Bob's same day", async () => {
      await push(bob, {
        cycle_days: [{ date: '2026-01-15', flow: 4, note: 'bob' }],
      });
      await push(ann, {
        cycle_days: [{ date: '2026-01-15', flow: 1, user_id: bob.id }],
      });
      expect(await cycleOf(bob.id)).toEqual([
        expect.objectContaining({ flow: 4, note: 'bob' }),
      ]);
      expect(await cycleOf(ann.id)).toEqual([
        expect.objectContaining({ flow: 1, note: null }),
      ]);
    });
  });

  describe('deletions', () => {
    it('still refuses a deletion in cycle_days, and keeps the day', async () => {
      await push(ann, { cycle_days: [{ date: '2026-01-15', flow: 2 }] });
      const id = '00000000-0000-4000-8000-000000000001';
      const res = await push(ann, {
        deleted: [{ table: 'cycle_days', id }],
      });
      expect(res.rejected).toEqual([
        { table: 'cycle_days', id, reason: 'unsupported_table' },
      ]);
      expect(await cycleOf(ann.id)).toHaveLength(1);
    });

    it('refuses a deletion that names a day instead of a uuid, and keeps the day', async () => {
      await push(ann, { cycle_days: [{ date: '2026-01-15', flow: 2 }] });
      const res = await push(ann, {
        deleted: [{ table: 'cycle_days', id: '2026-01-15' }],
      });
      expect(res.rejected).toEqual([
        { table: 'deleted', id: null, reason: 'invalid_row' },
      ]);
      expect(await cycleOf(ann.id)).toHaveLength(1);
    });
  });

  describe('the whole request', () => {
    it('writes the cycle together with tasks, marks and deletions', async () => {
      const T1 = '00000000-0000-4000-8000-000000000001';
      const res = await push(ann, {
        tasks: [{ id: T1 }],
        logs: [{ task_id: T1, date: '2026-01-15', completed: true }],
        cycle_days: [{ date: '2026-01-15', flow: 2 }],
        deleted: [
          { table: 'tasks', id: '00000000-0000-4000-8000-000000000002' },
        ],
      });
      expect(res.rejected).toEqual([]);
      expect(await cycleOf(ann.id)).toHaveLength(1);
      expect(await ds.query(`select count(*)::int n from tasks`)).toEqual([
        { n: 2 },
      ]);
    });

    it('rolls everything back when a later step fails, and a retry works', async () => {
      throwInDeletions = true;
      const body = {
        cycle_days: [{ date: '2026-01-15', flow: 2 }],
        deleted: [
          { table: 'tasks', id: '00000000-0000-4000-8000-000000000002' },
        ],
      };
      const res = await api()
        .post('/sync/push')
        .set('Authorization', `Bearer ${ann.token}`)
        .send(body)
        .expect(500);
      expect(res.body).toEqual({
        code: 'internal_error',
        message: 'Internal server error',
      });
      expect(await count()).toBe(0);

      throwInDeletions = false;
      expect((await push(ann, body)).rejected).toEqual([]);
      expect(await count()).toBe(1);
    });

    it('takes 500 days in one push', async () => {
      expect((await push(ann, { cycle_days: days(500) })).rejected).toEqual([]);
      expect(await count()).toBe(500);
    });

    it('refuses 501 days with batch_too_large and writes none', async () => {
      const res = await api()
        .post('/sync/push')
        .set('Authorization', `Bearer ${ann.token}`)
        .send({ cycle_days: days(501) })
        .expect(400);
      expect(res.body.code).toBe('batch_too_large');
      expect(await count()).toBe(0);
    });

    it('takes an empty list as nothing to do', async () => {
      const res = await push(ann, { cycle_days: [] });
      expect(res.rejected).toEqual([]);
      expect(await count()).toBe(0);
    });
  });
});
