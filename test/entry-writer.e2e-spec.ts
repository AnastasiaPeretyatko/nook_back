import { INestApplication } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { EntryWriter } from '../src/sync/entry-writer';
import { LabelWriter } from '../src/sync/label-writer';
import {
  EntryRow,
  MoodRow,
  parseEntry,
  parseMood,
  parseTag,
  RowResult,
  TagRow,
} from '../src/sync/push-rows';
import { createTestApp, truncateAll } from './support/db';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [N1, N2, N3] = [id(1), id(2), id(3)];
const [M1, M2] = [id(11), id(12)];
const [G1, G2, G3] = [id(21), id(22), id(23)];
const JOY = '0f8a4c3e-1d92-4b7a-9c15-6e2f8a01b4d3'; // a starter mood
const SAD = '7e94b2d1-6a08-4c52-9f7b-38e5c1470ab9'; // another one

const ok = <T>(result: RowResult<T>): T => {
  if (!('row' in result)) throw new Error('bad test row');
  return result.row;
};
const entry = (fields: Record<string, unknown>): EntryRow =>
  ok(parseEntry(fields));

describe('EntryWriter', () => {
  let app: INestApplication;
  let ds: DataSource;
  let entries: EntryWriter;
  let labels: LabelWriter;
  let ann: string;
  let bob: string;

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
    entries = app.get(EntryWriter);
    labels = app.get(LabelWriter);
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

  const addMoods = (userId: string, ...ids: string[]) =>
    ds.transaction((m) =>
      labels.writeMoods(
        m,
        userId,
        ids.map((i): MoodRow =>
          ok(parseMood({ id: i, name: 'mood', emoji: '🙂' })),
        ),
      ),
    );
  const addTags = (userId: string, ...ids: string[]) =>
    ds.transaction((m) =>
      labels.writeTags(
        m,
        userId,
        ids.map((i): TagRow => ok(parseTag({ id: i, name: 'tag' }))),
      ),
    );
  const write = (userId: string, ...rows: Record<string, unknown>[]) =>
    ds.transaction((m) => entries.write(m, userId, rows.map(entry)));

  const noteRow = async (noteId: string): Promise<Record<string, unknown>> => {
    const rows: Record<string, unknown>[] = await ds.query(
      `select * from diary_entries where id = $1`,
      [noteId],
    );
    return rows[0];
  };
  const moodsOf = async (noteId: string) =>
    (
      await ds.query(
        `select mood_id from diary_entry_moods where entry_id = $1 order by mood_id`,
        [noteId],
      )
    ).map((r: { mood_id: string }) => r.mood_id) as string[];
  const tagsOf = async (noteId: string) =>
    (
      await ds.query(
        `select tag_id from diary_entry_tags where entry_id = $1 order by tag_id`,
        [noteId],
      )
    ).map((r: { tag_id: string }) => r.tag_id) as string[];
  const count = async (table: string) =>
    (await ds.query(`select count(*)::int n from ${table}`))[0].n as number;
  const rejection = (noteId: string, reason: string) => ({
    table: 'diary_entries',
    id: noteId,
    reason,
  });

  describe('the note itself', () => {
    it('writes a new note with every field, under the caller', async () => {
      const rejected = await write(ann, {
        id: N1,
        title: 'A day',
        body: '[{"insert":"text\\n"}]',
        cover_image: 'cover.jpg',
        images: '["a.jpg"]',
        is_favorite: true,
        status: 'draft',
        created_at: '2026-01-15T10:00:00.123456Z',
        client_updated_at: '2026-01-15T10:00:01.654321Z',
      });
      expect(rejected).toEqual([]);
      expect(await noteRow(N1)).toMatchObject({
        user_id: ann,
        title: 'A day',
        body: '[{"insert":"text\\n"}]',
        cover_image: 'cover.jpg',
        images: '["a.jpg"]',
        is_favorite: true,
        status: 'draft',
        deleted_at: null,
      });
      const [{ created, client }] = await ds.query(
        `select created_at::text created, client_updated_at::text client from diary_entries`,
      );
      expect(created).toBe('2026-01-15 10:00:00.123456+00');
      expect(client).toBe('2026-01-15 10:00:01.654321+00');
    });

    it('stamps updated_at on the server, whatever the client says', async () => {
      await write(ann, { id: N1, client_updated_at: '2000-01-01T00:00:00Z' });
      const [{ fresh }] = await ds.query(
        `select updated_at > '2020-01-01' fresh from diary_entries`,
      );
      expect(fresh).toBe(true);
    });

    it('does nothing for an empty list', async () => {
      expect(await write(ann)).toEqual([]);
      expect(await count('diary_entries')).toBe(0);
    });

    it('overwrites its own note but keeps created_at, and clears fields the new version lacks', async () => {
      await write(ann, {
        id: N1,
        title: 'old',
        cover_image: 'c.jpg',
        images: '["a.jpg"]',
        created_at: '2026-01-01T00:00:00Z',
      });
      await write(ann, {
        id: N1,
        title: 'new',
        created_at: '2026-02-02T00:00:00Z',
      });
      const [{ created }] = await ds.query(
        `select created_at::text created from diary_entries`,
      );
      expect(await noteRow(N1)).toMatchObject({
        title: 'new',
        cover_image: null,
        images: '[]',
      });
      expect(created).toBe('2026-01-01 00:00:00+00');
      expect(await count('diary_entries')).toBe(1);
    });

    it('moves updated_at forward on every write', async () => {
      await write(ann, { id: N1 });
      const [{ before }] = await ds.query(
        `select updated_at::text before from diary_entries`,
      );
      await write(ann, { id: N1, title: 'x' });
      const [{ moved }] = await ds.query(
        `select updated_at > $1::timestamptz moved from diary_entries`,
        [before],
      );
      expect(moved).toBe(true);
    });

    it('stores half an emoji as U+FFFD and keeps quotes, backslashes and newlines exactly', async () => {
      await write(ann, {
        id: N1,
        title: 'a\ud83d',
        body: 'He said "hi" \\ \n 😀',
      });
      expect(await noteRow(N1)).toMatchObject({
        title: 'a�',
        body: 'He said "hi" \\ \n 😀',
      });
    });

    it('keeps the last version of a note sent twice in one batch', async () => {
      await write(
        ann,
        { id: N1, title: 'first', tag_ids: [] },
        { id: N1, title: 'second' },
      );
      expect((await noteRow(N1)).title).toBe('second');
    });

    it('rolls back with the push transaction, links included', async () => {
      await addTags(ann, G1);
      await expect(
        ds.transaction(async (m) => {
          await entries.write(m, ann, [entry({ id: N1, tag_ids: [G1] })]);
          throw new Error('later step failed');
        }),
      ).rejects.toThrow('later step failed');
      expect(await count('diary_entries')).toBe(0);
      expect(await count('diary_entry_tags')).toBe(0);
    });
  });

  describe('the links of a note', () => {
    beforeEach(async () => {
      await addMoods(ann, M1, M2);
      await addTags(ann, G1, G2, G3);
    });

    it('are saved with the note, starter moods included', async () => {
      const rejected = await write(ann, {
        id: N1,
        mood_ids: [M1, JOY],
        tag_ids: [G1, G2],
      });
      expect(rejected).toEqual([]);
      expect(await moodsOf(N1)).toEqual([M1, JOY].sort());
      expect(await tagsOf(N1)).toEqual([G1, G2]);
      const owners = await ds.query(
        `select user_id from diary_entry_moods union select user_id from diary_entry_tags`,
      );
      expect(owners).toEqual([{ user_id: ann }]);
    });

    it('are replaced as a whole: the ones not sent go, the ones sent stay, new ones come', async () => {
      await write(ann, { id: N1, mood_ids: [M1, JOY], tag_ids: [G1, G2] });
      await write(ann, { id: N1, mood_ids: [JOY, SAD], tag_ids: [G2, G3] });
      expect(await moodsOf(N1)).toEqual([JOY, SAD].sort());
      expect(await tagsOf(N1)).toEqual([G2, G3]);
    });

    it('are erased by an empty list', async () => {
      await write(ann, { id: N1, mood_ids: [M1], tag_ids: [G1] });
      await write(ann, { id: N1, mood_ids: [], tag_ids: [] });
      expect(await moodsOf(N1)).toEqual([]);
      expect(await tagsOf(N1)).toEqual([]);
    });

    it('are left as they were when the note does not name them', async () => {
      await write(ann, { id: N1, mood_ids: [M1], tag_ids: [G1] });
      await write(ann, { id: N1, title: 'edited' });
      expect(await moodsOf(N1)).toEqual([M1]);
      expect(await tagsOf(N1)).toEqual([G1]);
    });

    it('are replaced on one side only when only that side is named', async () => {
      await write(ann, { id: N1, mood_ids: [M1], tag_ids: [G1] });
      await write(ann, { id: N1, tag_ids: [] });
      expect(await moodsOf(N1)).toEqual([M1]);
      expect(await tagsOf(N1)).toEqual([]);
    });

    it('stay when the same note arrives again unchanged (idempotent)', async () => {
      const body = {
        id: N1,
        mood_ids: [M1, JOY],
        tag_ids: [G1],
        created_at: '2026-01-01T00:00:00Z',
        client_updated_at: '2026-01-02T00:00:00Z',
      };
      expect(await write(ann, body)).toEqual([]);
      expect(await write(ann, body)).toEqual([]);
      expect(await moodsOf(N1)).toEqual([M1, JOY].sort());
      expect(await tagsOf(N1)).toEqual([G1]);
      expect(await count('diary_entry_moods')).toBe(2);
    });

    it('go to the note they belong to, and not to another one', async () => {
      await write(ann, { id: N1, tag_ids: [G1] }, { id: N2, tag_ids: [G2] });
      await write(ann, { id: N1, tag_ids: [] });
      expect(await tagsOf(N1)).toEqual([]);
      expect(await tagsOf(N2)).toEqual([G2]);
    });

    it('may name a mood or tag made earlier in the same transaction', async () => {
      const rejected = await ds.transaction(async (m) => {
        await labels.writeTags(m, ann, [
          ok(parseTag({ id: id(30), name: 'fresh' })),
        ]);
        await labels.writeMoods(m, ann, [
          ok(parseMood({ id: id(31), name: 'fresh', emoji: '🙂' })),
        ]);
        return entries.write(m, ann, [
          entry({ id: N3, tag_ids: [id(30)], mood_ids: [id(31)] }),
        ]);
      });
      expect(rejected).toEqual([]);
      expect(await tagsOf(N3)).toEqual([id(30)]);
      expect(await moodsOf(N3)).toEqual([id(31)]);
    });

    it('take up to 100 of each kind on one note', async () => {
      const tagIds = Array.from({ length: 100 }, (_, i) => id(1000 + i));
      await addTags(ann, ...tagIds);
      await write(ann, { id: N1, tag_ids: tagIds });
      expect(await tagsOf(N1)).toHaveLength(100);
    });
  });

  describe('a label the server cannot use', () => {
    beforeEach(async () => {
      await addMoods(ann, M1);
      await addTags(ann, G1);
    });

    it("is dropped when it is another user's: the note is saved and the app is told", async () => {
      await addMoods(bob, M2);
      await addTags(bob, G2);
      const rejected = await write(ann, {
        id: N1,
        title: 'Mine',
        mood_ids: [M1, M2],
        tag_ids: [G1, G2],
      });
      expect(rejected).toEqual([rejection(N1, 'unknown_label')]);
      expect((await noteRow(N1)).title).toBe('Mine');
      expect(await moodsOf(N1)).toEqual([M1]);
      expect(await tagsOf(N1)).toEqual([G1]);
    });

    it('is dropped when the server has never seen it', async () => {
      const rejected = await write(ann, {
        id: N1,
        tag_ids: [id(99)],
        mood_ids: [id(98)],
      });
      expect(rejected).toEqual([rejection(N1, 'unknown_label')]);
      expect(await tagsOf(N1)).toEqual([]);
      expect(await moodsOf(N1)).toEqual([]);
    });

    it('is dropped when it has been deleted', async () => {
      await ds.query(`update note_tags set deleted_at = now() where id = $1`, [
        G1,
      ]);
      await ds.query(`update note_moods set deleted_at = now() where id = $1`, [
        M1,
      ]);
      const rejected = await write(ann, {
        id: N1,
        tag_ids: [G1],
        mood_ids: [M1, JOY],
      });
      expect(rejected).toEqual([rejection(N1, 'unknown_label')]);
      expect(await tagsOf(N1)).toEqual([]);
      expect(await moodsOf(N1)).toEqual([JOY]);
    });

    describe('each kind of trouble is reported on its own', () => {
      beforeEach(async () => {
        await addMoods(bob, M2);
        await addTags(bob, G2);
        await ds.query(
          `insert into note_moods (id, user_id, name, emoji, deleted_at) values ($1, $2, 'x', 'y', now())`,
          [id(50), ann],
        );
        await ds.query(
          `insert into note_tags (id, user_id, name, deleted_at) values ($1, $2, 'x', now())`,
          [id(51), ann],
        );
      });

      it.each([
        ['a mood of another user', { mood_ids: [M2] }],
        ['a mood that does not exist', { mood_ids: [id(99)] }],
        ['a mood that was deleted', { mood_ids: [id(50)] }],
        ['a tag of another user', { tag_ids: [G2] }],
        ['a tag that does not exist', { tag_ids: [id(99)] }],
        ['a tag that was deleted', { tag_ids: [id(51)] }],
        ['a tag named as a mood', { mood_ids: [G1] }],
        ['a mood named as a tag', { tag_ids: [M1] }],
      ])('%s', async (_name, labelsNamed) => {
        const rejected = await write(ann, { id: N1, ...labelsNamed });
        expect(rejected).toEqual([rejection(N1, 'unknown_label')]);
        expect(await moodsOf(N1)).toEqual([]);
        expect(await tagsOf(N1)).toEqual([]);
        expect((await noteRow(N1)).user_id).toBe(ann);
      });
    });

    it('is reported once per note, and the notes next to it are not affected', async () => {
      const rejected = await write(
        ann,
        { id: N1, tag_ids: [id(97), id(98)] },
        { id: N2, tag_ids: [G1] },
      );
      expect(rejected).toEqual([rejection(N1, 'unknown_label')]);
      expect(await tagsOf(N2)).toEqual([G1]);
    });

    it('does not take away the links that were fine', async () => {
      await write(ann, { id: N1, tag_ids: [G1] });
      await write(ann, { id: N1, tag_ids: [G1, id(99)] });
      expect(await tagsOf(N1)).toEqual([G1]);
    });

    it('is not a tag when it is a mood, nor a mood when it is a tag', async () => {
      const rejected = await write(ann, {
        id: N1,
        tag_ids: [M1],
        mood_ids: [G1],
      });
      expect(rejected).toEqual([rejection(N1, 'unknown_label')]);
      expect(await tagsOf(N1)).toEqual([]);
      expect(await moodsOf(N1)).toEqual([]);
    });
  });

  describe("another user's notes", () => {
    beforeEach(async () => {
      await addMoods(bob, M1);
      await addTags(bob, G1, G2);
      await write(bob, {
        id: N1,
        title: "Bob's",
        body: 'secret',
        mood_ids: [M1, JOY],
        tag_ids: [G1],
      });
    });

    it('are not touched: the id is reported as taken and the links stay', async () => {
      const rejected = await write(ann, {
        id: N1,
        title: 'Hijacked',
        mood_ids: [],
        tag_ids: [],
      });
      expect(rejected).toEqual([rejection(N1, 'id_taken')]);
      expect(await noteRow(N1)).toMatchObject({
        user_id: bob,
        title: "Bob's",
        body: 'secret',
      });
      expect(await moodsOf(N1)).toEqual([M1, JOY].sort());
      expect(await tagsOf(N1)).toEqual([G1]);
    });

    it('get no link from Ann, whatever she names', async () => {
      await addTags(ann, id(40));
      await write(ann, { id: N1, tag_ids: [id(40)], mood_ids: [JOY] });
      expect(await tagsOf(N1)).toEqual([G1]);
      expect(
        await ds.query(
          `select count(*)::int n from diary_entry_tags where user_id = $1`,
          [ann],
        ),
      ).toEqual([{ n: 0 }]);
    });

    it("cannot be given a link to Bob's own tag by Ann on a note of Ann's", async () => {
      const rejected = await write(ann, { id: N2, tag_ids: [G2] });
      expect(rejected).toEqual([rejection(N2, 'unknown_label')]);
      expect(await tagsOf(N2)).toEqual([]);
    });

    it('are not touched even when Bob has deleted them', async () => {
      await ds.query(
        `update diary_entries set deleted_at = now() where id = $1`,
        [N1],
      );
      expect(await write(ann, { id: N1, title: 'Mine' })).toEqual([
        rejection(N1, 'id_taken'),
      ]);
      expect(await noteRow(N1)).toMatchObject({ user_id: bob, title: '' });
    });

    it("stay out of reach if the check misses them (a race): the note, and its links, are Bob's still", async () => {
      await ds.transaction(async (manager) => {
        // The look-up claims N1 is Ann's, as if the note had changed hands a moment ago.
        const blind = Object.create(manager) as EntityManager;
        blind.query = ((sql: string, params?: unknown[]) =>
          sql.includes("select 'note'")
            ? Promise.resolve([
                { kind: 'note', id: N1, user_id: ann, deleted: false },
                { kind: 'tag', id: id(40), user_id: ann, deleted: false },
              ])
            : manager.query(sql, params)) as EntityManager['query'];
        await entries.write(blind, ann, [
          entry({ id: N1, title: 'Hijacked', mood_ids: [], tag_ids: [id(40)] }),
        ]);
      });
      expect(await noteRow(N1)).toMatchObject({ user_id: bob, title: "Bob's" });
      expect(await moodsOf(N1)).toEqual([M1, JOY].sort());
      expect(await tagsOf(N1)).toEqual([G1]);
    });

    it("keep a link to Bob's mood out of Ann's own note if the check misses that (a race)", async () => {
      await ds.transaction(async (manager) => {
        const blind = Object.create(manager) as EntityManager;
        blind.query = ((sql: string, params?: unknown[]) =>
          sql.includes("select 'note'")
            ? Promise.resolve([
                { kind: 'mood', id: M1, user_id: ann, deleted: false },
              ])
            : manager.query(sql, params)) as EntityManager['query'];
        await entries.write(blind, ann, [entry({ id: N2, mood_ids: [M1] })]);
      });
      expect((await noteRow(N2)).user_id).toBe(ann);
      expect(await moodsOf(N2)).toEqual([]);
    });

    it("keep Ann's own tag off Bob's note if the check misses who owns the note (a race)", async () => {
      await addTags(ann, id(40));
      await ds.transaction(async (manager) => {
        const blind = Object.create(manager) as EntityManager;
        blind.query = ((sql: string, params?: unknown[]) =>
          sql.includes("select 'note'")
            ? Promise.resolve([
                { kind: 'note', id: N1, user_id: ann, deleted: false },
                { kind: 'tag', id: id(40), user_id: ann, deleted: false },
              ])
            : manager.query(sql, params)) as EntityManager['query'];
        await entries.write(blind, ann, [entry({ id: N1, tag_ids: [id(40)] })]);
      });
      expect(await tagsOf(N1)).toEqual([G1]);
    });

    it("keep a link to Bob's tag out of Ann's own note if the check misses that (a race)", async () => {
      await ds.transaction(async (manager) => {
        const blind = Object.create(manager) as EntityManager;
        blind.query = ((sql: string, params?: unknown[]) =>
          sql.includes("select 'note'")
            ? Promise.resolve([
                { kind: 'tag', id: G2, user_id: ann, deleted: false },
              ])
            : manager.query(sql, params)) as EntityManager['query'];
        await entries.write(blind, ann, [entry({ id: N2, tag_ids: [G2] })]);
      });
      expect((await noteRow(N2)).user_id).toBe(ann);
      expect(await tagsOf(N2)).toEqual([]);
    });
  });

  describe('deleted notes', () => {
    it('stay deleted and empty, and get no links, when a device that missed the deletion sends them again', async () => {
      await addTags(ann, G1);
      await write(ann, { id: N1, title: 'Day', body: 'text', tag_ids: [G1] });
      await ds.query(
        `update diary_entries set deleted_at = now() where id = $1`,
        [N1],
      );
      expect(
        await write(ann, {
          id: N1,
          title: 'Back',
          body: 'again',
          tag_ids: [G1],
          mood_ids: [JOY],
        }),
      ).toEqual([]);
      expect(await noteRow(N1)).toMatchObject({ title: '', body: '' });
      expect((await noteRow(N1)).deleted_at).not.toBeNull();
      expect(await tagsOf(N1)).toEqual([]);
      expect(await moodsOf(N1)).toEqual([]);
    });

    it('are left untouched, updated_at included', async () => {
      await write(ann, { id: N1 });
      await ds.query(`update diary_entries set deleted_at = now()`);
      const [{ before }] = await ds.query(
        `select updated_at::text before from diary_entries`,
      );
      await write(ann, { id: N1, title: 'x' });
      const [{ same }] = await ds.query(
        `select updated_at = $1::timestamptz same from diary_entries`,
        [before],
      );
      expect(same).toBe(true);
    });
  });

  describe('bad notes next to good ones', () => {
    it('writes the good ones and reports each problem', async () => {
      await addTags(ann, G1);
      await addTags(bob, G2);
      await write(bob, { id: N2 });
      const rejected = await write(
        ann,
        { id: N1, tag_ids: [G1] },
        { id: N2, title: 'Hijacked' },
        { id: N3, tag_ids: [G2, G1] },
      );
      expect(
        rejected.sort((a, b) => (a.id ?? '').localeCompare(b.id ?? '')),
      ).toEqual([rejection(N2, 'id_taken'), rejection(N3, 'unknown_label')]);
      expect(await tagsOf(N1)).toEqual([G1]);
      expect(await tagsOf(N3)).toEqual([G1]);
      expect((await noteRow(N2)).user_id).toBe(bob);
    });
  });

  it('writes 500 notes with two links each in one go', async () => {
    await addTags(ann, G1);
    await addMoods(ann, M1);
    const rows = Array.from({ length: 500 }, (_, i) => ({
      id: id(2000 + i),
      tag_ids: [G1],
      mood_ids: [M1],
    }));
    expect(await write(ann, ...rows)).toEqual([]);
    expect(await count('diary_entries')).toBe(500);
    expect(await count('diary_entry_tags')).toBe(500);
    expect(await count('diary_entry_moods')).toBe(500);
  });
});
