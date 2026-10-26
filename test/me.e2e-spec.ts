import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp, truncateAll } from './support/db';

interface Session {
  accessToken: string;
  user: { id: string; email: string };
}
interface UserBody {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
}

describe('/me', () => {
  let app: INestApplication;
  let ds: DataSource;

  const api = () => request(app.getHttpServer());
  const as = (s: Session) => ({ Authorization: `Bearer ${s.accessToken}` });
  const getMe = (s: Session) => api().get('/me').set(as(s));
  const putProfile = (s: Session, body: unknown) =>
    api()
      .put('/me/profile')
      .set(as(s))
      .send(body as object);
  const profileRows = async () =>
    (await ds.query(`select count(*)::int n from profiles`))[0].n as number;

  async function signUp(email: string): Promise<Session> {
    const res = await api()
      .post('/auth/register')
      .send({ email, password: 'correct horse' })
      .expect(201);
    return res.body as Session;
  }

  const avatar = 'https://lh3.googleusercontent.com/a/photo=s96-c';

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
  });

  beforeEach(() => truncateAll(ds));

  afterAll(() => app.close());

  describe('GET /me', () => {
    it('needs a token', async () => {
      const res = await api().get('/me').expect(401);
      expect((res.body as { code: string }).code).toBe('unauthorized');
    });

    it('returns the account with empty name and picture, and nothing else', async () => {
      const ann = await signUp('ann@example.com');
      const res = await getMe(ann).expect(200);
      expect(res.body).toEqual({
        id: ann.user.id,
        email: 'ann@example.com',
        displayName: null,
        avatarUrl: null,
      });
      expect(await profileRows()).toBe(0); // reading creates nothing
    });

    it('returns each caller their own account', async () => {
      const ann = await signUp('ann@example.com');
      const bob = await signUp('bob@example.com');
      expect(((await getMe(ann).expect(200)).body as UserBody).email).toBe(
        'ann@example.com',
      );
      expect(((await getMe(bob).expect(200)).body as UserBody).email).toBe(
        'bob@example.com',
      );
    });

    it('answers unauthorized when the account behind a valid token is gone', async () => {
      const ann = await signUp('ann@example.com');
      await ds.query(`delete from users`);
      const res = await getMe(ann).expect(401);
      expect((res.body as { code: string }).code).toBe('unauthorized');
    });
  });

  describe('PUT /me/profile', () => {
    it('needs a token', async () => {
      await api()
        .put('/me/profile')
        .send({ displayName: 'Ann', avatarUrl: null })
        .expect(401);
    });

    it('saves the name and picture and returns the user', async () => {
      const ann = await signUp('ann@example.com');
      const res = await putProfile(ann, {
        displayName: 'Ann',
        avatarUrl: avatar,
      }).expect(200);
      expect(res.body).toEqual({
        id: ann.user.id,
        email: 'ann@example.com',
        displayName: 'Ann',
        avatarUrl: avatar,
      });
      expect(
        ((await getMe(ann).expect(200)).body as UserBody).displayName,
      ).toBe('Ann');
      const login = await api()
        .post('/auth/login')
        .send({ email: 'ann@example.com', password: 'correct horse' })
        .expect(200);
      expect((login.body as { user: UserBody }).user.displayName).toBe('Ann');
    });

    it('replaces the profile on every call without adding rows', async () => {
      const ann = await signUp('ann@example.com');
      await putProfile(ann, { displayName: 'Ann', avatarUrl: avatar }).expect(
        200,
      );
      await putProfile(ann, { displayName: 'Anna', avatarUrl: null }).expect(
        200,
      );
      expect(await profileRows()).toBe(1);
      expect((await getMe(ann)).body).toMatchObject({
        displayName: 'Anna',
        avatarUrl: null,
      });
    });

    it('moves updated_at forward on every save', async () => {
      const ann = await signUp('ann@example.com');
      await putProfile(ann, { displayName: 'Ann', avatarUrl: null }).expect(
        200,
      );
      const [{ before }] = await ds.query(
        `select updated_at::text as before from profiles`,
      );
      await putProfile(ann, { displayName: 'Ann', avatarUrl: null }).expect(
        200,
      );
      const [{ moved }] = await ds.query(
        `select updated_at > $1::timestamptz as moved from profiles`,
        [before],
      );
      expect(moved).toBe(true);
    });

    it('trims the name, and treats blank text and null as cleared', async () => {
      const ann = await signUp('ann@example.com');
      const saved = await putProfile(ann, {
        displayName: '  Ann  ',
        avatarUrl: `  ${avatar} `,
      }).expect(200);
      expect(saved.body).toMatchObject({
        displayName: 'Ann',
        avatarUrl: avatar,
      });
      const cleared = await putProfile(ann, {
        displayName: '   ',
        avatarUrl: '',
      }).expect(200);
      expect(cleared.body).toMatchObject({
        displayName: null,
        avatarUrl: null,
      });
      const nulls = await putProfile(ann, {
        displayName: null,
        avatarUrl: null,
      }).expect(200);
      expect(nulls.body).toMatchObject({ displayName: null, avatarUrl: null });
    });

    it('accepts the largest allowed name and address', async () => {
      const ann = await signUp('ann@example.com');
      const longUrl = `https://example.com/${'a'.repeat(2048 - 'https://example.com/'.length)}`;
      await putProfile(ann, {
        displayName: 'x'.repeat(100),
        avatarUrl: longUrl,
      }).expect(200);
    });

    it.each([
      ['name too long', { displayName: 'x'.repeat(101), avatarUrl: null }],
      ['name is a number', { displayName: 5, avatarUrl: null }],
      ['name is an object', { displayName: { a: 1 }, avatarUrl: null }],
      ['name missing', { avatarUrl: null }],
      ['picture missing', { displayName: 'Ann' }],
      [
        'picture over http',
        { displayName: 'Ann', avatarUrl: 'http://example.com/a.png' },
      ],
      [
        'picture is a javascript: address',
        { displayName: 'Ann', avatarUrl: 'javascript:alert(1)' },
      ],
      [
        'picture is a file: address',
        { displayName: 'Ann', avatarUrl: 'file:///etc/passwd' },
      ],
      [
        'picture is not an address',
        { displayName: 'Ann', avatarUrl: 'not a url' },
      ],
      [
        'picture too long',
        {
          displayName: 'Ann',
          avatarUrl: `https://example.com/${'a'.repeat(2049)}`,
        },
      ],
      ['picture is a number', { displayName: 'Ann', avatarUrl: 7 }],
      ['empty body', {}],
      ['body is an array', []],
    ])('rejects %s and changes nothing', async (_name, body) => {
      const ann = await signUp('ann@example.com');
      await putProfile(ann, { displayName: 'Keep', avatarUrl: avatar }).expect(
        200,
      );
      const res = await putProfile(ann, body).expect(400);
      expect((res.body as { code: string }).code).toBe('validation_failed');
      expect((await getMe(ann)).body).toMatchObject({
        displayName: 'Keep',
        avatarUrl: avatar,
      });
    });

    it('only ever changes the caller: ids in the body, query or headers are ignored', async () => {
      const ann = await signUp('ann@example.com');
      const bob = await signUp('bob@example.com');
      await putProfile(ann, { displayName: 'Ann', avatarUrl: null }).expect(
        200,
      );
      await api()
        .put(`/me/profile?userId=${ann.user.id}`)
        .set(as(bob))
        .set('X-User-Id', ann.user.id)
        .send({
          displayName: 'Bob',
          avatarUrl: null,
          userId: ann.user.id,
          user_id: ann.user.id,
        })
        .expect(200);
      expect((await getMe(ann)).body).toMatchObject({ displayName: 'Ann' });
      expect((await getMe(bob)).body).toMatchObject({ displayName: 'Bob' });
      expect(await profileRows()).toBe(2);
    });

    it('answers unauthorized and creates nothing when the account behind the token is gone', async () => {
      const ann = await signUp('ann@example.com');
      await ds.query(`delete from users`);
      const res = await putProfile(ann, {
        displayName: 'Ann',
        avatarUrl: null,
      }).expect(401);
      expect((res.body as { code: string }).code).toBe('unauthorized');
      expect(await profileRows()).toBe(0);
    });
  });
});
