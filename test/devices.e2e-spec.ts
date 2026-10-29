import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp, truncateAll } from './support/db';

interface Session {
  token: string;
  id: string;
}

const phone = (n: number, length = 40) => `phone-${n}-`.padEnd(length, 'x');

describe('PUT and DELETE /devices', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ann: Session;
  let bob: Session;
  const api = () => request(app.getHttpServer());
  const as = (who: Session) => ({ Authorization: `Bearer ${who.token}` });
  const put = (who: Session, body: unknown) =>
    api()
      .put('/devices')
      .set(as(who))
      .send(body as object);
  const del = (who: Session, body: unknown) =>
    api()
      .delete('/devices')
      .set(as(who))
      .send(body as object);
  const rows = async (): Promise<{ token: string; user_id: string }[]> =>
    ds.query(`select token, user_id from device_tokens order by token`);
  const ownerOf = async (token: string) =>
    (await rows()).find((r) => r.token === token)?.user_id;

  async function signUp(email: string): Promise<Session> {
    const res = await api()
      .post('/auth/register')
      .send({ email, password: 'correct horse' })
      .expect(201);
    const body = res.body as { accessToken: string; user: { id: string } };
    return { token: body.accessToken, id: body.user.id };
  }

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
  });

  beforeEach(async () => {
    await truncateAll(ds);
    ann = await signUp('ann@example.com');
    bob = await signUp('bob@example.com');
  });

  afterAll(() => app.close());

  describe('needs a signed-in account', () => {
    it.each([['put'], ['delete']] as const)(
      '%s without a token, or with a bad one, is 401',
      async (method) => {
        for (const headers of [{}, { Authorization: 'Bearer garbage' }]) {
          const res = await api()
            [method]('/devices')
            .set(headers)
            .send({ token: phone(1) })
            .expect(401);
          expect((res.body as { code: string }).code).toBe('unauthorized');
        }
        expect(await rows()).toEqual([]);
      },
    );

    it('a valid token of an account that is gone is 401, not a server error', async () => {
      await ds.query(`delete from users where id = $1`, [ann.id]);
      const res = await put(ann, { token: phone(1) }).expect(401);
      expect((res.body as { code: string }).code).toBe('unauthorized');
      expect(await rows()).toEqual([]);
    });
  });

  describe('PUT: this phone is mine', () => {
    it('saves the token for the account of the access token, with an empty 204', async () => {
      const res = await put(ann, { token: phone(1) }).expect(204);
      expect(res.text).toBe('');
      expect(await rows()).toEqual([{ token: phone(1), user_id: ann.id }]);
    });

    it('never takes the owner from the body', async () => {
      await put(ann, {
        token: phone(1),
        user_id: bob.id,
        userId: bob.id,
        owner: bob.id,
      }).expect(204);
      expect(await rows()).toEqual([{ token: phone(1), user_id: ann.id }]);
    });

    it('does not mind being sent twice', async () => {
      await put(ann, { token: phone(1) }).expect(204);
      await put(ann, { token: phone(1) }).expect(204);
      expect(await rows()).toEqual([{ token: phone(1), user_id: ann.id }]);
    });

    it('keeps several phones of one account, and other people’s alone', async () => {
      await put(ann, { token: phone(1) }).expect(204);
      await put(bob, { token: phone(3) }).expect(204);
      await put(ann, { token: phone(2) }).expect(204);
      expect(await rows()).toEqual([
        { token: phone(1), user_id: ann.id },
        { token: phone(2), user_id: ann.id },
        { token: phone(3), user_id: bob.id },
      ]);
    });

    it('hands the phone to whoever signed in on it last', async () => {
      await put(ann, { token: phone(1) }).expect(204);
      await put(bob, { token: phone(1) }).expect(204);
      expect(await rows()).toEqual([{ token: phone(1), user_id: bob.id }]);
      await put(ann, { token: phone(1) }).expect(204);
      expect(await ownerOf(phone(1))).toBe(ann.id);
    });
  });

  describe('DELETE: this phone is no longer mine', () => {
    it('removes the caller’s own token, with an empty 204', async () => {
      await put(ann, { token: phone(1) });
      await put(ann, { token: phone(2) });
      const res = await del(ann, { token: phone(1) }).expect(204);
      expect(res.text).toBe('');
      expect(await rows()).toEqual([{ token: phone(2), user_id: ann.id }]);
    });

    it('does not mind being sent twice, or a token that was never there', async () => {
      await put(ann, { token: phone(1) });
      await del(ann, { token: phone(1) }).expect(204);
      await del(ann, { token: phone(1) }).expect(204);
      await del(ann, { token: phone(9) }).expect(204);
      expect(await rows()).toEqual([]);
    });

    it('cannot remove somebody else’s token, and says the same as for no token at all', async () => {
      await put(bob, { token: phone(1) });
      const theirs = await del(ann, { token: phone(1) });
      const nothing = await del(ann, { token: phone(9) });
      expect(theirs.status).toBe(204);
      expect([
        theirs.status,
        theirs.text,
        theirs.headers['content-length'],
      ]).toEqual([
        nothing.status,
        nothing.text,
        nothing.headers['content-length'],
      ]);
      expect(await rows()).toEqual([{ token: phone(1), user_id: bob.id }]);
    });

    it('after the phone changed hands, the earlier owner cannot take it away from the new one', async () => {
      await put(ann, { token: phone(1) });
      await put(bob, { token: phone(1) }); // Bob signed in on Ann’s phone
      // Ann’s app logs out later and removes “its” token.
      await del(ann, { token: phone(1) }).expect(204);
      expect(await rows()).toEqual([{ token: phone(1), user_id: bob.id }]);
      await del(bob, { token: phone(1) }).expect(204);
      expect(await rows()).toEqual([]);
    });

    it('never takes the owner from the body', async () => {
      await put(bob, { token: phone(1) });
      await del(ann, { token: phone(1), user_id: bob.id }).expect(204);
      expect(await rows()).toEqual([{ token: phone(1), user_id: bob.id }]);
    });
  });

  describe('a token that is not a token is 400 bad_token and changes nothing', () => {
    const bad: [string, unknown][] = [
      ['no body', undefined],
      ['an empty body', {}],
      ['null', { token: null }],
      ['a number', { token: 1234567890123456 }],
      ['a list', { token: [phone(1)] }],
      ['an object', { token: { a: phone(1) } }],
      ['an empty string', { token: '' }],
      ['19 characters', { token: phone(1, 19) }],
      ['4097 characters', { token: phone(1, 4097) }],
      ['a space inside', { token: 'phone with a space inside it' }],
      ['a newline', { token: `${phone(1)}\n${phone(1)}` }],
      ['a tab', { token: `${phone(1)}\t` }],
      ['a NUL character', { token: `${phone(1)}\u0000abc` }],
      ['letters outside ASCII', { token: `${phone(1)}телефон` }],
    ];

    it.each(bad)('PUT with %s', async (_name, body) => {
      const res = await put(ann, body).expect(400);
      expect((res.body as { code: string }).code).toBe('bad_token');
      expect(await rows()).toEqual([]);
    });

    it.each(bad)('DELETE with %s', async (_name, body) => {
      await put(ann, { token: phone(5) });
      const res = await del(ann, body).expect(400);
      expect((res.body as { code: string }).code).toBe('bad_token');
      expect(await rows()).toHaveLength(1);
    });

    it.each([20, 21, 255, 4095, 4096])(
      'accepts %i characters',
      async (length) => {
        await put(ann, { token: phone(1, length) }).expect(204);
        expect((await rows())[0].token).toHaveLength(length);
      },
    );

    it('accepts what real FCM tokens are made of', async () => {
      const real = 'fN3x-Qa_9:APA91bF-_xyz.ABC~def/ghi+jkl=MNO0123456789';
      await put(ann, { token: real }).expect(204);
      expect(await ownerOf(real)).toBe(ann.id);
    });

    it('does not repeat the token in the error', async () => {
      const secret = 'SECRET TOKEN WITH SPACES 0123456789';
      const res = await put(ann, { token: secret }).expect(400);
      expect(JSON.stringify(res.body)).not.toContain('SECRET');
    });
  });
});
