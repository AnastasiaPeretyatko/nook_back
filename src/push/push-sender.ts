import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JWT } from 'google-auth-library';
import { EnvironmentVariables } from '../config/env.validation';
import {
  FirebaseServiceAccount,
  parseServiceAccount,
} from '../config/firebase-account';

export interface PushMessage {
  title: string;
  body: string;
  // FCM takes strings only.
  data: Record<string, string>;
}

// What happened to one send. Only `unregistered` says anything about the token: it is gone for
// good and may be deleted. `failed` can be our own mistake, so a token is never dropped for it.
export type PushOutcome = 'sent' | 'unregistered' | 'failed';

// The notification channel the app creates at start (`groupChannelId` in `app_notifications.dart`):
// change both.
const CHANNEL_ID = 'group_activity';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TIMEOUT_MS = 10_000;

const withTimeout = <T>(promise: Promise<T>, ms: number) => {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

// Sends one message to one phone through Firebase Cloud Messaging (HTTP v1), the way the Supabase
// Edge Function did. Separate from the rules of who is told what, so that tests put a fake in its
// place and never reach the network. Nothing here throws: the caller is a write that is already
// saved. The token is never written to the log (a log line is read by more people than a token).
@Injectable()
export class PushSender implements OnModuleInit {
  private readonly logger = new Logger(PushSender.name);
  private readonly account?: FirebaseServiceAccount;
  private auth?: JWT;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    const value = config.get('FIREBASE_SERVICE_ACCOUNT', { infer: true });
    // Already checked at start (validateEnv): here it is either good or missing.
    this.account = value ? parseServiceAccount(value) : undefined;
  }

  onModuleInit() {
    this.logger.log(
      this.account
        ? `Push notifications are on (Firebase project ${this.account.project_id})`
        : 'Push notifications are off: FIREBASE_SERVICE_ACCOUNT is not set',
    );
  }

  get enabled() {
    return !!this.account;
  }

  async send(token: string, message: PushMessage): Promise<PushOutcome> {
    if (!this.account) return 'failed';
    try {
      const bearer = await withTimeout(this.accessToken(), TIMEOUT_MS);
      const res = await fetch(
        `https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${bearer}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: {
              token,
              notification: { title: message.title, body: message.body },
              data: message.data,
              // High: a normal message can wait out the phone's sleep (Doze).
              android: {
                priority: 'HIGH',
                notification: { channel_id: CHANNEL_ID },
              },
            },
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
      if (res.ok) return 'sent';

      const body = (await res.json().catch(() => null)) as {
        error?: { status?: string; details?: { errorCode?: string }[] };
      } | null;
      const code = body?.error?.details?.find((d) => d.errorCode)?.errorCode;
      if (code === 'UNREGISTERED') return 'unregistered';
      this.logger.warn(
        `FCM refused a message: HTTP ${res.status} ${code ?? body?.error?.status ?? '(no code)'}`,
      );
      return 'failed';
    } catch (error) {
      this.logger.warn(`FCM send failed: ${(error as Error).message}`);
      return 'failed';
    }
  }

  // The OAuth access token for FCM. The library keeps it until it is about to expire.
  private async accessToken() {
    this.auth ??= this.createAuth(this.account!);
    const { token } = await this.auth.getAccessToken();
    if (!token) throw new Error('no access token from Google');
    return token;
  }

  // A seam for tests: they give the client a transport that is not the internet.
  protected createAuth({ client_email, private_key }: FirebaseServiceAccount) {
    return new JWT({ email: client_email, key: private_key, scopes: [SCOPE] });
  }
}
