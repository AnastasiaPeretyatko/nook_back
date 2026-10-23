import 'reflect-metadata'; // Nest loads it in the app; a bare unit test does not
import { validateEnv } from './env.validation';

const valid = {
  DATABASE_URL: 'postgresql://user:pass@host/db?sslmode=require',
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
    const plain = { DATABASE_URL: 'postgresql://u:p@h/d' };
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
});
