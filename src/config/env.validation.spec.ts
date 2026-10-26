import 'reflect-metadata'; // Nest loads it in the app; a bare unit test does not
import { validateEnv } from './env.validation';

const valid = {
  DATABASE_URL: 'postgresql://user:pass@host/db?sslmode=require',
  JWT_SECRET: 'x'.repeat(32),
};

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
      DATABASE_URL: 'postgresql://u:p@h/d',
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
});
