import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { DeletedRow } from './push-rows';
import { Rejection } from './rejection';

// One statement. The insert covers both cases: an id the server has not seen becomes a tombstone
// (so a task that arrives later from another device cannot come back), and the caller's own live
// task is marked deleted. `blank_deleted_task` then empties the row and erases its marks. A task
// that is already deleted is left alone, so a repeated deletion changes nothing, `updated_at`
// included. The `where` keeps someone else's task untouched; the final select sees the table as
// it was before the insert and returns those foreign ids so they can be refused.
const DELETE_TASKS = `
  with marked as (
    insert into tasks (id, user_id, deleted_at)
    select id, $2::uuid, now() from unnest($1::uuid[]) as id
    on conflict (id) do update set deleted_at = excluded.deleted_at
    where tasks.user_id = excluded.user_id and tasks.deleted_at is null
  )
  select id from tasks where id = any($1::uuid[]) and user_id <> $2::uuid
`;

@Injectable()
export class DeletionWriter {
  // Runs inside the push transaction, after tasks and marks were written. Only tasks can be
  // deleted so far; the other tables come with the diary (B3) and the cycle (B4).
  async write(
    manager: EntityManager,
    userId: string,
    rows: DeletedRow[],
  ): Promise<Rejection[]> {
    const rejected: Rejection[] = [];
    const taskIds = new Set<string>();
    for (const row of rows) {
      if (row.table === 'tasks') taskIds.add(row.id);
      else
        rejected.push({
          table: row.table,
          id: row.id,
          reason: 'unsupported_table',
        });
    }

    if (taskIds.size > 0) {
      const foreign: { id: string }[] = await manager.query(DELETE_TASKS, [
        [...taskIds],
        userId,
      ]);
      for (const { id } of foreign) {
        rejected.push({ table: 'tasks', id, reason: 'id_taken' });
      }
    }
    return rejected;
  }
}
