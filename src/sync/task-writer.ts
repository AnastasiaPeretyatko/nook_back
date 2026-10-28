import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { GroupAccess, KnownTask, planTaskWrites } from './plan-task-writes';
import { TaskRow } from './push-rows';
import { Rejection } from './rejection';

// The batch ids and their parents, plus the ancestors of those parents (up to the root), so
// the cycle check sees the tree as stored. The climb only follows the caller's own tasks.
const FIND_KNOWN = `
  with recursive up as (
    select id, user_id, parent_id, group_id, deleted_at is not null as deleted
    from tasks where id = any($1::uuid[])
    union
    select t.id, t.user_id, t.parent_id, t.group_id, t.deleted_at is not null
    from tasks t join up on t.id = up.parent_id
    where up.user_id = $2 and t.user_id = $2
  )
  select id, user_id, parent_id, group_id, deleted from up
`;

// What the caller is to each of these groups, for the groups that exist and are not deleted.
const FIND_GROUPS = `
  select g.id, m.user_id is not null as member, g.owner_id = $2 as owner
  from groups g
  left join group_members m
    on m.group_id = g.id and m.user_id = $2 and m.deleted_at is null
  where g.id = any($1::uuid[]) and g.deleted_at is null
`;

// One statement for the whole batch: the rows travel as one JSON value, which keeps the number
// of parameters fixed and the round trips few (the database can be an ocean away).
// On conflict: `created_at`, `user_id`, `group_id` and `deleted_at` are never changed; the last
// write wins for the rest, as the app decides whose edit is newer itself. The two `where`s are
// the access rule written into the SQL itself, in case the check before it was fooled or the
// row changed hands in between: a new group task needs the caller in the group, and a stored one
// is changed by its author or by the owner of the group, and only by someone in the group now.
const UPSERT = `
  insert into tasks (
    id, user_id, parent_id, title, description, status, repeat_type, repeat_interval,
    repeat_days_mask, tracking_mode, target_duration_minutes, target_value, icon_key,
    color_key, scheduled_time_minutes, end_time_minutes, start_date, created_at,
    client_updated_at, group_id, assignee_id
  )
  select
    r.id, $2::uuid, r."parentId", r.title, r.description, r.status, r."repeatType",
    r."repeatInterval", r."repeatDaysMask", r."trackingMode", r."targetDurationMinutes",
    r."targetValue", r."iconKey", r."colorKey", r."scheduledTimeMinutes", r."endTimeMinutes",
    r."startDate", r."createdAt", r."clientUpdatedAt", r."groupId", r."assigneeId"
  from jsonb_to_recordset($1::jsonb) as r(
    id uuid, "parentId" uuid, title text, description text, status text, "repeatType" text,
    "repeatInterval" integer, "repeatDaysMask" integer, "trackingMode" text,
    "targetDurationMinutes" integer, "targetValue" double precision, "iconKey" text,
    "colorKey" text, "scheduledTimeMinutes" integer, "endTimeMinutes" integer,
    "startDate" date, "createdAt" timestamptz, "clientUpdatedAt" timestamptz,
    "groupId" uuid, "assigneeId" uuid
  )
  where r."groupId" is null or is_group_member(r."groupId", $2::uuid)
  on conflict (id) do update set
    parent_id = excluded.parent_id, title = excluded.title,
    description = excluded.description, status = excluded.status,
    repeat_type = excluded.repeat_type, repeat_interval = excluded.repeat_interval,
    repeat_days_mask = excluded.repeat_days_mask, tracking_mode = excluded.tracking_mode,
    target_duration_minutes = excluded.target_duration_minutes,
    target_value = excluded.target_value, icon_key = excluded.icon_key,
    color_key = excluded.color_key, scheduled_time_minutes = excluded.scheduled_time_minutes,
    end_time_minutes = excluded.end_time_minutes, start_date = excluded.start_date,
    client_updated_at = excluded.client_updated_at, assignee_id = excluded.assignee_id
  where (tasks.group_id is null and tasks.user_id = $2::uuid)
    or (tasks.group_id is not null
        and is_group_member(tasks.group_id, $2::uuid)
        and (tasks.user_id = $2::uuid
             or exists (select 1 from groups g
                        where g.id = tasks.group_id and g.owner_id = $2::uuid
                          and g.deleted_at is null)))
`;

interface KnownTaskRow {
  id: string;
  user_id: string;
  parent_id: string | null;
  group_id: string | null;
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
      groupId: k.group_id,
      deleted: k.deleted,
    }));

    // The groups the rows name and the stored tasks belong to: what the caller is to each.
    const groupIds = new Set<string>();
    for (const row of rows) if (row.groupId) groupIds.add(row.groupId);
    for (const k of known) if (k.groupId) groupIds.add(k.groupId);
    const groups: GroupAccess[] =
      groupIds.size > 0
        ? await manager.query(FIND_GROUPS, [[...groupIds], userId])
        : [];

    const { write, rejected } = planTaskWrites(rows, userId, known, groups);
    if (write.length > 0) {
      await manager.query(UPSERT, [JSON.stringify(write), userId]);
    }
    return rejected;
  }
}
