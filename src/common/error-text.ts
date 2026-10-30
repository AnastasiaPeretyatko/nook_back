// What may be written to the log about an error.
//
// Postgres puts values the client sent into its messages (`invalid input syntax for type uuid:
// "<value>"`, `value "<value>" is out of range`), and TypeORM passes that text on. Anything a
// client can type may therefore be in `error.message`, and a log must never hold it. For database
// errors only the kind and the SQLSTATE code are kept (the code tells what went wrong); the
// stack frames stay so the place in our code is still visible. Other errors keep their message.
// shortcut: a non-database error that interpolates a client value into its own message is not
// caught here, so never build such messages in our code.
function isDatabaseError(error: unknown): error is Error & { code: string } {
  const e = error as {
    severity?: unknown;
    code?: unknown;
    driverError?: unknown;
  };
  return (
    error instanceof Error &&
    (e.driverError !== undefined ||
      (typeof e.severity === 'string' && typeof e.code === 'string'))
  );
}

export function errorText(error: unknown): string {
  if (isDatabaseError(error)) {
    const code =
      error.code ??
      (error as { driverError?: { code?: string } }).driverError?.code;
    return `${error.name} (database error${code ? ` ${code}` : ''})`;
  }
  return error instanceof Error ? error.message : String(error);
}

export function errorStack(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (!isDatabaseError(error)) return error.stack;
  const frames = (error.stack ?? '')
    .split('\n')
    .filter((line) => line.trimStart().startsWith('at '));
  return [errorText(error), ...frames].join('\n');
}
