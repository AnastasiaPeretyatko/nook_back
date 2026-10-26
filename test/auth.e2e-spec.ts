import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { TokenService } from '../src/auth/token.service';
import { createTestApp, truncateAll } from './support/db';

interface AuthBody {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; displayName: null; avatarUrl: null };
}
interface ErrorBody {
  code: string;
  message: string;
}

describe('Auth routes', () => {
  let app: INestApplication;
  let ds: DataSource;
  let tokens: TokenService;

  const api = () => request(app.getHttpServer());
  const register = (body: object) => api().post('/auth/register').send(body);
  const login = (body: object) => api().post('/auth/login').send(body);
  const refresh = (refreshToken: string) =>
    api().post('/auth/refresh').send({ refreshToken });
  const logout = (refreshToken: string) =>
    api().post('/auth/logout').send({ refreshToken });
  const count = async (table: string) =>
    (await ds.query(`select count(*)::int n from ${table}`))[0].n as number;

  const ann = { email: 'ann@example.com', password: 'correct horse' };

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
    tokens = app.get(TokenService);
  });

  beforeEach(() => truncateAll(ds));

  afterAll(() => app.close());

  describe('POST /auth/register', () => {
    it('creates the account and signs in', async () => {
      const res = await register(ann).expect(201);
      const body = res.body as AuthBody;
      expect(body.user).toEqual({
        id: expect.any(String),
        email: 'ann@example.com',
        displayName: null,
        avatarUrl: null,
      });
      expect(await tokens.verifyAccessToken(body.accessToken)).toBe(
        body.user.id,
      );
      await refresh(body.refreshToken).expect(200);
    });

    it('stores a hash of the password and of the refresh token, never the originals', async () => {
      const body = (await register(ann).expect(201)).body as AuthBody;
      const [user] = await ds.query(`select password_hash from users`);
      expect(user.password_hash).toMatch(/^\$argon2id\$/);
      expect(user.password_hash).not.toContain(ann.password);
      const [token] = await ds.query(`select token_hash from refresh_tokens`);
      expect(token.token_hash).not.toBe(body.refreshToken);
      expect(JSON.stringify(body)).not.toMatch(/password/i);
    });

    it('lower-cases and trims the email', async () => {
      await register({ ...ann, email: '  Ann@Example.COM ' }).expect(201);
      const [row] = await ds.query(`select email from users`);
      expect(row.email).toBe('ann@example.com');
    });

    it('answers invalid_email for a bad, missing or oversized email', async () => {
      for (const email of [
        'nope',
        'a@b',
        '',
        undefined,
        42,
        `${'a'.repeat(250)}@example.com`,
      ]) {
        const res = await register({ email, password: ann.password }).expect(
          400,
        );
        expect((res.body as ErrorBody).code).toBe('invalid_email');
      }
      expect(await count('users')).toBe(0);
    });

    it('answers weak_password for a short, long or non-text password', async () => {
      for (const password of [
        '1234567',
        'x'.repeat(129),
        '',
        undefined,
        12345678,
      ]) {
        const res = await register({ email: ann.email, password }).expect(400);
        expect((res.body as ErrorBody).code).toBe('weak_password');
      }
      expect(await count('users')).toBe(0);
      await register({ email: ann.email, password: 'x'.repeat(128) }).expect(
        201,
      );
    });

    it('answers email_taken (409) for a used email, in any letter case', async () => {
      await register(ann).expect(201);
      const res = await register({ ...ann, email: 'ANN@example.com' }).expect(
        409,
      );
      expect((res.body as ErrorBody).code).toBe('email_taken');
      expect(await count('users')).toBe(1);
      expect(await count('refresh_tokens')).toBe(1); // the failed attempt left nothing
    });

    it('lets only one of two simultaneous sign-ups with the same email through', async () => {
      const results = await Promise.all([register(ann), register(ann)]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await count('users')).toBe(1);
    });

    it('ignores fields it does not know', async () => {
      await register({ ...ann, id: 'x', googleSub: 'y', isAdmin: true }).expect(
        201,
      );
      const [row] = await ds.query(`select google_sub from users`);
      expect(row.google_sub).toBeNull();
    });
  });

  describe('POST /auth/login', () => {
    beforeEach(async () => {
      await register(ann).expect(201);
    });

    it('signs in with the right password, whatever the email case', async () => {
      const res = await login({
        email: 'ANN@Example.com',
        password: ann.password,
      }).expect(200);
      const body = res.body as AuthBody;
      expect(body.user.email).toBe('ann@example.com');
      expect(Object.keys(body.user).sort()).toEqual([
        'avatarUrl',
        'displayName',
        'email',
        'id',
      ]);
      expect(JSON.stringify(body)).not.toMatch(/password|argon2/i);
      expect(await tokens.verifyAccessToken(body.accessToken)).toBe(
        body.user.id,
      );
      await refresh(body.refreshToken).expect(200);
    });

    it('returns the profile name and picture once they exist', async () => {
      await ds.query(
        `insert into profiles (user_id, display_name, avatar_url)
         select id, 'Ann', 'https://example.com/a.png' from users`,
      );
      const res = await login(ann).expect(200);
      expect((res.body as AuthBody).user).toMatchObject({
        displayName: 'Ann',
        avatarUrl: 'https://example.com/a.png',
      });
    });

    it('gives one identical answer for a wrong password, an unknown email and a Google-only account', async () => {
      await ds.query(
        `insert into users (email, google_sub) values ('g@example.com', 'sub-1')`,
      );
      const answers = await Promise.all([
        login({ email: ann.email, password: 'wrong password' }),
        login({ email: 'nobody@example.com', password: ann.password }),
        login({ email: 'g@example.com', password: ann.password }),
      ]);
      for (const res of answers) expect(res.status).toBe(401);
      const bodies = answers.map((r) => r.body as ErrorBody);
      expect(bodies[0].code).toBe('invalid_credentials');
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[2]).toEqual(bodies[0]);
    });

    it('treats a malformed body as a plain validation error', async () => {
      const res = await login({ email: ann.email }).expect(400);
      expect((res.body as ErrorBody).code).toBe('validation_failed');
    });

    it('opens a new session each time and keeps the others', async () => {
      await login(ann).expect(200);
      await login(ann).expect(200);
      expect(await count('refresh_tokens')).toBe(3); // register + two logins
    });
  });

  describe('POST /auth/refresh', () => {
    it('exchanges a token for a new pair, once', async () => {
      const first = (await register(ann).expect(201)).body as AuthBody;
      const res = await refresh(first.refreshToken).expect(200);
      const second = res.body as AuthBody;
      expect(Object.keys(second).sort()).toEqual([
        'accessToken',
        'refreshToken',
      ]);
      expect(second.refreshToken).not.toBe(first.refreshToken);
      expect(await tokens.verifyAccessToken(second.accessToken)).toBe(
        first.user.id,
      );

      const again = await refresh(first.refreshToken).expect(401);
      expect((again.body as ErrorBody).code).toBe('invalid_refresh_token');
      await refresh(second.refreshToken).expect(200);
    });

    it('answers invalid_refresh_token for an unknown token', async () => {
      const res = await refresh('nope').expect(401);
      expect((res.body as ErrorBody).code).toBe('invalid_refresh_token');
    });

    it('answers invalid_refresh_token for an expired token', async () => {
      const first = (await register(ann).expect(201)).body as AuthBody;
      await ds.query(
        `update refresh_tokens set expires_at = now() - interval '1 second'`,
      );
      const res = await refresh(first.refreshToken).expect(401);
      expect((res.body as ErrorBody).code).toBe('invalid_refresh_token');
    });

    it('rejects a request without a token', async () => {
      await api().post('/auth/refresh').send({}).expect(400);
    });
  });

  describe('POST /auth/logout', () => {
    it('ends that session only and answers 204', async () => {
      await register(ann).expect(201);
      const phone = (await login(ann).expect(200)).body as AuthBody;
      const tablet = (await login(ann).expect(200)).body as AuthBody;
      await logout(phone.refreshToken).expect(204);
      await refresh(phone.refreshToken).expect(401);
      await refresh(tablet.refreshToken).expect(200);
    });

    it('is harmless to repeat or to send with a junk token', async () => {
      const first = (await register(ann).expect(201)).body as AuthBody;
      await logout(first.refreshToken).expect(204);
      await logout(first.refreshToken).expect(204);
      await logout('junk').expect(204);
    });

    it('rejects a request without a token', async () => {
      await api().post('/auth/logout').send({}).expect(400);
    });
  });
});
