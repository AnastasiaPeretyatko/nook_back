import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { planEntryWrites } from './plan-entry-writes';
import { KnownLabel } from './plan-label-writes';
import { EntryRow } from './push-rows';
import { Rejection } from './rejection';

// Who owns the notes, moods and tags the batch names, in one round trip.
const FIND_KNOWN = `
  select 'note' as kind, id, user_id, deleted_at is not null as deleted
    from diary_entries where id = any($1::uuid[])
  union all
  select 'mood', id, user_id, deleted_at is not null
    from note_moods where id = any($2::uuid[])
  union all
  select 'tag', id, user_id, deleted_at is not null
    from note_tags where id = any($3::uuid[])
`;

// One statement for all the notes, rows as one JSON value (see TaskWriter). On conflict
// `created_at`, `user_id` and `deleted_at` never change; the `where` keeps someone else's note
// out of reach even if the check before it was fooled.
const UPSERT_ENTRIES = `
  insert into diary_entries (
    id, user_id, title, body, cover_image, images, is_favorite, status, created_at,
    client_updated_at
  )
  select
    r.id, $2::uuid, r.title, r.body, r."coverImage", r.images, r."isFavorite", r.status,
    r."createdAt", r."clientUpdatedAt"
  from jsonb_to_recordset($1::jsonb) as r(
    id uuid, title text, body text, "coverImage" text, images text, "isFavorite" boolean,
    status text, "createdAt" timestamptz, "clientUpdatedAt" timestamptz
  )
  on conflict (id) do update set
    title = excluded.title, body = excluded.body, cover_image = excluded.cover_image,
    images = excluded.images, is_favorite = excluded.is_favorite, status = excluded.status,
    client_updated_at = excluded.client_updated_at
  where diary_entries.user_id = excluded.user_id
`;

// Replaces the links of the named notes by the links that came. Not "delete all, insert all":
// the parts of one statement see the same data and would collide on the pairs that stay. So
// the missing pairs are inserted (those already there are skipped) and the pairs that are no
// longer wanted are deleted, which touch different rows.
// $1 moods to insert, $2 tags to insert, $3 notes whose mood links are replaced, $4 the same for
// tags, $5 the caller. Every part is bound to a live note of the caller, and a link to a live
// label the caller may use, so a link can't land on someone else's data even if the check
// before it was fooled.
const REPLACE_LINKS = `
  with
  add_moods as (
    insert into diary_entry_moods (entry_id, mood_id, user_id)
    select r."entryId", r."labelId", $5::uuid
    from jsonb_to_recordset($1::jsonb) as r("entryId" uuid, "labelId" uuid)
    join diary_entries e on e.id = r."entryId" and e.user_id = $5::uuid and e.deleted_at is null
    join note_moods m on m.id = r."labelId" and m.deleted_at is null
      and (m.user_id = $5::uuid or m.user_id is null)
    on conflict do nothing
  ),
  add_tags as (
    insert into diary_entry_tags (entry_id, tag_id, user_id)
    select r."entryId", r."labelId", $5::uuid
    from jsonb_to_recordset($2::jsonb) as r("entryId" uuid, "labelId" uuid)
    join diary_entries e on e.id = r."entryId" and e.user_id = $5::uuid and e.deleted_at is null
    join note_tags t on t.id = r."labelId" and t.user_id = $5::uuid and t.deleted_at is null
    on conflict do nothing
  ),
  drop_moods as (
    delete from diary_entry_moods l
    using diary_entries e
    where e.id = l.entry_id and e.user_id = $5::uuid
      and l.entry_id = any($3::uuid[])
      and not exists (
        select 1 from jsonb_to_recordset($1::jsonb) as r("entryId" uuid, "labelId" uuid)
        where r."entryId" = l.entry_id and r."labelId" = l.mood_id
      )
  ),
  drop_tags as (
    delete from diary_entry_tags l
    using diary_entries e
    where e.id = l.entry_id and e.user_id = $5::uuid
      and l.entry_id = any($4::uuid[])
      and not exists (
        select 1 from jsonb_to_recordset($2::jsonb) as r("entryId" uuid, "labelId" uuid)
        where r."entryId" = l.entry_id and r."labelId" = l.tag_id
      )
  )
  select 1
`;

interface FoundRow {
  kind: 'note' | 'mood' | 'tag';
  id: string;
  user_id: string | null;
  deleted: boolean;
}

@Injectable()
export class EntryWriter {
  // Runs inside the push transaction, after the moods and tags of the same push were written, so
  // a note may be marked with a label created in the same request. Four queries however many
  // notes there are. Returns the notes it refused and the ones saved without a link.
  async write(
    manager: EntityManager,
    userId: string,
    rows: EntryRow[],
  ): Promise<Rejection[]> {
    if (rows.length === 0) return [];

    const noteIds = new Set(rows.map((r) => r.id));
    const moodIds = new Set(rows.flatMap((r) => r.moodIds ?? []));
    const tagIds = new Set(rows.flatMap((r) => r.tagIds ?? []));
    const found: FoundRow[] = await manager.query(FIND_KNOWN, [
      [...noteIds],
      [...moodIds],
      [...tagIds],
    ]);
    const of = (kind: FoundRow['kind']): KnownLabel[] =>
      found
        .filter((f) => f.kind === kind)
        .map((f) => ({ id: f.id, userId: f.user_id, deleted: f.deleted }));

    const plan = planEntryWrites(rows, userId, {
      notes: of('note'),
      moods: of('mood'),
      tags: of('tag'),
    });

    if (plan.write.length > 0) {
      await manager.query(UPSERT_ENTRIES, [JSON.stringify(plan.write), userId]);
    }
    if (plan.replaceMoodsOf.length + plan.replaceTagsOf.length > 0) {
      await manager.query(REPLACE_LINKS, [
        JSON.stringify(plan.moodLinks),
        JSON.stringify(plan.tagLinks),
        plan.replaceMoodsOf,
        plan.replaceTagsOf,
        userId,
      ]);
    }
    return plan.rejected;
  }
}
