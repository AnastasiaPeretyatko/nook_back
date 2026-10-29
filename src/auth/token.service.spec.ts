import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { ACCESS_TTL_SECONDS, TokenService } from './token.service';

const SECRET = 'unit-test-secret-unit-test-secret-0123';
const b64 = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

describe('TokenService access tokens', () => {
  const service = new TokenService(
    new JwtService({ secret: SECRET }),
    {} as DataSource,
  );

  afterEach(() => jest.restoreAllMocks());

  // Only Date.now is faked: jest's fake timers also stall the library's async signing.
  const at = (iso: string) =>
    jest.spyOn(Date, 'now').mockReturnValue(new Date(iso).getTime());

  it('round-trips the user id', async () => {
    const token = await service.signAccessToken('user-1');
    expect(await service.verifyAccessToken(token)).toBe('user-1');
  });

  it('lives for one hour', async () => {
    at('2026-01-01T00:00:00Z');
    const token = await service.signAccessToken('user-1');
    at('2026-01-01T00:59:00Z');
    expect(await service.verifyAccessToken(token)).toBe('user-1');
    at('2026-01-01T01:00:01Z');
    expect(await service.verifyAccessToken(token)).toBeNull();
    expect(ACCESS_TTL_SECONDS).toBe(3600);
  });

  it('readAccessToken gives the user and the expiry in milliseconds', async () => {
    at('2026-01-01T00:00:00Z');
    const token = await service.signAccessToken('user-1');
    expect(await service.readAccessToken(token)).toEqual({
      userId: 'user-1',
      expiresAt: new Date('2026-01-01T01:00:00Z').getTime(),
    });
  });

  it('rejects a token that never expires', async () => {
    const token = await new JwtService({ secret: SECRET }).signAsync(
      { sub: 'user-1' },
      { algorithm: 'HS256' },
    );
    expect(await service.readAccessToken(token)).toBeNull();
    expect(await service.verifyAccessToken(token)).toBeNull();
  });

  it('rejects a token signed with another secret', async () => {
    const foreign = new JwtService({
      secret: 'another-secret-another-secret-0123456',
    });
    const token = await foreign.signAsync({ sub: 'user-1' }, { expiresIn: 60 });
    expect(await service.verifyAccessToken(token)).toBeNull();
  });

  it('rejects a payload swapped under the original signature', async () => {
    const [header, , signature] = (
      await service.signAccessToken('user-1')
    ).split('.');
    const forged = `${header}.${b64({ sub: 'admin', exp: 9999999999 })}.${signature}`;
    expect(await service.verifyAccessToken(forged)).toBeNull();
  });

  it('rejects an unsigned token (alg "none")', async () => {
    const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'user-1', exp: 9999999999 })}.`;
    expect(await service.verifyAccessToken(unsigned)).toBeNull();
  });

  it('rejects garbage and a token without a string sub', async () => {
    expect(await service.verifyAccessToken('')).toBeNull();
    expect(await service.verifyAccessToken('a.b.c')).toBeNull();
    const numeric = await new JwtService({ secret: SECRET }).signAsync({
      sub: 42,
    });
    expect(await service.verifyAccessToken(numeric)).toBeNull();
  });
});
