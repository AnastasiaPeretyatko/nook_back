import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DEFAULT_PULL_LIMIT, SyncPullQuery } from './dto/sync-pull.query';

export interface PullResult {
  // The time to ask from next. Null only when the user has no rows at all and gave no `since`.
  next: string | null;
  has_more: boolean;
  tasks: Record<string, unknown>[];
  logs: Record<string, unknown>[];
}

// Moments leave as text with all six digits of microseconds (a JS Date would cut them to
// milliseconds, and the app asks for "newer than this" with exactly the text it was given).
const iso = (column: string) =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
// A day leaves as plain 'YYYY-MM-DD' (the pg driver would turn a `date` into a JS Date).
const day = (column: string) => `to_char(${column}, 'YYYY-MM-DD')`;

// The keys of `taskToRow` plus user_id, updated_at, deleted_at. group_id and assignee_id are in
// the shape already and stay null until groups (B5).
const TASK_COLUMNS = `
  id, user_id, parent_id, title, description, status, repeat_type, repeat_interval,
  repeat_days_mask, tracking_mode, target_duration_minutes, target_value, icon_key, color_key,
  scheduled_time_minutes, end_time_minutes, ${day('start_date')} as start_date,
  ${iso('created_at')} as created_at, ${iso('client_updated_at')} as client_updated_at,
  ${iso('updated_at')} as updated_at, ${iso('deleted_at')} as deleted_at,
  null::uuid as group_id, null::uuid as assignee_id`;

const LOG_COLUMNS = `
  task_id, user_id, ${day('date')} as date, completed, value,
  ${iso('completed_at')} as completed_at, ${iso('client_updated_at')} as client_updated_at,
  ${iso('updated_at')} as updated_at`;

// The caller's rows newer than $2, oldest first, at least $3 of them unless there are fewer.
// `cut` is the time of the $3-th row; everything up to and including that time is returned, so
// rows that share it are never split between two pages (the next page asks for "strictly
// newer" and would lose the rest). `more` says whether anything lies beyond. `not materialized`
// lets every use of `page` follow the (user_id, updated_at) index instead of reading it all first.
const pageQuery = (table: string, columns: string) => `
  with page as not materialized (
    select * from ${table}
    where user_id = $1 and ($2::timestamptz is null or updated_at > $2::timestamptz)
  ), cut as (
    select updated_at from page order by updated_at offset ($3::int - 1) limit 1
  )
  select ${columns},
    exists(select 1 from page p where p.updated_at > (select updated_at from cut)) as more
  from page
  where page.updated_at <= coalesce((select updated_at from cut), 'infinity'::timestamptz)
  order by page.updated_at
`;

interface Page {
  rows: Record<string, unknown>[];
  truncated: boolean;
  last: string | null;
}

@Injectable()
export class SyncPullService {
  constructor(private readonly dataSource: DataSource) {}

  async pull(userId: string, query: SyncPullQuery): Promise<PullResult> {
    const since = query.since ?? null;
    const limit = query.limit ?? DEFAULT_PULL_LIMIT;

    // `include` is not read: tasks always come, and diary and cycle do not exist yet.
    // Two reads at once, to halve the wait on a far-away database.
    const [tasks, logs] = await Promise.all([
      this.page('tasks', TASK_COLUMNS, userId, since, limit),
      this.page('task_logs', LOG_COLUMNS, userId, since, limit),
    ]);

    const pages = [tasks, logs];
    const truncated = pages.filter((p) => p.truncated);
    // Cut short: continue from the earliest of the cut tables' last times, so none of them
    // skips a row (a table already ahead of it just repeats a few rows, which is harmless).
    // Otherwise everything is here: continue from the newest time seen.
    const stamps = (truncated.length > 0 ? truncated : pages)
      .map((p) => p.last)
      .filter((t): t is string => t !== null);
    // Times have a fixed width, so text order is time order.
    const next =
      stamps.length === 0
        ? since
        : truncated.length > 0
          ? stamps.reduce((a, b) => (a < b ? a : b))
          : stamps.reduce((a, b) => (a > b ? a : b));

    return {
      next,
      has_more: truncated.length > 0,
      tasks: tasks.rows,
      logs: logs.rows,
    };
  }

  private async page(
    table: string,
    columns: string,
    userId: string,
    since: string | null,
    limit: number,
  ): Promise<Page> {
    const found: (Record<string, unknown> & { more: boolean })[] =
      await this.dataSource.query(pageQuery(table, columns), [
        userId,
        since,
        limit,
      ]);
    // `more` is the same on every row; it is not part of the answer.
    const truncated = found[0]?.more ?? false;
    for (const row of found) delete (row as { more?: boolean }).more;
    const rows: Record<string, unknown>[] = found;
    return {
      rows,
      truncated,
      last: (rows.at(-1)?.updated_at as string | undefined) ?? null,
    };
  }
}
