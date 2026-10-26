import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import {
  GoogleIdentity,
  GoogleTokenVerifier,
  InvalidGoogleToken,
} from '../src/auth/google-token.verifier';
import { TokenService } from '../src/auth/token.service';
import { UsersService } from '../src/users/users.service';
import { createTestApp, truncateAll } from './support/db';

interface AuthBody {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
}
interface ErrorBody {
  code: string;
  message: string;
}

const identity = (over: Partial<GoogleIdentity> = {}): GoogleIdentity => ({
  sub: 'google-sub-1',
  email: 'ann@gmail.com',
  emailVerified: true,
  name: 'Ann Google',
  picture: 'https://lh3.googleusercontent.com/a/ann',
  ...over,
});

describe('POST /auth/google', () => {
  let app: INestApplication;
  let ds: DataSource;
  let tokens: TokenService;
  // "Google": the token is looked up here instead of being verified against Google's keys.
  const issued = new Map<string, GoogleIdentity>();
  const fakeVerifier = {
    verify: (token: string) =>
      issued.has(token)
        ? Promise.resolve(issued.get(token) as GoogleIdentity)
        : Promise.reject(new InvalidGoogleToken('no such token')),
  };

  const api = () => request(app.getHttpServer());
  const googleLogin = (idToken: unknown) =>
    api().post('/auth/google').send({ idToken });
  const tokenFor = (over: Partial<GoogleIdentity> = {}) => {
    const token = `token-${issued.size}`;
    issued.set(token, identity(over));
    return token;
  };
  const count = async (table: string) =>
    (await ds.query(`select count(*)::int n from ${table}`))[0].n as number;

  beforeAll(async () => {
    app = await createTestApp([], 0, (b) =>
      b.overrideProvider(GoogleTokenVerifier).useValue(fakeVerifier),
    );
    ds = app.get(DataSource);
    tokens = app.get(TokenService);
  });

  beforeEach(async () => {
    issued.clear();
    await truncateAll(ds);
  });

  afterAll(() => app.close());

  it('creates the account on the first sign-in, with name and picture from Google', async () => {
    const res = await googleLogin(tokenFor()).expect(200);
    const body = res.body as AuthBody;
    expect(body.user).toEqual({
      id: expect.any(String),
      email: 'ann@gmail.com',
      displayName: 'Ann Google',
      avatarUrl: 'https://lh3.googleusercontent.com/a/ann',
    });
    expect(await tokens.verifyAccessToken(body.accessToken)).toBe(body.user.id);
    const [row] = await ds.query(`select password_hash, google_sub from users`);
    expect(row).toEqual({ password_hash: null, google_sub: 'google-sub-1' });
    expect(await count('profiles')).toBe(1);
    await api()
      .post('/auth/refresh')
      .send({ refreshToken: body.refreshToken })
      .expect(200);
    await api()
      .get('/me')
      .set('Authorization', `Bearer ${body.accessToken}`)
      .expect(200);
  });

  it('lower-cases the email', async () => {
    await googleLogin(tokenFor({ email: 'Ann.Smith@GMAIL.com' })).expect(200);
    const [row] = await ds.query(`select email from users`);
    expect(row.email).toBe('ann.smith@gmail.com');
  });

  it('signs the same person in again: same account, new session, profile left alone', async () => {
    const first = (await googleLogin(tokenFor()).expect(200)).body as AuthBody;
    await api()
      .put('/me/profile')
      .set('Authorization', `Bearer ${first.accessToken}`)
      .send({ displayName: 'My own name', avatarUrl: null })
      .expect(200);
    const second = (await googleLogin(tokenFor()).expect(200)).body as AuthBody;
    expect(second.user.id).toBe(first.user.id);
    expect(second.user.displayName).toBe('My own name'); // Google does not overwrite it
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(await count('users')).toBe(1);
    expect(await count('profiles')).toBe(1);
    expect(await count('refresh_tokens')).toBe(2);
  });

  it('recognises the account by Google id even if its Google email changed', async () => {
    const first = (await googleLogin(tokenFor()).expect(200)).body as AuthBody;
    const again = (
      await googleLogin(tokenFor({ email: 'ann.new@gmail.com' })).expect(200)
    ).body as AuthBody;
    expect(again.user.id).toBe(first.user.id);
    expect(again.user.email).toBe('ann@gmail.com'); // our record is not rewritten
  });

  it('refuses to merge into a password account with the same email, and touches nothing', async () => {
    await api()
      .post('/auth/register')
      .send({ email: 'ann@gmail.com', password: 'correct horse' })
      .expect(201);
    const res = await googleLogin(tokenFor()).expect(409);
    expect((res.body as ErrorBody).code).toBe('google_email_conflict');
    expect(await count('users')).toBe(1);
    const [row] = await ds.query(
      `select google_sub, password_hash is not null as has_password from users`,
    );
    expect(row).toEqual({ google_sub: null, has_password: true });
    expect(await count('refresh_tokens')).toBe(1); // only the password sign-up's session
    // the password owner can still sign in
    await api()
      .post('/auth/login')
      .send({ email: 'ann@gmail.com', password: 'correct horse' })
      .expect(200);
  });

  it('refuses a second Google account that reports an email already used by another one', async () => {
    await googleLogin(tokenFor({ sub: 'sub-A' })).expect(200);
    const res = await googleLogin(tokenFor({ sub: 'sub-B' })).expect(409);
    expect((res.body as ErrorBody).code).toBe('google_email_conflict');
    expect(await count('users')).toBe(1);
  });

  it('treats an unverified Google email as an invalid token and creates nothing', async () => {
    const res = await googleLogin(tokenFor({ emailVerified: false })).expect(
      401,
    );
    expect((res.body as ErrorBody).code).toBe('google_token_invalid');
    expect(await count('users')).toBe(0);
  });

  it('answers google_token_invalid for a token Google does not vouch for', async () => {
    const res = await googleLogin('forged-token').expect(401);
    expect((res.body as ErrorBody).code).toBe('google_token_invalid');
    expect(await count('users')).toBe(0);
  });

  it.each([[undefined], [''], [42], [{}], ['x'.repeat(4097)]])(
    'rejects the malformed idToken %p as a validation error',
    async (idToken) => {
      const res = await googleLogin(idToken).expect(400);
      expect((res.body as ErrorBody).code).toBe('validation_failed');
    },
  );

  it('does not let a Google-only account sign in with a password', async () => {
    await googleLogin(tokenFor()).expect(200);
    const res = await api()
      .post('/auth/login')
      .send({ email: 'ann@gmail.com', password: 'anything at all' })
      .expect(401);
    expect((res.body as ErrorBody).code).toBe('invalid_credentials');
  });

  it('lets two simultaneous first sign-ins of one Google account share one account', async () => {
    // Force the unlucky timing: both requests look the account up, both find nothing,
    // and only then do both try to create it.
    const users = app.get(UsersService);
    const realLookup = users.findByGoogleSub.bind(
      users,
    ) as UsersService['findByGoogleSub'];
    let lookups = 0;
    let release!: () => void;
    const bothLooked = new Promise<void>((resolve) => (release = resolve));
    jest.spyOn(users, 'findByGoogleSub').mockImplementation(async (sub) => {
      lookups += 1;
      if (lookups > 2) return realLookup(sub); // the loser's second look finds the winner
      if (lookups === 2) release();
      await bothLooked;
      return null;
    });
    try {
      const token = tokenFor();
      const results = await Promise.all([
        googleLogin(token),
        googleLogin(token),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      const ids = results.map((r) => (r.body as AuthBody).user.id);
      expect(ids[0]).toBe(ids[1]);
      expect(await count('users')).toBe(1);
      expect(await count('profiles')).toBe(1);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('fits Google data into the profile limits: long name cut, odd picture dropped', async () => {
    const long = '😀'.repeat(150);
    const res = await googleLogin(
      tokenFor({ name: long, picture: 'http://insecure.example.com/a.png' }),
    ).expect(200);
    const user = (res.body as AuthBody).user;
    expect([...(user.displayName as string)]).toHaveLength(100);
    expect(user.avatarUrl).toBeNull();
  });

  it('leaves the profile empty when Google sends no name or picture', async () => {
    const res = await googleLogin(
      tokenFor({ name: null, picture: null }),
    ).expect(200);
    expect((res.body as AuthBody).user).toMatchObject({
      displayName: null,
      avatarUrl: null,
    });
  });
});

describe('POST /auth/google with the real verifier and no client ids configured', () => {
  it('accepts no token at all', async () => {
    const app = await createTestApp();
    try {
      const res = await request(app.getHttpServer())
        .post('/auth/google')
        .send({ idToken: 'eyJhbGciOi.any.thing' })
        .expect(401);
      expect((res.body as ErrorBody).code).toBe('google_token_invalid');
    } finally {
      await app.close();
    }
  });
});
