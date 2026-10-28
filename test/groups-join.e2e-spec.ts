import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp, truncateAll } from './support/db';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [T1, T2, T3, T4] = [id(1), id(2), id(3), id(4)];
const CODE = '123456';
// Never a real code in these tests: the codes are all set by hand to something that starts with 1.
const wrong = (i: number) => `00000${i}`.slice(-6);

interface Session {
  token: string;
  id: string;
}

describe('POST /groups/join', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ann: Session;
  let bob: Session;
  let cat: Session;
  let group: string;
  let users = 0;
  const api = () => request(app.getHttpServer());

  async function signUp(email: string): Promise<Session> {
    const res = await api()
      .post('/auth/register')
      .send({ email, password: 'correct horse' })
      .expect(201);
    const body = res.body as { accessToken: string; user: { id: string } };
    return { token: body.accessToken, id: body.user.id };
  }
  const as = (who: Session) => ({ Authorization: `Bearer ${who.token}` });
  const join = (who: Session, code: unknown) =>
    api().post('/groups/join').set(as(who)).send({ code });
  const newUser = () => signUp(`user${++users}@example.com`);

  async function newGroup(owner: Session, code = CODE) {
    const res = await api()
      .post('/groups')
      .set(as(owner))
      .send({ name: 'Home' })
      .expect(201);
    await ds.query(`update group_invites set code = $2 where group_id = $1`, [
      res.body.id,
      code,
    ]);
    return res.body.id as string;
  }
  const failures = async (who: Session) =>
    (
      await ds.query(
        `select count(*)::int n from group_join_failures where user_id = $1`,
        [who.id],
      )
    )[0].n as number;
  const members = (g = group) =>
    ds.query<{ user_id: string; role: string; left_group: boolean }[]>(
      `select user_id, role, deleted_at is not null as left_group
       from group_members where group_id = $1 order by joined_at, user_id`,
      [g],
    );
  const isMember = async (who: Session, g = group) =>
    (await members(g)).some((m) => m.user_id === who.id && !m.left_group);

  beforeAll(async () => {
    app = await createTestApp();
    // Many parallel calls of the tests each hang a listener on the one server.
    app.getHttpServer().setMaxListeners(100);
    ds = app.get(DataSource);
  });

  beforeEach(async () => {
    await truncateAll(ds);
    users = 0;
    ann = await signUp('ann@example.com');
    bob = await signUp('bob@example.com');
    cat = await signUp('cat@example.com');
    group = await newGroup(ann);
  });

  afterAll(() => app.close());

  it('is closed without a valid token', async () => {
    for (const headers of [{}, { Authorization: 'Bearer garbage' }]) {
      const res = await api()
        .post('/groups/join')
        .set(headers)
        .send({ code: CODE })
        .expect(401);
      expect(res.body.code).toBe('unauthorized');
    }
    expect(await members()).toHaveLength(1);
  });

  describe('a right code', () => {
    it('makes the caller a member and answers with the group’s id', async () => {
      const res = await join(bob, CODE).expect(200);
      expect(res.body).toEqual({ id: group });
      expect(await members()).toEqual([
        { user_id: ann.id, role: 'owner', left_group: false },
        { user_id: bob.id, role: 'member', left_group: false },
      ]);
    });

    it('stays valid for the next person', async () => {
      await join(bob, CODE).expect(200);
      await join(cat, CODE).expect(200);
      expect(await members()).toHaveLength(3);
    });

    it('is not a wrong guess: nothing is written to the failures', async () => {
      await join(bob, CODE).expect(200);
      expect(await failures(bob)).toBe(0);
    });

    it.each([
      ['spaces around', ' 123456 '],
      ['dashes', '123-456'],
      ['spaces inside', '12 34 56'],
      ['letters around', 'abc123456def'],
      ['a new line', '123456\n'],
    ])('is read through %s', async (_name, typed) => {
      const who = await newUser();
      const res = await join(who, typed).expect(200);
      expect(res.body.id).toBe(group);
    });

    it('is not read from digits of another script', async () => {
      const who = await newUser();
      await join(who, '１２３４５６').expect(400);
    });
  });

  describe('already a member', () => {
    it('answers with the id and changes nothing, for the owner and for a member', async () => {
      await join(bob, CODE).expect(200);
      const before = await ds.query(
        `select user_id, joined_at, updated_at from group_members order by user_id`,
      );
      expect((await join(ann, CODE).expect(200)).body).toEqual({ id: group });
      expect((await join(bob, CODE).expect(200)).body).toEqual({ id: group });
      expect(
        await ds.query(
          `select user_id, joined_at, updated_at from group_members order by user_id`,
        ),
      ).toEqual(before);
    });

    it('does not touch the group’s tasks', async () => {
      await join(bob, CODE).expect(200);
      await ds.query(
        `insert into tasks (id, user_id, group_id) values ($1, $2, $3)`,
        [T1, ann.id, group],
      );
      const [{ before }] = await ds.query(
        `select updated_at::text before from tasks`,
      );
      await join(bob, CODE).expect(200);
      const [{ after }] = await ds.query(
        `select updated_at::text after from tasks`,
      );
      expect(after).toBe(before);
    });

    it('two joins at once leave one membership and no error', async () => {
      const results = await Promise.all([
        join(bob, CODE),
        join(bob, CODE),
        join(bob, CODE),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(
        (await members()).filter((m) => m.user_id === bob.id),
      ).toHaveLength(1);
    });
  });

  describe('coming back', () => {
    it('revives the old row instead of adding another', async () => {
      await join(bob, CODE).expect(200);
      await ds.query(
        `update group_members set deleted_at = now(), joined_at = '2020-01-01' where user_id = $1`,
        [bob.id],
      );
      await join(bob, CODE).expect(200);
      const rows = await ds.query(
        `select deleted_at, role, joined_at > '2025-01-01' as fresh
         from group_members where user_id = $1`,
        [bob.id],
      );
      expect(rows).toEqual([{ deleted_at: null, role: 'member', fresh: true }]);
    });
  });

  describe('a wrong code', () => {
    it('is refused with 400 bad_code and recorded', async () => {
      const res = await join(bob, wrong(1)).expect(400);
      expect(res.body.code).toBe('bad_code');
      expect(await failures(bob)).toBe(1);
      expect(await isMember(bob)).toBe(false);
    });

    it('counts, and is not rolled back with the refusal', async () => {
      for (let i = 1; i <= 3; i++) await join(bob, wrong(i)).expect(400);
      expect(await failures(bob)).toBe(3);
    });

    it.each([
      ['empty', ''],
      ['no digits', 'abc'],
      ['five digits', '12345'],
      ['seven digits', '1234567'],
      ['another group’s unknown code', '999999'],
    ])('%s is just a wrong code', async (_name, typed) => {
      const res = await join(bob, typed).expect(400);
      expect(res.body.code).toBe('bad_code');
      expect(await failures(bob)).toBe(1);
    });

    it('is the answer for the code of a deleted group, and recorded', async () => {
      await ds.query(`update groups set deleted_at = now()`);
      const res = await join(bob, CODE).expect(400);
      expect(res.body.code).toBe('bad_code');
      expect(await failures(bob)).toBe(1);
      expect(await isMember(bob)).toBe(false);
    });

    it('is not a validation error when it is merely text', async () => {
      await join(bob, 'x'.repeat(64)).expect(400);
      expect(await failures(bob)).toBe(1);
    });

    it.each([
      ['missing', undefined],
      ['null', null],
      ['a number', 123456],
      ['a list', ['123456']],
      ['text over 64 characters', 'x'.repeat(65)],
    ])(
      '%s is a malformed request: 400 validation_failed, not counted',
      async (_n, code) => {
        const res = await join(bob, code).expect(400);
        expect(res.body.code).toBe('validation_failed');
        expect(await failures(bob)).toBe(0);
      },
    );
  });

  describe('the limit of ten wrong codes an hour', () => {
    it('lets ten through as 400, and answers the eleventh with 429', async () => {
      for (let i = 1; i <= 10; i++) {
        const res = await join(bob, wrong(i)).expect(400);
        expect(res.body.code).toBe('bad_code');
      }
      const res = await join(bob, wrong(11)).expect(429);
      expect(res.body.code).toBe('too_many_requests');
      expect(await failures(bob)).toBe(10);
    });

    it('refuses the right code too once the limit is spent, and does not join', async () => {
      for (let i = 1; i <= 10; i++) await join(bob, wrong(i)).expect(400);
      const res = await join(bob, CODE).expect(429);
      expect(res.body.code).toBe('too_many_requests');
      expect(await isMember(bob)).toBe(false);
    });

    it('lets a right code in after nine wrong ones', async () => {
      for (let i = 1; i <= 9; i++) await join(bob, wrong(i)).expect(400);
      await join(bob, CODE).expect(200);
      expect(await isMember(bob)).toBe(true);
    });

    it('does not touch another account', async () => {
      for (let i = 1; i <= 10; i++) await join(bob, wrong(i)).expect(400);
      await join(bob, wrong(11)).expect(429);
      await join(cat, wrong(1)).expect(400);
      expect(await failures(cat)).toBe(1);
      await join(cat, CODE).expect(200);
    });

    it('does not count an attempt older than an hour', async () => {
      await ds.query(
        `insert into group_join_failures (user_id, at)
         select $1, now() - interval '61 minutes' from generate_series(1, 10)`,
        [bob.id],
      );
      await join(bob, CODE).expect(200);
    });

    it('counts an attempt of 59 minutes ago', async () => {
      await ds.query(
        `insert into group_join_failures (user_id, at)
         select $1, now() - interval '59 minutes' from generate_series(1, 10)`,
        [bob.id],
      );
      await join(bob, CODE).expect(429);
    });

    it('sweeps attempts older than a day at the next wrong guess, and only that account’s', async () => {
      await ds.query(
        `insert into group_join_failures (user_id, at) values
         ($1, now() - interval '25 hours'), ($1, now() - interval '3 hours'),
         ($2, now() - interval '25 hours')`,
        [bob.id, cat.id],
      );
      await join(bob, wrong(1)).expect(400);
      expect(await failures(bob)).toBe(2);
      expect(await failures(cat)).toBe(1);
    });

    it('does not let parallel guesses slip past the count', async () => {
      const results = await Promise.all(
        Array.from({ length: 25 }, (_, i) => join(bob, wrong(i + 1))),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 400)).toHaveLength(10);
      expect(statuses.filter((s) => s === 429)).toHaveLength(15);
      expect(await failures(bob)).toBe(10);
    });

    it('spends the limit exactly once even when the right code is among the parallel guesses', async () => {
      const results = await Promise.all([
        ...Array.from({ length: 12 }, (_, i) => join(bob, wrong(i + 1))),
        join(bob, CODE),
      ]);
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 400)).toHaveLength(10);
      expect(await failures(bob)).toBe(10);
      // The right code is served either before the limit is spent (200) or after (429).
      const right = results[12].status;
      expect([200, 429]).toContain(right);
      expect(await isMember(bob)).toBe(right === 200);
    });
  });

  describe('joining touches what the new member must pull', () => {
    const OLD = '2020-01-01T00:00:00Z';
    // Gives rows an old updated_at, so that a touch is visible.
    async function backdate() {
      for (const table of ['tasks', 'task_logs']) {
        await ds.query(
          `alter table ${table} disable trigger ${table}_updated_at`,
        );
      }
      try {
        await ds.query(`update tasks set updated_at = $1`, [OLD]);
        await ds.query(`update task_logs set updated_at = $1`, [OLD]);
      } finally {
        for (const table of ['tasks', 'task_logs']) {
          await ds.query(
            `alter table ${table} enable trigger ${table}_updated_at`,
          );
        }
      }
    }
    const stamped = async (table: string, key: string, value: string) => {
      const rows = await ds.query<{ fresh: boolean }[]>(
        `select updated_at > '2025-01-01' as fresh from ${table} where ${key} = $1`,
        [value],
      );
      return rows.map((r) => r.fresh);
    };
    const logFresh = async (taskId: string, who: Session) =>
      (
        await ds.query(
          `select updated_at > '2025-01-01' as fresh from task_logs where task_id = $1 and user_id = $2`,
          [taskId, who.id],
        )
      )[0].fresh as boolean;

    let dan: Session;
    let other: string;
    beforeEach(async () => {
      dan = await newUser();
      other = await newGroup(cat, '654321');
      await ds.query(
        `insert into group_members (group_id, user_id) values ($1, $2)`,
        [group, dan.id],
      );
      // T1 live group task with marks of its author and of dan (who then left); T2 a deleted
      // group task; T3 a personal task of the owner; T4 a task of another group.
      await ds.query(
        `insert into tasks (id, user_id, group_id, title, client_updated_at) values
         ($1, $2, $3, 'Buy milk', '2026-01-01T10:00:00Z'), ($4, $2, $3, 'Gone', now()),
         ($5, $2, null, 'Mine', now()), ($6, $7, $8, 'Elsewhere', now())`,
        [T1, ann.id, group, T2, T3, T4, cat.id, other],
      );
      await ds.query(`update tasks set deleted_at = now() where id = $1`, [T2]);
      await ds.query(
        `insert into task_logs (task_id, user_id, date, completed) values
         ($1, $2, '2026-01-15', true), ($1, $3, '2026-01-15', true), ($4, $5, '2026-01-15', true)`,
        [T1, ann.id, dan.id, T4, cat.id],
      );
      await ds.query(
        `update group_members set deleted_at = now() where user_id = $1`,
        [dan.id],
      );
      await backdate();
    });

    it('stamps the live tasks of the group and every mark of them, a leaver’s included', async () => {
      await join(bob, CODE).expect(200);
      expect(await stamped('tasks', 'id', T1)).toEqual([true]);
      expect(await logFresh(T1, ann)).toBe(true);
      expect(await logFresh(T1, dan)).toBe(true);
    });

    it('leaves the content as it was, the device’s time included', async () => {
      await join(bob, CODE).expect(200);
      const [row] = await ds.query(
        `select title, client_updated_at::text c, user_id from tasks where id = $1`,
        [T1],
      );
      expect(row).toEqual({
        title: 'Buy milk',
        c: '2026-01-01 10:00:00+00',
        user_id: ann.id,
      });
      const marks = await ds.query(
        `select user_id, completed from task_logs where task_id = $1 order by user_id`,
        [T1],
      );
      expect(marks).toHaveLength(2);
      expect(marks.every((m: { completed: boolean }) => m.completed)).toBe(
        true,
      );
    });

    it('leaves alone a deleted task, a personal task, another group’s tasks and marks', async () => {
      await join(bob, CODE).expect(200);
      expect(await stamped('tasks', 'id', T2)).toEqual([false]);
      expect(await stamped('tasks', 'id', T3)).toEqual([false]);
      expect(await stamped('tasks', 'id', T4)).toEqual([false]);
      expect(await logFresh(T4, cat)).toBe(false);
    });

    it('touches nothing when the code was wrong or the limit was spent', async () => {
      await join(bob, wrong(1)).expect(400);
      for (let i = 2; i <= 10; i++) await join(bob, wrong(i)).expect(400);
      await join(bob, CODE).expect(429);
      expect(await stamped('tasks', 'id', T1)).toEqual([false]);
    });

    it('touches the group of a member who comes back too', async () => {
      await join(dan, CODE).expect(200);
      expect(await stamped('tasks', 'id', T1)).toEqual([true]);
    });
  });
});
