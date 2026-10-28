import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createTestApp, truncateAll } from './support/db';

const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';
const M1 = '33333333-3333-4333-8333-333333333333';
const M2 = '44444444-4444-4444-8444-444444444444';
const G1 = '55555555-5555-4555-8555-555555555555';
const G2 = '66666666-6666-4666-8666-666666666666';
const NOBODY = '00000000-0000-4000-8000-000000000000';

// Written out here on purpose, apart from the migration: the application ships the same eight
// (lib/utils/note_labels.dart) and a changed uuid would be a different mood on every phone.
const STARTERS: [string, string, string][] = [
  ['0f8a4c3e-1d92-4b7a-9c15-6e2f8a01b4d3', 'Радость', '😊'],
  ['2b6d91f7-84ca-4e35-b0d8-77c4e9a12f56', 'Спокойствие', '🌿'],
  ['5c31e0a8-2f47-4d69-8b3e-91da6c25f087', 'Размышления', '🤔'],
  ['7e94b2d1-6a08-4c52-9f7b-38e5c1470ab9', 'Грусть', '😢'],
  ['9a07f3c5-4b81-4e20-a6d9-52fb8c364e1a', 'Усталость', '😴'],
  ['b3d85e19-7c62-4a0f-8e41-6db29f057c34', 'Благодарность', '🙏'],
  ['d51c7a26-9e34-4f8b-b273-40a6e8d91cf5', 'Тревога', '😰'],
  ['f28b60d4-3a15-4c97-9e56-18c7b2f4a06e', 'Любовь', '❤️'],
];

describe('Diary tables', () => {
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

  // Raw SQL; `fields` are extra columns after id and user_id.
  function insert(
    table: string,
    id: string,
    userId: string,
    fields: Record<string, unknown> = {},
  ) {
    const cols = ['id', 'user_id', ...Object.keys(fields)];
    const params = [id, userId, ...Object.values(fields)];
    return ds.query(
      `insert into ${table} (${cols.join(', ')})
       values (${params.map((_, i) => `$${i + 1}`).join(', ')})`,
      params,
    );
  }
  const addEntry = (user: string, id: string, f = {}) =>
    insert('diary_entries', id, user, f);
  const addTag = (user: string, id: string, f: Record<string, unknown> = {}) =>
    insert('note_tags', id, user, { name: 'tag', ...f });
  const addMood = (user: string, id: string, f: Record<string, unknown> = {}) =>
    insert('note_moods', id, user, { name: 'mood', emoji: '🙂', ...f });
  const linkMood = (entry: string, mood: string, user: string) =>
    ds.query(
      `insert into diary_entry_moods (entry_id, mood_id, user_id) values ($1, $2, $3)`,
      [entry, mood, user],
    );
  const linkTag = (entry: string, tag: string, user: string) =>
    ds.query(
      `insert into diary_entry_tags (entry_id, tag_id, user_id) values ($1, $2, $3)`,
      [entry, tag, user],
    );
  const count = async (table: string, where = 'true') =>
    (await ds.query(`select count(*)::int n from ${table} where ${where}`))[0]
      .n as number;
  const row = async (
    table: string,
    id: string,
  ): Promise<Record<string, unknown>> => {
    const rows: Record<string, unknown>[] = await ds.query(
      `select * from ${table} where id = $1`,
      [id],
    );
    return rows[0];
  };

  describe('the starter moods', () => {
    it('are eight rows that belong to nobody, exactly as the app has them', async () => {
      const rows: { id: string; name: string; emoji: string; user_id: null }[] =
        await ds.query(
          `select id, name, emoji, user_id from note_moods where user_id is null order by name`,
        );
      expect(rows.map((r) => [r.id, r.name, r.emoji]).sort()).toEqual(
        [...STARTERS].sort(),
      );
      expect(await count('note_moods')).toBe(8);
    });

    it('survive an emptying of the tables in tests', async () => {
      await truncateAll(ds);
      expect(await count('note_moods', 'user_id is null')).toBe(8);
    });

    it('cannot be renamed, emptied, deleted or given an owner, by anybody', async () => {
      const user = await addUser();
      const [id] = STARTERS[0];
      await expect(
        ds.query(`update note_moods set name = 'x' where id = $1`, [id]),
      ).rejects.toThrow(/starter mood/);
      await expect(
        ds.query(`update note_moods set deleted_at = now() where id = $1`, [
          id,
        ]),
      ).rejects.toThrow(/starter mood/);
      await expect(
        ds.query(`update note_moods set user_id = $2 where id = $1`, [
          id,
          user,
        ]),
      ).rejects.toThrow(/starter mood/);
      await expect(
        ds.query(`delete from note_moods where id = $1`, [id]),
      ).rejects.toThrow(/starter mood/);
      expect((await row('note_moods', id)).name).toBe('Радость');
    });

    it('cannot be turned into a mood of one’s own either way', async () => {
      const user = await addUser();
      await addMood(user, M1);
      await expect(
        ds.query(`update note_moods set user_id = null where id = $1`, [M1]),
      ).rejects.toThrow(/starter mood/);
    });

    it('can be linked to a note', async () => {
      const user = await addUser();
      await addEntry(user, E1);
      await linkMood(E1, STARTERS[0][0], user);
      expect(await count('diary_entry_moods')).toBe(1);
    });

    it('stay when a user is deleted', async () => {
      const user = await addUser();
      await addEntry(user, E1);
      await linkMood(E1, STARTERS[0][0], user);
      await ds.query(`delete from users where id = $1`, [user]);
      expect(await count('note_moods', 'user_id is null')).toBe(8);
      expect(await count('diary_entry_moods')).toBe(0);
    });
  });

  describe('diary_entries', () => {
    it('fills in the defaults of a bare note', async () => {
      const user = await addUser();
      await addEntry(user, E1);
      expect(await row('diary_entries', E1)).toMatchObject({
        title: '',
        body: '',
        cover_image: null,
        images: '[]',
        is_favorite: false,
        status: 'normal',
        deleted_at: null,
      });
    });

    it('accepts the three statuses and refuses any other', async () => {
      const user = await addUser();
      await addEntry(user, E1, { status: 'draft' });
      await addEntry(user, E2, { status: 'archived' });
      await expect(addEntry(user, G1, { status: 'done' })).rejects.toThrow(
        /diary_entries_status_check/,
      );
    });

    it('refuses an owner that does not exist, and the same id twice', async () => {
      await expect(addEntry(NOBODY, E1)).rejects.toThrow(
        /diary_entries_user_id_fkey/,
      );
      const user = await addUser();
      await addEntry(user, E1);
      await expect(addEntry(user, E1)).rejects.toThrow(/diary_entries_pkey/);
    });

    it('stamps updated_at on the server and moves it on every update', async () => {
      const user = await addUser();
      await addEntry(user, E1, { updated_at: '2000-01-01' });
      const [{ fresh, before }] = await ds.query(
        `select updated_at > '2020-01-01' fresh, updated_at::text before from diary_entries`,
      );
      expect(fresh).toBe(true);
      await ds.query(`update diary_entries set title = 'x'`);
      const [{ moved }] = await ds.query(
        `select updated_at > $1::timestamptz moved from diary_entries`,
        [before],
      );
      expect(moved).toBe(true);
    });

    it('is removed with its owner, its links included', async () => {
      const user = await addUser();
      await addEntry(user, E1);
      await addTag(user, G1);
      await linkTag(E1, G1, user);
      await ds.query(`delete from users where id = $1`, [user]);
      expect(await count('diary_entries')).toBe(0);
      expect(await count('diary_entry_tags')).toBe(0);
    });
  });

  describe('note_moods and note_tags', () => {
    it('need a name; a mood needs an emoji; a tag has a default colour', async () => {
      const user = await addUser();
      await expect(
        insert('note_moods', M1, user, { emoji: '🙂' }),
      ).rejects.toThrow(/name/);
      await expect(
        insert('note_moods', M1, user, { name: 'x' }),
      ).rejects.toThrow(/emoji/);
      await expect(insert('note_tags', G1, user, {})).rejects.toThrow(/name/);
      await insert('note_tags', G1, user, { name: 'x' });
      expect((await row('note_tags', G1)).color_key).toBe('violet');
    });

    it('refuse an owner that does not exist, and the same id twice', async () => {
      await expect(addTag(NOBODY, G1)).rejects.toThrow(
        /note_tags_user_id_fkey/,
      );
      await expect(addMood(NOBODY, M1)).rejects.toThrow(
        /note_moods_user_id_fkey/,
      );
      const user = await addUser();
      await addTag(user, G1);
      await expect(addTag(user, G1)).rejects.toThrow(/note_tags_pkey/);
    });

    it('cannot take the id of a starter mood', async () => {
      const user = await addUser();
      await expect(addMood(user, STARTERS[0][0])).rejects.toThrow(
        /note_moods_pkey/,
      );
    });

    it('stamp updated_at on the server and move it on every update', async () => {
      const user = await addUser();
      await addTag(user, G1, { updated_at: '2000-01-01' });
      await addMood(user, M1, { updated_at: '2000-01-01' });
      for (const [table, id] of [
        ['note_tags', G1],
        ['note_moods', M1],
      ]) {
        const [{ before }] = await ds.query(
          `select updated_at::text before from ${table} where id = $1`,
          [id],
        );
        expect(new Date(before).getFullYear()).toBeGreaterThan(2020);
        await ds.query(`update ${table} set name = 'y' where id = $1`, [id]);
        const [{ moved }] = await ds.query(
          `select updated_at > $2::timestamptz moved from ${table} where id = $1`,
          [id, before],
        );
        expect(moved).toBe(true);
      }
    });

    it('can be changed and deleted by their owner’s own statements', async () => {
      const user = await addUser();
      await addMood(user, M1);
      await ds.query(`update note_moods set name = 'new' where id = $1`, [M1]);
      expect((await row('note_moods', M1)).name).toBe('new');
      await ds.query(`delete from note_moods where id = $1`, [M1]);
      expect(await count('note_moods', 'user_id is not null')).toBe(0);
    });
  });

  describe('links', () => {
    it('refuse a note, mood or tag that does not exist, and a user that does not exist', async () => {
      const user = await addUser();
      await addEntry(user, E1);
      await addTag(user, G1);
      await addMood(user, M1);
      await expect(linkMood(E2, M1, user)).rejects.toThrow(
        /diary_entry_moods_entry_id_fkey/,
      );
      await expect(linkMood(E1, M2, user)).rejects.toThrow(
        /diary_entry_moods_mood_id_fkey/,
      );
      await expect(linkMood(E1, M1, NOBODY)).rejects.toThrow(
        /diary_entry_moods_user_id_fkey/,
      );
      await expect(linkTag(E2, G1, user)).rejects.toThrow(
        /diary_entry_tags_entry_id_fkey/,
      );
      await expect(linkTag(E1, G2, user)).rejects.toThrow(
        /diary_entry_tags_tag_id_fkey/,
      );
      await expect(linkTag(E1, G1, NOBODY)).rejects.toThrow(
        /diary_entry_tags_user_id_fkey/,
      );
    });

    it('are one per pair', async () => {
      const user = await addUser();
      await addEntry(user, E1);
      await addTag(user, G1);
      await addMood(user, M1);
      await linkTag(E1, G1, user);
      await linkMood(E1, M1, user);
      await expect(linkTag(E1, G1, user)).rejects.toThrow(
        /diary_entry_tags_pkey/,
      );
      await expect(linkMood(E1, M1, user)).rejects.toThrow(
        /diary_entry_moods_pkey/,
      );
    });

    it('go with a note that is really deleted, and with a really deleted mood or tag', async () => {
      const user = await addUser();
      await addEntry(user, E1);
      await addEntry(user, E2);
      await addTag(user, G1);
      await addMood(user, M1);
      for (const e of [E1, E2]) {
        await linkTag(e, G1, user);
        await linkMood(e, M1, user);
      }
      await ds.query(`delete from diary_entries where id = $1`, [E1]);
      expect(await count('diary_entry_tags')).toBe(1);
      await ds.query(`delete from note_tags where id = $1`, [G1]);
      await ds.query(`delete from note_moods where id = $1`, [M1]);
      expect(await count('diary_entry_tags')).toBe(0);
      expect(await count('diary_entry_moods')).toBe(0);
      expect(await count('diary_entries')).toBe(1);
    });
  });

  describe('deleting a note', () => {
    async function fullEntry(user: string) {
      await addEntry(user, E1, {
        title: 'Day',
        body: '[{"insert":"text"}]',
        cover_image: 'c.jpg',
        images: '["a.jpg"]',
        is_favorite: true,
        status: 'archived',
      });
      await addTag(user, G1);
      await addMood(user, M1);
      await linkTag(E1, G1, user);
      await linkMood(E1, M1, user);
      await linkMood(E1, STARTERS[0][0], user);
    }
    const blank = {
      title: '',
      body: '',
      cover_image: null,
      images: '[]',
      is_favorite: false,
      status: 'normal',
    };

    it('empties it and erases its links, keeping id, owner and deleted_at', async () => {
      const user = await addUser();
      await fullEntry(user);
      await ds.query(
        `update diary_entries set deleted_at = now() where id = $1`,
        [E1],
      );
      const r = await row('diary_entries', E1);
      expect(r).toMatchObject({ ...blank, user_id: user });
      expect(r.deleted_at).not.toBeNull();
      expect(await count('diary_entry_tags')).toBe(0);
      expect(await count('diary_entry_moods')).toBe(0);
      // The tag and the mood themselves are untouched.
      expect(await count('note_tags')).toBe(1);
      expect(await count('note_moods', 'user_id is not null')).toBe(1);
    });

    it('leaves other notes and their links alone', async () => {
      const user = await addUser();
      await fullEntry(user);
      await addEntry(user, E2, { title: 'Other' });
      await linkTag(E2, G1, user);
      await ds.query(
        `update diary_entries set deleted_at = now() where id = $1`,
        [E1],
      );
      expect((await row('diary_entries', E2)).title).toBe('Other');
      expect(await count('diary_entry_tags')).toBe(1);
    });

    it('moves updated_at forward, so other devices pull the deletion', async () => {
      const user = await addUser();
      await addEntry(user, E1);
      const [{ before }] = await ds.query(
        `select updated_at::text before from diary_entries`,
      );
      await ds.query(`update diary_entries set deleted_at = now()`);
      const [{ moved }] = await ds.query(
        `select updated_at > $1::timestamptz moved from diary_entries`,
        [before],
      );
      expect(moved).toBe(true);
    });

    it('stays empty when a device that missed the deletion writes the note again', async () => {
      const user = await addUser();
      await fullEntry(user);
      await ds.query(
        `update diary_entries set deleted_at = now() where id = $1`,
        [E1],
      );
      await ds.query(
        `insert into diary_entries (id, user_id, title, body, status)
         values ($1, $2, 'Back', 'text', 'draft')
         on conflict (id) do update set title = excluded.title, body = excluded.body, status = excluded.status`,
        [E1, user],
      );
      expect(await row('diary_entries', E1)).toMatchObject(blank);
    });

    it('is empty when it is created already deleted (a tombstone)', async () => {
      const user = await addUser();
      await addEntry(user, E1, {
        title: 'x',
        body: 'y',
        is_favorite: true,
        deleted_at: '2026-01-01',
      });
      expect(await row('diary_entries', E1)).toMatchObject(blank);
    });

    it('does not erase the links of an existing note when a deleted row with its id loses the insert', async () => {
      // A BEFORE INSERT trigger runs before the conflict is noticed; it must not touch the links.
      const user = await addUser();
      await fullEntry(user);
      const other = await addUser('other@example.com');
      await ds.query(
        `insert into diary_entries (id, user_id, deleted_at) values ($1, $2, now()) on conflict (id) do nothing`,
        [E1, other],
      );
      expect(await count('diary_entry_tags')).toBe(1);
      expect(await count('diary_entry_moods')).toBe(2);
    });

    it('does not touch a note that is not deleted', async () => {
      const user = await addUser();
      await fullEntry(user);
      await ds.query(
        `update diary_entries set title = 'Edited' where id = $1`,
        [E1],
      );
      expect(await row('diary_entries', E1)).toMatchObject({
        title: 'Edited',
        body: '[{"insert":"text"}]',
        is_favorite: true,
      });
      expect(await count('diary_entry_tags')).toBe(1);
    });
  });

  describe('deleting a tag or a mood', () => {
    it('empties the tag and erases its links in every note, leaving the other tags’ links', async () => {
      const user = await addUser();
      await addEntry(user, E1);
      await addEntry(user, E2);
      await addTag(user, G1, { name: 'Work', color_key: 'red' });
      await addTag(user, G2);
      for (const e of [E1, E2]) await linkTag(e, G1, user);
      await linkTag(E1, G2, user);
      await ds.query(`update note_tags set deleted_at = now() where id = $1`, [
        G1,
      ]);
      expect(await row('note_tags', G1)).toMatchObject({
        name: '',
        color_key: 'violet',
        user_id: user,
      });
      expect((await row('note_tags', G1)).deleted_at).not.toBeNull();
      expect(await ds.query(`select tag_id from diary_entry_tags`)).toEqual([
        { tag_id: G2 },
      ]);
    });

    it('empties the mood and erases its links in every note, leaving other moods’ links', async () => {
      const user = await addUser();
      await addEntry(user, E1);
      await addMood(user, M1, { name: 'Mine', emoji: '🙂' });
      await linkMood(E1, M1, user);
      await linkMood(E1, STARTERS[0][0], user);
      await ds.query(`update note_moods set deleted_at = now() where id = $1`, [
        M1,
      ]);
      expect(await row('note_moods', M1)).toMatchObject({
        name: '',
        emoji: '',
        user_id: user,
      });
      expect(await ds.query(`select mood_id from diary_entry_moods`)).toEqual([
        { mood_id: STARTERS[0][0] },
      ]);
    });

    it('stay empty when written again after the deletion', async () => {
      const user = await addUser();
      await addTag(user, G1);
      await addMood(user, M1);
      await ds.query(`update note_tags set deleted_at = now()`);
      await ds.query(
        `update note_moods set deleted_at = now() where user_id is not null`,
      );
      await ds.query(
        `insert into note_tags (id, user_id, name) values ($1, $2, 'Back') on conflict (id) do update set name = excluded.name`,
        [G1, user],
      );
      await ds.query(
        `insert into note_moods (id, user_id, name, emoji) values ($1, $2, 'Back', '🙂') on conflict (id) do update set name = excluded.name, emoji = excluded.emoji`,
        [M1, user],
      );
      expect((await row('note_tags', G1)).name).toBe('');
      expect(await row('note_moods', M1)).toMatchObject({
        name: '',
        emoji: '',
      });
    });

    it('do not erase the links of an existing tag or mood when a deleted row with its id loses the insert', async () => {
      const user = await addUser();
      const other = await addUser('other@example.com');
      await addEntry(user, E1);
      await addTag(user, G1);
      await addMood(user, M1);
      await linkTag(E1, G1, user);
      await linkMood(E1, M1, user);
      await ds.query(
        `insert into note_tags (id, user_id, name, deleted_at) values ($1, $2, 'x', now()) on conflict (id) do nothing`,
        [G1, other],
      );
      await ds.query(
        `insert into note_moods (id, user_id, name, emoji, deleted_at) values ($1, $2, 'x', 'y', now()) on conflict (id) do nothing`,
        [M1, other],
      );
      expect(await count('diary_entry_tags')).toBe(1);
      expect(await count('diary_entry_moods')).toBe(1);
    });
  });
});
