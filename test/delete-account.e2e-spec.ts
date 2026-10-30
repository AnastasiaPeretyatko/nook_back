import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import {
  GoogleIdentity,
  GoogleTokenVerifier,
  InvalidGoogleToken,
} from '../src/auth/google-token.verifier';
import { createTestApp, truncateAll } from './support/db';
import { PullBody } from './support/fake-device';
import {
  CHANGED,
  listenForSockets,
  nextMessage,
  quiet,
  Sockets,
} from './support/ws-client';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [T_ANN, T_BOB, T_BOB_PERSONAL, T_G2_BOB, T_G2_CAT, T_ANN_PERSONAL] = [
  1, 2, 3, 4, 5, 6,
].map(id);
const [MOOD, TAG, NOTE, ANN_NOTE] = [11, 12, 13, 14].map(id);
const CODE1 = '111111';
const CODE2 = '222222';
const DAY = '2026-01-15';
const PHONE = 'phone-token-bob-0123456789-abcdefghij';

interface Session {
  token: string;
  refresh: string;
  id: string;
  email: string;
}

describe('DELETE /me (B8.5)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let sockets: Sockets;
  let ann: Session; // owns G1; bob is a member
  let bob: Session; // the one who deletes; owns G2 (with cat)
  let cat: Session; // member of G2
  let dan: Session; // a stranger
  let G1: string;
  let G2: string;
  const api = () => request(app.getHttpServer());
  const as = (who: Session) => ({ Authorization: `Bearer ${who.token}` });

  // "Google": the token is looked up here instead of being verified against Google's keys.
  const issued = new Map<string, GoogleIdentity>();
  const fakeVerifier = {
    verify: (token: string) =>
      issued.has(token)
        ? Promise.resolve(issued.get(token) as GoogleIdentity)
        : Promise.reject(new InvalidGoogleToken('no such token')),
  };
  const googleToken = (sub: string, email = `${sub}@gmail.com`) => {
    const token = `token-${issued.size}`;
    issued.set(token, {
      sub,
      email,
      emailVerified: true,
      name: 'Gus Google',
      picture: null,
    });
    return token;
  };

  async function signUp(name: string): Promise<Session> {
    const email = `${name}@example.com`;
    const res = await api()
      .post('/auth/register')
      .send({ email, password: 'correct horse' })
      .expect(201);
    const body = res.body as {
      accessToken: string;
      refreshToken: string;
      user: { id: string };
    };
    return {
      token: body.accessToken,
      refresh: body.refreshToken,
      id: body.user.id,
      email,
    };
  }
  const push = async (who: Session, body: object) => {
    const res = await api()
      .post('/sync/push')
      .set(as(who))
      .send(body)
      .expect(200);
    expect((res.body as { rejected: unknown[] }).rejected).toEqual([]);
  };
  const pull = async (who: Session, query = '?include=tasks,diary,cycle') =>
    (await api().get(`/sync/pull${query}`).set(as(who)).expect(200))
      .body as PullBody;
  // `null` = a request without any body.
  const del = (
    who: Session,
    body: object | null = { password: 'correct horse' },
  ) => {
    const call = api().delete('/me').set(as(who));
    return body === null ? call : call.send(body);
  };
  const one = async (sql: string, ...params: unknown[]) =>
    (await ds.query(sql, params))[0] as Record<string, unknown>;
  const count = async (sql: string, ...params: unknown[]) =>
    (await one(`select count(*)::int n from (${sql}) q`, ...params))
      .n as number;

  beforeAll(async () => {
    app = await createTestApp([], 0, (b) =>
      b.overrideProvider(GoogleTokenVerifier).useValue(fakeVerifier),
    );
    app.getHttpServer().setMaxListeners(100);
    ds = app.get(DataSource);
    sockets = await listenForSockets(app);
  });

  afterEach(async () => {
    await sockets.closeAll();
    await ds.query(`drop trigger if exists test_break_delete on cycle_days`);
    await ds.query(`drop function if exists test_break_delete()`);
  });

  afterAll(() => app.close());

  beforeEach(async () => {
    await truncateAll(ds);
    issued.clear();
    [ann, bob, cat, dan] = [
      await signUp('ann'),
      await signUp('bob'),
      await signUp('cat'),
      await signUp('dan'),
    ];
    const group = async (who: Session, name: string, code: string) => {
      const res = await api()
        .post('/groups')
        .set(as(who))
        .send({ name })
        .expect(201);
      const gid = (res.body as { id: string }).id;
      await ds.query(`update group_invites set code = $2 where group_id = $1`, [
        gid,
        code,
      ]);
      return gid;
    };
    G1 = await group(ann, 'Home', CODE1);
    G2 = await group(bob, 'Our place', CODE2);
    await api()
      .post('/groups/join')
      .set(as(bob))
      .send({ code: CODE1 })
      .expect(200);
    await api()
      .post('/groups/join')
      .set(as(cat))
      .send({ code: CODE2 })
      .expect(200);
    for (const [who, name] of [
      [ann, 'Ann'],
      [bob, 'Bob'],
      [cat, 'Cat'],
    ] as const) {
      await api()
        .put('/me/profile')
        .set(as(who))
        .send({ displayName: name, avatarUrl: null })
        .expect(200);
    }
    await api().put('/devices').set(as(bob)).send({ token: PHONE }).expect(204);

    // Ann: a group task for Bob, and her own private things.
    await push(ann, {
      tasks: [
        {
          id: T_ANN,
          group_id: G1,
          title: 'ann group task',
          assignee_id: bob.id,
        },
        { id: T_ANN_PERSONAL, title: 'SECRET-ANN-TASK' },
      ],
      entries: [{ id: ANN_NOTE, title: 'SECRET-ANN-NOTE', body: 'x' }],
      cycle_days: [{ date: DAY, note: 'SECRET-ANN-CYCLE', flow: 2 }],
    });
    // Bob: his own task in Ann's group, a mark on Ann's task, a task in his group, and everything
    // private there is.
    await push(bob, {
      tasks: [
        { id: T_BOB, group_id: G1, title: 'bob group task' },
        { id: T_G2_BOB, group_id: G2, title: 'bob task in his own group' },
        { id: T_BOB_PERSONAL, title: 'SECRET-BOB-TASK' },
      ],
      logs: [
        { task_id: T_ANN, date: DAY, completed: true, value: 1 },
        { task_id: T_BOB_PERSONAL, date: DAY, completed: true, value: 42 },
      ],
      moods: [{ id: MOOD, name: 'SECRET-BOB-MOOD', emoji: '🙂' }],
      tags: [{ id: TAG, name: 'SECRET-BOB-TAG' }],
      entries: [
        {
          id: NOTE,
          title: 'SECRET-BOB-NOTE',
          body: 'SECRET-BOB-BODY',
          mood_ids: [MOOD],
          tag_ids: [TAG],
        },
      ],
      cycle_days: [{ date: DAY, note: 'SECRET-BOB-CYCLE', flow: 3 }],
    });
    await push(cat, {
      tasks: [{ id: T_G2_CAT, group_id: G2, title: 'cat task in bobs group' }],
    });
    await ds.query(`insert into group_join_failures (user_id) values ($1)`, [
      bob.id,
    ]);
  });

  describe('what must be proved', () => {
    it('is closed without a token', async () => {
      await api().delete('/me').send({ password: 'correct horse' }).expect(401);
    });

    it.each([
      ['no body', null],
      ['an empty body', {}],
      [
        'both password and idToken',
        { password: 'correct horse', idToken: 'x' },
      ],
      ['null instead of the password', { password: null }],
    ])(
      '%s: 400 confirmation_required, nothing deleted',
      async (_name, body) => {
        const res = await del(bob, body).expect(400);
        expect((res.body as { code: string }).code).toBe(
          'confirmation_required',
        );
        expect(
          await one(`select deleted_at from users where id = $1`, bob.id),
        ).toEqual({ deleted_at: null });
      },
    );

    it.each([
      ['a wrong password', 'wrong password'],
      ['an empty password', ''],
    ])(
      '%s: 401 invalid_credentials, nothing deleted',
      async (_name, password) => {
        const res = await del(bob, { password }).expect(401);
        expect((res.body as { code: string }).code).toBe('invalid_credentials');
        expect(
          await count(`select 1 from tasks where user_id = $1`, bob.id),
        ).toBe(3);
        expect(
          await count(
            `select 1 from users where id = $1 and deleted_at is null`,
            bob.id,
          ),
        ).toBe(1);
      },
    );

    it('an account with a password does not accept a Google token', async () => {
      const res = await del(bob, { idToken: googleToken('some-sub') }).expect(
        401,
      );
      expect((res.body as { code: string }).code).toBe('invalid_credentials');
    });

    it('deletes the caller, never the person named in the body', async () => {
      await del(bob, {
        password: 'correct horse',
        userId: ann.id,
        id: ann.id,
      }).expect(204);
      expect(
        await count(
          `select 1 from users where id = $1 and deleted_at is null`,
          ann.id,
        ),
      ).toBe(1);
      expect(
        await count(
          `select 1 from users where id = $1 and deleted_at is not null`,
          bob.id,
        ),
      ).toBe(1);
    });

    it('someone else’s password does not open the door', async () => {
      // Bob's token with Ann's password: the password is Bob's to know, and it is the same text
      // here, so use a different one for Ann to tell them apart.
      const other = await api()
        .post('/auth/register')
        .send({ email: 'eve@example.com', password: 'eve has other words' })
        .expect(201);
      const eve = other.body as { accessToken: string };
      await api()
        .delete('/me')
        .set('Authorization', `Bearer ${eve.accessToken}`)
        .send({ password: 'correct horse' })
        .expect(401);
    });
  });

  describe('a Google-only account', () => {
    let gus: Session;
    const SUB = 'google-sub-gus';

    beforeEach(async () => {
      const res = await api()
        .post('/auth/google')
        .send({ idToken: googleToken(SUB) })
        .expect(200);
      const body = res.body as {
        accessToken: string;
        refreshToken: string;
        user: { id: string; email: string };
      };
      gus = {
        token: body.accessToken,
        refresh: body.refreshToken,
        id: body.user.id,
        email: body.user.email,
      };
    });

    it('is deleted with a fresh token of its own Google account', async () => {
      await del(gus, { idToken: googleToken(SUB) }).expect(204);
      const user = await one(
        `select email, google_sub, password_hash, deleted_at is not null as gone from users where id = $1`,
        gus.id,
      );
      expect(user).toEqual({
        email: `deleted-${gus.id}@deleted.invalid`,
        google_sub: null,
        password_hash: null,
        gone: true,
      });
    });

    it('is not deleted by a password, by another Google account or by a bad token', async () => {
      let res = await del(gus, { password: 'anything at all' }).expect(401);
      expect((res.body as { code: string }).code).toBe('invalid_credentials');
      res = await del(gus, { idToken: googleToken('another-sub') }).expect(401);
      expect((res.body as { code: string }).code).toBe('invalid_credentials');
      res = await del(gus, { idToken: 'not-a-token' }).expect(401);
      expect((res.body as { code: string }).code).toBe('google_token_invalid');
      expect(
        await count(
          `select 1 from users where id = $1 and deleted_at is null`,
          gus.id,
        ),
      ).toBe(1);
    });

    it('signing in with the same Google account afterwards makes a brand new account', async () => {
      await del(gus, { idToken: googleToken(SUB) }).expect(204);
      const res = await api()
        .post('/auth/google')
        .send({ idToken: googleToken(SUB) })
        .expect(200);
      const again = res.body as { user: { id: string; email: string } };
      expect(again.user.id).not.toBe(gus.id);
      expect(again.user.email).toBe(gus.email);
    });
  });

  describe('after a successful deletion', () => {
    beforeEach(async () => {
      await del(bob).expect(204);
    });

    it('nothing personal is left, in any table', async () => {
      // Every table, every row, written out as text: the secrets, the email and the name are gone.
      const tables: { tablename: string }[] = await ds.query(
        `select tablename from pg_tables where schemaname = 'public' and tablename <> 'migrations'`,
      );
      for (const { tablename } of tables) {
        for (const needle of ['SECRET-BOB', 'bob@example.com', 'Bob', PHONE]) {
          const n = await count(
            `select 1 from "${tablename}" t where t::text like $1`,
            `%${needle}%`,
          );
          expect([tablename, needle, n]).toEqual([tablename, needle, 0]);
        }
      }
    });

    it('the user row is an empty shell with a made-up email', async () => {
      expect(
        await one(
          `select email, password_hash, google_sub, deleted_at is not null as gone from users where id = $1`,
          bob.id,
        ),
      ).toEqual({
        email: `deleted-${bob.id}@deleted.invalid`,
        password_hash: null,
        google_sub: null,
        gone: true,
      });
    });

    it('every table that points at the person holds only what the plan lets stay', async () => {
      // Found from the schema, not from a list: a table added later and forgotten here fails.
      const columns: { table_name: string; column_name: string }[] =
        await ds.query(
          `select table_name, column_name from information_schema.columns
         where table_schema = 'public'
           and column_name in ('user_id', 'owner_id', 'assignee_id', 'id')
           and table_name <> 'migrations'`,
        );
      const left: Record<string, number> = {};
      for (const { table_name, column_name } of columns) {
        if (
          table_name === 'users' ||
          (column_name === 'id' && table_name !== 'users')
        )
          continue;
        const n = await count(
          `select 1 from "${table_name}" where "${column_name}" = $1`,
          bob.id,
        );
        if (n > 0) left[`${table_name}.${column_name}`] = n;
      }
      expect(left).toEqual({
        'tasks.user_id': 2, // his group tasks in Ann's group and in his own (emptied)
        'task_logs.user_id': 1, // his mark on Ann's task
        'group_members.user_id': 2, // both memberships, ended
        'groups.owner_id': 1, // his group, deleted
      });
    });

    it('private data is gone, other people’s is untouched', async () => {
      expect(
        await count(`select 1 from tasks where id = $1`, T_BOB_PERSONAL),
      ).toBe(0);
      expect(
        await count(
          `select 1 from task_logs where task_id = $1`,
          T_BOB_PERSONAL,
        ),
      ).toBe(0);
      expect(
        await count(`select 1 from diary_entries where id = $1`, NOTE),
      ).toBe(0);
      expect(await count(`select 1 from device_tokens`)).toBe(0);
      // The eight starter moods belong to nobody and stay.
      expect(
        await count(`select 1 from note_moods where user_id is null`),
      ).toBe(8);
      const annSees = await pull(ann);
      expect(JSON.stringify(annSees)).toContain('SECRET-ANN-TASK');
      expect(JSON.stringify(annSees)).toContain('SECRET-ANN-NOTE');
      expect(JSON.stringify(annSees)).toContain('SECRET-ANN-CYCLE');
      expect(
        await count(
          `select 1 from tasks where id = $1 and deleted_at is null`,
          T_ANN_PERSONAL,
        ),
      ).toBe(1);
    });

    it('a group he owned is deleted for its members; one he was in carries on without him', async () => {
      expect(
        await one(
          `select deleted_at is not null as gone from groups where id = $1`,
          G2,
        ),
      ).toEqual({ gone: true });
      expect(
        await one(
          `select deleted_at is not null as gone from groups where id = $1`,
          G1,
        ),
      ).toEqual({ gone: false });
      // Cat: G2 is gone from her snapshot and its tasks are deleted.
      const catSees = await pull(cat);
      expect(catSees.groups!.groups.map((g) => g.id)).not.toContain(G2);
      expect(
        await count(
          `select 1 from tasks where group_id = $1 and deleted_at is null`,
          G2,
        ),
      ).toBe(0);
      // Ann: G1 is there, Bob is not a member, his task is still the group's, nameless.
      const annSees = await pull(ann);
      expect(annSees.groups!.groups.map((g) => g.id)).toEqual([G1]);
      expect(annSees.groups!.members.map((m) => m.user_id)).toEqual([ann.id]);
      expect(annSees.tasks.find((t) => t.id === T_BOB)).toMatchObject({
        title: 'bob group task',
        user_id: bob.id,
      });
      expect(JSON.stringify(annSees)).not.toContain('Bob');
    });

    it('his mark on Ann’s task stays and the task is no longer assigned to him', async () => {
      expect(
        await one(`select assignee_id from tasks where id = $1`, T_ANN),
      ).toEqual({ assignee_id: null });
      expect(
        await count(
          `select 1 from task_logs where task_id = $1 and user_id = $2`,
          T_ANN,
          bob.id,
        ),
      ).toBe(1);
    });

    it('the tokens stop working: sign-in, renewal, and the account itself', async () => {
      let res = await api()
        .post('/auth/login')
        .send({ email: bob.email, password: 'correct horse' })
        .expect(401);
      expect((res.body as { code: string }).code).toBe('invalid_credentials');
      res = await api()
        .post('/auth/refresh')
        .send({ refreshToken: bob.refresh })
        .expect(401);
      expect((res.body as { code: string }).code).toBe('invalid_refresh_token');
      // The access token is checked by its signature only (up to an hour); the routes that read
      // the account see nobody.
      await api().get('/me').set(as(bob)).expect(401);
      await api()
        .put('/me/profile')
        .set(as(bob))
        .send({ displayName: 'Ghost', avatarUrl: null })
        .expect(401);
    });

    it('the email can be taken again, by a new empty account', async () => {
      const again = await signUp('bob');
      expect(again.id).not.toBe(bob.id);
      const sees = await pull(again);
      expect(sees.tasks).toEqual([]);
      expect(sees.groups).toEqual({ groups: [], members: [] });
      expect(JSON.stringify(sees)).not.toContain('SECRET-BOB');
    });

    it('a repeat is harmless and changes nothing', async () => {
      const before = await count(`select 1 from tasks`);
      await del(bob).expect(204);
      await del(bob, null).expect(204);
      await del(bob, { password: 'wrong' }).expect(204);
      expect(await count(`select 1 from tasks`)).toBe(before);
      expect(
        await count(`select 1 from users where deleted_at is not null`),
      ).toBe(1);
    });
  });

  it('two deletions at the same moment both answer 204 and the account is deleted once', async () => {
    const results = await Promise.all([del(bob), del(bob)]);
    expect(results.map((r) => r.status)).toEqual([204, 204]);
    expect(
      await count(`select 1 from users where deleted_at is not null`),
    ).toBe(1);
    expect(
      await count(
        `select 1 from tasks where user_id = $1 and group_id is null`,
        bob.id,
      ),
    ).toBe(0);
  });

  it('a failure in the middle changes nothing at all', async () => {
    await ds.query(`
      create function test_break_delete() returns trigger language plpgsql as $$
      begin raise exception 'broken on purpose'; end; $$`);
    await ds.query(`create trigger test_break_delete before delete on cycle_days
      for each row execute function test_break_delete()`);
    const before = await one(
      `select (select count(*) from tasks) t, (select count(*) from group_members where deleted_at is null) m,
              (select count(*) from groups where deleted_at is null) g, (select count(*) from device_tokens) d`,
    );
    await del(bob).expect(500);
    expect(
      await one(
        `select (select count(*) from tasks) t, (select count(*) from group_members where deleted_at is null) m,
                (select count(*) from groups where deleted_at is null) g, (select count(*) from device_tokens) d`,
      ),
    ).toEqual(before);
    expect(
      await count(
        `select 1 from users where id = $1 and deleted_at is null`,
        bob.id,
      ),
    ).toBe(1);
    // And it can be tried again once the fault is gone.
    await ds.query(`drop trigger test_break_delete on cycle_days`);
    await del(bob).expect(204);
  });

  it('rings the people of his groups, and nobody else', async () => {
    const annSocket = await sockets.join(ann.token);
    const catSocket = await sockets.join(cat.token);
    const danSocket = await sockets.join(dan.token);
    await del(bob).expect(204);
    expect(await nextMessage(annSocket)).toBe(CHANGED);
    expect(await nextMessage(catSocket)).toBe(CHANGED);
    await quiet(150);
    expect(danSocket.messages).toEqual([]);
  });
});
