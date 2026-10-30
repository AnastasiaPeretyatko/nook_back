// The database cannot answer right now, as opposed to "our query is wrong". The first kind is
// answered with 503 so the app waits and tries again; the second stays a 500 (a bug to fix).
//
// Socket errors (Node): nothing listens, the link broke, the name or route is gone.
const SOCKET_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);
// Postgres (SQLSTATE): class 08 = connection exception; 57P01/57P02 = the server was shut down
// or crashed; 57P03 = it is still starting; 53300 = too many connections.
const SQLSTATE_CODES = new Set(['57P01', '57P02', '57P03', '53300']);
// pg's own errors have no code, only these texts (pg and pg-pool, fixed strings with no client data).
const MESSAGES = new Set([
  'Connection terminated',
  'Connection terminated unexpectedly',
  'Connection terminated due to connection timeout',
  'timeout exceeded when trying to connect',
  'Client has encountered a connection error and is not queryable',
]);

export function isDbUnavailable(error: unknown): boolean {
  const e = error as {
    code?: unknown;
    message?: unknown;
    driverError?: unknown;
  } | null;
  if (typeof e !== 'object' || e === null) return false;
  if (typeof e.code === 'string') {
    if (SOCKET_CODES.has(e.code) || SQLSTATE_CODES.has(e.code)) return true;
    if (e.code.startsWith('08')) return true;
  }
  if (typeof e.message === 'string' && MESSAGES.has(e.message)) return true;
  // TypeORM wraps what the driver threw.
  return e.driverError !== undefined && isDbUnavailable(e.driverError);
}
