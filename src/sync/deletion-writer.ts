import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { DeletedRow } from './push-rows';
import { Rejection } from './rejection';

// The tables whose rows can be deleted. Only these names are ever put into the SQL (they come
// from this list, never from the request). A tombstone of a tag or a mood needs no name: the
// `blank_deleted_*` triggers fill the empty ones in before the not-null check.
const TABLES = ['tasks', 'diary_entries', 'note_tags', 'note_moods'];

// One statement for every table that has ids to delete. For each, the insert covers both cases:
// an id the server has not seen becomes a tombstone (so a row that arrives later from another
// device cannot come back), and the caller's own live row is marked deleted. The triggers then
// empty the row and erase its marks / links. A row that is already deleted is left alone, so a
// repeated deletion changes nothing, `updated_at` included. The `where` keeps someone else's row
// untouched; the final selects see the tables as they were before the inserts and return the
// foreign ids so they can be refused. `is distinct from`, not `<>`: a starter mood has no owner,
// and "null <> x" is not true, so it would not be recognised as not the caller's.
function deleteSql(tables: string[]): string {
  const marked = tables.map(
    (table, i) => `m${i} as (
      insert into ${table} (id, user_id, deleted_at)
      select id, $1::uuid, now() from unnest($${i + 2}::uuid[]) as id
      on conflict (id) do update set deleted_at = excluded.deleted_at
      where ${table}.user_id = excluded.user_id and ${table}.deleted_at is null
    )`,
  );
  const foreign = tables.map(
    (table, i) => `select '${table}' as tbl, id from ${table}
      where id = any($${i + 2}::uuid[]) and user_id is distinct from $1::uuid`,
  );
  return `with ${marked.join(',\n')}\n${foreign.join('\nunion all\n')}`;
}

@Injectable()
export class DeletionWriter {
  // Runs inside the push transaction, after everything that is written. Tasks and the diary
  // (notes, tags, moods) can be deleted; the cycle comes with B4.
  async write(
    manager: EntityManager,
    userId: string,
    rows: DeletedRow[],
  ): Promise<Rejection[]> {
    const rejected: Rejection[] = [];
    const ids = new Map<string, Set<string>>();
    for (const row of rows) {
      if (TABLES.includes(row.table)) {
        ids.set(row.table, (ids.get(row.table) ?? new Set()).add(row.id));
      } else {
        rejected.push({
          table: row.table,
          id: row.id,
          reason: 'unsupported_table',
        });
      }
    }

    const tables = [...ids.keys()];
    if (tables.length > 0) {
      const foreign: { tbl: string; id: string }[] = await manager.query(
        deleteSql(tables),
        [userId, ...tables.map((t) => [...ids.get(t)!])],
      );
      for (const { tbl, id } of foreign) {
        rejected.push({ table: tbl, id, reason: 'id_taken' });
      }
    }
    return rejected;
  }
}
