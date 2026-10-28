import {
  parseCycleDay,
  parseDeleted,
  parseEntry,
  parseLog,
  parseMood,
  parseTag,
  parseTask,
} from './push-rows';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

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
      const expected = 'id' in extra ? undefined : ID;
      expect(refusedId(parseTask(task(extra)))).toBe(expected ?? null);
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

describe('parseEntry', () => {
  const entry = (extra: Record<string, unknown> = {}) => ({ id: ID, ...extra });

  it('takes a full note as the app sends it', () => {
    const row = rowOf(
      parseEntry({
        id: ID,
        title: 'A day',
        body: '[{"insert":"text\\n"}]',
        cover_image: 'cover.jpg',
        images: '["a.jpg","b.jpg"]',
        is_favorite: true,
        status: 'draft',
        created_at: '2026-01-15T10:00:00.123456Z',
        client_updated_at: '2026-01-15T10:00:01.654321Z',
        mood_ids: [OTHER],
        tag_ids: [ID, OTHER],
      }),
    );
    expect(row).toEqual({
      id: ID,
      title: 'A day',
      body: '[{"insert":"text\\n"}]',
      coverImage: 'cover.jpg',
      images: '["a.jpg","b.jpg"]',
      isFavorite: true,
      status: 'draft',
      createdAt: '2026-01-15T10:00:00.123456Z',
      clientUpdatedAt: '2026-01-15T10:00:01.654321Z',
      moodIds: [OTHER],
      tagIds: [ID, OTHER],
    });
  });

  it('fills the database defaults when only the id is given, and leaves the labels alone', () => {
    const row = rowOf(parseEntry(entry()));
    expect(row).toMatchObject({
      title: '',
      body: '',
      coverImage: null,
      images: '[]',
      isFavorite: false,
      status: 'normal',
      moodIds: null,
      tagIds: null,
    });
    expect(row.createdAt).toMatch(/^\d{4}-.*Z$/);
  });

  describe('the labels of a note', () => {
    it('keeps an empty list as empty (it erases the labels) and absent or null as "not said"', () => {
      expect(
        rowOf(parseEntry(entry({ mood_ids: [], tag_ids: [] }))),
      ).toMatchObject({
        moodIds: [],
        tagIds: [],
      });
      expect(
        rowOf(parseEntry(entry({ mood_ids: null, tag_ids: null }))),
      ).toMatchObject({
        moodIds: null,
        tagIds: null,
      });
      expect(rowOf(parseEntry(entry({ mood_ids: [] })))).toMatchObject({
        moodIds: [],
        tagIds: null,
      });
    });

    it('lower-cases the ids and drops repeats', () => {
      const row = rowOf(
        parseEntry(entry({ tag_ids: [OTHER.toUpperCase(), OTHER, ID, ID] })),
      );
      expect(row.tagIds).toEqual([OTHER, ID]);
    });

    it('takes 100 of each and refuses 101', () => {
      const many = (n: number) =>
        Array.from({ length: n }, (_, i) => id(i + 1));
      expect(
        rowOf(parseEntry(entry({ mood_ids: many(100) }))).moodIds,
      ).toHaveLength(100);
      expect(
        rowOf(parseEntry(entry({ tag_ids: many(100) }))).tagIds,
      ).toHaveLength(100);
      expect(refusedId(parseEntry(entry({ mood_ids: many(101) })))).toBe(ID);
      expect(refusedId(parseEntry(entry({ tag_ids: many(101) })))).toBe(ID);
    });

    it('counts the repeats towards the 100 (the list sent is what is limited)', () => {
      expect(
        refusedId(parseEntry(entry({ tag_ids: Array(101).fill(ID) }))),
      ).toBe(ID);
    });

    it('refuses a list that is not a list, or holds something that is not a uuid', () => {
      for (const bad of [
        'abc',
        5,
        {},
        [1],
        ['abc'],
        [ID, 'abc'],
        [null],
        [[ID]],
      ]) {
        expect(refusedId(parseEntry(entry({ mood_ids: bad })))).toBe(ID);
        expect(refusedId(parseEntry(entry({ tag_ids: bad })))).toBe(ID);
      }
    });
  });

  describe('refuses the note, naming its id', () => {
    const bad: [string, Record<string, unknown>][] = [
      ['a title that is not text', { title: 5 }],
      ['a null title', { title: null }],
      ['a title over 1000 characters', { title: 'x'.repeat(1001) }],
      ['a null body', { body: null }],
      ['a body over 1,000,000 characters', { body: 'x'.repeat(1_000_001) }],
      ['a cover_image over 2048 characters', { cover_image: 'x'.repeat(2049) }],
      ['a cover_image that is a number', { cover_image: 1 }],
      ['images over 100,000 characters', { images: 'x'.repeat(100_001) }],
      ['images that is a real list, not text', { images: ['a.jpg'] }],
      ['a null images', { images: null }],
      ['is_favorite that is not a boolean', { is_favorite: 1 }],
      ['a null is_favorite', { is_favorite: null }],
      ['an unknown status', { status: 'done' }],
      ['a status of the tasks', { status: 'active' }],
      ['a null status', { status: null }],
      ['a NUL in the title', { title: 'a\0b' }],
      ['a NUL in the body', { body: 'a\0b' }],
      ['a NUL in the images', { images: '[\0]' }],
      ['a created_at without the Z', { created_at: '2026-01-15T10:00:00' }],
      [
        'a client_updated_at on 30 February',
        { client_updated_at: '2026-02-30T10:00:00Z' },
      ],
    ];
    it.each(bad)('%s', (_name, extra) => {
      expect(refusedId(parseEntry(entry(extra)))).toBe(ID);
    });
  });

  it('accepts the edges of every length', () => {
    const row = rowOf(
      parseEntry(
        entry({
          title: 'x'.repeat(1000),
          body: 'x'.repeat(1_000_000),
          cover_image: 'x'.repeat(2048),
          images: 'x'.repeat(100_000),
        }),
      ),
    );
    expect(row.body).toHaveLength(1_000_000);
  });

  it('accepts all three statuses', () => {
    for (const status of ['draft', 'normal', 'archived']) {
      expect(rowOf(parseEntry(entry({ status }))).status).toBe(status);
    }
  });

  it('replaces half an emoji with U+FFFD in the text, and leaves whole ones alone', () => {
    const row = rowOf(
      parseEntry(entry({ title: 'a\ud83d', body: '\ude00b😀' })),
    );
    expect(row.title).toBe('a\ufffd');
    expect(row.body).toBe('\ufffdb😀');
  });

  it('ignores a user_id sent by the client', () => {
    const row = rowOf(parseEntry(entry({ user_id: OTHER })));
    expect(row).not.toHaveProperty('userId');
    expect(Object.values(row)).not.toContain(OTHER);
  });

  it('refuses a bad id and anything that is not an object, with no id to report', () => {
    expect(refusedId(parseEntry({ id: 'abc' }))).toBeNull();
    expect(refusedId(parseEntry({}))).toBeNull();
    for (const raw of [null, 5, 'x', [], [ID]]) {
      expect(refusedId(parseEntry(raw))).toBeNull();
    }
  });

  it('names the id of a bad note in lower case', () => {
    expect(refusedId(parseEntry({ id: ID.toUpperCase(), status: 'x' }))).toBe(
      ID,
    );
  });
});

describe('parseMood', () => {
  const mood = (extra: Record<string, unknown> = {}) => ({
    id: ID,
    name: 'Joy',
    emoji: '😊',
    ...extra,
  });

  it('takes a mood as the app sends it', () => {
    expect(
      rowOf(
        parseMood({
          ...mood(),
          created_at: '2026-01-15T10:00:00.5Z',
          client_updated_at: '2026-01-15T10:00:01Z',
        }),
      ),
    ).toEqual({
      id: ID,
      name: 'Joy',
      emoji: '😊',
      createdAt: '2026-01-15T10:00:00.5Z',
      clientUpdatedAt: '2026-01-15T10:00:01Z',
    });
  });

  it('fills the times with now when they are not given', () => {
    expect(rowOf(parseMood(mood())).createdAt).toMatch(/^\d{4}-.*Z$/);
  });

  describe('refuses the mood, naming its id', () => {
    const bad: [string, Record<string, unknown>][] = [
      ['a missing name', { name: undefined }],
      ['a null name', { name: null }],
      ['a name that is not text', { name: 5 }],
      ['a name over 100 characters', { name: 'x'.repeat(101) }],
      ['a NUL in the name', { name: 'a\0' }],
      ['a missing emoji', { emoji: undefined }],
      ['a null emoji', { emoji: null }],
      ['an emoji over 32 characters', { emoji: '😊'.repeat(17) }],
      ['a created_at that is a date only', { created_at: '2026-01-15' }],
    ];
    it.each(bad)('%s', (_name, extra) => {
      expect(refusedId(parseMood(mood(extra)))).toBe(ID);
    });
  });

  it('accepts the edges of the lengths, and an empty name', () => {
    expect(rowOf(parseMood(mood({ name: 'x'.repeat(100) }))).name).toHaveLength(
      100,
    );
    expect(
      rowOf(parseMood(mood({ emoji: '😊'.repeat(16) }))).emoji,
    ).toHaveLength(32);
    expect(rowOf(parseMood(mood({ name: '' }))).name).toBe('');
  });

  it('ignores a user_id, and refuses what is not an object', () => {
    expect(rowOf(parseMood(mood({ user_id: OTHER })))).not.toHaveProperty(
      'userId',
    );
    expect(refusedId(parseMood(null))).toBeNull();
    expect(
      refusedId(parseMood({ id: 'abc', name: 'x', emoji: 'y' })),
    ).toBeNull();
  });
});

describe('parseTag', () => {
  const tag = (extra: Record<string, unknown> = {}) => ({
    id: ID,
    name: 'Work',
    ...extra,
  });

  it('takes a tag as the app sends it', () => {
    expect(
      rowOf(
        parseTag({
          ...tag(),
          color_key: 'green',
          created_at: '2026-01-15T10:00:00Z',
          client_updated_at: '2026-01-15T10:00:01Z',
        }),
      ),
    ).toEqual({
      id: ID,
      name: 'Work',
      colorKey: 'green',
      createdAt: '2026-01-15T10:00:00Z',
      clientUpdatedAt: '2026-01-15T10:00:01Z',
    });
  });

  it('uses violet when no colour is given', () => {
    expect(rowOf(parseTag(tag())).colorKey).toBe('violet');
  });

  describe('refuses the tag, naming its id', () => {
    const bad: [string, Record<string, unknown>][] = [
      ['a missing name', { name: undefined }],
      ['a null name', { name: null }],
      ['a name over 100 characters', { name: 'x'.repeat(101) }],
      ['a NUL in the name', { name: 'a\0' }],
      ['a null colour (the column has a default)', { color_key: null }],
      ['a colour that is not text', { color_key: 3 }],
      ['a colour over 100 characters', { color_key: 'x'.repeat(101) }],
      [
        'a client_updated_at that is not a moment',
        { client_updated_at: 'now' },
      ],
    ];
    it.each(bad)('%s', (_name, extra) => {
      expect(refusedId(parseTag(tag(extra)))).toBe(ID);
    });
  });

  it('replaces half an emoji in the name with U+FFFD', () => {
    expect(rowOf(parseTag(tag({ name: 'a\ud83d' }))).name).toBe('a\ufffd');
  });

  it('ignores a user_id, and refuses what is not an object', () => {
    expect(rowOf(parseTag(tag({ user_id: OTHER })))).not.toHaveProperty(
      'userId',
    );
    expect(refusedId(parseTag('x'))).toBeNull();
    expect(refusedId(parseTag({ name: 'x' }))).toBeNull();
  });
});

describe('parseCycleDay', () => {
  const DAY = '2026-01-15';
  const cycle = (extra: Record<string, unknown> = {}) => ({
    date: DAY,
    ...extra,
  });

  it('takes a day as the app sends it', () => {
    expect(
      rowOf(
        parseCycleDay({
          user_id: ID,
          date: DAY,
          flow: 3,
          mood: 5,
          symptoms: [0, 4, 8],
          discharge: 6,
          sex: 2,
          pill: true,
          note: 'tired',
          client_updated_at: '2026-01-15T10:00:01.123456Z',
        }),
      ),
    ).toEqual({
      date: DAY,
      flow: 3,
      mood: 5,
      symptoms: [0, 4, 8],
      discharge: 6,
      sex: 2,
      pill: true,
      note: 'tired',
      clientUpdatedAt: '2026-01-15T10:00:01.123456Z',
    });
  });

  it('fills defaults when only the day is given: that is an empty day', () => {
    expect(rowOf(parseCycleDay(cycle()))).toMatchObject({
      date: DAY,
      flow: 0,
      mood: null,
      symptoms: [],
      discharge: null,
      sex: null,
      pill: false,
      note: null,
    });
  });

  it('takes null for the optional fields', () => {
    expect(
      rowOf(
        parseCycleDay(
          cycle({ mood: null, discharge: null, sex: null, note: null }),
        ),
      ),
    ).toMatchObject({ mood: null, discharge: null, sex: null, note: null });
  });

  it('ignores a user_id sent by the client', () => {
    expect(rowOf(parseCycleDay(cycle({ user_id: OTHER })))).not.toHaveProperty(
      'userId',
    );
  });

  it('accepts every border of every option', () => {
    for (const [key, max] of [
      ['flow', 4],
      ['mood', 5],
      ['discharge', 6],
      ['sex', 2],
    ] as const) {
      expect(rowOf(parseCycleDay(cycle({ [key]: 0 })))).toHaveProperty(key, 0);
      expect(rowOf(parseCycleDay(cycle({ [key]: max })))).toHaveProperty(
        key,
        max,
      );
    }
  });

  it('drops repeated symptoms and sorts the rest', () => {
    expect(
      rowOf(parseCycleDay(cycle({ symptoms: [8, 2, 2, 0, 8] }))),
    ).toHaveProperty('symptoms', [0, 2, 8]);
  });

  it('takes all nine symptoms', () => {
    const all = [8, 7, 6, 5, 4, 3, 2, 1, 0];
    expect(rowOf(parseCycleDay(cycle({ symptoms: all })))).toHaveProperty(
      'symptoms',
      [0, 1, 2, 3, 4, 5, 6, 7, 8],
    );
  });

  it('keeps a note of 10 000 characters and replaces a lone surrogate', () => {
    expect(
      rowOf(parseCycleDay(cycle({ note: 'a'.repeat(10_000) }))),
    ).toHaveProperty('note', 'a'.repeat(10_000));
    expect(rowOf(parseCycleDay(cycle({ note: 'ab\uD83D' })))).toHaveProperty(
      'note',
      'ab\uFFFD',
    );
  });

  describe('refuses the day, naming it', () => {
    const bad: [string, Record<string, unknown>][] = [
      ['a flow of -1', { flow: -1 }],
      ['a flow of 5', { flow: 5 }],
      ['a null flow', { flow: null }],
      ['a flow that is a string', { flow: '1' }],
      ['a flow that is not whole', { flow: 1.5 }],
      ['a mood of -1', { mood: -1 }],
      ['a mood of 6', { mood: 6 }],
      ['a discharge of -1', { discharge: -1 }],
      ['a discharge of 7', { discharge: 7 }],
      ['a sex of -1', { sex: -1 }],
      ['a sex of 3', { sex: 3 }],
      ['a mood that is a string', { mood: '2' }],
      ['a symptom of -1', { symptoms: [-1] }],
      ['a symptom of 9', { symptoms: [9] }],
      ['a symptom that is not whole', { symptoms: [1.5] }],
      ['a symptom that is a string', { symptoms: ['1'] }],
      ['a symptom that is null', { symptoms: [null] }],
      ['symptoms that are not a list', { symptoms: 1 }],
      ['null symptoms', { symptoms: null }],
      ['ten symptoms', { symptoms: [0, 1, 2, 3, 4, 5, 6, 7, 8, 8] }],
      ['a pill that is not a boolean', { pill: 1 }],
      ['a null pill', { pill: null }],
      ['a note that is not text', { note: 5 }],
      ['a note of 10 001 characters', { note: 'a'.repeat(10_001) }],
      ['a note with a NUL', { note: 'a\0b' }],
      [
        'a client_updated_at without the Z',
        { client_updated_at: '2026-01-15T10:00:00' },
      ],
      [
        'a client_updated_at that is not a moment',
        { client_updated_at: 'now' },
      ],
    ];

    it.each(bad)('%s', (_name, extra) => {
      expect(refusedId(parseCycleDay(cycle(extra)))).toBe(DAY);
    });
  });

  describe('refuses a day that cannot be read, with no id', () => {
    const bad: [string, unknown][] = [
      ['a missing date', {}],
      ['a null date', { date: null }],
      ['a date that is a number', { date: 20260115 }],
      ['a date that is a moment', { date: '2026-01-15T00:00:00Z' }],
      ['30 February', { date: '2026-02-30', flow: 9 }],
      ['a year before 1000', { date: '0999-01-01' }],
      ['an array', []],
      ['null', null],
      ['a string', DAY],
    ];

    it.each(bad)('%s', (_name, raw) => {
      expect(refusedId(parseCycleDay(raw))).toBeNull();
    });
  });
});
