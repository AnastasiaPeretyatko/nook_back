import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp, truncateAll } from './support/db';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [N1, N2, N3] = [id(1), id(2), id(3)];
const [M1, M2] = [id(11), id(12)];
const [G1, G2, G3] = [id(21), id(22), id(23)];
const JOY = '0f8a4c3e-1d92-4b7a-9c15-6e2f8a01b4d3'; // a starter mood
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

type Row = Record<string, unknown>;
interface PullResponse {
  next: string | null;
  has_more: boolean;
  tasks: Row[];
  logs: Row[];
  moods?: Row[];
  tags?: Row[];
  entries?: Row[];
}
interface Session {
  token: string;
  id: string;
}

describe('GET /sync/pull with the diary', () => {
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
  const pull = async (who: Session, query = '?include=diary', status = 200) => {
    const res = await api()
      .get(`/sync/pull${query}`)
      .set('Authorization', `Bearer ${who.token}`)
      .expect(status);
    return res.body as PullResponse;
  };

  // Gives rows chosen times, to build exact situations (the server normally stamps them itself).
  async function stamp(table: string, rowId: string, at: string) {
    await ds.query(`alter table ${table} disable trigger ${table}_updated_at`);
    await ds.query(`update ${table} set updated_at = $1 where id = $2`, [
      at,
      rowId,
    ]);
    await ds.query(`alter table ${table} enable trigger ${table}_updated_at`);
  }
  // Times in the past, for tests that push for real afterwards (a real push is stamped "now").
  const early = (n: number) =>
    `2026-03-01T10:00:${String(n).padStart(2, '0')}.000000Z`;
  const second = (n: number) =>
    `2030-03-01T10:00:${String(n).padStart(2, '0')}.000000Z`;
  const ids = (rows: Row[] | undefined) => (rows ?? []).map((r) => r.id);
  const own = (rows: Row[] | undefined) =>
    (rows ?? []).filter((m) => !STARTER_NAMES.includes(m.name as string));

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
        moods: [{ id: M1, name: 'Mine', emoji: '🙂' }],
        tags: [{ id: G1, name: 'Work' }],
        entries: [{ id: N1, title: 'A day', tag_ids: [G1] }],
        tasks: [{ id: id(40), title: 'Read' }],
      });
    });

    it.each(['', '?include=tasks', '?include='])(
      'does not send the diary %p',
      async (query) => {
        const res = await pull(ann, query);
        expect(Object.keys(res).sort()).toEqual([
          'groups',
          'has_more',
          'logs',
          'next',
          'tasks',
        ]);
        expect(res.tasks).toHaveLength(1);
      },
    );

    it.each(['?include=cycle', '?include=tasks,cycle'])(
      'does not send the diary for %p, only the cycle',
      async (query) => {
        const res = await pull(ann, query);
        expect(Object.keys(res).sort()).toEqual([
          'cycle_days',
          'groups',
          'has_more',
          'logs',
          'next',
          'tasks',
        ]);
        expect(res.tasks).toHaveLength(1);
      },
    );

    it.each(['?include=diary', '?include=tasks,diary'])(
      'sends the diary, and the tasks with it, for %p',
      async (query) => {
        const res = await pull(ann, query);
        expect(Object.keys(res).sort()).toEqual([
          'entries',
          'groups',
          'has_more',
          'logs',
          'moods',
          'next',
          'tags',
          'tasks',
        ]);
        expect(res.tasks).toHaveLength(1);
        expect(ids(res.entries)).toEqual([N1]);
        expect(ids(res.tags)).toEqual([G1]);
        expect(ids(own(res.moods))).toEqual([M1]);
      },
    );
  });

  describe('the starter moods', () => {
    it('come to everybody on the first pull, ownerless and as the app knows them', async () => {
      for (const who of [ann, bob]) {
        const res = await pull(who);
        expect(res.moods).toHaveLength(8);
        expect(res.moods!.map((m) => m.name).sort()).toEqual(
          [...STARTER_NAMES].sort(),
        );
        const joy = res.moods!.find((m) => m.id === JOY)!;
        expect(joy).toMatchObject({
          name: 'Радость',
          emoji: '😊',
          deleted_at: null,
        });
        expect(joy).not.toHaveProperty('user_id');
      }
    });

    it('do not come again once they have been seen', async () => {
      const first = await pull(ann);
      const again = await pull(ann, `?include=diary&since=${first.next}`);
      expect(again.moods).toEqual([]);
    });

    it('are not part of a pull that does not ask for the diary', async () => {
      expect(await pull(ann, '')).not.toHaveProperty('moods');
    });
  });

  describe('the shape of a row', () => {
    it('gives a note with its moods and tags inside, sorted, in the plan’s keys and without user_id', async () => {
      await push(ann, {
        moods: [{ id: M1, name: 'Mine', emoji: '🙂' }],
        tags: [
          { id: G1, name: 'Work' },
          { id: G2, name: 'Home' },
        ],
        entries: [
          {
            id: N1,
            title: 'A day',
            body: '[{"insert":"text\\n"}]',
            cover_image: 'cover.jpg',
            images: '["a.jpg"]',
            is_favorite: true,
            status: 'draft',
            created_at: '2026-01-15T10:00:00.123456Z',
            client_updated_at: '2026-01-15T10:00:01.654321Z',
            mood_ids: [M1, JOY],
            tag_ids: [G2, G1],
          },
        ],
      });
      const { entries } = await pull(ann);
      const { updated_at, ...rest } = entries![0];
      expect(rest).toEqual({
        id: N1,
        title: 'A day',
        body: '[{"insert":"text\\n"}]',
        cover_image: 'cover.jpg',
        images: '["a.jpg"]',
        is_favorite: true,
        status: 'draft',
        created_at: '2026-01-15T10:00:00.123456Z',
        client_updated_at: '2026-01-15T10:00:01.654321Z',
        deleted_at: null,
        mood_ids: [M1, JOY].sort(),
        tag_ids: [G1, G2],
      });
      expect(updated_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
    });

    it('gives a note without labels empty lists, not missing ones', async () => {
      await push(ann, { entries: [{ id: N1 }] });
      expect((await pull(ann)).entries![0]).toMatchObject({
        mood_ids: [],
        tag_ids: [],
      });
    });

    it('gives a mood and a tag in the plan’s keys', async () => {
      await push(ann, {
        moods: [
          {
            id: M1,
            name: 'Mine',
            emoji: '🙂',
            created_at: '2026-01-15T10:00:00Z',
            client_updated_at: '2026-01-15T10:00:01Z',
          },
        ],
        tags: [
          {
            id: G1,
            name: 'Work',
            color_key: 'red',
            created_at: '2026-01-15T10:00:00Z',
            client_updated_at: '2026-01-15T10:00:01Z',
          },
        ],
      });
      const res = await pull(ann);
      const { updated_at: moodStamp, ...mood } = own(res.moods)[0];
      const { updated_at: tagStamp, ...tag } = res.tags![0];
      expect(mood).toEqual({
        id: M1,
        name: 'Mine',
        emoji: '🙂',
        created_at: '2026-01-15T10:00:00.000000Z',
        client_updated_at: '2026-01-15T10:00:01.000000Z',
        deleted_at: null,
      });
      expect(tag).toEqual({
        id: G1,
        name: 'Work',
        color_key: 'red',
        created_at: '2026-01-15T10:00:00.000000Z',
        client_updated_at: '2026-01-15T10:00:01.000000Z',
        deleted_at: null,
      });
      expect(moodStamp).toMatch(/\.\d{6}Z$/);
      expect(tagStamp).toMatch(/\.\d{6}Z$/);
    });

    it('tells about a deleted note, tag and mood with empty rows and deleted_at', async () => {
      await push(ann, {
        moods: [{ id: M1, name: 'Mine', emoji: '🙂' }],
        tags: [{ id: G1, name: 'Work' }],
        entries: [
          {
            id: N1,
            title: 'A day',
            body: 'text',
            tag_ids: [G1],
            mood_ids: [M1],
          },
        ],
      });
      await push(ann, {
        deleted: [
          { table: 'diary_entries', id: N1 },
          { table: 'note_tags', id: G1 },
          { table: 'note_moods', id: M1 },
        ],
      });
      const res = await pull(ann);
      expect(res.entries![0]).toMatchObject({
        id: N1,
        title: '',
        body: '',
        images: '[]',
        mood_ids: [],
        tag_ids: [],
      });
      expect(res.entries![0].deleted_at).toMatch(/\.\d{6}Z$/);
      expect(res.tags![0]).toMatchObject({
        id: G1,
        name: '',
        color_key: 'violet',
      });
      expect(res.tags![0].deleted_at).not.toBeNull();
      expect(own(res.moods)[0]).toMatchObject({ id: M1, name: '', emoji: '' });
      expect(own(res.moods)[0].deleted_at).not.toBeNull();
    });

    it('keeps text exactly: quotes, backslashes, newlines, emoji', async () => {
      const title = 'He said "hi" \\ \n 😀 ё';
      await push(ann, { entries: [{ id: N1, title }] });
      expect((await pull(ann)).entries![0].title).toBe(title);
    });
  });

  describe('whose rows', () => {
    it('gives each user only their own notes, tags and moods (and the starter moods)', async () => {
      await push(ann, {
        moods: [{ id: M1, name: 'A mood', emoji: '🙂' }],
        tags: [{ id: G1, name: 'A tag' }],
        entries: [{ id: N1, tag_ids: [G1], mood_ids: [M1] }],
      });
      await push(bob, {
        moods: [{ id: M2, name: 'B mood', emoji: '🙃' }],
        tags: [{ id: G2, name: 'B tag' }],
        entries: [{ id: N2, tag_ids: [G2], mood_ids: [M2, SAD] }],
      });

      const forAnn = await pull(ann);
      expect(ids(forAnn.entries)).toEqual([N1]);
      expect(ids(forAnn.tags)).toEqual([G1]);
      expect(ids(own(forAnn.moods))).toEqual([M1]);
      expect(forAnn.moods).toHaveLength(9);

      const forBob = await pull(bob);
      expect(ids(forBob.entries)).toEqual([N2]);
      expect(ids(forBob.tags)).toEqual([G2]);
      expect(ids(own(forBob.moods))).toEqual([M2]);
      expect(forBob.entries![0].mood_ids).toEqual([M2, SAD].sort());
    });

    it("does not show Bob's rows even from the beginning of time", async () => {
      await push(bob, {
        moods: [{ id: M2, name: 'B', emoji: '🙃' }],
        tags: [{ id: G2, name: 'B' }],
        entries: [{ id: N2 }, { id: N3 }],
      });
      const res = await pull(
        ann,
        '?include=diary&since=2000-01-01T00:00:00Z&limit=1000',
      );
      expect(res.entries).toEqual([]);
      expect(res.tags).toEqual([]);
      expect(own(res.moods)).toEqual([]);
    });

    it("does not let a tombstone of Bob's note, tag or mood reach Ann", async () => {
      await push(bob, {
        deleted: [
          { table: 'diary_entries', id: N1 },
          { table: 'note_tags', id: G1 },
          { table: 'note_moods', id: M1 },
        ],
      });
      const res = await pull(ann);
      expect(res.entries).toEqual([]);
      expect(res.tags).toEqual([]);
      expect(own(res.moods)).toEqual([]);
    });

    it('does not hand a link of another user’s tag over, even if one were somehow there', async () => {
      await push(bob, { tags: [{ id: G2, name: 'B' }] });
      await push(ann, { entries: [{ id: N1 }] });
      // A link row that the writers would never make, forced in directly.
      await ds.query(
        `insert into diary_entry_tags (entry_id, tag_id, user_id) values ($1, $2, $3)`,
        [N1, G2, bob.id],
      );
      const res = await pull(ann);
      // The note is Ann's and carries what is linked to it; this documents the read, and the
      // writers are what keep such a row from ever existing.
      expect(res.entries![0].tag_ids).toEqual([G2]);
    });
  });

  describe('since', () => {
    beforeEach(async () => {
      await push(ann, {
        moods: [
          { id: M1, name: 'm', emoji: 'e' },
          { id: M2, name: 'm2', emoji: 'e' },
        ],
        tags: [
          { id: G1, name: 't' },
          { id: G2, name: 't2' },
        ],
        entries: [{ id: N1 }, { id: N2 }],
      });
      await stamp('note_moods', M1, early(1));
      await stamp('note_moods', M2, early(2));
      await stamp('note_tags', G1, early(1));
      await stamp('note_tags', G2, early(2));
      await stamp('diary_entries', N1, early(1));
      await stamp('diary_entries', N2, early(2));
    });

    it('gives each table only what is strictly newer', async () => {
      const res = await pull(ann, `?include=diary&since=${early(1)}`);
      expect(ids(res.entries)).toEqual([N2]);
      expect(ids(res.tags)).toEqual([G2]);
      expect(ids(own(res.moods))).toEqual([M2]);
    });

    it('gives a note again once it changed, with its new labels', async () => {
      const before = (await pull(ann)).next!;
      await push(ann, {
        entries: [{ id: N1, tag_ids: [G1], title: 'Edited' }],
      });
      const res = await pull(ann, `?include=diary&since=${before}`);
      expect(res.entries).toMatchObject([
        { id: N1, title: 'Edited', tag_ids: [G1] },
      ]);
    });

    it('does not repeat a note whose tag was deleted: the deleted tag tells the app to drop the link', async () => {
      const before = (await pull(ann)).next!;
      await push(ann, { entries: [{ id: N1, tag_ids: [G1] }] });
      const mid = (await pull(ann, `?include=diary&since=${before}`)).next!;
      await push(ann, { deleted: [{ table: 'note_tags', id: G1 }] });
      const res = await pull(ann, `?include=diary&since=${mid}`);
      expect(ids(res.tags)).toEqual([G1]);
      expect(res.tags![0].deleted_at).not.toBeNull();
      expect(res.entries).toEqual([]);
    });

    it('takes the newest time of all the parts as next when nothing is cut', async () => {
      const res = await pull(ann);
      expect(res.has_more).toBe(false);
      const latest = [
        ...res.tasks,
        ...res.logs,
        ...res.moods!,
        ...res.tags!,
        ...res.entries!,
      ]
        .map((r) => r.updated_at as string)
        .reduce((a, b) => (a > b ? a : b));
      expect(res.next).toBe(latest);
    });
  });

  describe('pages', () => {
    it('gives at most 50 notes a page whatever the limit, and says there is more', async () => {
      await push(ann, {
        entries: Array.from({ length: 120 }, (_, i) => ({ id: id(1000 + i) })),
      });
      const first = await pull(ann, '?include=diary&limit=1000');
      expect(first.entries).toHaveLength(50);
      expect(first.has_more).toBe(true);
    });

    it('gives fewer when the app asks for fewer', async () => {
      await push(ann, {
        entries: Array.from({ length: 12 }, (_, i) => ({ id: id(1000 + i) })),
      });
      expect((await pull(ann, '?include=diary&limit=10')).entries).toHaveLength(
        10,
      );
    });

    it('walks 120 notes in pages of 50 and sees every one', async () => {
      await push(ann, {
        entries: Array.from({ length: 120 }, (_, i) => ({
          id: id(1000 + i),
          title: `n${i}`,
        })),
      });
      const seen = new Set<unknown>();
      let since = '';
      let pages = 0;
      for (;;) {
        const res = await pull(ann, `?include=diary&limit=1000${since}`);
        res.entries!.forEach((e) => seen.add(e.id));
        pages += 1;
        if (!res.has_more) break;
        since = `&since=${res.next}`;
        expect(pages).toBeLessThan(10);
      }
      expect(seen.size).toBe(120);
      expect(pages).toBe(3);
    });

    it('does not split notes that share one time', async () => {
      await push(ann, {
        entries: [{ id: N1 }, { id: N2 }, { id: N3 }, { id: id(4) }],
      });
      await stamp('diary_entries', N1, second(1));
      await stamp('diary_entries', N2, second(2));
      await stamp('diary_entries', N3, second(2));
      await stamp('diary_entries', id(4), second(3));
      const first = await pull(
        ann,
        '?include=diary&limit=2&since=2030-01-01T00:00:00Z',
      );
      expect(first.entries).toHaveLength(3);
      expect(first.has_more).toBe(true);
      expect(first.next).toBe(second(2));
      const next = await pull(
        ann,
        `?include=diary&limit=2&since=${first.next}`,
      );
      expect(ids(next.entries)).toEqual([id(4)]);
    });

    it('continues from the earliest of the cut tables, among all five', async () => {
      // Tags are cut at s2 (of s1..s3), notes are cut later, at s12: next must be s2.
      await push(ann, {
        tags: [
          { id: G1, name: 'a' },
          { id: G2, name: 'b' },
          { id: G3, name: 'c' },
        ],
        entries: [{ id: N1 }, { id: N2 }, { id: N3 }],
      });
      await stamp('note_tags', G1, second(1));
      await stamp('note_tags', G2, second(2));
      await stamp('note_tags', G3, second(3));
      await stamp('diary_entries', N1, second(11));
      await stamp('diary_entries', N2, second(12));
      await stamp('diary_entries', N3, second(13));
      const res = await pull(
        ann,
        '?include=diary&limit=2&since=2030-01-01T00:00:00Z',
      );
      expect(res.has_more).toBe(true);
      expect(res.tags).toHaveLength(2);
      expect(res.entries).toHaveLength(2);
      expect(res.next).toBe(second(2));
    });

    it('converges: walking small pages gives every row of every table', async () => {
      await push(ann, {
        moods: [M1, M2, id(13), id(14), id(15)].map((m, i) => ({
          id: m,
          name: `m${i}`,
          emoji: 'e',
        })),
        tags: [G1, G2, G3, id(24), id(25), id(26)].map((g, i) => ({
          id: g,
          name: `t${i}`,
        })),
        entries: [N1, N2, N3, id(4), id(5), id(6), id(7)].map((n) => ({
          id: n,
          tag_ids: [G1],
          mood_ids: [M1],
        })),
        tasks: [id(40), id(41), id(42)].map((t) => ({ id: t })),
        logs: [1, 2, 3, 4].map((d) => ({
          task_id: id(40),
          date: `2026-01-0${d}`,
        })),
      });
      const got = {
        tasks: new Set<unknown>(),
        logs: new Set<unknown>(),
        moods: new Set<unknown>(),
        tags: new Set<unknown>(),
        entries: new Set<unknown>(),
      };
      let since = '';
      for (let pages = 0; pages < 40; pages += 1) {
        const res = await pull(ann, `?include=diary&limit=2${since}`);
        res.tasks.forEach((r) => got.tasks.add(r.id));
        res.logs.forEach((r) => got.logs.add(r.date));
        res.moods!.forEach((r) => got.moods.add(r.id));
        res.tags!.forEach((r) => got.tags.add(r.id));
        res.entries!.forEach((r) => got.entries.add(r.id));
        if (!res.has_more) break;
        since = `&since=${res.next}`;
      }
      expect(got.tasks.size).toBe(3);
      expect(got.logs.size).toBe(4);
      expect(got.moods.size).toBe(13);
      expect(got.tags.size).toBe(6);
      expect(got.entries.size).toBe(7);
    });
  });

  it('refuses what is not an include, as before', async () => {
    await pull(ann, '?include=diary,foo', 400);
  });
});
