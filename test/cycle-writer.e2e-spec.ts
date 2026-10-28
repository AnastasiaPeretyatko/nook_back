import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CycleWriter } from '../src/sync/cycle-writer';
import { CycleDayRow, parseCycleDay } from '../src/sync/push-rows';
import { createTestApp, truncateAll } from './support/db';

// Rows go through the same check as in a real push.
const day = (
  date: string,
  fields: Record<string, unknown> = {},
): CycleDayRow => {
  const result = parseCycleDay({ date, ...fields });
  if (!('row' in result)) throw new Error('bad test row');
  return result.row;
};

describe('CycleWriter', () => {
  let app: INestApplication;
  let ds: DataSource;
  let cycle: CycleWriter;
  let ann: string;
  let bob: string;

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
    cycle = app.get(CycleWriter);
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

  const write = (userId: string, rows: CycleDayRow[]) =>
    ds.transaction((m) => cycle.write(m, userId, rows));

  // Days and moments are read back as text: a JS Date would lose the day's zone or the microseconds.
  const allDays = (): Promise<Record<string, unknown>[]> =>
    ds.query(
      `select user_id, date::text as day, flow, mood, symptoms, discharge, sex, pill, note,
              client_updated_at::text as client_updated_at
       from cycle_days order by user_id, date`,
    );

  const FULL = {
    flow: 3,
    mood: 5,
    symptoms: [8, 0, 4],
    discharge: 6,
    sex: 2,
    pill: true,
    note: 'tired',
    client_updated_at: '2026-01-15T10:00:01.654321Z',
  };

  it('writes a day with every field, under the caller', async () => {
    await write(ann, [day('2026-01-15', FULL)]);
    expect(await allDays()).toEqual([
      {
        user_id: ann,
        day: '2026-01-15',
        flow: 3,
        mood: 5,
        symptoms: [0, 4, 8],
        discharge: 6,
        sex: 2,
        pill: true,
        note: 'tired',
        client_updated_at: '2026-01-15 10:00:01.654321+00',
      },
    ]);
  });

  it('stamps updated_at on the server, whatever the client says', async () => {
    await write(ann, [
      day('2026-01-15', { client_updated_at: '2000-01-01T00:00:00Z' }),
    ]);
    const [{ fresh }] = await ds.query(
      `select updated_at > '2020-01-01' fresh from cycle_days`,
    );
    expect(fresh).toBe(true);
  });

  it('does nothing for an empty list', async () => {
    await write(ann, []);
    expect(await allDays()).toEqual([]);
  });

  describe('an empty day', () => {
    it('is stored as a row, not skipped', async () => {
      await write(ann, [day('2026-01-15')]);
      expect(await allDays()).toEqual([
        expect.objectContaining({
          day: '2026-01-15',
          flow: 0,
          mood: null,
          symptoms: [],
          discharge: null,
          sex: null,
          pill: false,
          note: null,
        }),
      ]);
    });

    it('replaces a filled day and stays one row', async () => {
      await write(ann, [day('2026-01-15', FULL)]);
      await write(ann, [day('2026-01-15')]);
      const rows = await allDays();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        flow: 0,
        mood: null,
        symptoms: [],
        discharge: null,
        sex: null,
        pill: false,
        note: null,
      });
    });
  });

  describe('updating', () => {
    it('replaces the day whole: a field the new version lacks is cleared', async () => {
      await write(ann, [day('2026-01-15', FULL)]);
      await write(ann, [day('2026-01-15', { flow: 1 })]);
      expect(await allDays()).toEqual([
        expect.objectContaining({
          flow: 1,
          mood: null,
          symptoms: [],
          note: null,
          pill: false,
        }),
      ]);
    });

    it('moves updated_at forward', async () => {
      await write(ann, [day('2026-01-15')]);
      const [{ before }] = await ds.query(
        `select updated_at::text before from cycle_days`,
      );
      await write(ann, [day('2026-01-15', { flow: 2 })]);
      const [{ moved }] = await ds.query(
        `select updated_at > $1::timestamptz moved from cycle_days`,
        [before],
      );
      expect(moved).toBe(true);
    });

    it('is idempotent: the same batch twice leaves the same rows', async () => {
      const rows = [day('2026-01-15', FULL), day('2026-01-16')];
      await write(ann, rows);
      const first = await allDays();
      await write(ann, rows);
      expect(await allDays()).toEqual(first);
    });

    it('keeps one row per day: another day is another row', async () => {
      await write(ann, [day('2026-01-15'), day('2026-01-16')]);
      expect(await allDays()).toHaveLength(2);
    });

    it('lets the later row win when a day comes twice in a batch', async () => {
      await write(ann, [
        day('2026-01-15', { flow: 1, note: 'first' }),
        day('2026-01-16', { flow: 4 }),
        day('2026-01-15', { flow: 2 }),
      ]);
      expect(await allDays()).toEqual([
        expect.objectContaining({ day: '2026-01-15', flow: 2, note: null }),
        expect.objectContaining({ day: '2026-01-16', flow: 4 }),
      ]);
    });

    it('lets an empty day win over a filled one earlier in the batch', async () => {
      await write(ann, [day('2026-01-15', FULL), day('2026-01-15')]);
      expect(await allDays()).toEqual([
        expect.objectContaining({ flow: 0, mood: null, symptoms: [] }),
      ]);
    });
  });

  describe('two people', () => {
    it('keeps the same day of two users as two rows', async () => {
      await write(ann, [day('2026-01-15', { flow: 1 })]);
      await write(bob, [day('2026-01-15', { flow: 4 })]);
      expect(await allDays()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ user_id: ann, flow: 1 }),
          expect.objectContaining({ user_id: bob, flow: 4 }),
        ]),
      );
      expect(await allDays()).toHaveLength(2);
    });

    it("does not touch Bob's day when Ann writes the same day", async () => {
      await write(bob, [day('2026-01-15', { flow: 4, note: 'bob' })]);
      await write(ann, [day('2026-01-15', { flow: 1 })]);
      const rows = await allDays();
      expect(rows.find((r) => r.user_id === bob)).toMatchObject({
        flow: 4,
        note: 'bob',
      });
    });

    it('ignores a user_id in the row: the day lands under the caller, not Bob', async () => {
      await write(ann, [day('2026-01-15', { user_id: bob, flow: 2 })]);
      expect(await allDays()).toEqual([
        expect.objectContaining({ user_id: ann, flow: 2 }),
      ]);
    });
  });

  describe('the data', () => {
    it('stores a lone surrogate in a note as U+FFFD instead of failing', async () => {
      await write(ann, [day('2026-01-15', { note: 'ab\uD83D' })]);
      expect((await allDays())[0].note).toBe('ab�');
    });

    it('keeps an emoji, quotes, a backslash and a newline in a note', async () => {
      const note = 'ok 😊 "q" \\ \n end';
      await write(ann, [day('2026-01-15', { note })]);
      expect((await allDays())[0].note).toBe(note);
    });

    it('writes 500 days in one go', async () => {
      const start = Date.UTC(2025, 0, 1);
      const rows = Array.from({ length: 500 }, (_, i) =>
        day(new Date(start + i * 86_400_000).toISOString().slice(0, 10), {
          flow: i % 5,
          symptoms: [i % 9],
        }),
      );
      await write(ann, rows);
      expect(await allDays()).toHaveLength(500);
    });
  });

  it('writes nothing when the transaction fails afterwards', async () => {
    await expect(
      ds.transaction(async (m) => {
        await cycle.write(m, ann, [day('2026-01-15', FULL)]);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await allDays()).toEqual([]);
  });
});
