import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createVerify, generateKeyPairSync } from 'crypto';
import { FirebaseServiceAccount } from '../config/firebase-account';
import { PushMessage, PushSender } from './push-sender';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const account: FirebaseServiceAccount = {
  project_id: 'nook-test',
  client_email: 'firebase-adminsdk-x@nook-test.iam.gserviceaccount.com',
  private_key: privateKey,
};
const encoded = Buffer.from(
  JSON.stringify({ type: 'service_account', ...account }),
).toString('base64');

const TOKEN = 'phone-token-SECRET-0123456789-abcdefghij';
const message: PushMessage = {
  title: 'Новая задача от Аня',
  body: 'Купить молоко · Дом',
  data: { group_id: 'g1', task_id: 't1' },
};

interface TokenRequest {
  url: string;
  method: string;
  data: URLSearchParams;
}

// The real sender with the network taken out: Google's token endpoint is a function here.
class TestSender extends PushSender {
  tokenRequests: TokenRequest[] = [];
  tokenAnswer: () => Promise<unknown> = () =>
    Promise.resolve({
      status: 200,
      data: {
        access_token: 'ya29.fake-access',
        expires_in: 3600,
        token_type: 'Bearer',
      },
    });

  protected override createAuth(key: FirebaseServiceAccount) {
    // The real client (its key, its scope), with its one network call replaced.
    const auth = super.createAuth(key);
    (auth.transporter as unknown as { request: unknown }).request = (
      options: TokenRequest,
    ) => {
      this.tokenRequests.push(options);
      return this.tokenAnswer();
    };
    return auth;
  }
}

const senderWith = (value: string | undefined) =>
  new TestSender({ get: () => value } as unknown as ConfigService<never, true>);
const sender = () => senderWith(encoded);

const reply = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
    }),
  );
const fcmError = (status: number, errorStatus: string, errorCode?: string) =>
  reply(status, {
    error: {
      code: status,
      status: errorStatus,
      message: 'details that must not reach the log',
      details: errorCode
        ? [
            {
              '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
              errorCode,
            },
          ]
        : [],
    },
  });

describe('PushSender', () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let logged: string[];

  beforeEach(() => {
    fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementation(() => reply(200, {}));
    logged = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((text: unknown) => void logged.push(String(text)));
    }
  });
  afterEach(() => jest.restoreAllMocks());

  describe('without a key', () => {
    it('is off, says so once at start, and never touches the network', async () => {
      for (const value of [undefined, '']) {
        const off = senderWith(value);
        off.onModuleInit();
        expect(off.enabled).toBe(false);
        expect(await off.send(TOKEN, message)).toBe('failed');
      }
      expect(fetchMock).not.toHaveBeenCalled();
      expect(logged).toEqual([
        'Push notifications are off: FIREBASE_SERVICE_ACCOUNT is not set',
        'Push notifications are off: FIREBASE_SERVICE_ACCOUNT is not set',
      ]);
    });
  });

  describe('with a key', () => {
    it('is on and names the project at start, not the key', () => {
      const on = sender();
      on.onModuleInit();
      expect(on.enabled).toBe(true);
      expect(logged).toEqual([
        'Push notifications are on (Firebase project nook-test)',
      ]);
    });

    it('asks Google for an access token signed with the key, for the messaging scope', async () => {
      const s = sender();
      await s.send(TOKEN, message);

      expect(s.tokenRequests).toHaveLength(1);
      const [request] = s.tokenRequests;
      expect(request.url).toBe('https://oauth2.googleapis.com/token');
      expect(request.method).toBe('POST');
      expect(request.data.get('grant_type')).toBe(
        'urn:ietf:params:oauth:grant-type:jwt-bearer',
      );
      const [head, claims, signature] = (
        request.data.get('assertion') as string
      ).split('.');
      const verify = createVerify('RSA-SHA256');
      verify.update(`${head}.${claims}`);
      expect(verify.verify(publicKey, signature, 'base64url')).toBe(true);
      const payload = JSON.parse(
        Buffer.from(claims, 'base64url').toString(),
      ) as { exp: number; iat: number };
      expect(payload).toMatchObject({
        iss: account.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
      });
      expect(payload.exp).toBeGreaterThan(payload.iat);
    });

    it('keeps the access token between sends', async () => {
      const s = sender();
      await s.send(TOKEN, message);
      await s.send(`${TOKEN}-2`, message);
      expect(s.tokenRequests).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('sends the message to the project of the key, to that phone, with the right shape', async () => {
      const s = sender();
      expect(await s.send(TOKEN, message)).toBe('sent');

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        'https://fcm.googleapis.com/v1/projects/nook-test/messages:send',
      );
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual({
        Authorization: 'Bearer ya29.fake-access',
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(init?.body as string)).toEqual({
        message: {
          token: TOKEN,
          notification: { title: message.title, body: message.body },
          data: { group_id: 'g1', task_id: 't1' },
          android: {
            priority: 'HIGH',
            notification: { channel_id: 'group_activity' },
          },
        },
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('what FCM answers', () => {
    it.each([
      [
        'an accepted message',
        () => reply(200, { name: 'projects/x/messages/1' }),
        'sent',
      ],
      [
        'a token that is gone for good',
        () => fcmError(404, 'NOT_FOUND', 'UNREGISTERED'),
        'unregistered',
      ],
      [
        'a refused argument',
        () => fcmError(400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT'),
        'failed',
      ],
      [
        'a NOT_FOUND that is not UNREGISTERED',
        () => fcmError(404, 'NOT_FOUND'),
        'failed',
      ],
      [
        'a sender mismatch',
        () => fcmError(403, 'PERMISSION_DENIED', 'SENDER_ID_MISMATCH'),
        'failed',
      ],
      [
        'quota',
        () => fcmError(429, 'RESOURCE_EXHAUSTED', 'QUOTA_EXCEEDED'),
        'failed',
      ],
      [
        'an overloaded server',
        () => fcmError(503, 'UNAVAILABLE', 'UNAVAILABLE'),
        'failed',
      ],
      [
        'a rejected credential',
        () => fcmError(401, 'UNAUTHENTICATED'),
        'failed',
      ],
      [
        'a page that is not JSON',
        () => reply(502, '<html>Bad gateway</html>'),
        'failed',
      ],
      ['an empty error', () => reply(500, ''), 'failed'],
      [
        'a network error',
        () => Promise.reject(new Error('socket hang up')),
        'failed',
      ],
    ])('%s', async (_name, answer, outcome) => {
      fetchMock.mockImplementation(answer);
      expect(await sender().send(TOKEN, message)).toBe(outcome);
    });

    it('does not make a token "unregistered" from a look-alike', async () => {
      // The code is UNREGISTERED only in the details of the error, not in free text.
      fetchMock.mockImplementation(() =>
        reply(400, {
          error: {
            status: 'INVALID_ARGUMENT',
            message: 'UNREGISTERED',
            details: [],
          },
        }),
      );
      expect(await sender().send(TOKEN, message)).toBe('failed');
    });
  });

  describe('when Google does not give an access token', () => {
    it.each([
      ['the endpoint is down', () => Promise.reject(new Error('ECONNREFUSED'))],
      ['the key is refused', () => Promise.reject(new Error('invalid_grant'))],
      [
        'the answer has no token',
        () => Promise.resolve({ status: 200, data: {} }),
      ],
    ])('%s: failed, and nothing is sent to FCM', async (_name, answer) => {
      const s = sender();
      s.tokenAnswer = answer;
      expect(await s.send(TOKEN, message)).toBe('failed');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('tries again on the next send', async () => {
      const s = sender();
      s.tokenAnswer = () => Promise.reject(new Error('ECONNREFUSED'));
      expect(await s.send(TOKEN, message)).toBe('failed');
      s.tokenAnswer = () =>
        Promise.resolve({
          status: 200,
          data: {
            access_token: 'ya29.later',
            expires_in: 3600,
            token_type: 'Bearer',
          },
        });
      expect(await s.send(TOKEN, message)).toBe('sent');
    });

    it('gives up on a token request that never answers', async () => {
      jest.useFakeTimers({
        doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
      });
      try {
        const s = sender();
        s.tokenAnswer = () => new Promise(() => undefined);
        const sending = s.send(TOKEN, message);
        await jest.advanceTimersByTimeAsync(10_000);
        expect(await sending).toBe('failed');
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('the log', () => {
    it('never holds the phone token, the access token or the key', async () => {
      const s = sender();
      s.onModuleInit();
      for (const answer of [
        () => fcmError(400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT'),
        () => fcmError(404, 'NOT_FOUND', 'UNREGISTERED'),
        () => Promise.reject(new Error('socket hang up')),
        () => reply(500, ''),
      ]) {
        fetchMock.mockImplementation(answer);
        await s.send(TOKEN, message);
      }
      const text = logged.join('\n');
      expect(logged.length).toBeGreaterThan(2);
      for (const secret of [
        'SECRET',
        'ya29',
        'PRIVATE KEY',
        'details that must not',
      ]) {
        expect(text).not.toContain(secret);
      }
    });

    it('says what was refused, in a few words', async () => {
      fetchMock.mockImplementation(() =>
        fcmError(403, 'PERMISSION_DENIED', 'SENDER_ID_MISMATCH'),
      );
      await sender().send(TOKEN, message);
      expect(logged).toEqual([
        'FCM refused a message: HTTP 403 SENDER_ID_MISMATCH',
      ]);
    });
  });
});
