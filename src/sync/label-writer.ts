import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { KnownLabel, planLabelWrites } from './plan-label-writes';
import { MoodRow, TagRow } from './push-rows';
import { Rejection } from './rejection';

// One statement per list, rows as one JSON value (see TaskWriter). On conflict only the content
// changes: `created_at`, `user_id` and `deleted_at` never do. The `where` keeps a row of someone
// else's, and a starter mood (its `user_id` is null, and null is never equal to anything), out of
// reach even if the check before it was fooled.
const UPSERT_MOODS = `
  insert into note_moods (id, user_id, name, emoji, created_at, client_updated_at)
  select r.id, $2::uuid, r.name, r.emoji, r."createdAt", r."clientUpdatedAt"
  from jsonb_to_recordset($1::jsonb) as r(
    id uuid, name text, emoji text, "createdAt" timestamptz, "clientUpdatedAt" timestamptz
  )
  on conflict (id) do update set
    name = excluded.name, emoji = excluded.emoji,
    client_updated_at = excluded.client_updated_at
  where note_moods.user_id = excluded.user_id
`;

const UPSERT_TAGS = `
  insert into note_tags (id, user_id, name, color_key, created_at, client_updated_at)
  select r.id, $2::uuid, r.name, r."colorKey", r."createdAt", r."clientUpdatedAt"
  from jsonb_to_recordset($1::jsonb) as r(
    id uuid, name text, "colorKey" text, "createdAt" timestamptz, "clientUpdatedAt" timestamptz
  )
  on conflict (id) do update set
    name = excluded.name, color_key = excluded.color_key,
    client_updated_at = excluded.client_updated_at
  where note_tags.user_id = excluded.user_id
`;

interface FoundLabel {
  id: string;
  user_id: string | null;
  deleted: boolean;
}

@Injectable()
export class LabelWriter {
  // Both run inside the push transaction, before the notes (a note may be marked with a mood or
  // tag created in the same push). Two queries however many rows there are. They return the rows
  // they refused.
  writeMoods(
    manager: EntityManager,
    userId: string,
    rows: MoodRow[],
  ): Promise<Rejection[]> {
    return this.write(manager, userId, rows, 'note_moods', UPSERT_MOODS);
  }

  writeTags(
    manager: EntityManager,
    userId: string,
    rows: TagRow[],
  ): Promise<Rejection[]> {
    return this.write(manager, userId, rows, 'note_tags', UPSERT_TAGS);
  }

  private async write<T extends { id: string }>(
    manager: EntityManager,
    userId: string,
    rows: T[],
    table: 'note_moods' | 'note_tags',
    upsert: string,
  ): Promise<Rejection[]> {
    if (rows.length === 0) return [];

    const found: FoundLabel[] = await manager.query(
      `select id, user_id, deleted_at is not null as deleted
       from ${table} where id = any($1::uuid[])`,
      [[...new Set(rows.map((r) => r.id))]],
    );
    const known: KnownLabel[] = found.map((f) => ({
      id: f.id,
      userId: f.user_id,
      deleted: f.deleted,
    }));

    const { write, rejected } = planLabelWrites(table, rows, userId, known);
    if (write.length > 0) {
      await manager.query(upsert, [JSON.stringify(write), userId]);
    }
    return rejected;
  }
}
