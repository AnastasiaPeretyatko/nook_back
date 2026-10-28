import { TaskRow } from './push-rows';
import { Rejection, RejectReason } from './rejection';

// A task as the database already has it.
export interface KnownTask {
  id: string;
  userId: string;
  parentId: string | null;
  deleted: boolean;
}

// Decides which rows of a push may be written; no database access, so every rule can be tested
// on its own. `known` holds the tasks already stored under the ids in the batch, their parents,
// and the parents' ancestors (the writer fetches them in one query).
export function planTaskWrites(
  rows: TaskRow[],
  userId: string,
  known: KnownTask[],
): { write: TaskRow[]; rejected: Rejection[] } {
  const rejected: Rejection[] = [];
  const reject = (id: string, reason: RejectReason) =>
    rejected.push({ table: 'tasks', id, reason });

  const stored = new Map(known.map((k) => [k.id, k]));
  // Another user's task is as good as absent: it can't be a parent, and its id is taken.
  const mine = new Map(
    known.filter((k) => k.userId === userId).map((k) => [k.id, k]),
  );

  // The same id twice in one batch: the later row wins. (An insert can't touch a row twice.)
  const live = new Map<string, TaskRow>();
  for (const row of new Map(rows.map((r) => [r.id, r])).values()) {
    if (row.groupId) reject(row.id, 'groups_not_supported');
    else if (stored.has(row.id) && !mine.has(row.id))
      reject(row.id, 'id_taken');
    // Deletion always wins: a device that missed it must not bring the task back, and there
    // is nothing to write, since the row stays empty.
    else if (!mine.get(row.id)?.deleted) live.set(row.id, row);
  }

  // The parent as it will be once the batch is written.
  const exists = (id: string) => live.has(id) || mine.has(id);
  const parentOf = (id: string) =>
    live.has(id) ? live.get(id)!.parentId : (mine.get(id)?.parentId ?? null);

  const inCycle = (row: TaskRow) => {
    const seen = new Set<string>();
    for (let cur = row.parentId; cur && !seen.has(cur); cur = parentOf(cur)) {
      if (cur === row.id) return true;
      seen.add(cur);
    }
    return false;
  };

  // Rows are judged all against the same state, then removed together, and the rest is judged
  // again: refusing a parent also refuses its children, and the cycle members get
  // `parent_cycle` rather than `unknown_parent` for whichever of them goes first.
  for (;;) {
    const bad: [TaskRow, RejectReason][] = [];
    for (const row of live.values()) {
      if (!row.parentId) continue;
      if (!exists(row.parentId)) bad.push([row, 'unknown_parent']);
      else if (inCycle(row)) bad.push([row, 'parent_cycle']);
    }
    if (bad.length === 0) break;
    for (const [row, reason] of bad) {
      live.delete(row.id);
      reject(row.id, reason);
    }
  }

  return { write: [...live.values()], rejected };
}
