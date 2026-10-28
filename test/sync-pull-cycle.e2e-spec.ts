import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp, truncateAll } from './support/db';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

type Row = Record<string, unknown>;
interface PullResponse {
  next: string | null;
  has_more: boolean;
  tasks: Row[];
  logs: Row[];
  moods?: Row[];
  tags?: Row[];
  entries?: Row[];
  cycle_days?: Row[];
}
interface Session {
  token: string;
  id: string;
}

describe('GET /sync/pull with the cycle', () => {
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
  const push = (who: Session, body: object) =>
    api()
      .post('/sync/push')
      .set('Authorization', `Bearer ${who.token}`)
      .send(body)
      .expect(200);
  const pull = async (who: Session, query = '?include=cycle', status = 200) => {
    const res = await api()
      .get(`/sync/pull${query}`)
      .set('Authorization', `Bearer ${who.token}`)
      .expect(status);
    return res.body as PullResponse;
  };

  // Gives a day a chosen time, to build exact situations (the server normally stamps it itself).
  async function stamp(userId: string, date: string, at: string) {
    await ds.query(
      `alter table cycle_days disable trigger cycle_days_updated_at`,
    );
    await ds.query(
      `update cycle_days set updated_at = $1 where user_id = $2 and date = $3`,
      [at, userId, date],
    );
    await ds.query(
      `alter table cycle_days enable trigger cycle_days_updated_at`,
    );
  }
  const early = (n: number) =>
    `2026-03-01T10:00:${String(n).padStart(2, '0')}.000000Z`;
  const second = (n: number) =>
    `2030-03-01T10:00:${String(n).padStart(2, '0')}.000000Z`;
  const dates = (rows: Row[] | undefined) => (rows ?? []).map((r) => r.date);
  const dayN = (n: number) => `2026-01-${String(n).padStart(2, '0')}`;

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

  describe('the switch', () => {
    beforeEach(async () => {
      await push(ann, {
        cycle_days: [{ date: dayN(15), flow: 2 }],
        tasks: [{ id: id(1) }],
      });
    });

    it('gives no cycle without include=cycle', async () => {
      for (const query of ['', '?include=tasks', '?include=diary']) {
        const res = await pull(ann, query);
        expect(res).not.toHaveProperty('cycle_days');
        expect(JSON.stringify(res)).not.toContain(dayN(15));
      }
    });

    it('gives the cycle, and not the diary, with include=cycle', async () => {
      const res = await pull(ann);
      expect(dates(res.cycle_days)).toEqual([dayN(15)]);
      expect(Object.keys(res).sort()).toEqual([
        'cycle_days',
        'groups',
        'has_more',
        'logs',
        'next',
        'tasks',
      ]);
    });

    it('gives both when both are asked for', async () => {
      const res = await pull(ann, '?include=tasks,diary,cycle');
      expect(dates(res.cycle_days)).toEqual([dayN(15)]);
      expect(res.moods).toBeDefined();
      expect(res.entries).toBeDefined();
    });

    it('gives an empty list, not a missing key, when there are no days', async () => {
      const res = await pull(bob);
      expect(res.cycle_days).toEqual([]);
    });
  });

  describe('the shape of a row', () => {
    it('gives a day in the plan’s keys, without user_id', async () => {
      await push(ann, {
        cycle_days: [
          {
            user_id: bob.id,
            date: dayN(15),
            flow: 3,
            mood: 5,
            symptoms: [8, 0, 4],
            discharge: 6,
            sex: 2,
            pill: true,
            note: 'tired',
            client_updated_at: '2026-01-15T10:00:01.654321Z',
          },
        ],
      });
      const [row] = (await pull(ann)).cycle_days!;
      const { updated_at, ...rest } = row;
      expect(rest).toEqual({
        date: dayN(15),
        flow: 3,
        mood: 5,
        symptoms: [0, 4, 8],
        discharge: 6,
        sex: 2,
        pill: true,
        note: 'tired',
        client_updated_at: '2026-01-15T10:00:01.654321Z',
      });
      expect(updated_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
      );
    });

    it('gives the day as plain text and symptoms as numbers', async () => {
      await push(ann, { cycle_days: [{ date: dayN(15), symptoms: [2, 1] }] });
      const [row] = (await pull(ann)).cycle_days!;
      expect(typeof row.date).toBe('string');
      expect(row.symptoms).toEqual([1, 2]);
    });

    it('gives an empty day as a row, not nothing', async () => {
      await push(ann, { cycle_days: [{ date: dayN(15) }] });
      const [row] = (await pull(ann)).cycle_days!;
      expect(row).toMatchObject({
        date: dayN(15),
        flow: 0,
        mood: null,
        symptoms: [],
        discharge: null,
        sex: null,
        pill: false,
        note: null,
      });
    });

    it('gives a taken-back mark as an empty day newer than the filled one', async () => {
      await push(ann, {
        cycle_days: [{ date: dayN(15), flow: 3, mood: 2, note: 'x' }],
      });
      const filled = (await pull(ann)).cycle_days![0];
      await push(ann, { cycle_days: [{ date: dayN(15) }] });
      const res = await pull(
        ann,
        `?include=cycle&since=${filled.updated_at as string}`,
      );
      expect(res.cycle_days).toEqual([
        expect.objectContaining({
          date: dayN(15),
          flow: 0,
          mood: null,
          symptoms: [],
          note: null,
        }),
      ]);
    });

    it('keeps text exactly: quotes, backslashes, newlines, emoji', async () => {
      const note = 'q " b \\ n \n e 😊';
      await push(ann, { cycle_days: [{ date: dayN(15), note }] });
      expect((await pull(ann)).cycle_days![0].note).toBe(note);
    });
  });

  describe('whose days', () => {
    it('gives each user only their own days', async () => {
      await push(ann, { cycle_days: [{ date: dayN(1), flow: 1 }] });
      await push(bob, {
        cycle_days: [
          { date: dayN(1), flow: 4, note: 'bob' },
          { date: dayN(2) },
        ],
      });
      const mine = await pull(ann);
      expect(mine.cycle_days).toEqual([
        expect.objectContaining({ date: dayN(1), flow: 1, note: null }),
      ]);
      expect(JSON.stringify(mine)).not.toContain('bob');
      expect(dates((await pull(bob)).cycle_days)).toEqual([dayN(1), dayN(2)]);
    });

    it('shows Bob nothing of Ann even from the beginning of time', async () => {
      await push(ann, { cycle_days: [{ date: dayN(1), note: 'secret' }] });
      const res = await pull(bob, '?include=cycle,diary,tasks&since=');
      expect(res.cycle_days).toEqual([]);
      expect(JSON.stringify(res)).not.toContain('secret');
    });

    it('does not let a day pushed with Bob’s user_id reach Bob', async () => {
      await push(ann, {
        cycle_days: [{ date: dayN(1), user_id: bob.id, note: 'sneaky' }],
      });
      expect((await pull(bob)).cycle_days).toEqual([]);
      expect(dates((await pull(ann)).cycle_days)).toEqual([dayN(1)]);
    });
  });

  describe('since', () => {
    beforeEach(async () => {
      await push(ann, {
        cycle_days: [{ date: dayN(1) }, { date: dayN(2) }, { date: dayN(3) }],
      });
      await stamp(ann.id, dayN(1), early(1));
      await stamp(ann.id, dayN(2), early(2));
      await stamp(ann.id, dayN(3), early(3));
    });

    it('gives only days strictly newer', async () => {
      const res = await pull(ann, `?include=cycle&since=${early(1)}`);
      expect(dates(res.cycle_days)).toEqual([dayN(2), dayN(3)]);
    });

    it('gives days oldest first by the time of the change, not by the day', async () => {
      await stamp(ann.id, dayN(3), early(0));
      expect(dates((await pull(ann)).cycle_days)).toEqual([
        dayN(3),
        dayN(1),
        dayN(2),
      ]);
    });

    it('takes the newest time as next, even when only the cycle has rows', async () => {
      const res = await pull(ann);
      expect(res.tasks).toEqual([]);
      expect(res.next).toBe(early(3));
      expect(res.has_more).toBe(false);
    });

    it('gives nothing and keeps since when nothing is newer', async () => {
      const res = await pull(ann, `?include=cycle&since=${early(3)}`);
      expect(res.cycle_days).toEqual([]);
      expect(res.next).toBe(early(3));
    });

    it('gives a day again once it was saved again', async () => {
      await push(ann, { cycle_days: [{ date: dayN(1), flow: 4 }] });
      const res = await pull(ann, `?include=cycle&since=${early(3)}`);
      expect(res.cycle_days).toEqual([
        expect.objectContaining({ date: dayN(1), flow: 4 }),
      ]);
    });
  });

  describe('pages', () => {
    it('cuts at the limit and says there is more', async () => {
      await push(ann, {
        cycle_days: [1, 2, 3, 4, 5].map((d) => ({ date: dayN(d) })),
      });
      for (const d of [1, 2, 3, 4, 5]) await stamp(ann.id, dayN(d), second(d));
      const res = await pull(ann, '?include=cycle&limit=2');
      expect(dates(res.cycle_days)).toEqual([dayN(1), dayN(2)]);
      expect(res.has_more).toBe(true);
      expect(res.next).toBe(second(2));
    });

    it('does not split days that share one time', async () => {
      await push(ann, {
        cycle_days: [1, 2, 3, 4].map((d) => ({ date: dayN(d) })),
      });
      await stamp(ann.id, dayN(1), second(1));
      await stamp(ann.id, dayN(2), second(2));
      await stamp(ann.id, dayN(3), second(2));
      await stamp(ann.id, dayN(4), second(3));
      const first = await pull(ann, '?include=cycle&limit=2');
      expect(dates(first.cycle_days)).toEqual([dayN(1), dayN(2), dayN(3)]);
      expect(first.next).toBe(second(2));
      const next = await pull(
        ann,
        `?include=cycle&limit=2&since=${first.next}`,
      );
      expect(dates(next.cycle_days)).toEqual([dayN(4)]);
    });

    it('continues from the earliest of the cut parts, among all six', async () => {
      // Tasks are cut at s2 (of s1..s3), days are cut later, at s12: next must be s2.
      await push(ann, {
        tasks: [id(1), id(2), id(3)].map((t) => ({ id: t })),
        cycle_days: [1, 2, 3].map((d) => ({ date: dayN(d) })),
      });
      for (const [i, t] of [id(1), id(2), id(3)].entries()) {
        await ds.query(`alter table tasks disable trigger tasks_updated_at`);
        await ds.query(`update tasks set updated_at = $1 where id = $2`, [
          second(i + 1),
          t,
        ]);
        await ds.query(`alter table tasks enable trigger tasks_updated_at`);
      }
      for (const d of [1, 2, 3]) await stamp(ann.id, dayN(d), second(10 + d));
      const res = await pull(
        ann,
        '?include=diary,cycle&limit=2&since=2030-01-01T00:00:00Z',
      );
      expect(res.has_more).toBe(true);
      expect(res.tasks).toHaveLength(2);
      expect(res.cycle_days).toHaveLength(2);
      expect(res.next).toBe(second(2));
    });

    it('converges: walking small pages gives every day', async () => {
      await push(ann, {
        tasks: [id(40), id(41), id(42)].map((t) => ({ id: t })),
        cycle_days: Array.from({ length: 11 }, (_, i) => ({
          date: dayN(i + 1),
        })),
      });
      const got = new Set<unknown>();
      let since = '';
      for (let pages = 0; pages < 40; pages += 1) {
        const res = await pull(ann, `?include=cycle&limit=2${since}`);
        res.cycle_days!.forEach((r) => got.add(r.date));
        if (!res.has_more) break;
        since = `&since=${res.next}`;
      }
      expect(got.size).toBe(11);
    });
  });

  it('refuses what is not an include, as before', async () => {
    await pull(ann, '?include=cycle,foo', 400);
  });
});
