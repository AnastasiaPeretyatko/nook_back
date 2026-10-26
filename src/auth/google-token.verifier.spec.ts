import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { generateKeyPairSync } from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import {
  GoogleTokenVerifier,
  InvalidGoogleToken,
} from './google-token.verifier';

const MY_CLIENT = 'my-app.apps.googleusercontent.com';
const OTHER_CLIENT = 'another-app.apps.googleusercontent.com';

const pair = () =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
const google = pair(); // stands in for Google's signing key
const stranger = pair();

const sign = (
  claims: Record<string, unknown> = {},
  options: { key?: string; kid?: string; expiresIn?: number } = {},
) =>
  new JwtService().signAsync(
    {
      iss: 'https://accounts.google.com',
      aud: MY_CLIENT,
      sub: '1234567890',
      email: 'ann@gmail.com',
      email_verified: true,
      name: 'Ann',
      picture: 'https://lh3.googleusercontent.com/a/photo',
      ...claims,
    },
    {
      privateKey: options.key ?? google.privateKey,
      algorithm: 'RS256',
      keyid: options.kid ?? 'google-key-1',
      expiresIn: options.expiresIn ?? 3600,
    },
  );

describe('GoogleTokenVerifier', () => {
  function makeVerifier(clientIds: string[] | null = [MY_CLIENT]) {
    const client = new OAuth2Client();
    // No network: hand the library "Google's" public key directly.
    jest.spyOn(client, 'getFederatedSignonCertsAsync').mockResolvedValue({
      certs: { 'google-key-1': google.publicKey },
      format: 'PEM' as never,
    });
    const config = { get: () => clientIds } as unknown as ConfigService<
      any,
      true
    >;
    return { verifier: new GoogleTokenVerifier(client, config), client };
  }

  afterEach(() => jest.restoreAllMocks());

  it('accepts a genuine token and returns who it is about', async () => {
    const { verifier } = makeVerifier();
    expect(await verifier.verify(await sign())).toEqual({
      sub: '1234567890',
      email: 'ann@gmail.com',
      emailVerified: true,
      name: 'Ann',
      picture: 'https://lh3.googleusercontent.com/a/photo',
    });
  });

  it('accepts the old "accounts.google.com" issuer and any configured client id', async () => {
    const { verifier } = makeVerifier([OTHER_CLIENT, MY_CLIENT]);
    await expect(
      verifier.verify(await sign({ iss: 'accounts.google.com' })),
    ).resolves.toMatchObject({ sub: '1234567890' });
  });

  it('reports an unverified email as such, and a missing name or picture as null', async () => {
    const { verifier } = makeVerifier();
    const identity = await verifier.verify(
      await sign({
        email_verified: false,
        name: undefined,
        picture: undefined,
      }),
    );
    expect(identity).toMatchObject({
      emailVerified: false,
      name: null,
      picture: null,
    });
    const stringy = await verifier.verify(
      await sign({ email_verified: 'true' }),
    );
    expect(stringy.emailVerified).toBe(true);
  });

  it.each([
    [
      'a token made for another app',
      () => sign({ aud: 'evil.apps.googleusercontent.com' }),
    ],
    ['a token without an audience', () => sign({ aud: undefined })],
    ['an expired token', () => sign({}, { expiresIn: -3600 })],
    ['another issuer', () => sign({ iss: 'https://evil.example.com' })],
    [
      'a signature from a different key',
      () => sign({}, { key: stranger.privateKey }),
    ],
    ['an unknown key id', () => sign({}, { kid: 'not-a-google-key' })],
    ['a token without a subject', () => sign({ sub: undefined })],
    ['a token without an email', () => sign({ email: undefined })],
    [
      'an unsigned token (alg none)',
      () =>
        Promise.resolve(
          `${Buffer.from('{"alg":"none","typ":"JWT","kid":"google-key-1"}').toString('base64url')}.` +
            `${Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: MY_CLIENT, sub: '1', email: 'a@b.c', iat: 1, exp: 9999999999 })).toString('base64url')}.`,
        ),
    ],
    ['garbage', () => Promise.resolve('not.a.token')],
    ['an empty string', () => Promise.resolve('')],
  ])('rejects %s', async (_name, makeToken) => {
    const { verifier } = makeVerifier();
    await expect(verifier.verify(await makeToken())).rejects.toBeInstanceOf(
      InvalidGoogleToken,
    );
  });

  it('accepts nothing when no client id is configured, and does not even ask the library', async () => {
    for (const ids of [null, []]) {
      const { verifier, client } = makeVerifier(ids);
      const spy = jest.spyOn(client, 'verifyIdToken');
      await expect(verifier.verify(await sign())).rejects.toBeInstanceOf(
        InvalidGoogleToken,
      );
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('never writes the token to the log', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { verifier } = makeVerifier();
    const token = await sign({ aud: 'evil.apps.googleusercontent.com' });
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(
      InvalidGoogleToken,
    );
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(token.slice(0, 30));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('ann@gmail.com');
  });
});
