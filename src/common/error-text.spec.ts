import { QueryFailedError } from 'typeorm';
import { errorStack, errorText } from './error-text';

// What pg throws for a bad value: the message holds the value, `code` is the SQLSTATE.
function pgError() {
  return Object.assign(
    new Error('invalid input syntax for type uuid: "SECRET"'),
    {
      severity: 'ERROR',
      code: '22P02',
    },
  );
}

describe('errorText / errorStack', () => {
  it('keeps the message of an ordinary error', () => {
    const error = new Error('Cannot read properties of undefined');
    expect(errorText(error)).toBe('Cannot read properties of undefined');
    expect(errorStack(error)).toBe(error.stack);
  });

  it('turns a non-error into text', () => {
    expect(errorText('oops')).toBe('oops');
    expect(errorStack('oops')).toBeUndefined();
  });

  it('keeps only the kind and the SQLSTATE of a pg error', () => {
    expect(errorText(pgError())).toBe('Error (database error 22P02)');
    expect(errorStack(pgError())).not.toContain('SECRET');
    expect(errorStack(pgError())).toContain('    at ');
  });

  it('does the same for the TypeORM wrapper', () => {
    const error = new QueryFailedError('select 1', ['SECRET'], pgError());
    expect(error.message).toContain('SECRET'); // the reason this module exists
    expect(errorText(error)).toBe('QueryFailedError (database error 22P02)');
    expect(errorStack(error)).not.toContain('SECRET');
  });

  it('keeps the message of a connection error (it has no client values)', () => {
    const error = Object.assign(
      new Error('connect ECONNREFUSED 127.0.0.1:5432'),
      {
        code: 'ECONNREFUSED',
      },
    );
    expect(errorText(error)).toBe('connect ECONNREFUSED 127.0.0.1:5432');
  });
});
