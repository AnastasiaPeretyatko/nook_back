import { INestApplication } from '@nestjs/common';
import { createHash } from 'crypto';
import { DataSource } from 'typeorm';
import { TokenService } from '../src/auth/token.service';
import { createTestApp, truncateAll } from './support/db';

describe('Refresh tokens', () => {
  let app: INestApplication;
  let ds: DataSource;
  let tokens: TokenService;

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
    tokens = app.get(TokenService);
  });

  beforeEach(() => truncateAll(ds));

  afterAll(() => app.close());

  async function addUser(email = 'a@example.com') {
    const [row] = await ds.query(
      `insert into users (email, password_hash) values ($1, 'hash') returning id`,
      [email],
    );
    return row.id as string;
  }

  const count = async (where = 'true') =>
    (
      await ds.query(
        `select count(*)::int n from refresh_tokens where ${where}`,
      )
    )[0].n as number;

  it('stores only a hash, valid for 90 days by the database clock', async () => {
    const userId = await addUser();
    const token = await tokens.issueRefreshToken(userId);
    const [row] = await ds.query(
      `select token_hash, expires_at - now() as left from refresh_tokens`,
    );
    expect(row.token_hash).toBe(
      createHash('sha256').update(token).digest('hex'),
    );
    expect(row.token_hash).not.toContain(token);
    expect(row.left.days).toBeGreaterThanOrEqual(89);
    expect(token.length).toBeGreaterThanOrEqual(43); // 32 random bytes
  });

  it('gives a different token every time', async () => {
    const userId = await addUser();
    const a = await tokens.issueRefreshToken(userId);
    const b = await tokens.issueRefreshToken(userId);
    expect(a).not.toBe(b);
  });

  it('rotates: the old token dies, the new one works', async () => {
    const userId = await addUser();
    const first = await tokens.issueRefreshToken(userId);
    const second = await tokens.rotateRefreshToken(first);
    expect(second.userId).toBe(userId);
    expect(second.refreshToken).not.toBe(first);
    expect(await count()).toBe(1);
    const third = await tokens.rotateRefreshToken(second.refreshToken);
    expect(third.userId).toBe(userId);
  });

  it('rejects a reused token, and leaves the user other sessions alone', async () => {
    const userId = await addUser();
    const phone = await tokens.issueRefreshToken(userId);
    const tablet = await tokens.issueRefreshToken(userId);
    await tokens.rotateRefreshToken(phone);
    await expect(tokens.rotateRefreshToken(phone)).rejects.toMatchObject({
      response: { code: 'invalid_refresh_token' },
    });
    // the tablet session survives (the agreed soft behaviour)
    await expect(tokens.rotateRefreshToken(tablet)).resolves.toBeDefined();
  });

  it('rejects an unknown token', async () => {
    await expect(tokens.rotateRefreshToken('nope')).rejects.toMatchObject({
      response: { code: 'invalid_refresh_token' },
    });
  });

  it('rejects an expired token and keeps nothing new', async () => {
    const userId = await addUser();
    const token = await tokens.issueRefreshToken(userId);
    await ds.query(
      `update refresh_tokens set expires_at = now() - interval '1 second'`,
    );
    await expect(tokens.rotateRefreshToken(token)).rejects.toMatchObject({
      response: { code: 'invalid_refresh_token' },
    });
    expect(await count()).toBe(1); // the expired row is still there, nothing was added
  });

  it('lets exactly one of two simultaneous refreshes win', async () => {
    const userId = await addUser();
    const token = await tokens.issueRefreshToken(userId);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => tokens.rotateRefreshToken(token)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(4);
    expect(await count()).toBe(1);
  });

  it('keeps the old token usable if issuing the new one fails', async () => {
    const userId = await addUser();
    const token = await tokens.issueRefreshToken(userId);
    const spy = jest
      .spyOn(tokens, 'issueRefreshToken')
      .mockRejectedValueOnce(new Error('boom'));
    await expect(tokens.rotateRefreshToken(token)).rejects.toThrow('boom');
    spy.mockRestore();
    await expect(tokens.rotateRefreshToken(token)).resolves.toBeDefined();
  });

  it('revokes a token, and revoking twice or revoking junk is harmless', async () => {
    const userId = await addUser();
    const token = await tokens.issueRefreshToken(userId);
    await tokens.revokeRefreshToken(token);
    await tokens.revokeRefreshToken(token);
    await tokens.revokeRefreshToken('junk');
    expect(await count()).toBe(0);
    await expect(tokens.rotateRefreshToken(token)).rejects.toMatchObject({
      response: { code: 'invalid_refresh_token' },
    });
  });

  it("sweeps only that user's expired tokens when a new one is issued", async () => {
    const ann = await addUser('ann@example.com');
    const bob = await addUser('bob@example.com');
    await tokens.issueRefreshToken(ann);
    await tokens.issueRefreshToken(bob);
    await ds.query(
      `update refresh_tokens set expires_at = now() - interval '1 day'`,
    );
    const live = await tokens.issueRefreshToken(ann);
    expect(await count(`user_id = '${ann}'`)).toBe(1); // only the fresh one
    expect(await count(`user_id = '${bob}'`)).toBe(1); // Bob's expired row untouched
    await expect(tokens.rotateRefreshToken(live)).resolves.toBeDefined();
  });
});
