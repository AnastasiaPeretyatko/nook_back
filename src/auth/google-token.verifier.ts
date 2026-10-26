import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import { EnvironmentVariables } from '../config/env.validation';

export interface GoogleIdentity {
  /** Google's stable account id; unlike the email it never changes. */
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

export class InvalidGoogleToken extends Error {}

// Checks a Google ID token: signature against Google's public keys, issuer, expiry and
// that it was issued for one of OUR clients (GOOGLE_CLIENT_IDS).
@Injectable()
export class GoogleTokenVerifier {
  private readonly logger = new Logger(GoogleTokenVerifier.name);
  private readonly audiences: string[];

  constructor(
    private readonly client: OAuth2Client,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.audiences = config.get('GOOGLE_CLIENT_IDS', { infer: true }) ?? [];
  }

  async verify(idToken: string): Promise<GoogleIdentity> {
    // The library skips the audience check when none is given, which would accept a token
    // made for any other app. With nothing configured, nothing is accepted.
    if (this.audiences.length === 0) {
      throw new InvalidGoogleToken('Google sign-in is not configured');
    }
    try {
      const ticket = await this.client.verifyIdToken({
        idToken,
        audience: this.audiences,
      });
      const payload = ticket.getPayload();
      if (!payload?.sub || !payload.email) {
        throw new Error('Token has no sub or email');
      }
      return {
        sub: payload.sub,
        email: payload.email,
        // Google sends a boolean; some older tokens carry the string "true".
        emailVerified: String(payload.email_verified) === 'true',
        name: payload.name ?? null,
        picture: payload.picture ?? null,
      };
    } catch (error) {
      // Never log the message: the library puts the whole token into it.
      // shortcut: a failure to reach Google's keys also reads as "invalid token", upgrade
      // if that ever confuses (a 503 would be more honest).
      this.logger.warn(
        `Google ID token rejected (${error instanceof Error ? error.name : 'unknown'})`,
      );
      throw new InvalidGoogleToken('Invalid Google ID token');
    }
  }
}
