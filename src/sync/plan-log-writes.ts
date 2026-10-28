import { LogRow } from './push-rows';
import { Rejection } from './rejection';

// A task as far as marks care: whose it is, which group it is in, who it is for, whether it is
// deleted, and whether the caller is in its group now (false for a personal task).
export interface MarkableTask {
  id: string;
  userId: string;
  groupId: string | null;
  assigneeId: string | null;
  deleted: boolean;
  member: boolean;
}

// Decides which marks of a push may be written; no database access. `tasks` holds the tasks the
// marks name, as the database has them (after this push's tasks were written).
//
// A mark is the caller's own: on a personal task only its owner may make one; on a task of a
// group a member who is in the group now, and, when the task is for someone, only that someone.
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
  const reject = (taskId: string, reason: 'unknown_task' | 'not_allowed') =>
    // A mark has no id of its own, so it is reported by its task.
    rejected.push({ table: 'task_logs', id: taskId, reason });

  for (const row of latest.values()) {
    const task = byId.get(row.taskId);
    // A task that is not there, someone else's personal task, and a group task of a group the
    // caller is not in are all reported alike: the caller learns nothing about them.
    if (!task || (task.groupId ? !task.member : task.userId !== userId)) {
      reject(row.taskId, 'unknown_task');
    }
    // Not an error: the device drops these marks itself once it learns the task is gone.
    else if (task.deleted) continue;
    // A member, but the task was handed to someone else.
    else if (task.assigneeId && task.assigneeId !== userId) {
      reject(row.taskId, 'not_allowed');
    } else write.push(row);
  }
  return { write, rejected };
}
