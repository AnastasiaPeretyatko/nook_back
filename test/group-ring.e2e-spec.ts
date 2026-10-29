import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { RealtimeService } from '../src/realtime/realtime.service';
import { createTestApp, truncateAll } from './support/db';
import { CHANGED, Client, listenForSockets, quiet } from './support/ws-client';

interface Session {
  token: string;
  id: string;
}

// Rings after group actions and profile changes (B6.4): who hears and who does not.
// Per test: group G = Ann (owner, two phones), Bob (two phones), Cat. Dan and Eve are outsiders;
// Dan has two phones, Eve has two.
describe('rings on group actions and profile changes', () => {
  let app: INestApplication;
  let ds: DataSource;
  let listen: Awaited<ReturnType<typeof listenForSockets>>;
  let G: string;
  const users: Record<string, Session> = {};
  let phones: Record<string, Client> = {};
  const api = () => request(app.getHttpServer());
  const as = (who: string) => ({ Authorization: `Bearer ${users[who].token}` });

  async function signUp(name: string) {
    const res = await api()
      .post('/auth/register')
      .send({ email: `${name}@example.com`, password: 'correct horse' })
      .expect(201);
    const body = res.body as { accessToken: string; user: { id: string } };
    users[name] = { token: body.accessToken, id: body.user.id };
  }

  // One call, from the phone `device` of `who`.
  const call = (
    method: 'post' | 'patch' | 'delete' | 'put' | 'get',
    path: string,
    who: string,
    body?: object,
    device?: string,
  ) => {
    const req = api()[method](path).set(as(who));
    if (device) req.set('X-Device-Id', device);
    return body ? req.send(body) : req;
  };
  const inviteCode = async () =>
    (
      await ds.query(`select code from group_invites where group_id = $1`, [G])
    )[0].code as string;
  const memberRows = async () =>
    ds.query<{ user_id: string; gone: boolean }[]>(
      `select user_id, deleted_at is not null as gone from group_members where group_id = $1`,
      [G],
    );

  // Who got a message, after giving the server a moment. Each is exactly one ring.
  const heard = async () => {
    await quiet(120);
    const got = Object.entries(phones).filter(([, c]) => c.messages.length > 0);
    for (const [, c] of got) expect(c.messages).toEqual([CHANGED]);
    return got.map(([name]) => name).sort();
  };
  const hush = () => {
    for (const c of Object.values(phones)) c.messages.length = 0;
  };

  beforeAll(async () => {
    app = await createTestApp();
    app.getHttpServer().setMaxListeners(100);
    ds = app.get(DataSource);
    listen = await listenForSockets(app);
    await truncateAll(ds);
    for (const n of ['ann', 'bob', 'cat', 'dan', 'eve']) await signUp(n);
  });

  beforeEach(async () => {
    await ds.query(`truncate groups, profiles cascade`);
    const res = await call('post', '/groups', 'ann', { name: 'Home' }).expect(
      201,
    );
    G = (res.body as { id: string }).id;
    // A known code, so that a test can name it before the group exists.
    const code = '111111';
    await ds.query(`update group_invites set code = $2 where group_id = $1`, [
      G,
      code,
    ]);
    for (const m of ['bob', 'cat']) {
      await call('post', '/groups/join', m, { code }).expect(200);
    }
    const join = (name: string, device: string) =>
      listen.join(users[name].token, device);
    phones = {
      'ann-phone': await join('ann', 'ann-phone'),
      'ann-tablet': await join('ann', 'ann-tablet'),
      'bob-phone': await join('bob', 'bob-phone'),
      'bob-tablet': await join('bob', 'bob-tablet'),
      cat: await join('cat', 'cat-phone'),
      'dan-phone': await join('dan', 'dan-phone'),
      'dan-tablet': await join('dan', 'dan-tablet'),
      'eve-phone': await join('eve', 'eve-phone'),
      'eve-tablet': await join('eve', 'eve-tablet'),
    };
    hush();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await listen.closeAll();
  });

  afterAll(() => app.close());

  describe('creating a group', () => {
    it("rings the creator's other phone and nobody else", async () => {
      await call(
        'post',
        '/groups',
        'dan',
        { name: 'Mine' },
        'dan-phone',
      ).expect(201);
      expect(await heard()).toEqual(['dan-tablet']);
    });
  });

  describe('renaming', () => {
    it('rings every member, the owner’s other phone too, not the phone that asked, not outsiders', async () => {
      await call(
        'patch',
        `/groups/${G}`,
        'ann',
        { name: 'New' },
        'ann-phone',
      ).expect(204);
      expect(await heard()).toEqual([
        'ann-tablet',
        'bob-phone',
        'bob-tablet',
        'cat',
      ]);
    });

    it('rings the owner’s own phones when no device is named', async () => {
      await call('patch', `/groups/${G}`, 'ann', { name: 'New' }).expect(204);
      expect(await heard()).toEqual([
        'ann-phone',
        'ann-tablet',
        'bob-phone',
        'bob-tablet',
        'cat',
      ]);
    });

    it('the same name again changes nothing and rings nobody', async () => {
      await call(
        'patch',
        `/groups/${G}`,
        'ann',
        { name: 'Home' },
        'ann-phone',
      ).expect(204);
      expect(await heard()).toEqual([]);
    });

    it('a name change by a non-owner (403) or a stranger (404) rings nobody', async () => {
      await call('patch', `/groups/${G}`, 'bob', { name: 'Mine' }).expect(403);
      await call('patch', `/groups/${G}`, 'dan', { name: 'Mine' }).expect(404);
      expect(await heard()).toEqual([]);
    });
  });

  describe('joining', () => {
    it("rings all members and the newcomer's other phone, not the phone that joined, not outsiders", async () => {
      await call(
        'post',
        '/groups/join',
        'eve',
        { code: await inviteCode() },
        'eve-phone',
      ).expect(200);
      expect(await heard()).toEqual([
        'ann-phone',
        'ann-tablet',
        'bob-phone',
        'bob-tablet',
        'cat',
        'eve-tablet',
      ]);
    });

    it('joining again when already a member changes nothing and rings nobody', async () => {
      await call(
        'post',
        '/groups/join',
        'bob',
        { code: await inviteCode() },
        'bob-phone',
      ).expect(200);
      expect(await heard()).toEqual([]);
    });

    it('a wrong code rings nobody', async () => {
      await call(
        'post',
        '/groups/join',
        'eve',
        { code: '000000' },
        'eve-phone',
      ).expect(400);
      expect(await heard()).toEqual([]);
    });

    it('coming back after leaving rings the members again', async () => {
      await call('post', `/groups/${G}/leave`, 'bob').expect(204);
      hush();
      await call(
        'post',
        '/groups/join',
        'bob',
        { code: await inviteCode() },
        'bob-phone',
      ).expect(200);
      expect(await heard()).toEqual([
        'ann-phone',
        'ann-tablet',
        'bob-tablet',
        'cat',
      ]);
    });
  });

  describe('leaving', () => {
    it('rings those who stay and the leaver’s other phone, not the phone that left, not outsiders', async () => {
      await call(
        'post',
        `/groups/${G}/leave`,
        'bob',
        undefined,
        'bob-phone',
      ).expect(204);
      expect(await heard()).toEqual([
        'ann-phone',
        'ann-tablet',
        'bob-tablet',
        'cat',
      ]);
    });

    it('a repeated leave changes nothing and rings nobody', async () => {
      await call(
        'post',
        `/groups/${G}/leave`,
        'bob',
        undefined,
        'bob-phone',
      ).expect(204);
      hush();
      await call(
        'post',
        `/groups/${G}/leave`,
        'bob',
        undefined,
        'bob-phone',
      ).expect(204);
      expect(await heard()).toEqual([]);
    });

    it('the owner cannot leave (409) and rings nobody; a stranger gets 404 and rings nobody', async () => {
      await call('post', `/groups/${G}/leave`, 'ann').expect(409);
      await call('post', `/groups/${G}/leave`, 'dan').expect(404);
      expect(await heard()).toEqual([]);
    });

    it('whoever left hears nothing more about the group', async () => {
      await call('post', `/groups/${G}/leave`, 'bob').expect(204);
      hush();
      await call('patch', `/groups/${G}`, 'ann', { name: 'New' }).expect(204);
      expect(await heard()).toEqual(['ann-phone', 'ann-tablet', 'cat']);
    });
  });

  describe('removing a member', () => {
    it("rings the rest, the removed person's phones, the owner's other phone, not the phone that asked", async () => {
      await call(
        'delete',
        `/groups/${G}/members/${users.bob.id}`,
        'ann',
        undefined,
        'ann-phone',
      ).expect(204);
      expect(await heard()).toEqual([
        'ann-tablet',
        'bob-phone',
        'bob-tablet',
        'cat',
      ]);
    });

    it('removing again changes nothing and rings nobody', async () => {
      await call(
        'delete',
        `/groups/${G}/members/${users.bob.id}`,
        'ann',
      ).expect(204);
      hush();
      await call(
        'delete',
        `/groups/${G}/members/${users.bob.id}`,
        'ann',
      ).expect(204);
      expect(await heard()).toEqual([]);
    });

    it('a member trying it (403), a stranger (404), or an unknown person (404) rings nobody', async () => {
      await call(
        'delete',
        `/groups/${G}/members/${users.cat.id}`,
        'bob',
      ).expect(403);
      await call(
        'delete',
        `/groups/${G}/members/${users.cat.id}`,
        'dan',
      ).expect(404);
      await call(
        'delete',
        `/groups/${G}/members/${users.eve.id}`,
        'ann',
      ).expect(404);
      expect(await heard()).toEqual([]);
      expect((await memberRows()).filter((m) => m.gone)).toEqual([]);
    });

    it('the removed person hears nothing more about the group', async () => {
      await call(
        'delete',
        `/groups/${G}/members/${users.bob.id}`,
        'ann',
      ).expect(204);
      hush();
      await call('patch', `/groups/${G}`, 'ann', { name: 'New' }).expect(204);
      expect(await heard()).toEqual(['ann-phone', 'ann-tablet', 'cat']);
    });
  });

  describe('deleting the group', () => {
    it('rings everyone who was in it, the owner’s other phone, not the phone that asked, not outsiders', async () => {
      await call(
        'delete',
        `/groups/${G}`,
        'ann',
        undefined,
        'ann-phone',
      ).expect(204);
      expect(await heard()).toEqual([
        'ann-tablet',
        'bob-phone',
        'bob-tablet',
        'cat',
      ]);
    });

    it('does not ring someone who had already left', async () => {
      await call('post', `/groups/${G}/leave`, 'bob').expect(204);
      hush();
      await call(
        'delete',
        `/groups/${G}`,
        'ann',
        undefined,
        'ann-phone',
      ).expect(204);
      expect(await heard()).toEqual(['ann-tablet', 'cat']);
    });

    it('deleting again changes nothing and rings nobody', async () => {
      await call('delete', `/groups/${G}`, 'ann').expect(204);
      hush();
      await call('delete', `/groups/${G}`, 'ann').expect(204);
      expect(await heard()).toEqual([]);
    });

    it('a member trying it (403) or a stranger (404) rings nobody', async () => {
      await call('delete', `/groups/${G}`, 'bob').expect(403);
      await call('delete', `/groups/${G}`, 'dan').expect(404);
      expect(await heard()).toEqual([]);
    });
  });

  describe('the invite code', () => {
    it('making a new code rings nobody, not even the owner’s other phone', async () => {
      await call(
        'post',
        `/groups/${G}/invite/regenerate`,
        'ann',
        undefined,
        'ann-phone',
      ).expect(200);
      expect(await heard()).toEqual([]);
    });

    it('reading the code rings nobody', async () => {
      await call(
        'get',
        `/groups/${G}/invite`,
        'ann',
        undefined,
        'ann-phone',
      ).expect(200);
      expect(await heard()).toEqual([]);
    });
  });

  describe('the profile', () => {
    it('a new name rings the people of my groups and my other phone, not the phone that asked, not outsiders', async () => {
      await call(
        'put',
        '/me/profile',
        'ann',
        { displayName: 'Anna', avatarUrl: null },
        'ann-phone',
      ).expect(200);
      expect(await heard()).toEqual([
        'ann-tablet',
        'bob-phone',
        'bob-tablet',
        'cat',
      ]);
    });

    it('a new picture alone rings too', async () => {
      await call(
        'put',
        '/me/profile',
        'bob',
        { displayName: null, avatarUrl: 'https://example.com/a.png' },
        'bob-phone',
      ).expect(200);
      expect(await heard()).toEqual([
        'ann-phone',
        'ann-tablet',
        'bob-tablet',
        'cat',
      ]);
    });

    it('saving the same name and picture again changes nothing and rings nobody', async () => {
      const body = {
        displayName: 'Anna',
        avatarUrl: 'https://example.com/a.png',
      };
      await call('put', '/me/profile', 'ann', body, 'ann-phone').expect(200);
      hush();
      await call('put', '/me/profile', 'ann', body, 'ann-phone').expect(200);
      expect(await heard()).toEqual([]);
    });

    it('someone in no group rings only their own other phone', async () => {
      await call(
        'put',
        '/me/profile',
        'dan',
        { displayName: 'Dan', avatarUrl: null },
        'dan-phone',
      ).expect(200);
      expect(await heard()).toEqual(['dan-tablet']);
    });

    it('someone who shares two groups is rung once', async () => {
      const res = await call('post', '/groups', 'bob', {
        name: 'Second',
      }).expect(201);
      const second = (res.body as { id: string }).id;
      await ds.query(
        `update group_invites set code = '222222' where group_id = $1`,
        [second],
      );
      await call('post', '/groups/join', 'ann', { code: '222222' }).expect(200);
      hush();
      await call(
        'put',
        '/me/profile',
        'ann',
        { displayName: 'Anna', avatarUrl: null },
        'ann-phone',
      ).expect(200);
      expect(await heard()).toEqual([
        'ann-tablet',
        'bob-phone',
        'bob-tablet',
        'cat',
      ]);
    });

    it('people of groups I have left, and groups that are gone, are not rung', async () => {
      await call('post', `/groups/${G}/leave`, 'bob').expect(204);
      await call('delete', `/groups/${G}`, 'ann').expect(204);
      hush();
      await call('put', '/me/profile', 'cat', {
        displayName: 'Cat',
        avatarUrl: null,
      }).expect(200);
      expect(await heard()).toEqual(['cat']);
    });

    it('a refused profile (400) rings nobody', async () => {
      await call(
        'put',
        '/me/profile',
        'ann',
        { displayName: 'x'.repeat(101), avatarUrl: null },
        'ann-phone',
      ).expect(400);
      expect(await heard()).toEqual([]);
    });
  });

  describe('the device name', () => {
    it("is the sender's own: another person's phone with the same name is still rung", async () => {
      const twin = await listen.join(users.bob.token, 'ann-phone');
      phones.twin = twin;
      await call(
        'patch',
        `/groups/${G}`,
        'ann',
        { name: 'New' },
        'ann-phone',
      ).expect(204);
      expect(await heard()).toEqual([
        'ann-tablet',
        'bob-phone',
        'bob-tablet',
        'cat',
        'twin',
      ]);
    });
  });

  describe('the database', () => {
    it('is asked about members only when somebody else is connected', async () => {
      const query = jest.spyOn(ds, 'query');
      const lookups = () =>
        query.mock.calls.filter(([sql]) =>
          String(sql).includes('select distinct m.user_id'),
        ).length;

      await call(
        'patch',
        `/groups/${G}`,
        'ann',
        { name: 'One' },
        'ann-phone',
      ).expect(204);
      expect(lookups()).toBe(1);

      // Everyone but Ann goes away; her own phones need no lookup.
      for (const [name, c] of Object.entries(phones)) {
        if (!name.startsWith('ann')) c.socket.terminate();
      }
      await Promise.all(
        Object.entries(phones)
          .filter(([n]) => !n.startsWith('ann'))
          .map(([, c]) => c.closed),
      );
      await quiet(50);
      query.mockClear();
      await call(
        'patch',
        `/groups/${G}`,
        'ann',
        { name: 'Two' },
        'ann-phone',
      ).expect(204);
      expect(lookups()).toBe(0);
    });
  });

  describe('a failing ring does not undo the action', () => {
    it.each([
      [
        'creating',
        () => call('post', '/groups', 'ann', { name: 'Another' }),
        201,
      ],
      [
        'renaming',
        () => call('patch', `/groups/${G}`, 'ann', { name: 'New' }),
        204,
      ],
      [
        'joining',
        () => call('post', '/groups/join', 'eve', { code: '111111' }),
        200,
      ],
      ['leaving', () => call('post', `/groups/${G}/leave`, 'bob'), 204],
      [
        'removing a member',
        () => call('delete', `/groups/${G}/members/${users.bob.id}`, 'ann'),
        204,
      ],
      ['deleting', () => call('delete', `/groups/${G}`, 'ann'), 204],
      [
        'saving the profile',
        () =>
          call('put', '/me/profile', 'ann', {
            displayName: 'Anna',
            avatarUrl: null,
          }),
        200,
      ],
    ])('%s', async (_n, act, status) => {
      jest.spyOn(app.get(RealtimeService), 'ring').mockImplementation(() => {
        throw new Error('boom');
      });
      await act().expect(status);
    });

    it('and the change is saved', async () => {
      jest.spyOn(app.get(RealtimeService), 'ring').mockImplementation(() => {
        throw new Error('boom');
      });
      await call('patch', `/groups/${G}`, 'ann', { name: 'Saved' }).expect(204);
      await call('put', '/me/profile', 'ann', {
        displayName: 'Anna',
        avatarUrl: null,
      }).expect(200);
      expect(
        (await ds.query(`select name from groups where id = $1`, [G]))[0].name,
      ).toBe('Saved');
      expect(
        (await ds.query(`select display_name from profiles`))[0].display_name,
      ).toBe('Anna');
    });
  });
});
