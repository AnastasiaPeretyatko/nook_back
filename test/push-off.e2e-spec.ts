import { INestApplication } from '@nestjs/common';
import { PushSender } from '../src/push/push-sender';
import { createTestApp } from './support/db';

// The owner's real Firebase key may sit in .env. The tests must never be able to reach Google
// with it, so test/support/env.ts blanks the variable before anything reads .env.
describe('Push in the test app', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(() => app.close());

  it('is off, whatever .env holds, and sends nothing anywhere', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    try {
      const sender = app.get(PushSender);
      expect(sender.enabled).toBe(false);
      expect(
        await sender.send('phone-token-0123456789-abcdefghij', {
          title: 't',
          body: 'b',
          data: {},
        }),
      ).toBe('failed');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
