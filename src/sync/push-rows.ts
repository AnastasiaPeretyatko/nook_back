// Checks one row of a /sync/push body. A row is checked on its own and either becomes a clean
// object or is refused: the body itself is only "arrays of anything" (see SyncPushDto), so one
// bad row never turns into a 400 for the whole push. Everything the database would refuse
// (a bad enum, a number outside int4, a NUL in text, 30 February) must be refused here, because
// a database error rolls back the whole push transaction.

export type RowResult<T> = { row: T } | { id: string | null };

export interface TaskRow {
  id: string;
  parentId: string | null;
  title: string;
  description: string | null;
  status: string;
  repeatType: string | null;
  repeatInterval: number | null;
  repeatDaysMask: number | null;
  trackingMode: string;
  targetDurationMinutes: number | null;
  targetValue: number | null;
  iconKey: string | null;
  colorKey: string | null;
  scheduledTimeMinutes: number | null;
  endTimeMinutes: number | null;
  startDate: string | null;
  createdAt: string;
  clientUpdatedAt: string;
  // Sent by the app; groups arrive in B5, until then the writer refuses a task that has a group.
  groupId: string | null;
  assigneeId: string | null;
}

// No user_id: it comes from the token, whatever the client sends.
export interface LogRow {
  taskId: string;
  date: string;
  completed: boolean;
  value: number | null;
  completedAt: string | null;
  clientUpdatedAt: string;
}

export interface DeletedRow {
  table: string;
  id: string;
}

// The diary. `moodIds` / `tagIds` are the note's whole set of labels: a list replaces what the
// server has (an empty list erases it); null means the row did not say, and nothing is touched.
export interface EntryRow {
  id: string;
  title: string;
  body: string;
  coverImage: string | null;
  images: string;
  isFavorite: boolean;
  status: string;
  createdAt: string;
  clientUpdatedAt: string;
  moodIds: string[] | null;
  tagIds: string[] | null;
}

export interface MoodRow {
  id: string;
  name: string;
  emoji: string;
  createdAt: string;
  clientUpdatedAt: string;
}

export interface TagRow {
  id: string;
  name: string;
  colorKey: string;
  createdAt: string;
  clientUpdatedAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
// UTC only, with the `Z`: Postgres reads a bare time in the server's zone.
const INSTANT = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?Z$/;

const INT4_MAX = 2147483647;
const MINUTES_IN_DAY = 1440;

class InvalidRow extends Error {}

const fail = (): never => {
  throw new InvalidRow();
};

type Check<T> = (value: unknown) => T;

// Lower-cased, so the same id spelled two ways is one id when rows are compared in memory.
const uuid: Check<string> = (v) =>
  typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : fail();

// Half of an emoji (a lone surrogate) can come from a phone that cut a string in the middle of
// one. Postgres refuses it inside JSON, and the whole push would fail, so it becomes U+FFFD.
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const text =
  (maxLength: number): Check<string> =>
  (v) =>
    typeof v === 'string' && v.length <= maxLength && !v.includes('\0')
      ? v.replace(LONE_SURROGATE, '\uFFFD')
      : fail();

const int =
  (min: number, max: number): Check<number> =>
  (v) =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
      ? v
      : fail();

const real: Check<number> = (v) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fail();

const bool: Check<boolean> = (v) => (typeof v === 'boolean' ? v : fail());

// A list of ids (a note's moods or tags): at most `max`, each a uuid, lower-cased, no repeats.
const uuidList =
  (max: number): Check<string[]> =>
  (v) =>
    Array.isArray(v) && v.length <= max ? [...new Set(v.map(uuid))] : fail();

const oneOf =
  (allowed: readonly string[]): Check<string> =>
  (v) =>
    typeof v === 'string' && allowed.includes(v) ? v : fail();

// A real calendar day: JS and Postgres differ on what "30 February" means.
const isRealDay = (year: number, month: number, day: number) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

const dayOf = (s: string) => {
  const m = DAY.exec(s);
  if (!m) return fail();
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return year >= 1000 && isRealDay(year, month, day) ? s : fail();
};

const day: Check<string> = (v) => (typeof v === 'string' ? dayOf(v) : fail());

// Returned as the original string, not a Date: a JS Date keeps milliseconds and the app's
// stamps have microseconds; Postgres keeps them all.
const instant: Check<string> = (v) => {
  const m = typeof v === 'string' ? INSTANT.exec(v) : null;
  if (!m) return fail();
  dayOf(m[1]);
  return Number(m[2]) < 24 && Number(m[3]) < 60 && Number(m[4]) < 60
    ? (v as string)
    : fail();
};

export const isInstant = (v: unknown): v is string => {
  try {
    instant(v);
    return true;
  } catch {
    return false;
  }
};

type Fields = Record<string, unknown>;

const req = <T>(fields: Fields, key: string, check: Check<T>): T =>
  check(fields[key]);

// A nullable column: absent and null both mean "no value".
const opt = <T>(fields: Fields, key: string, check: Check<T>): T | null =>
  fields[key] == null ? null : check(fields[key]);

// A column with a default: absent gives the default, null is refused.
const def = <T>(
  fields: Fields,
  key: string,
  check: Check<T>,
  fallback: T,
): T => (fields[key] === undefined ? fallback : check(fields[key]));

const isObject = (v: unknown): v is Fields =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// The id to report back for a refused row; never an arbitrary client string.
export const idOf = (raw: unknown, key: string): string | null => {
  const v = isObject(raw) ? raw[key] : undefined;
  return typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : null;
};

function parse<T>(
  raw: unknown,
  idKey: string,
  build: (fields: Fields) => T,
): RowResult<T> {
  if (!isObject(raw)) return { id: null };
  try {
    return { row: build(raw) };
  } catch (error) {
    if (error instanceof InvalidRow) return { id: idOf(raw, idKey) };
    throw error;
  }
}

const STATUSES = ['active', 'paused', 'archived'];
const REPEAT_TYPES = ['daily', 'weekly', 'monthly', 'custom'];
const TRACKING_MODES = ['checkbox', 'counter', 'timer', 'value'];

export function parseTask(raw: unknown): RowResult<TaskRow> {
  return parse(raw, 'id', (f) => {
    const now = new Date().toISOString();
    return {
      id: req(f, 'id', uuid),
      parentId: opt(f, 'parent_id', uuid),
      title: def(f, 'title', text(1000), ''),
      description: opt(f, 'description', text(50_000)),
      status: def(f, 'status', oneOf(STATUSES), 'active'),
      repeatType: opt(f, 'repeat_type', oneOf(REPEAT_TYPES)),
      repeatInterval: opt(f, 'repeat_interval', int(1, INT4_MAX)),
      repeatDaysMask: opt(f, 'repeat_days_mask', int(0, INT4_MAX)),
      trackingMode: def(f, 'tracking_mode', oneOf(TRACKING_MODES), 'checkbox'),
      targetDurationMinutes: opt(
        f,
        'target_duration_minutes',
        int(0, INT4_MAX),
      ),
      targetValue: opt(f, 'target_value', real),
      iconKey: opt(f, 'icon_key', text(100)),
      colorKey: opt(f, 'color_key', text(100)),
      scheduledTimeMinutes: opt(
        f,
        'scheduled_time_minutes',
        int(0, MINUTES_IN_DAY),
      ),
      endTimeMinutes: opt(f, 'end_time_minutes', int(0, MINUTES_IN_DAY)),
      startDate: opt(f, 'start_date', day),
      createdAt: def(f, 'created_at', instant, now),
      clientUpdatedAt: def(f, 'client_updated_at', instant, now),
      groupId: opt(f, 'group_id', uuid),
      assigneeId: opt(f, 'assignee_id', uuid),
    };
  });
}

const ENTRY_STATUSES = ['draft', 'normal', 'archived'];
const MAX_LABELS_PER_ENTRY = 100;

export function parseEntry(raw: unknown): RowResult<EntryRow> {
  return parse(raw, 'id', (f) => {
    const now = new Date().toISOString();
    return {
      id: req(f, 'id', uuid),
      title: def(f, 'title', text(1000), ''),
      body: def(f, 'body', text(1_000_000), ''),
      coverImage: opt(f, 'cover_image', text(2048)),
      images: def(f, 'images', text(100_000), '[]'),
      isFavorite: def(f, 'is_favorite', bool, false),
      status: def(f, 'status', oneOf(ENTRY_STATUSES), 'normal'),
      createdAt: def(f, 'created_at', instant, now),
      clientUpdatedAt: def(f, 'client_updated_at', instant, now),
      moodIds: opt(f, 'mood_ids', uuidList(MAX_LABELS_PER_ENTRY)),
      tagIds: opt(f, 'tag_ids', uuidList(MAX_LABELS_PER_ENTRY)),
    };
  });
}

export function parseMood(raw: unknown): RowResult<MoodRow> {
  return parse(raw, 'id', (f) => {
    const now = new Date().toISOString();
    return {
      id: req(f, 'id', uuid),
      name: req(f, 'name', text(100)),
      emoji: req(f, 'emoji', text(32)),
      createdAt: def(f, 'created_at', instant, now),
      clientUpdatedAt: def(f, 'client_updated_at', instant, now),
    };
  });
}

export function parseTag(raw: unknown): RowResult<TagRow> {
  return parse(raw, 'id', (f) => {
    const now = new Date().toISOString();
    return {
      id: req(f, 'id', uuid),
      name: req(f, 'name', text(100)),
      colorKey: def(f, 'color_key', text(100), 'violet'),
      createdAt: def(f, 'created_at', instant, now),
      clientUpdatedAt: def(f, 'client_updated_at', instant, now),
    };
  });
}

// A refused mark is reported by its task id (a mark has no id of its own).
export function parseLog(raw: unknown): RowResult<LogRow> {
  return parse(raw, 'task_id', (f) => ({
    taskId: req(f, 'task_id', uuid),
    date: req(f, 'date', day),
    completed: def(f, 'completed', bool, false),
    value: opt(f, 'value', real),
    completedAt: opt(f, 'completed_at', instant),
    clientUpdatedAt: def(
      f,
      'client_updated_at',
      instant,
      new Date().toISOString(),
    ),
  }));
}

// The table name is only checked to be a short string; which tables are supported is decided
// later, so an unknown table is reported as such and not as a broken row.
export function parseDeleted(raw: unknown): RowResult<DeletedRow> {
  return parse(raw, 'id', (f) => ({
    table: req(f, 'table', text(64)),
    id: req(f, 'id', uuid),
  }));
}
