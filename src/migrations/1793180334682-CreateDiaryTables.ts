import { MigrationInterface, QueryRunner } from 'typeorm';

// The diary (B3): notes, moods, tags, and the links between a note and its moods / tags.
// Ported from the Supabase scripts 001 + 004.
export class CreateDiaryTables1793180334682 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // A check instead of an enum type, as for tasks. `images` is a JSON list kept as text.
    await queryRunner.query(`
      create table diary_entries (
        id uuid not null,
        user_id uuid not null,
        title text not null default '',
        body text not null default '',
        cover_image text,
        images text not null default '[]',
        is_favorite boolean not null default false,
        status text not null default 'normal',
        created_at timestamptz not null default now(),
        client_updated_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        deleted_at timestamptz,
        constraint diary_entries_pkey primary key (id),
        constraint diary_entries_user_id_fkey
          foreign key (user_id) references users (id) on delete cascade,
        constraint diary_entries_status_check
          check (status in ('draft', 'normal', 'archived'))
      )
    `);

    // `user_id` is empty for the eight starter moods: they belong to the application, not to a
    // person. They are in every note's picker and the app knows their uuids, so a link can name
    // one without the row ever being sent; the row exists so that the link's foreign key has
    // something to point at. Nobody may change or delete them (see the trigger below).
    await queryRunner.query(`
      create table note_moods (
        id uuid not null,
        user_id uuid,
        name text not null,
        emoji text not null,
        created_at timestamptz not null default now(),
        client_updated_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        deleted_at timestamptz,
        constraint note_moods_pkey primary key (id),
        constraint note_moods_user_id_fkey
          foreign key (user_id) references users (id) on delete cascade
      )
    `);

    await queryRunner.query(`
      create table note_tags (
        id uuid not null,
        user_id uuid not null,
        name text not null,
        color_key text not null default 'violet',
        created_at timestamptz not null default now(),
        client_updated_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        deleted_at timestamptz,
        constraint note_tags_pkey primary key (id),
        constraint note_tags_user_id_fkey
          foreign key (user_id) references users (id) on delete cascade
      )
    `);

    // A link has no identity of its own: it is the pair of its parents, and it travels inside
    // the note. `user_id` is kept so that whose link it is can be read off the row itself.
    // Cascade is for a really deleted parent (the account going away); an ordinary deletion is a
    // `deleted_at`, and the triggers below erase the links by hand.
    await queryRunner.query(`
      create table diary_entry_moods (
        entry_id uuid not null,
        mood_id uuid not null,
        user_id uuid not null,
        constraint diary_entry_moods_pkey primary key (entry_id, mood_id),
        constraint diary_entry_moods_entry_id_fkey
          foreign key (entry_id) references diary_entries (id) on delete cascade,
        constraint diary_entry_moods_mood_id_fkey
          foreign key (mood_id) references note_moods (id) on delete cascade,
        constraint diary_entry_moods_user_id_fkey
          foreign key (user_id) references users (id) on delete cascade
      )
    `);
    await queryRunner.query(`
      create table diary_entry_tags (
        entry_id uuid not null,
        tag_id uuid not null,
        user_id uuid not null,
        constraint diary_entry_tags_pkey primary key (entry_id, tag_id),
        constraint diary_entry_tags_entry_id_fkey
          foreign key (entry_id) references diary_entries (id) on delete cascade,
        constraint diary_entry_tags_tag_id_fkey
          foreign key (tag_id) references note_tags (id) on delete cascade,
        constraint diary_entry_tags_user_id_fkey
          foreign key (user_id) references users (id) on delete cascade
      )
    `);

    // The one read: "everything of mine changed since X". The link keys already index the entry;
    // the other side is looked up when a mood or a tag is deleted.
    await queryRunner.query(
      `create index diary_entries_user_updated_idx on diary_entries (user_id, updated_at)`,
    );
    await queryRunner.query(
      `create index note_moods_user_updated_idx on note_moods (user_id, updated_at)`,
    );
    await queryRunner.query(
      `create index note_tags_user_updated_idx on note_tags (user_id, updated_at)`,
    );
    await queryRunner.query(
      `create index diary_entry_moods_mood_id_idx on diary_entry_moods (mood_id)`,
    );
    await queryRunner.query(
      `create index diary_entry_tags_tag_id_idx on diary_entry_tags (tag_id)`,
    );

    for (const table of ['diary_entries', 'note_moods', 'note_tags']) {
      await queryRunner.query(`
        create trigger ${table}_updated_at
          before insert or update on ${table}
          for each row execute function set_updated_at()
      `);
    }

    // A deleted note, tag or mood keeps its row (other devices learn of the deletion from it)
    // and loses its contents at once; its links are erased. Fires on every write of a deleted
    // row, so a device that missed the deletion cannot bring the contents back. The links are
    // erased only on UPDATE: a BEFORE INSERT trigger runs even when the insert then loses to an
    // existing row (on conflict), and must not touch the links of someone else's note.
    await queryRunner.query(`
      create function blank_deleted_diary_entry()
      returns trigger
      language plpgsql
      as $$
      begin
        new.title := '';
        new.body := '';
        new.cover_image := null;
        new.images := '[]';
        new.is_favorite := false;
        new.status := 'normal';
        if tg_op = 'UPDATE' then
          delete from diary_entry_moods where entry_id = new.id;
          delete from diary_entry_tags where entry_id = new.id;
        end if;
        return new;
      end;
      $$
    `);
    await queryRunner.query(`
      create trigger diary_entries_blank_when_deleted
        before insert or update on diary_entries
        for each row
        when (new.deleted_at is not null)
        execute function blank_deleted_diary_entry()
    `);

    await queryRunner.query(`
      create function blank_deleted_note_tag()
      returns trigger
      language plpgsql
      as $$
      begin
        new.name := '';
        new.color_key := 'violet';
        if tg_op = 'UPDATE' then
          delete from diary_entry_tags where tag_id = new.id;
        end if;
        return new;
      end;
      $$
    `);
    await queryRunner.query(`
      create trigger note_tags_blank_when_deleted
        before insert or update on note_tags
        for each row
        when (new.deleted_at is not null)
        execute function blank_deleted_note_tag()
    `);

    await queryRunner.query(`
      create function blank_deleted_note_mood()
      returns trigger
      language plpgsql
      as $$
      begin
        new.name := '';
        new.emoji := '';
        if tg_op = 'UPDATE' then
          delete from diary_entry_moods where mood_id = new.id;
        end if;
        return new;
      end;
      $$
    `);
    await queryRunner.query(`
      create trigger note_moods_blank_when_deleted
        before insert or update on note_moods
        for each row
        when (new.deleted_at is not null)
        execute function blank_deleted_note_mood()
    `);

    // The starter moods are read-only for everyone, the database itself says no. (To add a ninth
    // one, change the server and the app together, with a migration that inserts it.)
    await queryRunner.query(`
      create function forbid_change_of_starter_mood()
      returns trigger
      language plpgsql
      as $$
      begin
        raise exception 'a starter mood belongs to nobody and cannot be changed or deleted';
      end;
      $$
    `);
    await queryRunner.query(`
      create trigger note_moods_starter_no_update
        before update on note_moods
        for each row
        when (old.user_id is null or new.user_id is null)
        execute function forbid_change_of_starter_mood()
    `);
    await queryRunner.query(`
      create trigger note_moods_starter_no_delete
        before delete on note_moods
        for each row
        when (old.user_id is null)
        execute function forbid_change_of_starter_mood()
    `);

    // The uuids, names and emoji must stay identical to `defaultNoteMoods` in the app
    // (lib/utils/note_labels.dart): changing one makes it a different mood on every device that
    // already has the old one.
    await queryRunner.query(`
      insert into note_moods (id, user_id, name, emoji) values
        ('0f8a4c3e-1d92-4b7a-9c15-6e2f8a01b4d3', null, 'Радость', '😊'),
        ('2b6d91f7-84ca-4e35-b0d8-77c4e9a12f56', null, 'Спокойствие', '🌿'),
        ('5c31e0a8-2f47-4d69-8b3e-91da6c25f087', null, 'Размышления', '🤔'),
        ('7e94b2d1-6a08-4c52-9f7b-38e5c1470ab9', null, 'Грусть', '😢'),
        ('9a07f3c5-4b81-4e20-a6d9-52fb8c364e1a', null, 'Усталость', '😴'),
        ('b3d85e19-7c62-4a0f-8e41-6db29f057c34', null, 'Благодарность', '🙏'),
        ('d51c7a26-9e34-4f8b-b273-40a6e8d91cf5', null, 'Тревога', '😰'),
        ('f28b60d4-3a15-4c97-9e56-18c7b2f4a06e', null, 'Любовь', '❤️')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('drop table diary_entry_tags');
    await queryRunner.query('drop table diary_entry_moods');
    await queryRunner.query('drop table note_tags');
    await queryRunner.query('drop table note_moods');
    await queryRunner.query('drop table diary_entries');
    await queryRunner.query('drop function forbid_change_of_starter_mood()');
    await queryRunner.query('drop function blank_deleted_note_mood()');
    await queryRunner.query('drop function blank_deleted_note_tag()');
    await queryRunner.query('drop function blank_deleted_diary_entry()');
  }
}
