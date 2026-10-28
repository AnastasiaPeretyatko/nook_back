import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp, truncateAll } from './support/db';

type Row = Record<string, unknown>;
interface Snapshot {
  groups: Row[];
  members: Row[];
}
interface PullResponse {
  next: string | null;
  has_more: boolean;
  tasks: Row[];
  logs: Row[];
  groups: Snapshot;
}
interface Session {
  token: string;
  id: string;
}

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('GET /sync/pull: the snapshot of groups', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ann: Session;
  let bob: Session;
  let cat: Session;
  let dan: Session;
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
  const pull = async (who: Session, query = '') => {
    const res = await api().get(`/sync/pull${query}`).set(as(who)).expect(200);
    return res.body as PullResponse;
  };
  const snapshot = async (who: Session) => (await pull(who)).groups;
  const newGroup = async (owner: Session, name = 'Home') =>
    (await api().post('/groups').set(as(owner)).send({ name }).expect(201)).body
      .id as string;
  const join = async (who: Session, g: string) => {
    const code = (
      await ds.query(`select code from group_invites where group_id = $1`, [g])
    )[0].code as string;
    await api().post('/groups/join').set(as(who)).send({ code }).expect(200);
  };
  const setProfile = (who: Session, displayName: unknown, avatarUrl: unknown) =>
    api()
      .put('/me/profile')
      .set(as(who))
      .send({ displayName, avatarUrl })
      .expect(200);
  const groupIds = (s: Snapshot) => s.groups.map((g) => g.id);
  const memberIds = (s: Snapshot, g: string) =>
    s.members.filter((m) => m.group_id === g).map((m) => m.user_id);

  beforeAll(async () => {
    app = await createTestApp();
    app.getHttpServer().setMaxListeners(100);
    ds = app.get(DataSource);
  });

  beforeEach(async () => {
    await truncateAll(ds);
    ann = await signUp('ann@example.com');
    bob = await signUp('bob@example.com');
    cat = await signUp('cat@example.com');
    dan = await signUp('dan@example.com');
  });

  afterAll(() => app.close());

  describe('where it is', () => {
    it('is in every answer, empty for someone with no group', async () => {
      for (const query of [
        '',
        '?include=tasks',
        '?include=diary',
        '?include=cycle',
        '?include=tasks,diary,cycle',
        '?limit=1',
        '?since=2000-01-01T00:00:00Z',
      ]) {
        const res = await pull(dan, query);
        expect(res.groups).toEqual({ groups: [], members: [] });
      }
    });

    it('is whole in every answer, whatever since and limit say', async () => {
      const g = await newGroup(ann);
      await join(bob, g);
      await api()
        .post('/sync/push')
        .set(as(ann))
        .send({ tasks: [1, 2, 3].map((n) => ({ id: id(n) })) })
        .expect(200);
      const first = await pull(ann, '?limit=1');
      expect(first.has_more).toBe(true);
      const second = await pull(ann, `?limit=1&since=${first.next}`);
      const future = await pull(ann, '?since=2099-01-01T00:00:00Z');
      for (const res of [first, second, future]) {
        expect(groupIds(res.groups)).toEqual([g]);
        expect(memberIds(res.groups, g)).toHaveLength(2);
      }
    });

    it('is not part of next and has_more', async () => {
      await newGroup(ann);
      const res = await pull(ann);
      expect(res.next).toBeNull();
      expect(res.has_more).toBe(false);
      const since = '2026-01-01T00:00:00Z';
      expect((await pull(ann, `?since=${since}`)).next).toBe(since);
    });
  });

  describe('the shape', () => {
    it('gives a group {id, name, owner_id} and a member {group_id, user_id, display_name, avatar_url}, nothing more', async () => {
      const g = await newGroup(ann, 'Family');
      await join(bob, g);
      await setProfile(ann, 'Ann', 'https://example.com/ann.png');
      const s = await snapshot(bob);
      expect(s.groups).toEqual([{ id: g, name: 'Family', owner_id: ann.id }]);
      expect(s.members).toEqual([
        {
          group_id: g,
          user_id: ann.id,
          display_name: 'Ann',
          avatar_url: 'https://example.com/ann.png',
        },
        { group_id: g, user_id: bob.id, display_name: null, avatar_url: null },
      ]);
    });

    it('never carries the invite code, the role, a stamp or an email', async () => {
      const g = await newGroup(ann);
      await join(bob, g);
      const code = (
        await ds.query(`select code from group_invites where group_id = $1`, [
          g,
        ])
      )[0].code as string;
      for (const who of [ann, bob]) {
        const text = JSON.stringify((await pull(who)).groups);
        expect(text).not.toContain(code);
        for (const word of [
          'code',
          'role',
          'deleted_at',
          'updated_at',
          'joined_at',
          'email',
          'example.com',
        ])
          expect(text).not.toContain(word);
      }
    });

    it('names the owner in owner_id and lists them among the members', async () => {
      const g = await newGroup(ann);
      const s = await snapshot(ann);
      expect(s.groups[0].owner_id).toBe(ann.id);
      expect(memberIds(s, g)).toEqual([ann.id]);
    });
  });

  describe('names and pictures', () => {
    it('come from the profile, and are null while there is none', async () => {
      const g = await newGroup(ann);
      await join(bob, g);
      await setProfile(bob, '  Bobby ', null);
      const s = await snapshot(ann);
      expect(s.members.find((m) => m.user_id === bob.id)).toMatchObject({
        display_name: 'Bobby',
        avatar_url: null,
      });
      expect(s.members.find((m) => m.user_id === ann.id)).toMatchObject({
        display_name: null,
        avatar_url: null,
      });
    });

    it('show a change at the very next pull, without waiting for any stamp', async () => {
      const g = await newGroup(ann);
      await join(bob, g);
      const before = await snapshot(bob);
      expect(before.members.every((m) => m.display_name === null)).toBe(true);
      await setProfile(ann, 'Ann', null);
      const after = await snapshot(bob);
      expect(
        after.members.find((m) => m.user_id === ann.id)?.display_name,
      ).toBe('Ann');
      await setProfile(ann, null, null);
      expect(
        (await snapshot(bob)).members.find((m) => m.user_id === ann.id)
          ?.display_name,
      ).toBeNull();
    });
  });

  describe('whose groups', () => {
    it('shows each person only the groups they are in', async () => {
      const home = await newGroup(ann, 'Home');
      const work = await newGroup(cat, 'Work');
      await join(bob, home);
      expect(groupIds(await snapshot(ann))).toEqual([home]);
      expect(groupIds(await snapshot(bob))).toEqual([home]);
      expect(groupIds(await snapshot(cat))).toEqual([work]);
      expect(await snapshot(dan)).toEqual({ groups: [], members: [] });
    });

    it('does not show a stranger the group, its name or its people, at any since', async () => {
      const g = await newGroup(ann, 'Secret name');
      await join(bob, g);
      for (const query of ['', '?since=', '?include=tasks,diary,cycle']) {
        const res = await pull(dan, query);
        const text = JSON.stringify(res);
        expect(text).not.toContain('Secret name');
        expect(text).not.toContain(g);
        expect(text).not.toContain(ann.id);
        expect(text).not.toContain(bob.id);
      }
    });

    it('shows someone in two groups both, and each with its own people only', async () => {
      const one = await newGroup(ann, 'one');
      const two = await newGroup(bob, 'two');
      await join(cat, one);
      await join(ann, two);
      const s = await snapshot(ann);
      expect(groupIds(s).sort()).toEqual([one, two].sort());
      expect(memberIds(s, one).sort()).toEqual([ann.id, cat.id].sort());
      expect(memberIds(s, two).sort()).toEqual([ann.id, bob.id].sort());
      expect(s.members).toHaveLength(4);
    });

    it('does not put a group’s people on another group', async () => {
      const one = await newGroup(ann, 'one');
      const two = await newGroup(bob, 'two');
      await join(cat, two);
      const s = await snapshot(ann);
      expect(groupIds(s)).toEqual([one]);
      expect(memberIds(s, two)).toEqual([]);
      expect(JSON.stringify(s)).not.toContain(cat.id);
    });
  });

  describe('how a phone learns it is out: the group is gone from the answer', () => {
    let g: string;
    beforeEach(async () => {
      g = await newGroup(ann);
      await join(bob, g);
      await join(cat, g);
      expect(groupIds(await snapshot(bob))).toEqual([g]);
    });

    it('when he leaves', async () => {
      await api().post(`/groups/${g}/leave`).set(as(bob)).expect(204);
      expect(await snapshot(bob)).toEqual({ groups: [], members: [] });
    });

    it('when he is removed', async () => {
      await api()
        .delete(`/groups/${g}/members/${bob.id}`)
        .set(as(ann))
        .expect(204);
      expect(await snapshot(bob)).toEqual({ groups: [], members: [] });
    });

    it('when the group is deleted, for everybody', async () => {
      await api().delete(`/groups/${g}`).set(as(ann)).expect(204);
      for (const who of [ann, bob, cat]) {
        expect(await snapshot(who)).toEqual({ groups: [], members: [] });
      }
    });

    it('even when only the group is stamped deleted and the memberships were somehow left', async () => {
      await ds.query(`update groups set deleted_at = now() where id = $1`, [g]);
      for (const who of [ann, bob, cat]) {
        expect(await snapshot(who)).toEqual({ groups: [], members: [] });
      }
    });

    it('and the others no longer see him among the people', async () => {
      await api().post(`/groups/${g}/leave`).set(as(bob)).expect(204);
      for (const who of [ann, cat]) {
        const s = await snapshot(who);
        expect(memberIds(s, g).sort()).toEqual([ann.id, cat.id].sort());
        expect(JSON.stringify(s)).not.toContain(bob.id);
      }
    });

    it('while another group of his stays', async () => {
      const other = await newGroup(cat, 'other');
      await join(bob, other);
      await api().post(`/groups/${g}/leave`).set(as(bob)).expect(204);
      expect(groupIds(await snapshot(bob))).toEqual([other]);
    });

    it('and he is back in it when he joins again', async () => {
      await api().post(`/groups/${g}/leave`).set(as(bob)).expect(204);
      await join(bob, g);
      const s = await snapshot(bob);
      expect(groupIds(s)).toEqual([g]);
      expect(memberIds(s, g)).toContain(bob.id);
    });

    it('whatever stamp the rows carry: the answer does not depend on updated_at', async () => {
      await ds.query(
        `alter table group_members disable trigger group_members_updated_at`,
      );
      try {
        await ds.query(`update group_members set updated_at = '2000-01-01'`);
      } finally {
        await ds.query(
          `alter table group_members enable trigger group_members_updated_at`,
        );
      }
      const s = await pull(bob, '?since=2099-01-01T00:00:00Z');
      expect(groupIds(s.groups)).toEqual([g]);
      expect(memberIds(s.groups, g)).toHaveLength(3);
    });
  });

  describe('order', () => {
    it('lists groups oldest first and members in the order they joined', async () => {
      const a = await newGroup(ann, 'a');
      const b = await newGroup(ann, 'b');
      await join(cat, a);
      await join(bob, a);
      const s = await snapshot(ann);
      expect(groupIds(s)).toEqual([a, b]);
      expect(memberIds(s, a)).toEqual([ann.id, cat.id, bob.id]);
      expect(await snapshot(ann)).toEqual(s);
    });
  });

  it('takes a big group: sixty people', async () => {
    const g = await newGroup(ann);
    await ds.query(
      `insert into users (email, password_hash)
       select 'm' || n || '@example.com', 'hash' from generate_series(1, 60) n`,
    );
    await ds.query(
      `insert into group_members (group_id, user_id)
       select $1, id from users where email like 'm%@example.com'`,
      [g],
    );
    const s = await snapshot(ann);
    expect(s.groups).toHaveLength(1);
    expect(s.members).toHaveLength(61);
  });
});
