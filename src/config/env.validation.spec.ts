import 'reflect-metadata'; // Nest loads it in the app; a bare unit test does not
import { validateEnv } from './env.validation';

const valid = {
  DATABASE_URL: 'postgresql://user:pass@host/db?sslmode=require',
  JWT_SECRET: 'x'.repeat(32),
};

const key = {
  type: 'service_account',
  project_id: 'nook-test',
  client_email: 'firebase-adminsdk-x@nook-test.iam.gserviceaccount.com',
  private_key:
    '-----BEGIN PRIVATE KEY-----\nTOP-SECRET-BYTES\n-----END PRIVATE KEY-----\n',
};
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64');

describe('validateEnv', () => {
  it('applies defaults for NODE_ENV and PORT', () => {
    const env = validateEnv(valid);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
  });

  it('converts PORT from string to number', () => {
    expect(validateEnv({ ...valid, PORT: '8080' }).PORT).toBe(8080);
  });

  it('fails without DATABASE_URL', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
  });

  it('fails on a non-postgres DATABASE_URL', () => {
    expect(() => validateEnv({ DATABASE_URL: 'mysql://x/y' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('requires sslmode in DATABASE_URL in production only', () => {
    const plain = {
      DATABASE_URL: 'postgresql://u:p@db.example.com/d',
      JWT_SECRET: valid.JWT_SECRET,
    };
    expect(() => validateEnv({ ...plain, NODE_ENV: 'production' })).toThrow(
      /sslmode/,
    );
    expect(() =>
      validateEnv({ ...plain, NODE_ENV: 'development' }),
    ).not.toThrow();
    expect(() =>
      validateEnv({ ...valid, NODE_ENV: 'production' }),
    ).not.toThrow();
  });

  describe('plain text to the database in production', () => {
    const prod = (host: string, query = '') => ({
      DATABASE_URL: `postgresql://u:p@${host}/d${query}`,
      JWT_SECRET: valid.JWT_SECRET,
      NODE_ENV: 'production',
    });

    it.each([
      'localhost:5432',
      '127.0.0.1',
      '[::1]:5432',
      'postgres',
      'postgres:5432',
      'my-db_1',
    ])(
      'allows %s: a database on this machine or in the Docker network',
      (host) => {
        expect(() => validateEnv(prod(host))).not.toThrow();
        expect(() => validateEnv(prod(host, '?sslmode=disable'))).not.toThrow();
      },
    );

    it.each([
      'db.example.com',
      'ep-x-pooler.c-6.us-east-2.aws.neon.tech',
      '8.8.8.8',
      '10.0.0.5',
      '2130706433', // 127.0.0.1 to the resolver, but any address could hide like this
      '134744072', // 8.8.8.8
      '[2001:db8::1]',
      '[::2]',
    ])('still demands TLS for %s', (host) => {
      expect(() => validateEnv(prod(host))).toThrow(/sslmode/);
      expect(() => validateEnv(prod(host, '?sslmode=disable'))).toThrow(
        /sslmode/,
      );
      expect(() => validateEnv(prod(host, '?sslmode=require'))).not.toThrow();
    });
  });

  it('fails on a bad PORT', () => {
    expect(() => validateEnv({ ...valid, PORT: '99999' })).toThrow(/PORT/);
    expect(() => validateEnv({ ...valid, PORT: 'abc' })).toThrow(/PORT/);
  });

  it('fails on an unknown NODE_ENV', () => {
    expect(() => validateEnv({ ...valid, NODE_ENV: 'staging' })).toThrow(
      /NODE_ENV/,
    );
  });

  it('accepts SELF_PING_URL when it is a URL, rejects garbage', () => {
    const url = 'https://nook.onrender.com';
    expect(validateEnv({ ...valid, SELF_PING_URL: url }).SELF_PING_URL).toBe(
      url,
    );
    expect(() => validateEnv({ ...valid, SELF_PING_URL: 'nope' })).toThrow(
      /SELF_PING_URL/,
    );
  });

  it('requires JWT_SECRET of at least 32 characters', () => {
    expect(() => validateEnv({ DATABASE_URL: valid.DATABASE_URL })).toThrow(
      /JWT_SECRET/,
    );
    expect(() => validateEnv({ ...valid, JWT_SECRET: 'x'.repeat(31) })).toThrow(
      /JWT_SECRET/,
    );
    expect(() =>
      validateEnv({ ...valid, JWT_SECRET: 'x'.repeat(32) }),
    ).not.toThrow();
  });

  it('turns GOOGLE_CLIENT_IDS into a trimmed list', () => {
    const env = validateEnv({
      ...valid,
      GOOGLE_CLIENT_IDS: ' a.apps , b.apps,, ',
    });
    expect(env.GOOGLE_CLIENT_IDS).toEqual(['a.apps', 'b.apps']);
  });

  it('leaves GOOGLE_CLIENT_IDS unset when absent, empty list when blank', () => {
    expect(validateEnv(valid).GOOGLE_CLIENT_IDS).toBeUndefined();
    expect(
      validateEnv({ ...valid, GOOGLE_CLIENT_IDS: '' }).GOOGLE_CLIENT_IDS,
    ).toEqual([]);
  });

  it('trusts no proxy by default and accepts 0 to 5 hops', () => {
    expect(validateEnv(valid).TRUST_PROXY_HOPS).toBe(0);
    expect(
      validateEnv({ ...valid, TRUST_PROXY_HOPS: '1' }).TRUST_PROXY_HOPS,
    ).toBe(1);
    for (const hops of ['-1', '6', 'x', '1.5']) {
      expect(() => validateEnv({ ...valid, TRUST_PROXY_HOPS: hops })).toThrow(
        /TRUST_PROXY_HOPS/,
      );
    }
  });

  it('keeps the rate limiter on by default and refuses it off in production', () => {
    expect(validateEnv(valid).RATE_LIMIT).toBe('on');
    expect(validateEnv({ ...valid, RATE_LIMIT: 'off' }).RATE_LIMIT).toBe('off');
    expect(() => validateEnv({ ...valid, RATE_LIMIT: 'maybe' })).toThrow(
      /RATE_LIMIT/,
    );
    expect(() =>
      validateEnv({ ...valid, NODE_ENV: 'production', RATE_LIMIT: 'off' }),
    ).toThrow(/RATE_LIMIT=off/);
  });

  describe('FIREBASE_SERVICE_ACCOUNT', () => {
    const withKey = (value: unknown) =>
      validateEnv({ ...valid, FIREBASE_SERVICE_ACCOUNT: value });

    it('is optional: not set or blank means push is off', () => {
      expect(validateEnv(valid).FIREBASE_SERVICE_ACCOUNT).toBeUndefined();
      expect(withKey('').FIREBASE_SERVICE_ACCOUNT).toBeUndefined();
      expect(withKey('  \n').FIREBASE_SERVICE_ACCOUNT).toBeUndefined();
    });

    it('accepts a key file encoded as base64', () => {
      expect(withKey(encode(key)).FIREBASE_SERVICE_ACCOUNT).toBe(encode(key));
    });

    it('tolerates a trailing newline from the shell', () => {
      expect(() => withKey(`${encode(key)}\n`)).not.toThrow();
    });

    it('refuses the JSON itself and says what to do', () => {
      expect(() => withKey(JSON.stringify(key))).toThrow(
        /JSON itself.*base64 -w0/,
      );
    });

    it.each([
      ['text that is not base64 of JSON', 'definitely not a key'],
      [
        'base64 of text that is not JSON',
        Buffer.from('hello').toString('base64'),
      ],
      ['base64 of JSON null', encode(null)],
      ['a JSON list', encode([key])],
      ['a key of another type', encode({ ...key, type: 'authorized_user' })],
      ['a key without project_id', encode({ ...key, project_id: undefined })],
      [
        'a key with an empty client_email',
        encode({ ...key, client_email: '' }),
      ],
      ['a key without private_key', encode({ ...key, private_key: undefined })],
      [
        'a private_key that is not a PEM',
        encode({ ...key, private_key: 'abc' }),
      ],
      ['a number in project_id', encode({ ...key, project_id: 5 })],
    ])('stops the start on %s', (_name, value) => {
      expect(() => withKey(value)).toThrow(/FIREBASE_SERVICE_ACCOUNT/);
    });

    it.each([
      'TOP-SECRET-BYTES but not base64 of JSON',
      JSON.stringify(key),
      Buffer.from('TOP-SECRET-BYTES').toString('base64'),
      encode({ ...key, type: 'authorized_user' }),
    ])('never repeats what was given in the error (%#)', (given) => {
      let message = '';
      try {
        withKey(given);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/FIREBASE_SERVICE_ACCOUNT/);
      expect(message).not.toContain('TOP-SECRET-BYTES');
      expect(message).not.toContain(given);
    });

    it('never repeats the key in the error', () => {
      const broken = encode({ ...key, project_id: '' });
      let message = '';
      try {
        withKey(broken);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/FIREBASE_SERVICE_ACCOUNT/);
      for (const secret of ['TOP-SECRET-BYTES', 'BEGIN PRIVATE', broken]) {
        expect(message).not.toContain(secret);
      }
    });
  });
});
