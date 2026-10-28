import { INestApplication } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { DeletionWriter } from '../src/sync/deletion-writer';
import { EntryWriter } from '../src/sync/entry-writer';
import { LabelWriter } from '../src/sync/label-writer';
import {
  DeletedRow,
  parseDeleted,
  parseEntry,
  parseMood,
  parseTag,
  RowResult,
} from '../src/sync/push-rows';
import { createTestApp, truncateAll } from './support/db';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [N1, N2] = [id(1), id(2)];
const [M1, M2] = [id(11), id(12)];
const [G1, G2] = [id(21), id(22)];
const [X1, X2] = [id(91), id(92)];
const JOY = '0f8a4c3e-1d92-4b7a-9c15-6e2f8a01b4d3'; // a starter mood

const ok = <T>(result: RowResult<T>): T => {
  if (!('row' in result)) throw new Error('bad test row');
  return result.row;
};
const gone = (table: string, rowId: string): DeletedRow =>
  ok(parseDeleted({ table, id: rowId }));

describe('Deleting diary rows', () => {
  let app: INestApplication;
  let ds: DataSource;
  let deletions: DeletionWriter;
  let entries: EntryWriter;
  let labels: LabelWriter;
  let ann: string;
  let bob: string;

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
    deletions = app.get(DeletionWriter);
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

  // A note with a mood and a tag for the user: what the deletions act on.
  const add = (userId: string, noteId: string, tagId: string, moodId: string) =>
    ds.transaction(async (m) => {
      await labels.writeTags(m, userId, [
        ok(parseTag({ id: tagId, name: 'Work', color_key: 'red' })),
      ]);
      await labels.writeMoods(m, userId, [
        ok(parseMood({ id: moodId, name: 'Mine', emoji: '🙂' })),
      ]);
      await entries.write(m, userId, [
        ok(
          parseEntry({
            id: noteId,
            title: 'Day',
            body: 'text',
            images: '["a.jpg"]',
            is_favorite: true,
            tag_ids: [tagId],
            mood_ids: [moodId, JOY],
          }),
        ),
      ]);
    });
  const remove = (userId: string, ...rows: DeletedRow[]) =>
    ds.transaction((m) => deletions.write(m, userId, rows));

  const get = async (
    table: string,
    rowId: string,
  ): Promise<Record<string, unknown>> => {
    const rows: Record<string, unknown>[] = await ds.query(
      `select * from ${table} where id = $1`,
      [rowId],
    );
    return rows[0];
  };
  const links = async () => {
    const moods: { entry_id: string; mood_id: string }[] = await ds.query(
      `select entry_id, mood_id from diary_entry_moods order by entry_id, mood_id`,
    );
    const tags: { entry_id: string; tag_id: string }[] = await ds.query(
      `select entry_id, tag_id from diary_entry_tags order by entry_id, tag_id`,
    );
    return { moods, tags };
  };
  const rejection = (table: string, rowId: string, reason: string) => ({
    table,
    id: rowId,
    reason,
  });

  describe('a note', () => {
    it('is marked deleted and emptied, and loses its links, but not the labels themselves', async () => {
      await add(ann, N1, G1, M1);
      expect(await remove(ann, gone('diary_entries', N1))).toEqual([]);
      expect(await get('diary_entries', N1)).toMatchObject({
        user_id: ann,
        title: '',
        body: '',
        cover_image: null,
        images: '[]',
        is_favorite: false,
        status: 'normal',
      });
      expect((await get('diary_entries', N1)).deleted_at).not.toBeNull();
      expect(await links()).toEqual({ moods: [], tags: [] });
      expect((await get('note_tags', G1)).deleted_at).toBeNull();
      expect((await get('note_moods', M1)).deleted_at).toBeNull();
    });

    it('leaves the other notes and their links alone', async () => {
      await add(ann, N1, G1, M1);
      await ds.transaction((m) =>
        entries.write(m, ann, [
          ok(
            parseEntry({
              id: N2,
              title: 'Other',
              tag_ids: [G1],
              mood_ids: [M1],
            }),
          ),
        ]),
      );
      await remove(ann, gone('diary_entries', N1));
      expect((await get('diary_entries', N2)).title).toBe('Other');
      const l = await links();
      expect(l.tags).toEqual([{ entry_id: N2, tag_id: G1 }]);
      expect(l.moods).toEqual([{ entry_id: N2, mood_id: M1 }]);
    });

    it('moves updated_at forward, so other devices pull the deletion', async () => {
      await add(ann, N1, G1, M1);
      const [{ before }] = await ds.query(
        `select updated_at::text before from diary_entries`,
      );
      await remove(ann, gone('diary_entries', N1));
      const [{ moved }] = await ds.query(
        `select updated_at > $1::timestamptz moved from diary_entries`,
        [before],
      );
      expect(moved).toBe(true);
    });

    it('stays deleted when a device that missed it writes the note again', async () => {
      await add(ann, N1, G1, M1);
      await remove(ann, gone('diary_entries', N1));
      await ds.transaction((m) =>
        entries.write(m, ann, [
          ok(
            parseEntry({ id: N1, title: 'Back', body: 'again', tag_ids: [G1] }),
          ),
        ]),
      );
      expect(await get('diary_entries', N1)).toMatchObject({
        title: '',
        body: '',
      });
      expect((await get('diary_entries', N1)).deleted_at).not.toBeNull();
      expect(await links()).toEqual({ moods: [], tags: [] });
    });
  });

  describe('a tag', () => {
    it('is marked deleted and emptied, and its links vanish from every note, but the notes stay', async () => {
      await add(ann, N1, G1, M1);
      await ds.transaction((m) =>
        labels.writeTags(m, ann, [ok(parseTag({ id: G2, name: 'Home' }))]),
      );
      await ds.transaction((m) =>
        entries.write(m, ann, [ok(parseEntry({ id: N2, tag_ids: [G1, G2] }))]),
      );

      expect(await remove(ann, gone('note_tags', G1))).toEqual([]);

      expect(await get('note_tags', G1)).toMatchObject({
        user_id: ann,
        name: '',
        color_key: 'violet',
      });
      expect((await get('note_tags', G1)).deleted_at).not.toBeNull();
      expect((await links()).tags).toEqual([{ entry_id: N2, tag_id: G2 }]);
      expect((await get('diary_entries', N1)).title).toBe('Day');
      expect((await get('note_tags', G2)).name).toBe('Home');
    });

    it('stays deleted when a device that missed it sends it again', async () => {
      await add(ann, N1, G1, M1);
      await remove(ann, gone('note_tags', G1));
      await ds.transaction((m) =>
        labels.writeTags(m, ann, [ok(parseTag({ id: G1, name: 'Back' }))]),
      );
      expect((await get('note_tags', G1)).name).toBe('');
    });
  });

  describe('a mood', () => {
    it('is marked deleted and emptied, and its links vanish, the starter mood’s link stays', async () => {
      await add(ann, N1, G1, M1);
      expect(await remove(ann, gone('note_moods', M1))).toEqual([]);
      expect(await get('note_moods', M1)).toMatchObject({
        user_id: ann,
        name: '',
        emoji: '',
      });
      expect((await get('note_moods', M1)).deleted_at).not.toBeNull();
      expect((await links()).moods).toEqual([{ entry_id: N1, mood_id: JOY }]);
    });

    it('stays deleted when a device that missed it sends it again', async () => {
      await add(ann, N1, G1, M1);
      await remove(ann, gone('note_moods', M1));
      await ds.transaction((m) =>
        labels.writeMoods(m, ann, [
          ok(parseMood({ id: M1, name: 'Back', emoji: '🙃' })),
        ]),
      );
      expect(await get('note_moods', M1)).toMatchObject({
        name: '',
        emoji: '',
      });
    });
  });

  describe.each([
    ['diary_entries', X1],
    ['note_tags', X1],
    ['note_moods', X1],
  ])('%s: an id the server has not seen', (table, unseen) => {
    it('becomes a tombstone owned by the caller', async () => {
      expect(await remove(ann, gone(table, unseen))).toEqual([]);
      const row = await get(table, unseen);
      expect(row.user_id).toBe(ann);
      expect(row.deleted_at).not.toBeNull();
    });
  });

  it('keeps a note, a tag or a mood that arrives after its tombstone deleted', async () => {
    await remove(
      ann,
      gone('diary_entries', N1),
      gone('note_tags', G1),
      gone('note_moods', M1),
    );
    await add(ann, N1, G1, M1);
    for (const [table, rowId] of [
      ['diary_entries', N1],
      ['note_tags', G1],
      ['note_moods', M1],
    ]) {
      expect((await get(table, rowId)).deleted_at).not.toBeNull();
    }
    expect(await links()).toEqual({
      moods: [{ entry_id: N1, mood_id: JOY }].filter(() => false),
      tags: [],
    });
  });

  describe.each([
    ['diary_entries', N1],
    ['note_tags', G1],
    ['note_moods', M1],
  ])('%s: repeating a deletion', (table, rowId) => {
    it('changes nothing: neither deleted_at nor updated_at', async () => {
      await add(ann, N1, G1, M1);
      await remove(ann, gone(table, rowId));
      const [before] = await ds.query(
        `select deleted_at::text d, updated_at::text u from ${table} where id = $1`,
        [rowId],
      );
      expect(await remove(ann, gone(table, rowId), gone(table, rowId))).toEqual(
        [],
      );
      const [after] = await ds.query(
        `select deleted_at::text d, updated_at::text u from ${table} where id = $1`,
        [rowId],
      );
      expect(after).toEqual(before);
    });
  });

  describe("another user's rows", () => {
    beforeEach(async () => {
      await add(bob, N1, G1, M1);
    });

    it.each([
      ['diary_entries', N1],
      ['note_tags', G1],
      ['note_moods', M1],
    ])(
      '%s: are refused as id_taken and left untouched, links included',
      async (table, rowId) => {
        const rejected = await remove(ann, gone(table, rowId));
        expect(rejected).toEqual([rejection(table, rowId, 'id_taken')]);
        expect(await get(table, rowId)).toMatchObject({ user_id: bob });
        expect((await get(table, rowId)).deleted_at).toBeNull();
        expect((await get('diary_entries', N1)).title).toBe('Day');
        const l = await links();
        expect(l.tags).toEqual([{ entry_id: N1, tag_id: G1 }]);
        expect(l.moods).toHaveLength(2);
      },
    );

    it('are refused even when Bob already deleted them', async () => {
      await remove(bob, gone('diary_entries', N1));
      const [before] = await ds.query(
        `select updated_at::text u from diary_entries`,
      );
      expect(await remove(ann, gone('diary_entries', N1))).toEqual([
        rejection('diary_entries', N1, 'id_taken'),
      ]);
      expect(
        await ds.query(`select updated_at::text u from diary_entries`),
      ).toEqual([before]);
    });

    it('do not stop her own deletions in the same batch', async () => {
      await add(ann, N2, G2, M2);
      const rejected = await remove(
        ann,
        gone('diary_entries', N1),
        gone('diary_entries', N2),
        gone('note_tags', G2),
      );
      expect(rejected).toEqual([rejection('diary_entries', N1, 'id_taken')]);
      expect((await get('diary_entries', N2)).deleted_at).not.toBeNull();
      expect((await get('note_tags', G2)).deleted_at).not.toBeNull();
    });
  });

  describe('the starter moods', () => {
    it('cannot be deleted by anybody: the id is refused, the mood and its links stay, and there is no error', async () => {
      await add(ann, N1, G1, M1);
      const rejected = await remove(ann, gone('note_moods', JOY));
      expect(rejected).toEqual([rejection('note_moods', JOY, 'id_taken')]);
      const [starter] = await ds.query(
        `select name, emoji, user_id, deleted_at from note_moods where id = $1`,
        [JOY],
      );
      expect(starter).toEqual({
        name: 'Радость',
        emoji: '😊',
        user_id: null,
        deleted_at: null,
      });
      expect((await links()).moods.map((l) => l.mood_id)).toContain(JOY);
      expect(await remove(bob, gone('note_moods', JOY))).toEqual([
        rejection('note_moods', JOY, 'id_taken'),
      ]);
    });

    it('do not stop the other deletions of the same batch', async () => {
      await add(ann, N1, G1, M1);
      const rejected = await remove(
        ann,
        gone('note_moods', JOY),
        gone('note_moods', M1),
      );
      expect(rejected).toEqual([rejection('note_moods', JOY, 'id_taken')]);
      expect((await get('note_moods', M1)).deleted_at).not.toBeNull();
    });
  });

  describe('a mix of tables', () => {
    it('is done in one query, and refusals name the table they are in', async () => {
      await add(ann, N1, G1, M1);
      await add(bob, N2, G2, M2);
      await ds.query(`insert into tasks (id, user_id) values ($1, $2)`, [
        id(70),
        ann,
      ]);
      await ds.query(`insert into tasks (id, user_id) values ($1, $2)`, [
        id(71),
        bob,
      ]);

      let queries = 0;
      const rejected = await ds.transaction(async (manager) => {
        const counting = Object.create(manager) as EntityManager;
        counting.query = ((sql: string, params?: unknown[]) => {
          queries += 1;
          return manager.query(sql, params);
        }) as EntityManager['query'];
        return deletions.write(counting, ann, [
          gone('tasks', id(70)),
          gone('tasks', id(71)),
          gone('diary_entries', N1),
          gone('diary_entries', N2),
          gone('note_tags', G1),
          gone('note_tags', G2),
          gone('note_moods', M1),
          gone('note_moods', M2),
          gone('note_moods', JOY),
          gone('cycle_days', X2),
        ]);
      });

      expect(queries).toBe(1);
      expect(
        rejected.map((r) => `${r.table}:${r.id}:${r.reason}`).sort(),
      ).toEqual(
        [
          `tasks:${id(71)}:id_taken`,
          `diary_entries:${N2}:id_taken`,
          `note_tags:${G2}:id_taken`,
          `note_moods:${M2}:id_taken`,
          `note_moods:${JOY}:id_taken`,
          `cycle_days:${X2}:unsupported_table`,
        ].sort(),
      );
      for (const [table, rowId] of [
        ['tasks', id(70)],
        ['diary_entries', N1],
        ['note_tags', G1],
        ['note_moods', M1],
      ]) {
        expect((await get(table, rowId)).deleted_at).not.toBeNull();
      }
    });

    it('ids that are the same in two tables are two different rows', async () => {
      await ds.query(`insert into tasks (id, user_id) values ($1, $2)`, [
        X1,
        bob,
      ]);
      await add(ann, N1, G1, M1);
      const rejected = await remove(
        ann,
        gone('note_tags', G1),
        gone('tasks', X1),
      );
      expect(rejected).toEqual([rejection('tasks', X1, 'id_taken')]);
      expect((await get('note_tags', G1)).deleted_at).not.toBeNull();
    });

    it('asks nothing of the database for tables that are not named', async () => {
      let queries = 0;
      await ds.transaction(async (manager) => {
        const counting = Object.create(manager) as EntityManager;
        counting.query = ((sql: string, params?: unknown[]) => {
          queries += 1;
          return manager.query(sql, params);
        }) as EntityManager['query'];
        await deletions.write(counting, ann, [
          gone('cycle_days', X1),
          gone('whatever', X2),
        ]);
        await deletions.write(counting, ann, []);
      });
      expect(queries).toBe(0);
    });
  });

  it('refuses names that only look like tables, by exact name', async () => {
    const rejected = await remove(
      ann,
      gone('Diary_entries', X1),
      gone('note_tags ', X2),
      gone('constructor', X1),
      gone('__proto__', X2),
    );
    expect(rejected.map((r) => r.reason)).toEqual(
      Array(4).fill('unsupported_table'),
    );
  });

  it('deletes 500 of each in one go', async () => {
    const many = (base: number, table: string) =>
      Array.from({ length: 500 }, (_, i) => gone(table, id(base + i)));
    const rejected = await remove(
      ann,
      ...many(1000, 'diary_entries'),
      ...many(2000, 'note_tags'),
      ...many(3000, 'note_moods'),
    );
    expect(rejected).toEqual([]);
    for (const table of ['diary_entries', 'note_tags', 'note_moods']) {
      const [{ n }] = await ds.query(
        `select count(*)::int n from ${table} where deleted_at is not null`,
      );
      expect(n).toBe(500);
    }
  });

  it('rolls back with the push transaction', async () => {
    await add(ann, N1, G1, M1);
    await expect(
      ds.transaction(async (m) => {
        await deletions.write(m, ann, [
          gone('diary_entries', N1),
          gone('note_tags', G1),
        ]);
        throw new Error('later step failed');
      }),
    ).rejects.toThrow('later step failed');
    expect((await get('diary_entries', N1)).deleted_at).toBeNull();
    expect((await links()).tags).toHaveLength(1);
  });
});
