import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard, AuthedRequest } from './auth.guard';
import { TokenService } from './token.service';

describe('AuthGuard', () => {
  const verify = jest.fn();
  const reflector = { getAllAndOverride: jest.fn() };
  const guard = new AuthGuard(
    reflector as unknown as Reflector,
    { verifyAccessToken: verify } as unknown as TokenService,
  );

  function contextWith(authorization?: string) {
    const request = { headers: { authorization } } as AuthedRequest;
    const context = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return { context, request };
  }

  beforeEach(() => {
    verify.mockReset();
    reflector.getAllAndOverride.mockReset().mockReturnValue(false);
  });

  it('lets a public route through without looking at the token', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    const { context } = contextWith(undefined);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(verify).not.toHaveBeenCalled();
  });

  it('accepts a valid bearer token and records the user id', async () => {
    verify.mockResolvedValue('user-1');
    const { context, request } = contextWith('Bearer abc.def.ghi');
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith('abc.def.ghi');
    expect(request.userId).toBe('user-1');
  });

  it('accepts the scheme in any letter case', async () => {
    verify.mockResolvedValue('user-1');
    await expect(
      guard.canActivate(contextWith('bearer abc').context),
    ).resolves.toBe(true);
  });

  it.each([
    ['no header', undefined],
    ['empty header', ''],
    ['another scheme', 'Basic abc'],
    ['no token', 'Bearer'],
    ['no token, trailing space', 'Bearer '],
    ['two tokens', 'Bearer a b'],
    ['token without scheme', 'abc'],
  ])('answers unauthorized for %s', async (_name, header) => {
    verify.mockResolvedValue('user-1');
    await expect(
      guard.canActivate(contextWith(header).context),
    ).rejects.toMatchObject({
      response: { code: 'unauthorized' },
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it('answers unauthorized when the token does not verify', async () => {
    verify.mockResolvedValue(null);
    const { context, request } = contextWith('Bearer forged');
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(request.userId).toBeUndefined();
  });
});
