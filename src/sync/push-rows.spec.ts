import { parseDeleted, parseLog, parseTask } from './push-rows';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const task = (extra: Record<string, unknown> = {}) => ({ id: ID, ...extra });
const log = (extra: Record<string, unknown> = {}) => ({
  task_id: ID,
  date: '2026-01-15',
  ...extra,
});

// The row, or the id the refusal would name.
const refusedId = (result: object) => {
  expect(result).not.toHaveProperty('row');
  return (result as { id: string | null }).id;
};
const rowOf = <T>(result: { row: T } | { id: string | null }) => {
  expect(result).toHaveProperty('row');
  return (result as { row: T }).row;
};

describe('parseTask', () => {
  it('takes a full row as the app sends it', () => {
    const row = rowOf(
      parseTask({
        id: ID,
        parent_id: OTHER,
        title: 'Read',
        description: 'ten pages',
        status: 'paused',
        repeat_type: 'weekly',
        repeat_interval: 2,
        repeat_days_mask: 5,
        tracking_mode: 'counter',
        target_duration_minutes: 30,
        target_value: 10.5,
        icon_key: 'book',
        color_key: 'violet',
        scheduled_time_minutes: 600,
        end_time_minutes: 660,
        start_date: '2026-03-01',
        created_at: '2026-01-15T10:00:00.123456Z',
        client_updated_at: '2026-01-15T10:00:01Z',
        group_id: null,
        assignee_id: null,
      }),
    );
    expect(row).toEqual({
      id: ID,
      parentId: OTHER,
      title: 'Read',
      description: 'ten pages',
      status: 'paused',
      repeatType: 'weekly',
      repeatInterval: 2,
      repeatDaysMask: 5,
      trackingMode: 'counter',
      targetDurationMinutes: 30,
      targetValue: 10.5,
      iconKey: 'book',
      colorKey: 'violet',
      scheduledTimeMinutes: 600,
      endTimeMinutes: 660,
      startDate: '2026-03-01',
      // Kept as the client wrote them: a JS Date would cut the microseconds.
      createdAt: '2026-01-15T10:00:00.123456Z',
      clientUpdatedAt: '2026-01-15T10:00:01Z',
      groupId: null,
      assigneeId: null,
    });
  });

  it('fills the database defaults when only the id is given', () => {
    const row = rowOf(parseTask(task()));
    expect(row).toMatchObject({
      parentId: null,
      title: '',
      description: null,
      status: 'active',
      repeatType: null,
      trackingMode: 'checkbox',
      startDate: null,
      groupId: null,
    });
    expect(row.createdAt).toMatch(/^\d{4}-.*Z$/);
    expect(row.clientUpdatedAt).toMatch(/^\d{4}-.*Z$/);
  });

  it('lower-cases ids so one id is never two', () => {
    const row = rowOf(
      parseTask(task({ id: ID.toUpperCase(), parent_id: OTHER.toUpperCase() })),
    );
    expect(row.id).toBe(ID);
    expect(row.parentId).toBe(OTHER);
  });

  it('replaces half an emoji with U+FFFD, and leaves whole ones alone', () => {
    const row = rowOf(
      parseTask(task({ title: 'a\ud83d', description: '\ude00b😀' })),
    );
    expect(row.title).toBe('a\ufffd');
    expect(row.description).toBe('\ufffdb😀');
  });

  it('ignores a user_id sent by the client', () => {
    const row = rowOf(parseTask(task({ user_id: OTHER })));
    expect(row).not.toHaveProperty('userId');
    expect(Object.values(row)).not.toContain(OTHER);
  });

  describe('refuses the row, naming its id', () => {
    const bad: [string, Record<string, unknown>][] = [
      ['an id that is not a uuid', { id: 'abc' }],
      ['a parent_id that is not a uuid', { parent_id: 'abc' }],
      ['a group_id that is not a uuid', { group_id: 5 }],
      ['an assignee_id that is not a uuid', { assignee_id: 'x' }],
      ['a title that is not text', { title: 5 }],
      ['a null title', { title: null }],
      ['a title over 1000 characters', { title: 'x'.repeat(1001) }],
      [
        'a description over 50000 characters',
        { description: 'x'.repeat(50_001) },
      ],
      ['a NUL character in the title (Postgres refuses it)', { title: 'a\0b' }],
      ['a NUL character in the description', { description: 'a\0b' }],
      ['an unknown status', { status: 'done' }],
      ['a null status', { status: null }],
      ['an unknown repeat_type', { repeat_type: 'yearly' }],
      ['an unknown tracking_mode', { tracking_mode: 'stopwatch' }],
      ['a null tracking_mode', { tracking_mode: null }],
      ['a repeat_interval of 0', { repeat_interval: 0 }],
      ['a fractional repeat_interval', { repeat_interval: 1.5 }],
      ['a repeat_interval beyond int4', { repeat_interval: 2147483648 }],
      ['a numeric string for a number', { repeat_interval: '2' }],
      ['a negative repeat_days_mask', { repeat_days_mask: -1 }],
      ['a repeat_days_mask beyond int4', { repeat_days_mask: 2 ** 31 }],
      ['a negative target_duration_minutes', { target_duration_minutes: -1 }],
      [
        'a target_duration_minutes beyond int4',
        { target_duration_minutes: 2 ** 31 },
      ],
      ['a target_value that is not finite', { target_value: Infinity }],
      ['a target_value that is a string', { target_value: '1' }],
      ['an icon_key over 100 characters', { icon_key: 'x'.repeat(101) }],
      ['a color_key that is not text', { color_key: 1 }],
      ['a scheduled time of -1', { scheduled_time_minutes: -1 }],
      [
        'a scheduled time past the end of the day',
        { scheduled_time_minutes: 1441 },
      ],
      ['an end time past the end of the day', { end_time_minutes: 1441 }],
      ['a start_date that is a moment', { start_date: '2026-03-01T00:00:00Z' }],
      ['a start_date without zero padding', { start_date: '2026-3-1' }],
      ['30 February', { start_date: '2026-02-30' }],
      ['month 13', { start_date: '2026-13-01' }],
      ['29 February in a non-leap year', { start_date: '2027-02-29' }],
      ['a created_at without the Z', { created_at: '2026-01-15T10:00:00' }],
      [
        'a created_at with an offset',
        { created_at: '2026-01-15T10:00:00+03:00' },
      ],
      ['a created_at that is a date only', { created_at: '2026-01-15' }],
      ['hour 24', { created_at: '2026-01-15T24:00:00Z' }],
      ['minute 60', { client_updated_at: '2026-01-15T10:60:00Z' }],
      ['second 60', { client_updated_at: '2026-01-15T10:00:60Z' }],
      [
        'a client_updated_at on 30 February',
        { client_updated_at: '2026-02-30T10:00:00Z' },
      ],
      [
        'a client_updated_at that is a number',
        { client_updated_at: 1768471200 },
      ],
    ];

    it.each(bad)('%s', (_name, extra) => {
      const id = 'id' in extra ? undefined : ID;
      expect(refusedId(parseTask(task(extra)))).toBe(id ?? null);
    });
  });

  it('accepts the edges of every range', () => {
    const row = rowOf(
      parseTask(
        task({
          repeat_interval: 2147483647,
          repeat_days_mask: 0,
          target_duration_minutes: 0,
          scheduled_time_minutes: 0,
          end_time_minutes: 1440,
          start_date: '2028-02-29',
          created_at: '2026-01-15T23:59:59.999999999Z',
          title: 'x'.repeat(1000),
        }),
      ),
    );
    expect(row.repeatInterval).toBe(2147483647);
    expect(row.startDate).toBe('2028-02-29');
  });

  it('refuses anything that is not an object, with no id', () => {
    for (const raw of [null, undefined, 5, 'text', true, [], [ID]]) {
      expect(refusedId(parseTask(raw))).toBeNull();
    }
  });

  it('does not echo back a client string that is not a uuid', () => {
    expect(refusedId(parseTask({ id: '<script>' }))).toBeNull();
  });

  it('names the id of a bad row in lower case', () => {
    expect(refusedId(parseTask({ id: ID.toUpperCase(), status: 'x' }))).toBe(
      ID,
    );
  });
});

describe('parseLog', () => {
  it('takes a mark as the app sends it', () => {
    expect(
      rowOf(
        parseLog({
          task_id: ID,
          date: '2026-01-15',
          completed: true,
          value: 3,
          completed_at: '2026-01-15T10:00:00.5Z',
          client_updated_at: '2026-01-15T10:00:01Z',
        }),
      ),
    ).toEqual({
      taskId: ID,
      date: '2026-01-15',
      completed: true,
      value: 3,
      completedAt: '2026-01-15T10:00:00.5Z',
      clientUpdatedAt: '2026-01-15T10:00:01Z',
    });
  });

  it('fills defaults when only the task and the day are given', () => {
    expect(rowOf(parseLog(log()))).toMatchObject({
      completed: false,
      value: null,
      completedAt: null,
    });
  });

  it('ignores a user_id sent by the client', () => {
    expect(rowOf(parseLog(log({ user_id: OTHER })))).not.toHaveProperty(
      'userId',
    );
  });

  describe('refuses the mark, naming its task', () => {
    const bad: [string, Record<string, unknown>][] = [
      ['a missing date', { date: undefined }],
      ['a null date', { date: null }],
      ['a date that is a moment', { date: '2026-01-15T00:00:00Z' }],
      ['30 February', { date: '2026-02-30' }],
      ['a completed that is not a boolean', { completed: 1 }],
      ['a null completed', { completed: null }],
      ['a value that is a string', { value: '3' }],
      ['a value that is not finite', { value: Infinity }],
      ['a completed_at without the Z', { completed_at: '2026-01-15T10:00:00' }],
      [
        'a client_updated_at that is not a moment',
        { client_updated_at: 'now' },
      ],
    ];

    it.each(bad)('%s', (_name, extra) => {
      expect(refusedId(parseLog(log(extra)))).toBe(ID);
    });
  });

  it('refuses a mark without a task, with no id', () => {
    expect(refusedId(parseLog({ date: '2026-01-15' }))).toBeNull();
    expect(
      refusedId(parseLog({ task_id: 'abc', date: '2026-01-15' })),
    ).toBeNull();
    expect(refusedId(parseLog(null))).toBeNull();
  });
});

describe('parseDeleted', () => {
  it('takes a table name and an id', () => {
    expect(
      rowOf(parseDeleted({ table: 'tasks', id: ID.toUpperCase() })),
    ).toEqual({
      table: 'tasks',
      id: ID,
    });
  });

  it('lets an unknown table through: that is decided later, as unsupported_table', () => {
    expect(rowOf(parseDeleted({ table: 'diary_entries', id: ID }))).toEqual({
      table: 'diary_entries',
      id: ID,
    });
  });

  it('refuses a bad id, a missing or non-text table, or a NUL in it', () => {
    expect(refusedId(parseDeleted({ table: 'tasks', id: 'abc' }))).toBeNull();
    expect(refusedId(parseDeleted({ id: ID }))).toBe(ID);
    expect(refusedId(parseDeleted({ table: 5, id: ID }))).toBe(ID);
    expect(refusedId(parseDeleted({ table: 'a\0', id: ID }))).toBe(ID);
    expect(refusedId(parseDeleted({ table: 'x'.repeat(65), id: ID }))).toBe(ID);
    expect(refusedId(parseDeleted('tasks'))).toBeNull();
  });
});
