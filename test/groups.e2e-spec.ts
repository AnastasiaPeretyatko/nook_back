import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import * as inviteCode from '../src/groups/invite-code';
import { createTestApp, truncateAll } from './support/db';

const NOBODY = '00000000-0000-4000-8000-0000000000ff';

interface Session {
  token: string;
  id: string;
}

describe('Groups: create, rename, invite code', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ann: Session;
  let bob: Session;
  let cat: Session;
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
  const create = (who: Session, body: object = { name: 'Home' }) =>
    api().post('/groups').set(as(who)).send(body);
  const rename = (who: Session, id: string, body: object = { name: 'New' }) =>
    api().patch(`/groups/${id}`).set(as(who)).send(body);
  const invite = (who: Session, id: string) =>
    api().get(`/groups/${id}/invite`).set(as(who));
  const regenerate = (who: Session, id: string) =>
    api().post(`/groups/${id}/invite/regenerate`).set(as(who));
  const newGroup = async (who: Session, name = 'Home') =>
    (await create(who, { name }).expect(201)).body.id as string;

  const addMember = (group: string, who: Session) =>
    ds.query(`insert into group_members (group_id, user_id) values ($1, $2)`, [
      group,
      who.id,
    ]);
  const dbGroup = async (id: string) =>
    (await ds.query(`select * from groups where id = $1`, [id]))[0] as Record<
      string,
      unknown
    >;
  const dbCode = async (id: string) =>
    (
      await ds.query(`select code from group_invites where group_id = $1`, [id])
    )[0]?.code as string;

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
  });

  beforeEach(async () => {
    await truncateAll(ds);
    ann = await signUp('ann@example.com');
    bob = await signUp('bob@example.com');
    cat = await signUp('cat@example.com');
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(() => app.close());

  describe('without a valid token', () => {
    const routes: [string, string][] = [
      ['post', '/groups'],
      ['patch', `/groups/${NOBODY}`],
      ['get', `/groups/${NOBODY}/invite`],
      ['post', `/groups/${NOBODY}/invite/regenerate`],
    ];

    it.each(routes)('%s %s is closed', async (method, path) => {
      const call = (headers: Record<string, string>) =>
        (api() as unknown as Record<string, (p: string) => request.Test>)
          [method](path)
          .set(headers)
          .send({ name: 'x' });
      const bad: Record<string, string>[] = [
        {},
        { Authorization: 'Bearer garbage' },
        { Authorization: 'Basic abc' },
      ];
      for (const headers of bad) {
        const res = await call(headers).expect(401);
        expect(res.body.code).toBe('unauthorized');
      }
    });
  });

  describe('POST /groups', () => {
    it('makes the group, the owner’s membership and a six-digit code, and answers with the id only', async () => {
      const res = await create(ann).expect(201);
      expect(Object.keys(res.body)).toEqual(['id']);
      const group = res.body.id as string;
      expect(await dbGroup(group)).toMatchObject({
        name: 'Home',
        owner_id: ann.id,
        deleted_at: null,
      });
      expect(
        await ds.query(`select user_id, role, deleted_at from group_members`),
      ).toEqual([{ user_id: ann.id, role: 'owner', deleted_at: null }]);
      expect(await dbCode(group)).toMatch(/^[0-9]{6}$/);
    });

    it('trims the name', async () => {
      const group = (await create(ann, { name: '  Home  ' }).expect(201)).body
        .id;
      expect((await dbGroup(group)).name).toBe('Home');
    });

    it('takes a name of 1 and of 100 characters', async () => {
      await create(ann, { name: 'x' }).expect(201);
      await create(ann, { name: 'x'.repeat(100) }).expect(201);
    });

    it.each([
      ['empty', { name: '' }],
      ['blank', { name: '   ' }],
      ['101 characters', { name: 'x'.repeat(101) }],
      ['101 characters after trimming', { name: ` ${'x'.repeat(101)} ` }],
      ['missing', {}],
      ['null', { name: null }],
      ['a number', { name: 5 }],
      ['a list', { name: ['a'] }],
    ])('refuses a name that is %s, and makes nothing', async (_n, body) => {
      const res = await create(ann, body).expect(400);
      expect(res.body.code).toBe('validation_failed');
      const [{ n }] = await ds.query(`select count(*)::int n from groups`);
      expect(n).toBe(0);
    });

    it('ignores an owner (or any other field) named in the body: the owner is the token’s user', async () => {
      const group = (
        await create(ann, {
          name: 'Home',
          owner_id: bob.id,
          id: NOBODY,
        }).expect(201)
      ).body.id;
      expect(group).not.toBe(NOBODY);
      expect((await dbGroup(group)).owner_id).toBe(ann.id);
    });

    it('gives different groups different codes', async () => {
      const codes = new Set<string>();
      for (let i = 0; i < 20; i++) codes.add(await dbCode(await newGroup(ann)));
      expect(codes.size).toBe(20);
    });

    it('draws again when the code is taken', async () => {
      const first = await newGroup(ann);
      const taken = await dbCode(first);
      const draw = jest
        .spyOn(inviteCode, 'newInviteCode')
        .mockReturnValueOnce(taken)
        .mockReturnValueOnce(taken)
        .mockReturnValueOnce('012345');
      const second = await newGroup(bob);
      expect(draw).toHaveBeenCalledTimes(3);
      expect(await dbCode(second)).toBe('012345');
      expect(await dbCode(first)).toBe(taken);
    });

    it('leaves nothing behind when no code can be had', async () => {
      const first = await newGroup(ann);
      jest
        .spyOn(inviteCode, 'newInviteCode')
        .mockReturnValue(await dbCode(first));
      await create(bob).expect(500);
      const [{ n }] = await ds.query(`select count(*)::int n from groups`);
      expect(n).toBe(1);
      const [{ m }] = await ds.query(
        `select count(*)::int m from group_members`,
      );
      expect(m).toBe(1);
    });
  });

  describe('PATCH /groups/:id', () => {
    it('renames for the owner, answers 204, and moves updated_at', async () => {
      const group = await newGroup(ann);
      const before = (await dbGroup(group)).updated_at as Date;
      const res = await rename(ann, group, { name: '  Office ' });
      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      const after = await dbGroup(group);
      expect(after.name).toBe('Office');
      expect((after.updated_at as Date) > before).toBe(true);
    });

    it('does not let a member rename: 403 not_owner', async () => {
      const group = await newGroup(ann);
      await addMember(group, bob);
      const res = await rename(bob, group).expect(403);
      expect(res.body.code).toBe('not_owner');
      expect((await dbGroup(group)).name).toBe('Home');
    });

    it('answers a stranger exactly as it answers a group that is not there', async () => {
      const group = await newGroup(ann);
      const stranger = await rename(bob, group).expect(404);
      const missing = await rename(bob, NOBODY).expect(404);
      expect(stranger.body).toEqual(missing.body);
      expect(stranger.body.code).toBe('not_found');
      expect((await dbGroup(group)).name).toBe('Home');
    });

    it('answers 404 for an id that is not a uuid', async () => {
      const res = await rename(ann, 'nope').expect(404);
      expect(res.body.code).toBe('not_found');
    });

    it('answers 404 for a member who has left and for a deleted group', async () => {
      const group = await newGroup(ann);
      await addMember(group, bob);
      await ds.query(
        `update group_members set deleted_at = now() where user_id = $1`,
        [bob.id],
      );
      await rename(bob, group).expect(404);
      await ds.query(`update groups set deleted_at = now()`);
      await rename(ann, group).expect(404);
    });

    it('refuses a bad name with 400, and keeps the old one', async () => {
      const group = await newGroup(ann);
      for (const body of [{ name: '' }, { name: 'x'.repeat(101) }, {}]) {
        const res = await rename(ann, group, body).expect(400);
        expect(res.body.code).toBe('validation_failed');
      }
      expect((await dbGroup(group)).name).toBe('Home');
    });

    it('cannot move the group to another owner through the body', async () => {
      const group = await newGroup(ann);
      await rename(ann, group, { name: 'New', owner_id: bob.id }).expect(204);
      expect((await dbGroup(group)).owner_id).toBe(ann.id);
    });

    it('touches only that group', async () => {
      const one = await newGroup(ann, 'one');
      const two = await newGroup(ann, 'two');
      await rename(ann, one).expect(204);
      expect((await dbGroup(two)).name).toBe('two');
    });
  });

  describe('GET /groups/:id/invite', () => {
    it('gives the owner the code', async () => {
      const group = await newGroup(ann);
      const res = await invite(ann, group).expect(200);
      expect(res.body).toEqual({ code: await dbCode(group) });
      expect(res.body.code).toMatch(/^[0-9]{6}$/);
      expect((await invite(ann, group)).body).toEqual(res.body);
    });

    it('does not give it to a member: 403 not_owner', async () => {
      const group = await newGroup(ann);
      await addMember(group, bob);
      const res = await invite(bob, group).expect(403);
      expect(res.body).toEqual({
        code: 'not_owner',
        message: expect.any(String),
      });
      expect(JSON.stringify(res.body)).not.toContain(await dbCode(group));
    });

    it('does not give it to a stranger, even the owner of another group', async () => {
      const group = await newGroup(ann);
      await newGroup(bob);
      const res = await invite(bob, group).expect(404);
      expect(res.body.code).toBe('not_found');
      expect(JSON.stringify(res.body)).not.toContain(await dbCode(group));
    });

    it('answers 404 for a member who has left, for a deleted group and for a bad id', async () => {
      const group = await newGroup(ann);
      await addMember(group, bob);
      await ds.query(
        `update group_members set deleted_at = now() where user_id = $1`,
        [bob.id],
      );
      await invite(bob, group).expect(404);
      await invite(ann, 'nope').expect(404);
      await ds.query(`update groups set deleted_at = now()`);
      await invite(ann, group).expect(404);
    });

    it('gives each group its own code', async () => {
      const one = await newGroup(ann, 'one');
      const two = await newGroup(ann, 'two');
      const a = (await invite(ann, one)).body.code;
      const b = (await invite(ann, two)).body.code;
      expect(a).toBe(await dbCode(one));
      expect(b).toBe(await dbCode(two));
      expect(a).not.toBe(b);
    });
  });

  describe('POST /groups/:id/invite/regenerate', () => {
    it('gives the owner a new code at once: the old one is gone', async () => {
      const group = await newGroup(ann);
      const old = await dbCode(group);
      jest.spyOn(inviteCode, 'newInviteCode').mockReturnValue('999999');
      const res = await regenerate(ann, group).expect(200);
      expect(res.body).toEqual({ code: '999999' });
      expect(await dbCode(group)).toBe('999999');
      expect((await invite(ann, group)).body.code).toBe('999999');
      expect(
        await ds.query(`select 1 from group_invites where code = $1`, [old]),
      ).toEqual([]);
    });

    it('draws again when the new code is taken, and never gives one that another group has', async () => {
      const mine = await newGroup(ann, 'mine');
      const other = await newGroup(bob, 'other');
      const taken = await dbCode(other);
      const draw = jest
        .spyOn(inviteCode, 'newInviteCode')
        .mockReturnValueOnce(taken)
        .mockReturnValueOnce('424242');
      const res = await regenerate(ann, mine).expect(200);
      expect(draw).toHaveBeenCalledTimes(2);
      expect(res.body.code).toBe('424242');
      expect(await dbCode(other)).toBe(taken);
    });

    it('does not touch the code of another group', async () => {
      const mine = await newGroup(ann, 'mine');
      const other = await newGroup(ann, 'other');
      const before = await dbCode(other);
      await regenerate(ann, mine).expect(200);
      expect(await dbCode(other)).toBe(before);
    });

    it('does not let a member: 403 not_owner, and the code stays', async () => {
      const group = await newGroup(ann);
      await addMember(group, bob);
      const before = await dbCode(group);
      const res = await regenerate(bob, group).expect(403);
      expect(res.body.code).toBe('not_owner');
      expect(await dbCode(group)).toBe(before);
    });

    it('does not let a stranger: 404, and the code stays', async () => {
      const group = await newGroup(ann);
      const before = await dbCode(group);
      const res = await regenerate(cat, group).expect(404);
      expect(res.body.code).toBe('not_found');
      await regenerate(cat, NOBODY).expect(404);
      await regenerate(cat, 'nope').expect(404);
      expect(await dbCode(group)).toBe(before);
    });

    it('answers 404 for a member who has left and for a deleted group', async () => {
      const group = await newGroup(ann);
      await addMember(group, bob);
      await ds.query(
        `update group_members set deleted_at = now() where user_id = $1`,
        [bob.id],
      );
      await regenerate(bob, group).expect(404);
      await ds.query(`update groups set deleted_at = now()`);
      await regenerate(ann, group).expect(404);
    });

    it('keeps the members who joined with the old code', async () => {
      const group = await newGroup(ann);
      await addMember(group, bob);
      await regenerate(ann, group).expect(200);
      const [{ n }] = await ds.query(
        `select count(*)::int n from group_members where deleted_at is null`,
      );
      expect(n).toBe(2);
    });
  });
});
