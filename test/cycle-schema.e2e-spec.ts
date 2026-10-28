import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createTestApp, truncateAll } from './support/db';

const NOBODY = '00000000-0000-4000-8000-000000000000';
const DAY = '2026-01-15';

describe('Table cycle_days', () => {
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

  // A day with the given columns (after user_id and date).
  function addDay(
    userId: string,
    date: string,
    fields: Record<string, unknown> = {},
  ) {
    const cols = ['user_id', 'date', ...Object.keys(fields)];
    const params = [userId, date, ...Object.values(fields)];
    return ds.query(
      `insert into cycle_days (${cols.join(', ')})
       values (${params.map((_, i) => `$${i + 1}`).join(', ')})`,
      params,
    );
  }
  const count = async () =>
    (await ds.query(`select count(*)::int n from cycle_days`))[0].n as number;

  it('fills in an empty day when only the key is given', async () => {
    const user = await addUser();
    await addDay(user, DAY);
    const [row] = await ds.query(`select * from cycle_days`);
    expect(row).toMatchObject({
      user_id: user,
      flow: 0,
      mood: null,
      symptoms: [],
      discharge: null,
      sex: null,
      pill: false,
      note: null,
    });
  });

  it('keeps the day as a plain date, not a moment', async () => {
    const user = await addUser();
    await addDay(user, DAY);
    const [{ d }] = await ds.query(`select date::text as d from cycle_days`);
    expect(d).toBe(DAY);
  });

  describe('the options are bounded as in the app', () => {
    // [column, lowest allowed, highest allowed, nullable]
    const columns: [string, number, number, boolean][] = [
      ['flow', 0, 4, false],
      ['mood', 0, 5, true],
      ['discharge', 0, 6, true],
      ['sex', 0, 2, true],
    ];

    it.each(columns)(
      '%s accepts %i to %i and refuses anything outside',
      async (column, low, high) => {
        const user = await addUser();
        let day = 0;
        const date = () => `2026-02-${String(++day).padStart(2, '0')}`;
        await addDay(user, date(), { [column]: low });
        await addDay(user, date(), { [column]: high });
        await expect(
          addDay(user, date(), { [column]: low - 1 }),
        ).rejects.toThrow(new RegExp(`cycle_days_${column}_check`));
        await expect(
          addDay(user, date(), { [column]: high + 1 }),
        ).rejects.toThrow(new RegExp(`cycle_days_${column}_check`));
      },
    );

    it.each(columns.filter(([, , , nullable]) => nullable))(
      '%s may be empty',
      async (column) => {
        const user = await addUser();
        await addDay(user, DAY, { [column]: null });
        expect(await count()).toBe(1);
      },
    );

    it('flow may not be empty', async () => {
      const user = await addUser();
      await expect(addDay(user, DAY, { flow: null })).rejects.toThrow(/flow/);
    });

    it('symptoms are any of 0 to 8, each at most once or repeated, and an empty list', async () => {
      const user = await addUser();
      await addDay(user, '2026-02-01', { symptoms: [] });
      await addDay(user, '2026-02-02', { symptoms: [0, 4, 8] });
      await addDay(user, '2026-02-03', {
        symptoms: [0, 1, 2, 3, 4, 5, 6, 7, 8],
      });
      expect(await count()).toBe(3);
    });

    it('symptoms outside 0 to 8 are refused', async () => {
      const user = await addUser();
      await expect(
        addDay(user, '2026-02-01', { symptoms: [9] }),
      ).rejects.toThrow(/cycle_days_symptoms_check/);
      await expect(
        addDay(user, '2026-02-02', { symptoms: [-1] }),
      ).rejects.toThrow(/cycle_days_symptoms_check/);
      await expect(
        addDay(user, '2026-02-03', { symptoms: [1, 2, 9] }),
      ).rejects.toThrow(/cycle_days_symptoms_check/);
    });

    it('symptoms may not be empty (null), only an empty list', async () => {
      const user = await addUser();
      await expect(addDay(user, DAY, { symptoms: null })).rejects.toThrow(
        /symptoms/,
      );
    });

    it('pill may not be empty', async () => {
      const user = await addUser();
      await expect(addDay(user, DAY, { pill: null })).rejects.toThrow(/pill/);
    });
  });

  it('keeps any note, long ones and ones with quotes, newlines and emoji included', async () => {
    const user = await addUser();
    const note = 'He said "hi" \\ \n 😀 ё'.repeat(1000);
    await addDay(user, DAY, { note });
    const [row] = await ds.query(`select note from cycle_days`);
    expect(row.note).toBe(note);
  });

  describe('the key', () => {
    it('is the user and the day: the same day twice is refused', async () => {
      const user = await addUser();
      await addDay(user, DAY);
      await expect(addDay(user, DAY)).rejects.toThrow(/cycle_days_pkey/);
    });

    it('lets two users mark the same day, and one user mark different days', async () => {
      const ann = await addUser('ann@example.com');
      const bob = await addUser('bob@example.com');
      await addDay(ann, DAY, { flow: 2 });
      await addDay(bob, DAY, { flow: 4 });
      await addDay(ann, '2026-01-16');
      expect(await count()).toBe(3);
      const rows = await ds.query(
        `select user_id, flow from cycle_days where date = $1 order by flow`,
        [DAY],
      );
      expect(rows).toEqual([
        { user_id: ann, flow: 2 },
        { user_id: bob, flow: 4 },
      ]);
    });

    it('is resolved by an upsert on the pair, so two phones converge on one row', async () => {
      const user = await addUser();
      const upsert = (flow: number) =>
        ds.query(
          `insert into cycle_days (user_id, date, flow) values ($1, $2, $3)
           on conflict (user_id, date) do update set flow = excluded.flow`,
          [user, DAY, flow],
        );
      await upsert(1);
      await upsert(3);
      expect(await count()).toBe(1);
      expect((await ds.query(`select flow from cycle_days`))[0].flow).toBe(3);
    });

    it('refuses a user that does not exist', async () => {
      await expect(addDay(NOBODY, DAY)).rejects.toThrow(
        /cycle_days_user_id_fkey/,
      );
    });

    it('is not a date that does not exist', async () => {
      const user = await addUser();
      await expect(addDay(user, '2026-02-30')).rejects.toThrow();
    });
  });

  describe('updated_at', () => {
    it('is stamped on the server, ignoring the value given', async () => {
      const user = await addUser();
      await addDay(user, DAY, { updated_at: '2000-01-01' });
      const [{ fresh }] = await ds.query(
        `select updated_at > '2020-01-01' fresh from cycle_days`,
      );
      expect(fresh).toBe(true);
    });

    it('moves forward on every update', async () => {
      const user = await addUser();
      await addDay(user, DAY);
      const [{ before }] = await ds.query(
        `select updated_at::text before from cycle_days`,
      );
      await ds.query(`update cycle_days set flow = 2`);
      const [{ moved }] = await ds.query(
        `select updated_at > $1::timestamptz moved from cycle_days`,
        [before],
      );
      expect(moved).toBe(true);
    });

    it('moves forward when a day is saved empty over a marked one (the taking back of a mark)', async () => {
      const user = await addUser();
      await addDay(user, DAY, {
        flow: 3,
        mood: 2,
        symptoms: [1, 2],
        pill: true,
        note: 'x',
      });
      const [{ before }] = await ds.query(
        `select updated_at::text before from cycle_days`,
      );
      await ds.query(
        `update cycle_days set flow = 0, mood = null, symptoms = '{}', discharge = null, sex = null, pill = false, note = null`,
      );
      const [row] = await ds.query(
        `select *, updated_at > $1::timestamptz moved from cycle_days`,
        [before],
      );
      expect(row).toMatchObject({
        flow: 0,
        mood: null,
        symptoms: [],
        pill: false,
        note: null,
        moved: true,
      });
      expect(await count()).toBe(1);
    });
  });

  it('is removed together with its user', async () => {
    const ann = await addUser('ann@example.com');
    const bob = await addUser('bob@example.com');
    await addDay(ann, DAY);
    await addDay(ann, '2026-01-16');
    await addDay(bob, DAY);
    await ds.query(`delete from users where id = $1`, [ann]);
    expect(await ds.query(`select user_id from cycle_days`)).toEqual([
      { user_id: bob },
    ]);
  });
});
