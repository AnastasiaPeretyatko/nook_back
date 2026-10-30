import { QueryFailedError } from 'typeorm';
import { isDbUnavailable } from './db-unavailable';

const withCode = (code: string, message = 'x') =>
  Object.assign(new Error(message), { code });

describe('isDbUnavailable', () => {
  it.each([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EPIPE',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENETUNREACH',
    '57P01', // admin_shutdown: the server is being stopped
    '57P02', // crash_shutdown
    '57P03', // cannot_connect_now: still starting up
    '53300', // too_many_connections
    '08000',
    '08003',
    '08006', // connection_failure
    '08P01',
  ])('%s: the database is unavailable', (code) => {
    expect(isDbUnavailable(withCode(code))).toBe(true);
  });

  it.each([
    'Connection terminated',
    'Connection terminated unexpectedly',
    'Connection terminated due to connection timeout',
    'timeout exceeded when trying to connect',
    'Client has encountered a connection error and is not queryable',
  ])('"%s" (pg has no code for it)', (message) => {
    expect(isDbUnavailable(new Error(message))).toBe(true);
  });

  it('sees through the TypeORM wrapper', () => {
    const wrapped = new QueryFailedError('select 1', [], withCode('57P01'));
    expect(isDbUnavailable(wrapped)).toBe(true);
  });

  it.each([
    '22P02', // bad input value
    '23505', // unique violation
    '23503', // foreign key violation
    '42P01', // missing table
    '42703', // missing column
    '40001', // serialization failure
    '53100', // disk full: not helped by waiting a few seconds
    '57014', // query cancelled
    'EACCES',
  ])('%s: our own error, stays a 500', (code) => {
    expect(isDbUnavailable(withCode(code))).toBe(false);
    const wrapped = new QueryFailedError('select 1', [], withCode(code));
    expect(isDbUnavailable(wrapped)).toBe(false);
  });

  it('ignores ordinary errors and non-errors', () => {
    expect(
      isDbUnavailable(new Error('Cannot read properties of undefined')),
    ).toBe(false);
    expect(isDbUnavailable(new Error('Connection terminated by a user'))).toBe(
      false,
    );
    expect(isDbUnavailable(null)).toBe(false);
    expect(isDbUnavailable(undefined)).toBe(false);
    expect(isDbUnavailable('ECONNREFUSED')).toBe(false);
  });
});
