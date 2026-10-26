import { Controller, Get, INestApplication, Post } from '@nestjs/common';
import { DiscoveryService, ModulesContainer } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { CurrentUserId } from '../src/auth/auth.guard';
import { IS_PUBLIC_KEY, Public } from '../src/auth/public.decorator';
import { createTestApp, truncateAll } from './support/db';

// Routes that exist only in this test, but go through the app's real global guard.
@Controller('probe')
class ProbeController {
  @Get('private')
  private_(@CurrentUserId() userId: string) {
    return { userId };
  }

  @Post('private')
  privatePost() {
    return { ok: true };
  }

  @Public()
  @Get('open')
  open(@CurrentUserId() userId?: string) {
    return { userId: userId ?? null };
  }
}

describe('Access guard', () => {
  let app: INestApplication;
  let ds: DataSource;
  const api = () => request(app.getHttpServer());

  async function signUp() {
    const res = await api()
      .post('/auth/register')
      .send({ email: 'ann@example.com', password: 'correct horse' })
      .expect(201);
    return res.body as { accessToken: string; user: { id: string } };
  }

  beforeAll(async () => {
    app = await createTestApp([ProbeController]);
    ds = app.get(DataSource);
  });

  beforeEach(() => truncateAll(ds));

  afterAll(() => app.close());

  it('closes every route that is not marked public', async () => {
    const calls = [
      () => api().get('/probe/private'),
      () => api().post('/probe/private'),
    ];
    for (const call of calls) {
      const res = await call().expect(401);
      expect(res.body).toEqual({
        code: 'unauthorized',
        message: 'Missing or invalid access token',
      });
    }
  });

  it('lets a valid token in and hands the route the user id from the token', async () => {
    const { accessToken, user } = await signUp();
    const res = await api()
      .get('/probe/private')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body).toEqual({ userId: user.id });
    await api()
      .post('/probe/private')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(201);
  });

  it('does not let a client name the user: body, query and headers are ignored', async () => {
    const { accessToken, user } = await signUp();
    const res = await api()
      .get('/probe/private?userId=someone-else')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-User-Id', 'someone-else')
      .expect(200);
    expect(res.body).toEqual({ userId: user.id });
  });

  it('refuses expired, foreign, refresh and garbage tokens with the same answer', async () => {
    const jwt = app.get(JwtService);
    const expired = await jwt.signAsync({ sub: 'u1' }, { expiresIn: -10 });
    const foreign = await new JwtService({
      secret: 'another-secret-another-secret-0123456',
    }).signAsync({ sub: 'u1' }, { expiresIn: 60 });
    const { accessToken } = await signUp();
    const refreshLike = 'rcPX-kXQ-this-is-an-opaque-refresh-token-0123456';
    const tampered = `${accessToken.slice(0, -3)}${accessToken.endsWith('abc') ? 'xyz' : 'abc'}`;

    for (const token of [expired, foreign, refreshLike, tampered, 'garbage']) {
      const res = await api()
        .get('/probe/private')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
      expect((res.body as { code: string }).code).toBe('unauthorized');
    }
  });

  it('keeps public routes open, with or without a token', async () => {
    await api().get('/probe/open').expect(200, { userId: null });
    await api().get('/health').expect(200);
    // Reaches the login logic (wrong credentials), so the guard did not stop it.
    const res = await api()
      .post('/auth/login')
      .send({ email: 'x@example.com', password: 'whatever' })
      .expect(401);
    expect((res.body as { code: string }).code).toBe('invalid_credentials');
  });

  it('answers an unknown route with 404, not 401', async () => {
    await api().get('/nope').expect(404);
  });

  // Known limit, on purpose: the token is checked by signature alone (no database), so it works
  // until it expires even if the account was deleted. If this ever changes, change it knowingly.
  it('trusts a correctly signed token without asking the database', async () => {
    const { accessToken } = await signUp();
    await ds.query(`delete from users`);
    await api()
      .get('/probe/private')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
  });

  // Tripwire: a new controller is protected unless it says @Public(). Making another one
  // public must be a conscious change to this list.
  it('has exactly these public controllers, and no public single routes', () => {
    const controllers = new DiscoveryService(app.get(ModulesContainer))
      .getControllers()
      .map((wrapper) => wrapper.metatype as (new () => object) | null)
      .filter((type): type is new () => object => !!type)
      .filter((type) => type.name !== 'ProbeController');

    const publicControllers = controllers
      .filter((type) => Reflect.getMetadata(IS_PUBLIC_KEY, type) === true)
      .map((type) => type.name)
      .sort();
    expect(publicControllers).toEqual(['AuthController', 'HealthController']);

    const publicRoutes = controllers.flatMap((type) =>
      Object.getOwnPropertyNames(type.prototype)
        .filter((name) => name !== 'constructor')
        .filter(
          (name) =>
            Reflect.getMetadata(
              IS_PUBLIC_KEY,
              (type.prototype as Record<string, object>)[name],
            ) === true,
        )
        .map((name) => `${type.name}.${name}`),
    );
    expect(publicRoutes).toEqual([]);
  });
});
