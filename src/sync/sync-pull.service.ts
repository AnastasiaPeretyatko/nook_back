import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DEFAULT_PULL_LIMIT, SyncPullQuery } from './dto/sync-pull.query';

type Rows = Record<string, unknown>[];

// The groups the caller is in now, whole, every time (see GROUPS_SQL).
export interface GroupsSnapshot {
  groups: { id: string; name: string; owner_id: string }[];
  members: {
    group_id: string;
    user_id: string;
    display_name: string | null;
    avatar_url: string | null;
  }[];
}

export interface PullResult {
  // The time to ask from next. Null only when there are no rows at all and no `since` was given.
  next: string | null;
  has_more: boolean;
  tasks: Rows;
  logs: Rows;
  // Always. Not paged and not part of `next` / `has_more`.
  groups: GroupsSnapshot;
  // Only with `include=diary`.
  moods?: Rows;
  tags?: Rows;
  entries?: Rows;
  // Only with `include=cycle`.
  cycle_days?: Rows;
}

// Moments leave as text with all six digits of microseconds (a JS Date would cut them to
// milliseconds, and the app asks for "newer than this" with exactly the text it was given).
const iso = (column: string) =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
// A day leaves as plain 'YYYY-MM-DD' (the pg driver would turn a `date` into a JS Date).
const day = (column: string) => `to_char(${column}, 'YYYY-MM-DD')`;

// The keys of `taskToRow` plus user_id, updated_at, deleted_at. In a group task `user_id` is the
// author; `group_id` and `assignee_id` are null for a personal task.
const TASK_COLUMNS = `
  id, user_id, parent_id, title, description, status, repeat_type, repeat_interval,
  repeat_days_mask, tracking_mode, target_duration_minutes, target_value, icon_key, color_key,
  scheduled_time_minutes, end_time_minutes, ${day('start_date')} as start_date,
  ${iso('created_at')} as created_at, ${iso('client_updated_at')} as client_updated_at,
  ${iso('updated_at')} as updated_at, ${iso('deleted_at')} as deleted_at,
  group_id, assignee_id`;

const LOG_COLUMNS = `
  task_id, user_id, ${day('date')} as date, completed, value,
  ${iso('completed_at')} as completed_at, ${iso('client_updated_at')} as client_updated_at,
  ${iso('updated_at')} as updated_at`;

// The diary, in the shape of the plan (4.2): no user_id. A note carries its moods and tags
// inside (sorted, so that the same set always reads the same way): the app used to ask twice
// for every note.
const MOOD_COLUMNS = `
  id, name, emoji, ${iso('created_at')} as created_at,
  ${iso('client_updated_at')} as client_updated_at, ${iso('updated_at')} as updated_at,
  ${iso('deleted_at')} as deleted_at`;

const TAG_COLUMNS = `
  id, name, color_key, ${iso('created_at')} as created_at,
  ${iso('client_updated_at')} as client_updated_at, ${iso('updated_at')} as updated_at,
  ${iso('deleted_at')} as deleted_at`;

const ENTRY_COLUMNS = `
  id, title, body, cover_image, images, is_favorite, status,
  ${iso('created_at')} as created_at, ${iso('client_updated_at')} as client_updated_at,
  ${iso('updated_at')} as updated_at, ${iso('deleted_at')} as deleted_at,
  coalesce((select array_agg(l.mood_id order by l.mood_id) from diary_entry_moods l
            where l.entry_id = page.id), '{}'::uuid[]) as mood_ids,
  coalesce((select array_agg(l.tag_id order by l.tag_id) from diary_entry_tags l
            where l.entry_id = page.id), '{}'::uuid[]) as tag_ids`;

// A day of the cycle, in the shape of the plan (4.2): no user_id. An empty day is a row like any
// other. Symptoms leave as a list of numbers (the pg driver reads smallint[] that way).
const CYCLE_COLUMNS = `
  ${day('date')} as date, flow, mood, symptoms, discharge, sex, pill, note,
  ${iso('client_updated_at')} as client_updated_at, ${iso('updated_at')} as updated_at`;

// One kind of rows in the answer. `owner` picks the caller's rows; the starter moods have no
// owner and are everybody's. `alsoOwner` is a second, never overlapping way for a row to be the
// caller's (the group's rows): it is read as a separate branch, because an `or` in one condition
// sends the planner to read the whole table instead of following an index. `maxPage` keeps a page of heavy rows (notes) small, whatever the
// app asks for: has_more makes up for it.
interface Part {
  key: 'tasks' | 'logs' | 'moods' | 'tags' | 'entries' | 'cycle_days';
  table: string;
  columns: string;
  owner: string;
  alsoOwner?: string;
  maxPage?: number;
}

// The groups the caller is in now. Whoever has left (or was removed, or the group is deleted)
// sees nothing of the group's rows from then on, the ones they wrote included.
const MY_GROUPS = `(select group_id from group_members where user_id = $1 and deleted_at is null)`;

// Own personal tasks, and every task of the caller's groups whoever wrote it.
const TASKS_PART: Part = {
  key: 'tasks',
  table: 'tasks',
  columns: TASK_COLUMNS,
  owner: `user_id = $1 and group_id is null`,
  alsoOwner: `group_id in ${MY_GROUPS}`,
};
// Own marks on personal tasks, and the marks of every member on the tasks of the caller's groups
// (that is the "2 of 3"). The caller's old marks on a group they have left stay behind with it.
const LOGS_PART: Part = {
  key: 'logs',
  table: 'task_logs',
  columns: LOG_COLUMNS,
  owner: `user_id = $1
          and task_id in (select id from tasks where user_id = $1 and group_id is null)`,
  alsoOwner: `task_id in (select id from tasks where group_id in ${MY_GROUPS})`,
};
const DIARY_PARTS: Part[] = [
  {
    key: 'moods',
    table: 'note_moods',
    columns: MOOD_COLUMNS,
    owner: '(user_id = $1 or user_id is null)',
  },
  {
    key: 'tags',
    table: 'note_tags',
    columns: TAG_COLUMNS,
    owner: 'user_id = $1',
  },
  {
    key: 'entries',
    table: 'diary_entries',
    columns: ENTRY_COLUMNS,
    owner: 'user_id = $1',
    maxPage: 50,
  },
];

const CYCLE_PART: Part = {
  key: 'cycle_days',
  table: 'cycle_days',
  columns: CYCLE_COLUMNS,
  owner: 'user_id = $1',
};

// The caller's rows newer than $2, oldest first, at least $3 of them unless there are fewer.
// `cut` is the time of the $3-th row; everything up to and including that time is returned, so
// rows that share it are never split between two pages (the next page asks for "strictly
// newer" and would lose the rest). `more` says whether anything lies beyond. `not materialized`
// lets every use of `page` follow the (user_id, updated_at) index instead of reading it all first.
const pageQuery = ({ table, columns, owner, alsoOwner }: Part) => `
  with page as not materialized (
    select * from ${table}
    where ${owner} and ($2::timestamptz is null or updated_at > $2::timestamptz)
    ${
      alsoOwner
        ? `union all
    select * from ${table}
    where ${alsoOwner} and ($2::timestamptz is null or updated_at > $2::timestamptz)`
        : ''
    }
  ), cut as (
    select updated_at from page order by updated_at offset ($3::int - 1) limit 1
  )
  select ${columns},
    exists(select 1 from page p where p.updated_at > (select updated_at from cut)) as more
  from page
  where page.updated_at <= coalesce((select updated_at from cut), 'infinity'::timestamptz)
  order by page.updated_at
`;

// The caller's groups and the people in them, in one round trip (the database can be far away).
// Only groups the caller is a member of *now*, and only the members who are in them now: a group
// that is gone from the answer is how a phone learns it left, was removed, or the group was
// deleted. Names come from `profiles` (none yet = null). The invite code is not here.
const GROUPS_SQL = `
  select g.id, g.name, g.owner_id, m.user_id, p.display_name, p.avatar_url
  from groups g
  join group_members me
    on me.group_id = g.id and me.user_id = $1 and me.deleted_at is null
  join group_members m on m.group_id = g.id and m.deleted_at is null
  left join profiles p on p.user_id = m.user_id
  where g.deleted_at is null
  order by g.created_at, g.id, m.joined_at, m.user_id
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

    // Tasks and their marks always come. The diary and the cycle only when asked for: the app
    // has a switch for each (the cycle is health data and is off by default).
    const include = (query.include ?? '').split(',');
    const parts = [
      TASKS_PART,
      LOGS_PART,
      ...(include.includes('diary') ? DIARY_PARTS : []),
      ...(include.includes('cycle') ? [CYCLE_PART] : []),
    ];

    // All reads at once, to spare the wait on a far-away database.
    const [pages, groups] = await Promise.all([
      Promise.all(parts.map((part) => this.page(part, userId, since, limit))),
      this.groups(userId),
    ]);

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

    const result: PullResult = {
      next,
      has_more: truncated.length > 0,
      tasks: [],
      logs: [],
      groups,
    };
    parts.forEach((part, i) => {
      result[part.key] = pages[i].rows;
    });
    return result;
  }

  private async groups(userId: string): Promise<GroupsSnapshot> {
    const found: {
      id: string;
      name: string;
      owner_id: string;
      user_id: string;
      display_name: string | null;
      avatar_url: string | null;
    }[] = await this.dataSource.query(GROUPS_SQL, [userId]);
    const groups = new Map<string, GroupsSnapshot['groups'][number]>();
    for (const r of found) {
      groups.set(r.id, { id: r.id, name: r.name, owner_id: r.owner_id });
    }
    return {
      groups: [...groups.values()],
      members: found.map((r) => ({
        group_id: r.id,
        user_id: r.user_id,
        display_name: r.display_name,
        avatar_url: r.avatar_url,
      })),
    };
  }

  private async page(
    part: Part,
    userId: string,
    since: string | null,
    limit: number,
  ): Promise<Page> {
    const found: (Record<string, unknown> & { more: boolean })[] =
      await this.dataSource.query(pageQuery(part), [
        userId,
        since,
        Math.min(limit, part.maxPage ?? limit),
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
