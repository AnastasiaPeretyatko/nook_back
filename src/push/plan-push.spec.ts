import {
  MAX_PER_RECIPIENT,
  NEW_TASK_MAX_AGE_MS,
  planPush,
  PushEvent,
  PushTask,
  PushWorld,
} from './plan-push';

const [ANN, BOB, CAT, DAN] = ['ann', 'bob', 'cat', 'dan'];
const NOW = Date.parse('2026-03-01T12:00:00Z');

const task = (fields: Partial<PushTask> = {}): PushTask => ({
  id: 't1',
  groupId: 'g1',
  title: 'Купить молоко',
  authorId: ANN,
  assigneeId: null,
  parentId: null,
  status: 'active',
  deleted: false,
  createdAt: NOW - 1000,
  ...fields,
});

// Ann, Bob and Cat are in the group "Дом"; Dan is not.
const world = (fields: Partial<PushWorld> = {}): PushWorld => ({
  now: NOW,
  groups: new Map([['g1', { name: 'Дом', members: [ANN, BOB, CAT] }]]),
  names: new Map<string, string | null>([
    [ANN, 'Аня'],
    [BOB, 'Боб'],
    [CAT, 'Кот'],
  ]),
  ...fields,
});

const created = (t = task()): PushEvent => ({ kind: 'created', task: t });
const assigned = (t: PushTask): PushEvent => ({ kind: 'assigned', task: t });
const done = (t: PushTask, doneBy: string): PushEvent => ({
  kind: 'done',
  task: t,
  doneBy,
});

const who = (events: PushEvent[], w = world()) =>
  planPush(events, w)
    .map((n) => n.userId)
    .sort();

describe('planPush', () => {
  it('has nothing to say about no events', () => {
    expect(planPush([], world())).toEqual([]);
  });

  describe('a new task', () => {
    it('for everyone: all the others, never the author, with the text of the plan', () => {
      expect(planPush([created()], world())).toEqual([
        {
          userId: BOB,
          message: {
            title: 'Новая задача для всех от Аня',
            body: 'Купить молоко · Дом',
            data: { group_id: 'g1', task_id: 't1' },
          },
        },
        {
          userId: CAT,
          message: {
            title: 'Новая задача для всех от Аня',
            body: 'Купить молоко · Дом',
            data: { group_id: 'g1', task_id: 't1' },
          },
        },
      ]);
    });

    it('for someone: only them, and the title says "от", not "для всех"', () => {
      const plan = planPush([created(task({ assigneeId: BOB }))], world());
      expect(plan.map((n) => n.userId)).toEqual([BOB]);
      expect(plan[0].message.title).toBe('Новая задача от Аня');
    });

    it('for the author themself: nobody', () => {
      expect(who([created(task({ assigneeId: ANN }))])).toEqual([]);
    });

    it('for someone who is no longer in the group: nobody', () => {
      expect(who([created(task({ assigneeId: DAN }))])).toEqual([]);
    });

    it('never goes to someone who is not in the group', () => {
      expect(who([created()])).toEqual([BOB, CAT]);
    });

    it('is told once to a member listed twice', () => {
      const w = world({
        groups: new Map([
          ['g1', { name: 'Дом', members: [ANN, BOB, BOB, CAT] }],
        ]),
      });
      expect(who([created()], w)).toEqual([BOB, CAT]);
    });

    it('is nobody’s news when only the author is in the group, or nobody', () => {
      for (const members of [[ANN], []]) {
        const w = world({
          groups: new Map([['g1', { name: 'Дом', members }]]),
        });
        expect(who([created()], w)).toEqual([]);
      }
    });

    describe('is news for an hour', () => {
      it.each([
        ['just made', NOW, 2],
        ['a minute old', NOW - 60_000, 2],
        ['exactly an hour old', NOW - NEW_TASK_MAX_AGE_MS, 2],
        ['an hour and a millisecond old', NOW - NEW_TASK_MAX_AGE_MS - 1, 0],
        ['a day old (the backlog)', NOW - 24 * 3600_000, 0],
        ['made on a clock that runs ahead', NOW + 5 * 60_000, 2],
        ['of an unreadable time', NaN, 0],
      ])('%s', (_name, createdAt, count) => {
        expect(who([created(task({ createdAt }))])).toHaveLength(count);
      });
    });

    it.each([
      ['a subtask', { parentId: 'parent' }],
      ['a deleted task', { deleted: true }],
      ['a paused task', { status: 'paused' }],
      ['an archived task', { status: 'archived' }],
    ])('is silent about %s', (_name, fields) => {
      expect(who([created(task(fields))])).toEqual([]);
    });

    it('is silent about a group that is gone', () => {
      expect(who([created()], world({ groups: new Map() }))).toEqual([]);
    });
  });

  describe('a task handed to someone', () => {
    it('tells only the new assignee, in the words of a task "от" its author', () => {
      const plan = planPush([assigned(task({ assigneeId: BOB }))], world());
      expect(plan.map((n) => n.userId)).toEqual([BOB]);
      expect(plan[0].message).toEqual({
        title: 'Новая задача от Аня',
        body: 'Купить молоко · Дом',
        data: { group_id: 'g1', task_id: 't1' },
      });
    });

    it('is news however old the task is: the hour counts only for a new task', () => {
      const old = task({
        assigneeId: BOB,
        createdAt: NOW - 30 * 24 * 3600_000,
      });
      expect(who([assigned(old)])).toEqual([BOB]);
    });

    it('is nobody’s news when it is handed back to everyone', () => {
      expect(who([assigned(task({ assigneeId: null }))])).toEqual([]);
    });

    it('is nobody’s news when handed to its own author', () => {
      expect(who([assigned(task({ assigneeId: ANN }))])).toEqual([]);
    });

    it.each([
      ['a subtask', { parentId: 'parent' }],
      ['a deleted task', { deleted: true }],
      ['a paused task', { status: 'paused' }],
    ])('is silent about %s', (_name, fields) => {
      expect(who([assigned(task({ assigneeId: BOB, ...fields }))])).toEqual([]);
    });

    it('is silent when the new assignee is not in the group any more', () => {
      expect(who([assigned(task({ assigneeId: DAN }))])).toEqual([]);
    });
  });

  describe('a task ticked', () => {
    it('for everyone: all the others, the author too, never the one who ticked', () => {
      const plan = planPush([done(task(), BOB)], world());
      expect(plan.map((n) => n.userId).sort()).toEqual([ANN, CAT]);
      expect(plan[0].message).toEqual({
        title: 'Выполнено: Боб',
        body: 'Купить молоко · Дом',
        data: { group_id: 'g1', task_id: 't1' },
      });
    });

    it('for the author ticking their own task for everyone: the others', () => {
      expect(who([done(task(), ANN)])).toEqual([BOB, CAT]);
    });

    it('for someone: only whoever handed it out', () => {
      const t = task({ assigneeId: BOB });
      expect(who([done(t, BOB)])).toEqual([ANN]);
    });

    it('for someone: the author is not told when the author ticked it', () => {
      expect(who([done(task({ assigneeId: BOB }), ANN)])).toEqual([]);
    });

    it('is news however old the task is, and whatever its status', () => {
      const t = task({
        createdAt: NOW - 90 * 24 * 3600_000,
        status: 'archived',
      });
      expect(who([done(t, BOB)])).toEqual([ANN, CAT]);
    });

    it('is silent about a deleted task and about a group that is gone', () => {
      expect(who([done(task({ deleted: true }), BOB)])).toEqual([]);
      expect(who([done(task(), BOB)], world({ groups: new Map() }))).toEqual(
        [],
      );
    });

    it('does not tell someone who has left the group', () => {
      const w = world({
        groups: new Map([['g1', { name: 'Дом', members: [ANN, BOB] }]]),
      });
      expect(who([done(task(), BOB)], w)).toEqual([ANN]);
    });
  });

  describe('names', () => {
    it.each([
      ['has none (null)', null],
      ['is blank', '   '],
      ['is empty', ''],
    ])('a member whose name %s is called "Участник"', (_name, display) => {
      const w = world({ names: new Map([[ANN, display]]) });
      expect(planPush([created()], w)[0].message.title).toBe(
        'Новая задача для всех от Участник',
      );
    });

    it('a member with no profile at all is called "Участник"', () => {
      const w = world({ names: new Map() });
      expect(planPush([done(task(), BOB)], w)[0].message.title).toBe(
        'Выполнено: Участник',
      );
    });

    it('a name is trimmed', () => {
      const w = world({ names: new Map([[ANN, '  Аня  ']]) });
      expect(planPush([created()], w)[0].message.title).toBe(
        'Новая задача для всех от Аня',
      );
    });
  });

  describe('a long title', () => {
    const bodyOf = (title: string) =>
      planPush([created(task({ title }))], world())[0].message.body;

    it('is left alone up to 200 characters', () => {
      expect(bodyOf('я'.repeat(200))).toBe(`${'я'.repeat(200)} · Дом`);
    });

    it('is cut with an ellipsis after that, and the group still shows', () => {
      expect(bodyOf('я'.repeat(201))).toBe(`${'я'.repeat(199)}… · Дом`);
      expect(bodyOf('я'.repeat(1000))).toBe(`${'я'.repeat(199)}… · Дом`);
    });

    it('is never cut in the middle of a character', () => {
      const body = bodyOf('😀'.repeat(300));
      expect(body).toBe(`${'😀'.repeat(199)}… · Дом`);
      // No half of a surrogate pair is left at either end.
      expect(body).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
      );
    });
  });

  describe('a flood', () => {
    it(`stops at ${MAX_PER_RECIPIENT} for each person, the first ones win`, () => {
      const events = Array.from({ length: 25 }, (_, i) =>
        created(task({ id: `t${i}`, title: `задача ${i}` })),
      );
      const plan = planPush(events, world());
      for (const user of [BOB, CAT]) {
        const mine = plan.filter((n) => n.userId === user);
        expect(mine).toHaveLength(MAX_PER_RECIPIENT);
        expect(mine.map((n) => n.message.data.task_id)).toEqual(
          Array.from({ length: MAX_PER_RECIPIENT }, (_, i) => `t${i}`),
        );
      }
      expect(plan.filter((n) => n.userId === ANN)).toEqual([]);
    });

    it('counts each person on their own', () => {
      const events = [
        ...Array.from({ length: 12 }, (_, i) =>
          created(task({ id: `b${i}`, assigneeId: BOB })),
        ),
        ...Array.from({ length: 3 }, (_, i) =>
          created(task({ id: `c${i}`, assigneeId: CAT })),
        ),
      ];
      const plan = planPush(events, world());
      expect(plan.filter((n) => n.userId === BOB)).toHaveLength(10);
      expect(plan.filter((n) => n.userId === CAT)).toHaveLength(3);
    });

    it('counts all kinds of event together', () => {
      const events = [
        ...Array.from({ length: 8 }, (_, i) => created(task({ id: `a${i}` }))),
        ...Array.from({ length: 8 }, (_, i) =>
          done(task({ id: `d${i}` }), ANN),
        ),
      ];
      const plan = planPush(events, world());
      expect(plan.filter((n) => n.userId === BOB)).toHaveLength(10);
      // Bob's first eight were the new tasks, then two ticks.
      expect(
        plan
          .filter((n) => n.userId === BOB)
          .map((n) => n.message.title.split(' ')[0]),
      ).toEqual([
        ...Array.from({ length: 8 }, () => 'Новая'),
        'Выполнено:',
        'Выполнено:',
      ]);
    });
  });

  it('keeps the order of the events, and does not touch what it was given', () => {
    const members = [ANN, BOB, CAT];
    const w = world({ groups: new Map([['g1', { name: 'Дом', members }]]) });
    const plan = planPush(
      [
        created(task({ id: 'first', assigneeId: BOB })),
        done(task({ id: 'second' }), CAT),
      ],
      w,
    );
    expect(plan.map((n) => `${n.userId}:${n.message.data.task_id}`)).toEqual([
      'bob:first',
      'ann:second',
      'bob:second',
    ]);
    expect(members).toEqual([ANN, BOB, CAT]);
  });
});
