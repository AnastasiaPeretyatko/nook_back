import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { RefreshToken } from './refresh-token.entity';

export const ACCESS_TTL_SECONDS = 60 * 60;
export const REFRESH_TTL_DAYS = 90;

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  // The access token is checked by signature alone (no database), so it stays valid
  // until it expires even if the account is gone; hence the short life.
  signAccessToken(userId: string) {
    return this.jwt.signAsync(
      { sub: userId },
      { algorithm: 'HS256', expiresIn: ACCESS_TTL_SECONDS },
    );
  }

  // The user id and the moment the token expires (ms), or null for anything wrong: bad
  // signature, expired, wrong algorithm, no expiry. The WebSocket needs the expiry because
  // its connection can outlive the token.
  async readAccessToken(token: string) {
    try {
      const { sub, exp } = await this.jwt.verifyAsync<{
        sub?: unknown;
        exp?: unknown;
      }>(token, { algorithms: ['HS256'] });
      return typeof sub === 'string' && typeof exp === 'number'
        ? { userId: sub, expiresAt: exp * 1000 }
        : null;
    } catch {
      return null;
    }
  }

  async verifyAccessToken(token: string): Promise<string | null> {
    return (await this.readAccessToken(token))?.userId ?? null;
  }

  // A random opaque string. Only its hash is stored, so a database leak gives no sessions.
  // Expiry uses the database clock, the same one that checks it later.
  async issueRefreshToken(
    userId: string,
    manager: EntityManager = this.dataSource.manager,
  ) {
    const token = randomBytes(32).toString('base64url');
    await manager.query(
      `insert into refresh_tokens (token_hash, user_id, expires_at)
       values ($1, $2, now() + make_interval(days => $3))`,
      [sha256(token), userId, REFRESH_TTL_DAYS],
    );
    // No timers may touch the database (Neon would never sleep), so this user's
    // expired tokens are swept here, whenever they sign in or refresh.
    await manager.query(
      `delete from refresh_tokens where user_id = $1 and expires_at <= now()`,
      [userId],
    );
    return token;
  }

  // Single use. The delete decides who wins: of two requests with the same token only
  // one gets the row back, the other finds nothing. Same transaction as the new
  // token, so a failure leaves the old one usable.
  rotateRefreshToken(token: string) {
    return this.dataSource.transaction(async (manager) => {
      const deleted = await manager
        .createQueryBuilder()
        .delete()
        .from(RefreshToken)
        .where('token_hash = :hash and expires_at > now()', {
          hash: sha256(token),
        })
        .returning('user_id')
        .execute();
      const userId = (deleted.raw as { user_id: string }[])[0]?.user_id;
      if (!userId) {
        throw new UnauthorizedException({
          code: 'invalid_refresh_token',
          message: 'Refresh token is invalid, used or expired',
        });
      }
      return {
        userId,
        refreshToken: await this.issueRefreshToken(userId, manager),
      };
    });
  }

  // Logout. Unknown or already used tokens are fine: the result is the same.
  async revokeRefreshToken(token: string) {
    await this.dataSource.query(
      `delete from refresh_tokens where token_hash = $1`,
      [sha256(token)],
    );
  }
}
