import { Rejection } from './rejection';

// A mood or a tag as the database already has it. `userId` is null for the starter moods.
export interface KnownLabel {
  id: string;
  userId: string | null;
  deleted: boolean;
}

// Decides which moods (or tags) of a push may be written; no database access. `known` holds
// what the database already has under the ids of the batch. `table` names the rows in `rejected`.
export function planLabelWrites<T extends { id: string }>(
  table: string,
  rows: T[],
  userId: string,
  known: KnownLabel[],
): { write: T[]; rejected: Rejection[] } {
  const stored = new Map(known.map((k) => [k.id, k]));
  const write: T[] = [];
  const rejected: Rejection[] = [];

  // The same id twice in one batch: the later row wins. (An insert can't touch a row twice.)
  for (const row of new Map(rows.map((r) => [r.id, r])).values()) {
    const existing = stored.get(row.id);
    // Someone else's id, or a starter mood (it belongs to nobody, so to nobody's push).
    if (existing && existing.userId !== userId) {
      rejected.push({ table, id: row.id, reason: 'id_taken' });
    }
    // Deletion always wins: a device that missed it must not bring the label back.
    else if (!existing?.deleted) write.push(row);
  }
  return { write, rejected };
}
