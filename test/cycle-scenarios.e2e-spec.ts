import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp, truncateAll } from './support/db';
import { Device, PullBody, Rejected, Row } from './support/fake-device';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [N1, G1, T1] = [id(1), id(21), id(31)];
const dayN = (n: number) =>
  new Date(Date.UTC(2025, 0, n)).toISOString().slice(0, 10);
const [D1, D2, D3] = [dayN(1), dayN(2), dayN(3)];

interface Session {
  token: string;
  id: string;
}

describe('The cycle (the "done when" list of stage B4)', () => {
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
    return res.body as { rejected: Rejected[] };
  };
  const pull = async (who: Session, query = '?include=cycle') => {
    const res = await api()
      .get(`/sync/pull${query}`)
      .set('Authorization', `Bearer ${who.token}`)
      .expect(200);
    return res.body as PullBody;
  };

  let tick = 0;
  const clock = () =>
    new Date(Date.UTC(2026, 0, 1, 0, 0, ++tick)).toISOString();
  const deviceOf = (who: Session, cycle = true, diary = false) =>
    new Device(
      { push: (body) => push(who, body), pull: (query) => pull(who, query) },
      clock,
      { cycle, diary },
    );

  const dates = (rows: Row[] | undefined) => (rows ?? []).map((r) => r.date);
  const rowsOf = (userId: string): Promise<Row[]> =>
    ds.query(
      `select date::text as date, flow, note from cycle_days where user_id = $1 order by date`,
      [userId],
    );

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
  });

  beforeEach(async () => {
    tick = 0;
    await truncateAll(ds);
    ann = await signUp('ann@example.com');
    bob = await signUp('bob@example.com');
  });

  afterAll(() => app.close());

  describe('marks reach the second device whole', () => {
    it('with every field', async () => {
      const phone = deviceOf(ann);
      const tablet = deviceOf(ann);
      phone.day(D1, {
        flow: 3,
        mood: 5,
        symptoms: [8, 0, 4],
        discharge: 6,
        sex: 2,
        pill: true,
        note: 'tired 😊',
      });
      phone.day(D2, { flow: 1 });
      await phone.sync();
      await tablet.sync();

      expect(phone.rejected).toEqual([]);
      expect(tablet.cycleSnapshot()).toEqual(phone.cycleSnapshot());
      expect(tablet.cycleSnapshot()[0]).toEqual([
        D1,
        3,
        5,
        [0, 4, 8],
        6,
        2,
        true,
        'tired 😊',
      ]);
    });

    it('along with the tasks, in the same sync', async () => {
      const phone = deviceOf(ann);
      const tablet = deviceOf(ann);
      phone.edit(T1, { title: 'Read' });
      phone.day(D1, { flow: 2 });
      await phone.sync();
      await tablet.sync();
      expect(tablet.snapshot().tasks).toEqual(phone.snapshot().tasks);
      expect(tablet.cycleSnapshot()).toEqual(phone.cycleSnapshot());
    });
  });

  describe('a taken-back mark arrives as an empty day, it does not vanish', () => {
    it('on the second device, which had the filled day', async () => {
      const phone = deviceOf(ann);
      const tablet = deviceOf(ann);
      phone.day(D1, { flow: 3, mood: 2, symptoms: [1, 2], note: 'x' });
      await phone.sync();
      await tablet.sync();
      expect(tablet.cycleDays.get(D1)).toMatchObject({ flow: 3 });

      phone.day(D1);
      await phone.sync();
      await tablet.sync();

      expect(tablet.cycleDays.has(D1)).toBe(true);
      expect(tablet.cycleSnapshot()).toEqual([
        [D1, 0, null, [], null, null, false, null],
      ]);
      expect(tablet.cycleSnapshot()).toEqual(phone.cycleSnapshot());
    });

    it('and the server keeps it as a row, so a new device learns of it too', async () => {
      const phone = deviceOf(ann);
      phone.day(D1, { flow: 3 });
      await phone.sync();
      phone.day(D1);
      await phone.sync();
      expect(await rowsOf(ann.id)).toEqual([{ date: D1, flow: 0, note: null }]);

      const fresh = deviceOf(ann);
      await fresh.sync();
      expect(fresh.cycleDays.has(D1)).toBe(true);
    });

    it('and the later of a clearing and an edit made elsewhere wins on both devices', async () => {
      const phone = deviceOf(ann);
      const tablet = deviceOf(ann);
      phone.day(D1, { flow: 3 });
      await phone.sync();
      await tablet.sync();
      phone.day(D1); // cleared, earlier
      tablet.day(D1, { flow: 4, note: 'later' });
      await phone.sync();
      await tablet.sync();
      await phone.sync();
      expect(phone.cycleSnapshot()).toEqual(tablet.cycleSnapshot());
      expect(phone.cycleDays.get(D1)).toMatchObject({ flow: 4, note: 'later' });
    });

    it('and a later clearing beats an earlier edit made elsewhere', async () => {
      const phone = deviceOf(ann);
      const tablet = deviceOf(ann);
      phone.day(D1, { flow: 3 });
      await phone.sync();
      await tablet.sync();
      tablet.day(D1, { flow: 4 }); // earlier
      phone.day(D1); // cleared, later
      await tablet.sync();
      await phone.sync();
      await tablet.sync();
      expect(phone.cycleSnapshot()).toEqual(tablet.cycleSnapshot());
      expect(tablet.cycleSnapshot()).toEqual([
        [D1, 0, null, [], null, null, false, null],
      ]);
    });
  });

  describe('the switch of the cycle', () => {
    it('keeps the cycle off a device that does not ask for it, and the tasks coming', async () => {
      const phone = deviceOf(ann);
      phone.edit(T1, { title: 'Read' });
      phone.day(D1, { flow: 2 });
      await phone.sync();

      const tablet = deviceOf(ann, false);
      await tablet.sync();
      expect(tablet.snapshot().tasks).toEqual(phone.snapshot().tasks);
      expect(tablet.cycleSnapshot()).toEqual([]);
    });

    it('still takes what a device with the switch off writes', async () => {
      const tablet = deviceOf(ann, false);
      tablet.day(D1, { flow: 2 });
      await tablet.sync();
      expect(tablet.rejected).toEqual([]);
      expect(dates((await pull(ann)).cycle_days)).toEqual([D1]);
    });

    describe('turning it on later', () => {
      // The one watermark moves ahead on the tasks alone while the cycle is off.
      async function oldDayThenLaterTask() {
        const phone = deviceOf(ann);
        phone.day(D1, { flow: 2 });
        await phone.sync();
        await ds.query(
          `alter table cycle_days disable trigger cycle_days_updated_at`,
        );
        await ds.query(
          `update cycle_days set updated_at = now() - interval '1 hour'`,
        );
        await ds.query(
          `alter table cycle_days enable trigger cycle_days_updated_at`,
        );
        phone.edit(T1, { title: 'a later task' });
        await phone.sync();

        const tablet = deviceOf(ann, false);
        await tablet.sync();
        expect(tablet.cycleSnapshot()).toEqual([]);
        return tablet;
      }

      it('loses the older days for a device that goes on from its watermark (why a full pull is needed)', async () => {
        const tablet = await oldDayThenLaterTask();
        tablet.setCycle(true);
        await tablet.sync();
        expect(tablet.cycleSnapshot()).toEqual([]);
      });

      it('gets all of it from a device that starts from the beginning when the switch goes on', async () => {
        const tablet = await oldDayThenLaterTask();
        tablet.setCycle(true);
        tablet.forgetWatermark();
        await tablet.sync();
        expect(dates([...tablet.cycleDays.values()])).toEqual([D1]);
      });
    });

    it('turned off again, the device stops getting days but keeps asking for tasks', async () => {
      const phone = deviceOf(ann);
      const tablet = deviceOf(ann);
      await tablet.sync();
      tablet.setCycle(false);
      phone.edit(T1, { title: 'new task' });
      phone.day(D1, { flow: 2 });
      await phone.sync();
      await tablet.sync();
      expect(tablet.snapshot().tasks).toEqual(phone.snapshot().tasks);
      expect(tablet.cycleSnapshot()).toEqual([]);
    });

    it('the cycle switch does not bring the diary, nor the diary switch the cycle', async () => {
      const phone = deviceOf(ann, true, true);
      phone.tag(G1, { name: 'Work' });
      phone.note(N1, { title: 'n' });
      phone.day(D1, { flow: 2 });
      await phone.sync();

      const onlyCycle = deviceOf(ann, true, false);
      await onlyCycle.sync();
      expect(onlyCycle.cycleSnapshot()).toHaveLength(1);
      expect(onlyCycle.diarySnapshot().notes).toEqual([]);

      const onlyDiary = deviceOf(ann, false, true);
      await onlyDiary.sync();
      expect(onlyDiary.diarySnapshot().notes).toHaveLength(1);
      expect(onlyDiary.cycleSnapshot()).toEqual([]);
    });
  });

  describe('Ann and Bob never see or touch each other’s days', () => {
    beforeEach(async () => {
      await push(bob, {
        cycle_days: [
          { date: D1, flow: 4, note: 'bob-secret' },
          { date: D2, mood: 3 },
        ],
        tasks: [{ id: id(40), title: 'bob task' }],
      });
    });

    it('does not show them in any pull, from the beginning of time, with every include', async () => {
      await push(ann, { cycle_days: [{ date: D3, flow: 1 }] });
      for (const query of [
        '?include=cycle',
        '?include=cycle,diary,tasks',
        '?include=cycle&since=',
        '',
        '?include=diary',
      ]) {
        const res = await pull(ann, query);
        expect(JSON.stringify(res)).not.toContain('bob-secret');
        expect(dates(res.cycle_days ?? [])).not.toContain(D2);
      }
      expect(dates((await pull(ann)).cycle_days)).toEqual([D3]);
    });

    it('does not let Ann change them: the same day under her token is her own row', async () => {
      await push(ann, { cycle_days: [{ date: D1, flow: 1, note: 'ann' }] });
      expect(await rowsOf(bob.id)).toEqual([
        { date: D1, flow: 4, note: 'bob-secret' },
        { date: D2, flow: 0, note: null },
      ]);
      expect(await rowsOf(ann.id)).toEqual([
        { date: D1, flow: 1, note: 'ann' },
      ]);
    });

    it('does not let a user_id in the body decide whose day it is', async () => {
      const res = await push(ann, {
        cycle_days: [{ date: dayN(10), flow: 2, user_id: bob.id }],
      });
      expect(res.rejected).toEqual([]);
      expect(dates(await rowsOf(bob.id))).toEqual([D1, D2]);
      expect(dates(await rowsOf(ann.id))).toEqual([dayN(10)]);
      expect(dates((await pull(bob)).cycle_days)).toEqual([D1, D2]);
    });

    it('does not let Ann delete them, by a day or by anything else', async () => {
      const res = await push(ann, {
        deleted: [
          { table: 'cycle_days', id: D1 },
          { table: 'cycle_days', id: id(99) },
        ],
      });
      expect(res.rejected.map((r) => r.reason).sort()).toEqual([
        'invalid_row',
        'unsupported_table',
      ]);
      expect(await rowsOf(bob.id)).toHaveLength(2);
    });

    it('keeps Ann’s emptied day from touching Bob’s same day', async () => {
      const phone = deviceOf(ann);
      phone.day(D1, { flow: 3 });
      await phone.sync();
      phone.day(D1);
      await phone.sync();
      expect((await rowsOf(bob.id))[0]).toEqual({
        date: D1,
        flow: 4,
        note: 'bob-secret',
      });
    });

    it('shows a new device of Ann nothing of Bob', async () => {
      const stranger = deviceOf(ann);
      await stranger.sync();
      expect(stranger.cycleSnapshot()).toEqual([]);
    });

    it('keeps the days out of every other part of the answer', async () => {
      await push(ann, {
        cycle_days: [{ date: D3, note: 'ann-private' }],
        tasks: [{ id: id(41), title: 'ann task' }],
      });
      const res = await pull(ann, '?include=cycle,diary');
      const { cycle_days, ...others } = res;
      expect(cycle_days).toHaveLength(1);
      expect(JSON.stringify(others)).not.toContain('ann-private');
    });
  });

  describe('two devices of one account exchange the days and agree', () => {
    let phone: Device;
    let tablet: Device;
    beforeEach(() => {
      phone = deviceOf(ann);
      tablet = deviceOf(ann);
    });
    const agree = () => {
      expect(tablet.cycleSnapshot()).toEqual(phone.cycleSnapshot());
      expect(tablet.snapshot()).toEqual(phone.snapshot());
    };

    it('different days marked on both sides all meet in the middle', async () => {
      phone.day(D1, { flow: 1 });
      await phone.sync();
      await tablet.sync();
      tablet.day(D2, { flow: 2 });
      phone.day(D3, { flow: 3, symptoms: [1] });
      phone.day(D1); // cleared
      await tablet.sync();
      await phone.sync();
      await tablet.sync();
      agree();
      expect(phone.cycleSnapshot().map((d) => [d[0], d[1]])).toEqual([
        [D1, 0],
        [D2, 2],
        [D3, 3],
      ]);
    });

    it('the later of two edits of one day wins on both devices', async () => {
      phone.day(D1, { flow: 1 });
      await phone.sync();
      await tablet.sync();
      phone.day(D1, { flow: 2, note: 'phone, earlier' });
      tablet.day(D1, { flow: 3, note: 'tablet, later' });
      await phone.sync();
      await tablet.sync();
      await phone.sync();
      agree();
      expect(phone.cycleDays.get(D1)).toMatchObject({
        flow: 3,
        note: 'tablet, later',
      });
    });

    it('a repeated sync with nothing new changes nothing', async () => {
      phone.day(D1, { flow: 1, symptoms: [1, 2] });
      phone.day(D2);
      await phone.sync();
      await tablet.sync();
      const before = JSON.stringify(tablet.cycleSnapshot());
      await tablet.sync();
      await phone.sync();
      await tablet.sync();
      expect(JSON.stringify(tablet.cycleSnapshot())).toBe(before);
      agree();
    });

    it('a new device receives a year and more of days in several pages', async () => {
      for (let i = 0; i < 700; i++) {
        phone.day(dayN(i + 1), { flow: i % 5, symptoms: [i % 9] });
      }
      await phone.sync();
      expect(phone.rejected).toEqual([]);

      await tablet.sync('pull-first', 100);
      expect(tablet.cycleDays.size).toBe(700);
      expect(tablet.pulls).toBeGreaterThan(5);
      agree();
    });

    it('more than 500 dirty days leave in several pushes and none is lost', async () => {
      for (let i = 0; i < 1200; i++) phone.day(dayN(i + 1), { flow: i % 5 });
      await phone.sync();
      expect(phone.rejected).toEqual([]);
      expect(await rowsOf(ann.id)).toHaveLength(1200);
    });

    it('a second account sees none of it', async () => {
      phone.day(D1, { flow: 2, note: 'private' });
      await phone.sync();
      const stranger = deviceOf(bob);
      await stranger.sync();
      expect(stranger.cycleSnapshot()).toEqual([]);
    });
  });
});
