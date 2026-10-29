import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryFailedError } from 'typeorm';

@Injectable()
export class DevicesService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  // The phone is now this account's, wherever the token was before: the last to sign in on a phone
  // owns it. One statement, so two quick calls cannot clash. Safe to repeat.
  async register(userId: string, token: string) {
    try {
      await this.dataSource.query(
        `insert into device_tokens (token, user_id) values ($1, $2)
         on conflict (token) do update set user_id = excluded.user_id`,
        [token, userId],
      );
    } catch (error) {
      // A valid access token of an account that no longer exists.
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { constraint?: string }).constraint ===
          'device_tokens_user_id_fkey'
      ) {
        throw new UnauthorizedException({
          code: 'unauthorized',
          message: 'Missing or invalid access token',
        });
      }
      throw error;
    }
  }

  // Only the owner's own token goes. Someone else's, or one that is not there, is the same
  // answer as success: nobody learns whose a token is, or whether it exists.
  async unregister(userId: string, token: string) {
    await this.dataSource.query(
      `delete from device_tokens where token = $1 and user_id = $2`,
      [token, userId],
    );
  }
}
