import { KnownLabel } from './plan-label-writes';
import { EntryRow } from './push-rows';
import { Rejection } from './rejection';

export interface EntryLink {
  entryId: string;
  // The mood's or the tag's id.
  labelId: string;
}

export interface EntryWritePlan {
  write: EntryRow[];
  // The notes whose mood (tag) links are replaced by the list that came; others keep theirs.
  replaceMoodsOf: string[];
  replaceTagsOf: string[];
  moodLinks: EntryLink[];
  tagLinks: EntryLink[];
  rejected: Rejection[];
}

// Decides which notes of a push may be written and which of their links stay; no database
// access. `notes` holds what the database has under the notes' ids; `moods` and `tags` what it
// has under the ids the notes name.
export function planEntryWrites(
  rows: EntryRow[],
  userId: string,
  known: { notes: KnownLabel[]; moods: KnownLabel[]; tags: KnownLabel[] },
): EntryWritePlan {
  const notes = new Map(known.notes.map((k) => [k.id, k]));
  const moods = new Map(known.moods.map((k) => [k.id, k]));
  const tags = new Map(known.tags.map((k) => [k.id, k]));
  const plan: EntryWritePlan = {
    write: [],
    replaceMoodsOf: [],
    replaceTagsOf: [],
    moodLinks: [],
    tagLinks: [],
    rejected: [],
  };

  // A mood may be a starter one (it belongs to nobody) or the caller's own; a tag only the
  // caller's. A deleted one is as good as unknown: nothing is left of it to point at.
  const moodOk = (id: string) => {
    const m = moods.get(id);
    return !!m && !m.deleted && (m.userId === null || m.userId === userId);
  };
  const tagOk = (id: string) => {
    const t = tags.get(id);
    return !!t && !t.deleted && t.userId === userId;
  };

  // The same id twice in one batch: the later row wins. (An insert can't touch a row twice.)
  for (const row of new Map(rows.map((r) => [r.id, r])).values()) {
    const existing = notes.get(row.id);
    if (existing && existing.userId !== userId) {
      plan.rejected.push({
        table: 'diary_entries',
        id: row.id,
        reason: 'id_taken',
      });
      continue;
    }
    // Deletion always wins: the note stays empty and gets no links.
    if (existing?.deleted) continue;

    plan.write.push(row);
    let droppedAny = false;
    if (row.moodIds) {
      plan.replaceMoodsOf.push(row.id);
      for (const labelId of row.moodIds) {
        if (moodOk(labelId)) plan.moodLinks.push({ entryId: row.id, labelId });
        else droppedAny = true;
      }
    }
    if (row.tagIds) {
      plan.replaceTagsOf.push(row.id);
      for (const labelId of row.tagIds) {
        if (tagOk(labelId)) plan.tagLinks.push({ entryId: row.id, labelId });
        else droppedAny = true;
      }
    }
    // The note is saved without the link it could not keep; the app is told once per note.
    if (droppedAny) {
      plan.rejected.push({
        table: 'diary_entries',
        id: row.id,
        reason: 'unknown_label',
      });
    }
  }
  return plan;
}
