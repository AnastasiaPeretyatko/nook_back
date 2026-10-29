import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { MarkableTask, planLogWrites } from './plan-log-writes';
import { LogRow } from './push-rows';
import { PushEvent } from '../push/plan-push';
import { Rejection } from './rejection';

const FIND_TASKS = `
  select id, user_id, group_id, assignee_id, deleted_at is not null as deleted,
         group_id is not null and is_group_member(group_id, $2::uuid) as member
  from tasks where id = any($1::uuid[])
`;

// One statement for the whole batch, rows as one JSON value (see TaskWriter). The join is the
// access rule written into the SQL itself: a mark lands only on a live task the caller may mark
// (`can_mark_task`: their own personal task, or a task of a group they are in, and for them or
// for everyone), even if the check before it was fooled. On conflict only the content changes;
// the key is the row.
//
// What comes back is for push notifications: the group tasks on which a mark has just BECOME
// completed (a new mark that is completed, or one that was not before; a re-sent one that already
// was is not), as the task is stored now. `before` sees the marks as they were when the statement
// began.
const UPSERT = `
  with src as (
    select r."taskId", r.date, r.completed, r.value, r."completedAt", r."clientUpdatedAt"
    from jsonb_to_recordset($1::jsonb) as r(
      "taskId" uuid, date date, completed boolean, value double precision,
      "completedAt" timestamptz, "clientUpdatedAt" timestamptz
    )
    join tasks t on t.id = r."taskId" and t.deleted_at is null
      and can_mark_task(t.id, $2::uuid)
  ),
  before as (
    select l.task_id, l.date, l.completed from task_logs l
    where l.user_id = $2::uuid and l.task_id in (select "taskId" from src)
  ),
  written as (
    insert into task_logs (
      task_id, user_id, date, completed, value, completed_at, client_updated_at
    )
    select "taskId", $2::uuid, date, completed, value, "completedAt", "clientUpdatedAt"
    from src
    on conflict (task_id, user_id, date) do update set
      completed = excluded.completed, value = excluded.value,
      completed_at = excluded.completed_at, client_updated_at = excluded.client_updated_at
    returning task_id, date, completed
  )
  select distinct tk.id, tk.user_id, tk.group_id, tk.title, tk.assignee_id, tk.parent_id,
         tk.status, tk.created_at, tk.deleted_at is not null as deleted
  from written w
  left join before b on b.task_id = w.task_id and b.date = w.date
  join tasks tk on tk.id = w.task_id
  where w.completed and b.completed is not true and tk.group_id is not null
`;

interface DoneTask {
  id: string;
  user_id: string;
  group_id: string;
  title: string;
  assignee_id: string | null;
  parent_id: string | null;
  status: string;
  created_at: Date;
  deleted: boolean;
}

interface TaskRowFound {
  id: string;
  user_id: string;
  group_id: string | null;
  assignee_id: string | null;
  deleted: boolean;
  member: boolean;
}

@Injectable()
export class LogWriter {
  // Runs inside the push transaction, after the tasks of the same push were written, so a mark
  // may name a task created in the same request. Two queries however many marks there are.
  // `events`, when given, collects one "done" for each group task a mark has just completed.
  async write(
    manager: EntityManager,
    userId: string,
    rows: LogRow[],
    events?: PushEvent[],
  ): Promise<Rejection[]> {
    if (rows.length === 0) return [];

    const found: TaskRowFound[] = await manager.query(FIND_TASKS, [
      [...new Set(rows.map((r) => r.taskId))],
      userId,
    ]);
    const tasks: MarkableTask[] = found.map((t) => ({
      id: t.id,
      userId: t.user_id,
      groupId: t.group_id,
      assigneeId: t.assignee_id,
      deleted: t.deleted,
      member: t.member,
    }));

    const { write, rejected } = planLogWrites(rows, userId, tasks);
    if (write.length > 0) {
      const done: DoneTask[] = await manager.query(UPSERT, [
        JSON.stringify(write),
        userId,
      ]);
      // `distinct` makes it one event per task, however many days were ticked in this batch.
      for (const t of done) {
        events?.push({
          kind: 'done',
          doneBy: userId,
          task: {
            id: t.id,
            groupId: t.group_id,
            title: t.title,
            authorId: t.user_id,
            assigneeId: t.assignee_id,
            parentId: t.parent_id,
            status: t.status,
            deleted: t.deleted,
            createdAt: t.created_at.getTime(),
          },
        });
      }
    }
    return rejected;
  }
}
