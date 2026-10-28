import { TaskRow } from './push-rows';
import { Rejection, RejectReason } from './rejection';

// A task as the database already has it.
export interface KnownTask {
  id: string;
  userId: string;
  parentId: string | null;
  groupId: string | null;
  deleted: boolean;
}

// What the caller is to a group that exists and is not deleted. A group missing from the list
// (unknown, deleted, or an id made up) is the same as one the caller is not in.
export interface GroupAccess {
  id: string;
  member: boolean;
  owner: boolean;
}

// Decides which rows of a push may be written; no database access, so every rule can be tested
// on its own. `known` holds the tasks already stored under the ids in the batch, their parents,
// and the parents' ancestors (the writer fetches them in one query); `groups` the groups the rows
// and those tasks belong to.
//
// A group task is written by its author or by the owner of the group, and only by someone who is
// in the group now. Its group and its author are fixed at creation: for a task that exists the
// stored group counts and a different `group_id` in the row is ignored, so a rewritten row
// carries the stored one.
export function planTaskWrites(
  rows: TaskRow[],
  userId: string,
  known: KnownTask[],
  groups: GroupAccess[] = [],
): { write: TaskRow[]; rejected: Rejection[] } {
  const rejected: Rejection[] = [];
  const reject = (id: string, reason: RejectReason) =>
    rejected.push({ table: 'tasks', id, reason });

  const stored = new Map(known.map((k) => [k.id, k]));
  const access = new Map(groups.map((g) => [g.id, g]));
  // Another user's task is as good as absent: it can't be a parent, and its id is taken. A group
  // task cannot be a parent either (a group task has no subtasks, and a personal one does not
  // hang under it).
  const mine = new Map(
    known
      .filter((k) => k.userId === userId && !k.groupId)
      .map((k) => [k.id, k]),
  );

  // The same id twice in one batch: the later row wins. (An insert can't touch a row twice.)
  const live = new Map<string, TaskRow>();
  for (const row of new Map(rows.map((r) => [r.id, r])).values()) {
    const old = stored.get(row.id);
    if (!old) {
      // New. A group task needs the caller to be in the group; a group that is not there looks
      // the same as one they are not in.
      if (row.groupId && !access.get(row.groupId)?.member)
        reject(row.id, 'unknown_group');
      else live.set(row.id, row);
    } else if (old.groupId) {
      const group = access.get(old.groupId);
      if (!group?.member) reject(row.id, 'id_taken');
      else if (old.userId !== userId && !group.owner)
        reject(row.id, 'not_allowed');
      // Deletion always wins, as for any task: nothing to write.
      else if (old.deleted) continue;
      // The row must still make a task the database accepts in a group, whatever it says of its group.
      else if (
        row.repeatType !== null ||
        row.parentId !== null ||
        row.trackingMode === 'value'
      )
        reject(row.id, 'invalid_row');
      else live.set(row.id, { ...row, groupId: old.groupId });
    } else if (old.userId !== userId) {
      reject(row.id, 'id_taken');
    }
    // Deletion always wins: a device that missed it must not bring the task back, and there
    // is nothing to write, since the row stays empty.
    else if (!old.deleted) {
      // A personal task stays personal.
      live.set(row.id, { ...row, groupId: null, assigneeId: null });
    }
  }

  // The parent as it will be once the batch is written. A group task is not one.
  const exists = (id: string) =>
    (live.has(id) && !live.get(id)!.groupId) || mine.has(id);
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
