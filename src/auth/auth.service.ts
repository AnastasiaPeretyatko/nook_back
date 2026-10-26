import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryFailedError } from 'typeorm';
import { User } from '../users/user.entity';
import { PublicUser, UsersService } from '../users/users.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

const isEmailTaken = (error: unknown) =>
  error instanceof QueryFailedError &&
  (error.driverError as { constraint?: string }).constraint ===
    'users_email_key';

@Injectable()
export class AuthService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
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
    const user = {
      id: found.id,
      email: found.email,
      displayName: found.displayName,
      avatarUrl: found.avatarUrl,
    };
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
