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
//
// Tasks are the one table with more than an owner: a task of a group is deleted by its author or
// by the owner of the group, and only by someone in the group now. Anyone else in the group is
// told `not_allowed`; someone outside it, like the owner of another person's personal task, is
// told `id_taken` (the id is none of their business).
// Columns are written with the table name: in the upsert's `where` a bare column is ambiguous
// (the row being inserted is `excluded`).
const TASK_MAY_DELETE = `(
  (tasks.group_id is null and tasks.user_id = $1::uuid)
  or (tasks.group_id is not null
      and is_group_member(tasks.group_id, $1::uuid)
      and (tasks.user_id = $1::uuid
           or exists (select 1 from groups g
                      where g.id = tasks.group_id and g.owner_id = $1::uuid
                        and g.deleted_at is null)))
)`;

function deleteSql(tables: string[]): string {
  const marked = tables.map(
    (table, i) => `m${i} as (
      insert into ${table} (id, user_id, deleted_at)
      select id, $1::uuid, now() from unnest($${i + 2}::uuid[]) as id
      on conflict (id) do update set deleted_at = excluded.deleted_at
      where ${
        table === 'tasks'
          ? TASK_MAY_DELETE
          : `${table}.user_id = excluded.user_id`
      } and ${table}.deleted_at is null
    )`,
  );
  const foreign = tables.map((table, i) =>
    table === 'tasks'
      ? `select 'tasks' as tbl, id,
          case when group_id is not null and is_group_member(group_id, $1::uuid)
               then 'not_allowed' else 'id_taken' end as reason
        from tasks
        where id = any($${i + 2}::uuid[]) and not ${TASK_MAY_DELETE}`
      : `select '${table}' as tbl, id, 'id_taken' as reason from ${table}
        where id = any($${i + 2}::uuid[]) and user_id is distinct from $1::uuid`,
  );
  return `with ${marked.join(',\n')}\n${foreign.join('\nunion all\n')}`;
}

@Injectable()
export class DeletionWriter {
  // Runs inside the push transaction, after everything that is written. Tasks (personal and of a
  // group) and the diary (notes, tags, moods) can be deleted; days of the cycle cannot.
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
      const foreign: {
        tbl: string;
        id: string;
        reason: 'id_taken' | 'not_allowed';
      }[] = await manager.query(deleteSql(tables), [
        userId,
        ...tables.map((t) => [...ids.get(t)!]),
      ]);
      for (const { tbl, id, reason } of foreign) {
        rejected.push({ table: tbl, id, reason });
      }
    }
    return rejected;
  }
}
