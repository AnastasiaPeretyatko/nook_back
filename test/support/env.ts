import { assertLocalDatabase, TEST_DATABASE_URL } from './test-env';

// Jest runs this before a test file imports anything. It has to be that early:
// AppModule reads .env the moment it is imported, and dotenv never overrides a
// variable that is already set. Set later, the app would silently use the real DATABASE_URL.
assertLocalDatabase(TEST_DATABASE_URL);
process.env.DATABASE_URL = TEST_DATABASE_URL;
delete process.env.SELF_PING_URL;
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-0123456789';
delete process.env.GOOGLE_CLIENT_IDS;
