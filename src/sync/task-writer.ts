import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { KnownTask, planTaskWrites } from './plan-task-writes';
import { TaskRow } from './push-rows';
import { Rejection } from './rejection';

// The batch ids and their parents, plus the ancestors of those parents (up to the root), so
// the cycle check sees the tree as stored. The climb only follows the caller's own tasks.
const FIND_KNOWN = `
  with recursive up as (
    select id, user_id, parent_id, deleted_at is not null as deleted
    from tasks where id = any($1::uuid[])
    union
    select t.id, t.user_id, t.parent_id, t.deleted_at is not null
    from tasks t join up on t.id = up.parent_id
    where up.user_id = $2 and t.user_id = $2
  )
  select id, user_id, parent_id, deleted from up
`;

// One statement for the whole batch: the rows travel as one JSON value, which keeps the number
// of parameters fixed and the round trips few (the database can be an ocean away).
// On conflict: `created_at`, `user_id` and `deleted_at` are never changed; the last write wins
// for the rest, as the app decides whose edit is newer itself. The `where` is only a guard
// against a row taken by someone else between the check and this write.
const UPSERT = `
  insert into tasks (
    id, user_id, parent_id, title, description, status, repeat_type, repeat_interval,
    repeat_days_mask, tracking_mode, target_duration_minutes, target_value, icon_key,
    color_key, scheduled_time_minutes, end_time_minutes, start_date, created_at,
    client_updated_at
  )
  select
    r.id, $2::uuid, r."parentId", r.title, r.description, r.status, r."repeatType",
    r."repeatInterval", r."repeatDaysMask", r."trackingMode", r."targetDurationMinutes",
    r."targetValue", r."iconKey", r."colorKey", r."scheduledTimeMinutes", r."endTimeMinutes",
    r."startDate", r."createdAt", r."clientUpdatedAt"
  from jsonb_to_recordset($1::jsonb) as r(
    id uuid, "parentId" uuid, title text, description text, status text, "repeatType" text,
    "repeatInterval" integer, "repeatDaysMask" integer, "trackingMode" text,
    "targetDurationMinutes" integer, "targetValue" double precision, "iconKey" text,
    "colorKey" text, "scheduledTimeMinutes" integer, "endTimeMinutes" integer,
    "startDate" date, "createdAt" timestamptz, "clientUpdatedAt" timestamptz
  )
  on conflict (id) do update set
    parent_id = excluded.parent_id, title = excluded.title,
    description = excluded.description, status = excluded.status,
    repeat_type = excluded.repeat_type, repeat_interval = excluded.repeat_interval,
    repeat_days_mask = excluded.repeat_days_mask, tracking_mode = excluded.tracking_mode,
    target_duration_minutes = excluded.target_duration_minutes,
    target_value = excluded.target_value, icon_key = excluded.icon_key,
    color_key = excluded.color_key, scheduled_time_minutes = excluded.scheduled_time_minutes,
    end_time_minutes = excluded.end_time_minutes, start_date = excluded.start_date,
    client_updated_at = excluded.client_updated_at
  where tasks.user_id = excluded.user_id
`;

interface KnownTaskRow {
  id: string;
  user_id: string;
  parent_id: string | null;
  deleted: boolean;
}

@Injectable()
export class TaskWriter {
  // Runs inside the push transaction (`manager`); the rows are already checked (parseTask).
  // Two queries however many tasks there are. Returns the rows it refused.
  async write(
    manager: EntityManager,
    userId: string,
    rows: TaskRow[],
  ): Promise<Rejection[]> {
    if (rows.length === 0) return [];

    const ids = new Set(rows.map((r) => r.id));
    for (const row of rows) if (row.parentId) ids.add(row.parentId);
    const found: KnownTaskRow[] = await manager.query(FIND_KNOWN, [
      [...ids],
      userId,
    ]);
    const known: KnownTask[] = found.map((k) => ({
      id: k.id,
      userId: k.user_id,
      parentId: k.parent_id,
      deleted: k.deleted,
    }));

    const { write, rejected } = planTaskWrites(rows, userId, known);
    if (write.length > 0) {
      await manager.query(UPSERT, [JSON.stringify(write), userId]);
    }
    return rejected;
  }
}
