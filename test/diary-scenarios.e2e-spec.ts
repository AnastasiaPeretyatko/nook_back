import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp, truncateAll } from './support/db';
import { Device, PullBody, Rejected, Row } from './support/fake-device';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [N1, N2, N3] = [id(1), id(2), id(3)];
const [M1, M2] = [id(11), id(12)];
const [G1, G2] = [id(21), id(22)];
const T1 = id(31);
const JOY = '0f8a4c3e-1d92-4b7a-9c15-6e2f8a01b4d3'; // starter moods
const SAD = '7e94b2d1-6a08-4c52-9f7b-38e5c1470ab9';
const STARTER_NAMES = [
  'Радость',
  'Спокойствие',
  'Размышления',
  'Грусть',
  'Усталость',
  'Благодарность',
  'Тревога',
  'Любовь',
];

interface Session {
  token: string;
  id: string;
}

describe('The diary (the "done when" list of stage B3)', () => {
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
  const pull = async (who: Session, query = '?include=diary') => {
    const res = await api()
      .get(`/sync/pull${query}`)
      .set('Authorization', `Bearer ${who.token}`)
      .expect(200);
    return res.body as PullBody;
  };
  const reasons = (r: { rejected: Rejected[] }) =>
    r.rejected.map((x) => `${x.table}:${x.id}:${x.reason}`).sort();

  let tick = 0;
  const clock = () =>
    new Date(Date.UTC(2026, 0, 1, 0, 0, ++tick)).toISOString();
  const deviceOf = (who: Session, diary = true) =>
    new Device(
      { push: (body) => push(who, body), pull: (query) => pull(who, query) },
      clock,
      { diary },
    );

  const all = async (sql: string, ...params: unknown[]) => {
    const rows: Row[] = await ds.query(sql, params);
    return rows;
  };
  const ids = (rows: Row[] | undefined) => (rows ?? []).map((r) => r.id);
  const own = (rows: Row[] | undefined) =>
    (rows ?? []).filter((m) => !STARTER_NAMES.includes(m.name as string));

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

  describe('a note with tags and a mood reaches the second device whole', () => {
    it('with every field, its own mood, a starter mood and its tags', async () => {
      const phone = deviceOf(ann);
      const tablet = deviceOf(ann);
      phone.mood(M1, { name: 'Mine', emoji: '🙂' });
      phone.tag(G1, { name: 'Work', color_key: 'red' });
      phone.tag(G2, { name: 'Home', color_key: 'green' });
      phone.note(N1, {
        title: 'A day',
        body: '[{"insert":"text\\n"}]',
        cover_image: 'cover.jpg',
        images: '["a.jpg"]',
        is_favorite: true,
        status: 'draft',
        mood_ids: [M1, JOY],
        tag_ids: [G1, G2],
      });
      await phone.sync();
      await tablet.sync();

      expect(phone.rejected).toEqual([]);
      expect(tablet.diarySnapshot()).toEqual(phone.diarySnapshot());
      expect(tablet.diarySnapshot().notes).toEqual([
        [
          N1,
          'A day',
          '[{"insert":"text\\n"}]',
          'draft',
          true,
          [M1, JOY].sort(),
          [G1, G2],
        ],
      ]);
      expect(tablet.notes.get(N1)).toMatchObject({
        cover_image: 'cover.jpg',
        images: '["a.jpg"]',
      });
      expect(tablet.diarySnapshot().tags).toEqual([
        [G1, 'Work', 'red'],
        [G2, 'Home', 'green'],
      ]);
    });

    it('along with the tasks, in the same sync', async () => {
      const phone = deviceOf(ann);
      const tablet = deviceOf(ann);
      phone.edit(T1, { title: 'Read' });
      phone.tag(G1, { name: 'Work' });
      phone.note(N1, { tag_ids: [G1] });
      await phone.sync();
      await tablet.sync();
      expect(tablet.snapshot().tasks).toEqual(phone.snapshot().tasks);
      expect(tablet.diarySnapshot()).toEqual(phone.diarySnapshot());
    });

    it('and a later change of its labels reaches it too', async () => {
      const phone = deviceOf(ann);
      const tablet = deviceOf(ann);
      phone.tag(G1, { name: 'a' });
      phone.tag(G2, { name: 'b' });
      phone.note(N1, { tag_ids: [G1], mood_ids: [JOY] });
      await phone.sync();
      await tablet.sync();
      phone.note(N1, { tag_ids: [G2], mood_ids: [SAD, JOY] });
      await phone.sync();
      await tablet.sync();
      expect(tablet.diarySnapshot().notes[0].slice(5)).toEqual([
        [JOY, SAD].sort(),
        [G2],
      ]);
      expect(tablet.diarySnapshot()).toEqual(phone.diarySnapshot());
    });
  });

  describe('the starter moods: read by everybody, written by nobody', () => {
    it('are on every account from the first sync, exactly as the app has them', async () => {
      for (const who of [ann, bob]) {
        const device = deviceOf(who);
        await device.sync();
        expect(
          device
            .diarySnapshot()
            .moods.map((m) => m[1])
            .sort(),
        ).toEqual([...STARTER_NAMES].sort());
        expect(device.moods.get(JOY)).toMatchObject({
          name: 'Радость',
          emoji: '😊',
        });
      }
    });

    it('can be put on a note by anybody', async () => {
      const a = deviceOf(ann);
      const b = deviceOf(bob);
      a.note(N1, { mood_ids: [JOY] });
      b.note(N2, { mood_ids: [JOY, SAD] });
      await a.sync();
      await b.sync();
      expect(a.rejected).toEqual([]);
      expect(b.rejected).toEqual([]);
      expect((await pull(ann)).entries![0].mood_ids).toEqual([JOY]);
      expect((await pull(bob)).entries![0].mood_ids).toEqual([JOY, SAD].sort());
    });

    describe('cannot be written', () => {
      const intact = async () => {
        const rows = await all(
          `select id, name, emoji, user_id, deleted_at from note_moods where user_id is null order by id`,
        );
        expect(rows).toHaveLength(8);
        expect(rows.find((r) => r.id === JOY)).toEqual({
          id: JOY,
          name: 'Радость',
          emoji: '😊',
          user_id: null,
          deleted_at: null,
        });
        expect(rows.map((r) => r.name).sort()).toEqual(
          [...STARTER_NAMES].sort(),
        );
      };

      it.each([['Ann'], ['Bob']])(
        'by a push of %s that names one as its own',
        async (who) => {
          const session = who === 'Ann' ? ann : bob;
          const res = await push(session, {
            moods: [
              { id: JOY, name: 'Hijacked', emoji: '💀', user_id: session.id },
            ],
          });
          expect(reasons(res)).toEqual([`note_moods:${JOY}:id_taken`]);
          await intact();
        },
      );

      it('by a deletion', async () => {
        const res = await push(ann, {
          deleted: [{ table: 'note_moods', id: JOY }],
        });
        expect(reasons(res)).toEqual([`note_moods:${JOY}:id_taken`]);
        await intact();
      });

      it('by a note that is pushed together with such a mood or such a deletion', async () => {
        const res = await push(ann, {
          moods: [{ id: JOY, name: 'x', emoji: 'y' }],
          entries: [{ id: N1, mood_ids: [JOY] }],
          deleted: [{ table: 'note_moods', id: JOY }],
        });
        expect(reasons(res)).toEqual([
          `note_moods:${JOY}:id_taken`,
          `note_moods:${JOY}:id_taken`,
        ]);
        await intact();
        // The note itself is fine and keeps its link to the real mood.
        expect((await pull(ann)).entries![0].mood_ids).toEqual([JOY]);
      });

      it('nor by the database itself: no statement can change or delete one', async () => {
        await expect(
          ds.query(`update note_moods set name = 'x' where id = $1`, [JOY]),
        ).rejects.toThrow(/starter mood/);
        await expect(
          ds.query(`delete from note_moods where id = $1`, [JOY]),
        ).rejects.toThrow(/starter mood/);
        await intact();
      });

      it('and a device that sends its seeded copy does not break its own sync', async () => {
        const phone = deviceOf(ann);
        phone.mood(JOY, { name: 'Радость', emoji: '😊' }); // an old app that syncs its seeds
        phone.note(N1, { mood_ids: [JOY] });
        // Pushing before it pulls, as an app that has not yet heard of the starter moods does.
        await phone.sync('push-first');
        expect(phone.rejected.map((r) => r.reason)).toEqual(['id_taken']);
        expect((await pull(ann)).entries![0].mood_ids).toEqual([JOY]);
        await intact();
      });
    });
  });

  describe('the switch of the diary', () => {
    it('keeps the diary off a device that does not ask for it, and the tasks coming', async () => {
      const phone = deviceOf(ann);
      phone.edit(T1, { title: 'Read' });
      phone.tag(G1, { name: 'Work' });
      phone.note(N1, { tag_ids: [G1] });
      await phone.sync();

      const tablet = deviceOf(ann, false);
      await tablet.sync();
      expect(tablet.snapshot().tasks).toEqual(phone.snapshot().tasks);
      expect(tablet.diarySnapshot()).toEqual({
        notes: [],
        tags: [],
        moods: [],
      });
    });

    it('still takes what a device with the switch off writes: the diary can be written in either state', async () => {
      const tablet = deviceOf(ann, false);
      tablet.note(N1, { title: 'written while off' });
      await tablet.sync();
      expect(tablet.rejected).toEqual([]);
      expect(ids((await pull(ann)).entries)).toEqual([N1]);
    });

    describe('turning it on later', () => {
      // The one watermark moves ahead on the tasks alone while the diary is off. The note is
      // older than the last task by more than the 5 seconds of overlap.
      async function diaryThenLaterTask() {
        const phone = deviceOf(ann);
        phone.tag(G1, { name: 'Work' });
        phone.note(N1, { title: 'old note', tag_ids: [G1] });
        await phone.sync();
        for (const [table, rowId] of [
          ['diary_entries', N1],
          ['note_tags', G1],
        ]) {
          await ds.query(
            `alter table ${table} disable trigger ${table}_updated_at`,
          );
          await ds.query(
            `update ${table} set updated_at = now() - interval '1 hour' where id = $1`,
            [rowId],
          );
          await ds.query(
            `alter table ${table} enable trigger ${table}_updated_at`,
          );
        }
        phone.edit(T1, { title: 'a later task' });
        await phone.sync();

        const tablet = deviceOf(ann, false);
        await tablet.sync();
        expect(tablet.diarySnapshot().notes).toEqual([]);
        return tablet;
      }

      it('loses the older diary rows for a device that goes on from its watermark (why a full pull is needed)', async () => {
        const tablet = await diaryThenLaterTask();
        tablet.setDiary(true);
        await tablet.sync();
        expect(tablet.diarySnapshot().notes).toEqual([]);
      });

      it('gets all of it from a device that starts from the beginning when the switch goes on', async () => {
        const tablet = await diaryThenLaterTask();
        tablet.setDiary(true);
        tablet.forgetWatermark();
        await tablet.sync();
        expect(tablet.diarySnapshot().notes.map((n) => n[0])).toEqual([N1]);
        expect(tablet.diarySnapshot().tags.map((t) => t[0])).toEqual([G1]);
        expect(tablet.notes.get(N1)!.tag_ids).toEqual([G1]);
        expect(tablet.moods.size).toBe(8);
      });
    });

    it('turned off again, the device stops getting diary rows but keeps asking for tasks', async () => {
      const phone = deviceOf(ann);
      const tablet = deviceOf(ann);
      await tablet.sync();
      tablet.setDiary(false);
      phone.edit(T1, { title: 'new task' });
      phone.note(N1, {});
      await phone.sync();
      await tablet.sync();
      expect(tablet.snapshot().tasks).toEqual(phone.snapshot().tasks);
      expect(tablet.diarySnapshot().notes).toEqual([]);
    });
  });

  describe('Ann and Bob never see or touch each other’s diary', () => {
    beforeEach(async () => {
      await push(bob, {
        moods: [{ id: M1, name: "Bob's mood", emoji: '🙂' }],
        tags: [{ id: G1, name: "Bob's tag", color_key: 'red' }],
        entries: [
          {
            id: N1,
            title: "Bob's note",
            body: 'secret',
            mood_ids: [M1, JOY],
            tag_ids: [G1],
          },
        ],
      });
      await push(ann, {
        entries: [{ id: N2, title: "Ann's note", mood_ids: [JOY] }],
      });
    });

    const bobsDiary = async () => {
      const res = await pull(bob);
      const strip = (rows: Row[] | undefined) =>
        rows!.map((r) => ({ ...r, updated_at: undefined }));
      return {
        entries: strip(res.entries),
        tags: strip(res.tags),
        moods: strip(res.moods),
      };
    };

    it('does not show them in a pull, from the beginning of time or by name', async () => {
      const res = await pull(
        ann,
        '?include=diary&since=2000-01-01T00:00:00Z&limit=1000',
      );
      expect(ids(res.entries)).toEqual([N2]);
      expect(res.tags).toEqual([]);
      expect(own(res.moods)).toEqual([]);
      const named = await api()
        .get(`/sync/pull?include=diary&user_id=${bob.id}`)
        .set('Authorization', `Bearer ${ann.token}`)
        .set('X-User-Id', bob.id)
        .expect(200);
      expect(ids((named.body as PullBody).entries)).toEqual([N2]);
    });

    it('does not let Ann change them by pushing their ids', async () => {
      const before = await bobsDiary();
      const res = await push(ann, {
        moods: [{ id: M1, name: 'Hijacked', emoji: '💀' }],
        tags: [{ id: G1, name: 'Hijacked', color_key: 'green' }],
        entries: [
          {
            id: N1,
            title: 'Hijacked',
            body: 'x',
            status: 'archived',
            mood_ids: [],
            tag_ids: [],
          },
        ],
      });
      expect(reasons(res)).toEqual(
        [
          `note_moods:${M1}:id_taken`,
          `note_tags:${G1}:id_taken`,
          `diary_entries:${N1}:id_taken`,
        ].sort(),
      );
      expect(await bobsDiary()).toEqual(before);
    });

    it('does not let Ann delete them', async () => {
      const before = await bobsDiary();
      const res = await push(ann, {
        deleted: [
          { table: 'diary_entries', id: N1 },
          { table: 'note_tags', id: G1 },
          { table: 'note_moods', id: M1 },
        ],
      });
      expect(reasons(res)).toEqual(
        [
          `diary_entries:${N1}:id_taken`,
          `note_tags:${G1}:id_taken`,
          `note_moods:${M1}:id_taken`,
        ].sort(),
      );
      expect(await bobsDiary()).toEqual(before);
    });

    it.each([
      [
        'his mood',
        { mood_ids: [M1, JOY], tag_ids: [] },
        { mood_ids: [JOY], tag_ids: [] },
      ],
      [
        'his tag',
        { mood_ids: [JOY], tag_ids: [G1] },
        { mood_ids: [JOY], tag_ids: [] },
      ],
      [
        'both of them',
        { mood_ids: [M1, JOY], tag_ids: [G1] },
        { mood_ids: [JOY], tag_ids: [] },
      ],
    ])('does not let Ann hang %s on her note', async (_name, named, kept) => {
      const res = await push(ann, {
        entries: [{ id: N2, title: "Ann's note", ...named }],
      });
      expect(reasons(res)).toEqual([`diary_entries:${N2}:unknown_label`]);
      const mine = (await pull(ann)).entries!.find((e) => e.id === N2)!;
      expect(mine).toMatchObject(kept);
    });

    it('does not let Ann add a label to his note, or erase the ones it has', async () => {
      const before = await bobsDiary();
      await push(ann, { tags: [{ id: G2, name: "Ann's tag" }] });
      await push(ann, { entries: [{ id: N1, tag_ids: [G2], mood_ids: [] }] });
      expect(await bobsDiary()).toEqual(before);
    });

    it('does not let a user_id in the body decide whose row it is', async () => {
      await push(ann, {
        moods: [{ id: M2, name: 'm', emoji: 'e', user_id: bob.id }],
        tags: [{ id: G2, name: 't', user_id: bob.id }],
        entries: [{ id: N3, user_id: bob.id, tag_ids: [G2] }],
      });
      const forBob = await pull(bob);
      expect(ids(forBob.entries)).toEqual([N1]);
      expect(ids(forBob.tags)).toEqual([G1]);
      const forAnn = await pull(ann);
      expect(ids(forAnn.entries).sort()).toEqual([N2, N3]);
      expect(ids(forAnn.tags)).toEqual([G2]);
    });

    it('does not leak anything through the answer to a refused label', async () => {
      const hers = await push(ann, {
        entries: [{ id: N3, tag_ids: [id(99)] }],
      });
      const his = await push(ann, { entries: [{ id: id(4), tag_ids: [G1] }] });
      expect(his.rejected[0].reason).toBe(hers.rejected[0].reason);
    });

    it('keeps their deletions apart: Ann removing her tag leaves Bob’s notes alone', async () => {
      await push(ann, {
        tags: [{ id: G2, name: 'mine' }],
        entries: [{ id: N3, tag_ids: [G2], mood_ids: [JOY] }],
      });
      await push(ann, {
        deleted: [
          { table: 'note_tags', id: G2 },
          { table: 'diary_entries', id: N3 },
        ],
      });
      const bobs = (await pull(bob)).entries![0];
      expect(bobs).toMatchObject({
        id: N1,
        tag_ids: [G1],
        mood_ids: [M1, JOY].sort(),
      });
    });
  });

  describe('two devices of one account exchange the diary and agree', () => {
    let phone: Device;
    let tablet: Device;
    beforeEach(() => {
      phone = deviceOf(ann);
      tablet = deviceOf(ann);
    });
    const agree = () => {
      expect(tablet.diarySnapshot()).toEqual(phone.diarySnapshot());
      expect(tablet.snapshot()).toEqual(phone.snapshot());
    };

    it('edits made on both sides, a deleted note and a renamed tag all meet in the middle', async () => {
      phone.tag(G1, { name: 'Work' });
      phone.tag(G2, { name: 'Home' });
      phone.note(N1, { title: 'one', tag_ids: [G1] });
      phone.note(N2, { title: 'two', tag_ids: [G2] });
      phone.note(N3, { title: 'three' });
      await phone.sync();
      await tablet.sync();

      tablet.note(N1, { title: 'one (tablet)', tag_ids: [G1, G2] });
      tablet.removeNote(N3);
      phone.note(N2, { title: 'two (phone)' });
      phone.tag(G1, { name: 'Office' });

      await tablet.sync();
      await phone.sync();
      await tablet.sync();

      agree();
      expect(
        phone.diarySnapshot().notes.map((n) => [n[0], n[1], n[6]]),
      ).toEqual([
        [N1, 'one (tablet)', [G1, G2]],
        [N2, 'two (phone)', [G2]],
      ]);
      expect(phone.diarySnapshot().tags).toEqual([
        [G1, 'Office', 'violet'],
        [G2, 'Home', 'violet'],
      ]);
    });

    it('a tag deleted on one device is taken off the notes of the other', async () => {
      phone.tag(G1, { name: 'Work' });
      phone.tag(G2, { name: 'Home' });
      phone.note(N1, { tag_ids: [G1, G2] });
      phone.note(N2, { tag_ids: [G1] });
      await phone.sync();
      await tablet.sync();

      phone.removeTag(G1);
      await phone.sync();
      await tablet.sync();

      agree();
      expect(tablet.diarySnapshot().notes.map((n) => n[6])).toEqual([[G2], []]);
      expect(await all(`select tag_id from diary_entry_tags`)).toEqual([
        { tag_id: G2 },
      ]);
    });

    it('a mood deleted on one device is taken off the notes of the other, a starter mood stays', async () => {
      phone.mood(M1, { name: 'Mine', emoji: '🙂' });
      phone.note(N1, { mood_ids: [M1, JOY] });
      await phone.sync();
      await tablet.sync();
      phone.removeMood(M1);
      await phone.sync();
      await tablet.sync();
      agree();
      expect(tablet.diarySnapshot().notes[0][5]).toEqual([JOY]);
    });

    describe('a note deleted on one device beats an edit made elsewhere, whichever device acts first', () => {
      it.each(['pull-first', 'push-first'] as const)(
        'when the editing device syncs %s',
        async (order) => {
          phone.tag(G1, { name: 'Work' });
          phone.note(N1, { title: 'one', tag_ids: [G1] });
          await phone.sync();
          await tablet.sync();

          phone.removeNote(N1);
          tablet.note(N1, {
            title: 'edited after the deletion elsewhere',
            tag_ids: [G1],
          });
          await phone.sync();
          await tablet.sync(order);
          await phone.sync();

          agree();
          expect(tablet.diarySnapshot().notes).toEqual([]);
          expect(
            await all(`select count(*)::int n from diary_entry_tags`),
          ).toEqual([{ n: 0 }]);
        },
      );
    });

    describe('a note edited with a tag that was deleted elsewhere', () => {
      const setUp = async () => {
        phone.tag(G1, { name: 'Work' });
        phone.note(N1, { title: 'one', tag_ids: [G1] });
        await phone.sync();
        await tablet.sync();
        phone.removeTag(G1);
        await phone.sync();
        tablet.note(N1, { title: 'edited on the tablet' }); // still names the tag
      };

      it('loses only the tag when the tablet pulls first (it hears of the deletion before it pushes)', async () => {
        await setUp();
        await tablet.sync('pull-first');
        await phone.sync();
        expect(tablet.rejected).toEqual([]);
        agree();
        expect(phone.diarySnapshot().notes[0].slice(1, 2)).toEqual([
          'edited on the tablet',
        ]);
        expect(phone.diarySnapshot().notes[0][6]).toEqual([]);
      });

      it('is saved without the tag and the app is told when the tablet pushes first', async () => {
        await setUp();
        await tablet.sync('push-first');
        await phone.sync();
        expect(tablet.rejected.map((r) => `${r.table}:${r.reason}`)).toEqual([
          'diary_entries:unknown_label',
        ]);
        agree();
        expect(phone.diarySnapshot().notes[0][6]).toEqual([]);
        expect(phone.diarySnapshot().notes[0][1]).toBe('edited on the tablet');
      });
    });

    it('the later of two edits of one note wins on both devices', async () => {
      phone.note(N1, { title: 'start' });
      await phone.sync();
      await tablet.sync();
      phone.note(N1, { title: 'phone, earlier' });
      tablet.note(N1, { title: 'tablet, later' });
      await phone.sync();
      await tablet.sync();
      await phone.sync();
      agree();
      expect(phone.diarySnapshot().notes[0][1]).toBe('tablet, later');
    });

    it('a repeated sync with nothing new changes nothing', async () => {
      phone.tag(G1, { name: 'Work' });
      phone.note(N1, { tag_ids: [G1], mood_ids: [JOY] });
      await phone.sync();
      await tablet.sync();
      const before = JSON.stringify(tablet.diarySnapshot());
      await tablet.sync();
      await phone.sync();
      await tablet.sync();
      expect(JSON.stringify(tablet.diarySnapshot())).toBe(before);
      agree();
    });

    it('a new device receives a large diary in several pages', async () => {
      for (let i = 0; i < 30; i++) phone.tag(id(5000 + i), { name: `t${i}` });
      for (let i = 0; i < 120; i++) {
        phone.note(id(6000 + i), {
          title: `n${i}`,
          tag_ids: [id(5000 + (i % 30))],
          mood_ids: [JOY],
        });
      }
      await phone.sync();
      expect(phone.rejected).toEqual([]);

      await tablet.sync('pull-first', 40);
      expect(tablet.notes.size).toBe(120);
      expect(tablet.tags.size).toBe(30);
      expect(tablet.pulls).toBeGreaterThan(2);
      agree();
    });

    it('a second account sees none of it', async () => {
      phone.tag(G1, { name: 'private' });
      phone.note(N1, { title: 'private', tag_ids: [G1] });
      await phone.sync();
      const stranger = deviceOf(bob);
      await stranger.sync();
      expect(stranger.diarySnapshot().notes).toEqual([]);
      expect(stranger.diarySnapshot().tags).toEqual([]);
      expect(stranger.diarySnapshot().moods).toHaveLength(8);
    });
  });
});
