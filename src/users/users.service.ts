import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

// What the API calls `user`.
export interface PublicUser {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
}

@Injectable()
export class UsersService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  // One query: the account with its profile, which may not exist yet.
  async findByEmail(
    email: string,
  ): Promise<(PublicUser & { passwordHash: string | null }) | null> {
    const [row] = await this.dataSource.query<
      {
        id: string;
        email: string;
        password_hash: string | null;
        display_name: string | null;
        avatar_url: string | null;
      }[]
    >(
      `select u.id, u.email, u.password_hash, p.display_name, p.avatar_url
       from users u left join profiles p on p.user_id = u.id
       where u.email = $1`,
      [email],
    );
    return row
      ? {
          id: row.id,
          email: row.email,
          passwordHash: row.password_hash,
          displayName: row.display_name ?? null,
          avatarUrl: row.avatar_url ?? null,
        }
      : null;
  }
}
