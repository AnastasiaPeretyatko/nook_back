import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { MarkableTask, planLogWrites } from './plan-log-writes';
import { LogRow } from './push-rows';
import { Rejection } from './rejection';

const FIND_TASKS = `
  select id, user_id, deleted_at is not null as deleted
  from tasks where id = any($1::uuid[])
`;

// One statement for the whole batch, rows as one JSON value (see TaskWriter). The join is the
// access rule written into the SQL itself: a mark lands only on a live task of the caller, even
// if the check before it was fooled. On conflict only the content changes; the key is the row.
const UPSERT = `
  insert into task_logs (
    task_id, user_id, date, completed, value, completed_at, client_updated_at
  )
  select
    r."taskId", $2::uuid, r.date, r.completed, r.value, r."completedAt", r."clientUpdatedAt"
  from jsonb_to_recordset($1::jsonb) as r(
    "taskId" uuid, date date, completed boolean, value double precision,
    "completedAt" timestamptz, "clientUpdatedAt" timestamptz
  )
  join tasks t on t.id = r."taskId" and t.user_id = $2::uuid and t.deleted_at is null
  on conflict (task_id, user_id, date) do update set
    completed = excluded.completed, value = excluded.value,
    completed_at = excluded.completed_at, client_updated_at = excluded.client_updated_at
`;

interface TaskRowFound {
  id: string;
  user_id: string;
  deleted: boolean;
}

@Injectable()
export class LogWriter {
  // Runs inside the push transaction, after the tasks of the same push were written, so a mark
  // may name a task created in the same request. Two queries however many marks there are.
  async write(
    manager: EntityManager,
    userId: string,
    rows: LogRow[],
  ): Promise<Rejection[]> {
    if (rows.length === 0) return [];

    const found: TaskRowFound[] = await manager.query(FIND_TASKS, [
      [...new Set(rows.map((r) => r.taskId))],
    ]);
    const tasks: MarkableTask[] = found.map((t) => ({
      id: t.id,
      userId: t.user_id,
      deleted: t.deleted,
    }));

    const { write, rejected } = planLogWrites(rows, userId, tasks);
    if (write.length > 0) {
      await manager.query(UPSERT, [JSON.stringify(write), userId]);
    }
    return rejected;
  }
}
