export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://nook:nook@localhost:54330/nook_test';

// Tests wipe tables. Refuse anything but a local database, so a wrong URL can never reach Neon.
export function assertLocalDatabase(url: string) {
  const host = new URL(url).hostname;
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    throw new Error(
      `Refusing to run tests against non-local database host "${host}"`,
    );
  }
}
