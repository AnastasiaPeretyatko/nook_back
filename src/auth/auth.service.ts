import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryFailedError } from 'typeorm';
import { User } from '../users/user.entity';
import { PublicUser, UsersService } from '../users/users.service';
import {
  GoogleTokenVerifier,
  InvalidGoogleToken,
} from './google-token.verifier';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

const violatedConstraint = (error: unknown) =>
  error instanceof QueryFailedError
    ? (error.driverError as { constraint?: string }).constraint
    : undefined;

const isEmailTaken = (error: unknown) =>
  violatedConstraint(error) === 'users_email_key';

// Keeps what fits the profile limits (the database refuses longer); counts characters, not
// UTF-16 units, so an emoji is never cut in half.
const profileName = (name: string | null) =>
  [...(name ?? '').trim()].slice(0, 100).join('') || null;

const profilePicture = (url: string | null) => {
  try {
    return url && url.length <= 2048 && new URL(url).protocol === 'https:'
      ? url
      : null;
  } catch {
    return null;
  }
};

@Injectable()
export class AuthService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly google: GoogleTokenVerifier,
  ) {}

  async register(email: string, password: string): Promise<AuthResult> {
    const passwordHash = await this.passwords.hash(password);
    try {
      const { user, refreshToken } = await this.dataSource.transaction(
        async (manager) => {
          const created = await manager.save(User, { email, passwordHash });
          return {
            user: { id: created.id, email, displayName: null, avatarUrl: null },
            refreshToken: await this.tokens.issueRefreshToken(
              created.id,
              manager,
            ),
          };
        },
      );
      return {
        accessToken: await this.tokens.signAccessToken(user.id),
        refreshToken,
        user,
      };
    } catch (error) {
      // The unique constraint decides, so two simultaneous sign-ups cannot both win.
      if (isEmailTaken(error)) {
        throw new ConflictException({
          code: 'email_taken',
          message: 'This email is already registered',
        });
      }
      throw error;
    }
  }

  async login(email: string, password: string): Promise<AuthResult> {
    const found = await this.users.findByEmail(email);
    // Same answer and same work for "no such email", "Google-only account" and "wrong password".
    if (
      !(await this.passwords.verify(found?.passwordHash, password)) ||
      !found
    ) {
      throw new UnauthorizedException({
        code: 'invalid_credentials',
        message: 'Wrong email or password',
      });
    }
    return this.startSession({
      id: found.id,
      email: found.email,
      displayName: found.displayName,
      avatarUrl: found.avatarUrl,
    });
  }

  // Sign in with a Google ID token. The account is Google's `sub`, never the email: an email
  // that already belongs to a password account is NOT merged (we do not verify emails at
  // sign-up, so anyone could have registered someone else's address first and would
  // inherit the real owner's access). That case is `google_email_conflict`.
  async loginWithGoogle(idToken: string): Promise<AuthResult> {
    const identity = await this.google.verify(idToken).catch((error) => {
      if (!(error instanceof InvalidGoogleToken)) throw error;
      throw this.invalidGoogleToken();
    });
    if (!identity.emailVerified) throw this.invalidGoogleToken();

    const existing = await this.users.findByGoogleSub(identity.sub);
    if (existing) return this.startSession(existing);

    const email = identity.email.trim().toLowerCase();
    try {
      const { user, refreshToken } = await this.dataSource.transaction(
        async (manager) => {
          const created = await manager.save(User, {
            email,
            googleSub: identity.sub,
          });
          const displayName = profileName(identity.name);
          const avatarUrl = profilePicture(identity.picture);
          await manager.query(
            `insert into profiles (user_id, display_name, avatar_url) values ($1, $2, $3)`,
            [created.id, displayName, avatarUrl],
          );
          return {
            user: { id: created.id, email, displayName, avatarUrl },
            refreshToken: await this.tokens.issueRefreshToken(
              created.id,
              manager,
            ),
          };
        },
      );
      return {
        accessToken: await this.tokens.signAccessToken(user.id),
        refreshToken,
        user,
      };
    } catch (error) {
      if (!violatedConstraint(error)) throw error;
      // Two first sign-ins of the same Google account at once: the other one won, join it.
      const winner = await this.users.findByGoogleSub(identity.sub);
      if (winner) return this.startSession(winner);
      if (isEmailTaken(error)) {
        throw new ConflictException({
          code: 'google_email_conflict',
          message:
            'This email already has an account that was not created with Google',
        });
      }
      throw error;
    }
  }

  private invalidGoogleToken() {
    return new UnauthorizedException({
      code: 'google_token_invalid',
      message: 'Google sign-in could not be verified',
    });
  }

  // A new session: one access token and one new refresh token. Other sessions stay.
  private async startSession(user: PublicUser): Promise<AuthResult> {
    return {
      accessToken: await this.tokens.signAccessToken(user.id),
      refreshToken: await this.tokens.issueRefreshToken(user.id),
      user,
    };
  }

  async refresh(token: string) {
    const { userId, refreshToken } =
      await this.tokens.rotateRefreshToken(token);
    return {
      accessToken: await this.tokens.signAccessToken(userId),
      refreshToken,
    };
  }

  logout(token: string) {
    return this.tokens.revokeRefreshToken(token);
  }
}
