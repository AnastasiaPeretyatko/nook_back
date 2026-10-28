import { LogRow } from './push-rows';
import { Rejection } from './rejection';

// A task as far as marks care: whose it is and whether it is deleted.
export interface MarkableTask {
  id: string;
  userId: string;
  deleted: boolean;
}

// Decides which marks of a push may be written; no database access. `tasks` holds the tasks the
// marks name, as the database has them (after this push's tasks were written).
export function planLogWrites(
  rows: LogRow[],
  userId: string,
  tasks: MarkableTask[],
): { write: LogRow[]; rejected: Rejection[] } {
  const byId = new Map(tasks.map((t) => [t.id, t]));

  // The same mark twice in one batch: the later row wins. (An insert can't touch a row twice.)
  const latest = new Map(rows.map((r) => [`${r.taskId}|${r.date}`, r]));

  const write: LogRow[] = [];
  const rejected: Rejection[] = [];
  for (const row of latest.values()) {
    const task = byId.get(row.taskId);
    // Someone else's task is reported like a missing one: the caller learns nothing about it.
    if (!task || task.userId !== userId) {
      // A mark has no id of its own, so it is reported by its task.
      rejected.push({
        table: 'task_logs',
        id: row.taskId,
        reason: 'unknown_task',
      });
    }
    // Not an error: the device drops these marks itself once it learns the task is gone.
    else if (!task.deleted) write.push(row);
  }
  return { write, rejected };
}
