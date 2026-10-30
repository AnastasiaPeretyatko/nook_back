import { TEST_DATABASE_URL } from './test-env';

// Import this FIRST in a test that talks to the database through a TcpProxy. The app reads its
// settings the moment AppModule is imported, so the address has to be replaced before that.
export const PROXY_PORT = 54331;
const url = new URL(TEST_DATABASE_URL);
export const TARGET = { host: '127.0.0.1', port: Number(url.port) };
url.hostname = '127.0.0.1';
url.port = String(PROXY_PORT);
process.env.DATABASE_URL = url.toString();
