import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { Ringer } from '../realtime/ringer.service';
import { Profile } from './profile.entity';

// What the API calls `user`.
export interface PublicUser {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  display_name: string | null;
  avatar_url: string | null;
}

const toUser = (row: UserRow) => ({
  id: row.id,
  email: row.email,
  passwordHash: row.password_hash,
  displayName: row.display_name ?? null,
  avatarUrl: row.avatar_url ?? null,
});

@Injectable()
export class UsersService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly ringer: Ringer,
  ) {}

  // The account with its profile (which may not exist yet), in one query.
  // `passwordHash` is for the login check only and must never reach a response.
  private async findWith(column: 'email' | 'id' | 'google_sub', value: string) {
    const [row] = await this.dataSource.query<UserRow[]>(
      `select u.id, u.email, u.password_hash, p.display_name, p.avatar_url
       from users u left join profiles p on p.user_id = u.id
       where u.${column} = $1`,
      [value],
    );
    return row ? toUser(row) : null;
  }

  findByEmail(email: string) {
    return this.findWith('email', email);
  }

  async findByGoogleSub(sub: string): Promise<PublicUser | null> {
    const found = await this.findWith('google_sub', sub);
    return found && this.toPublic(found);
  }

  // The public view of an account. A valid token whose account is gone is simply unauthorized.
  async getById(id: string): Promise<PublicUser> {
    const found = await this.findWith('id', id);
    if (!found) throw this.noSuchUser();
    return this.toPublic(found);
  }

  private toPublic(found: PublicUser): PublicUser {
    return {
      id: found.id,
      email: found.email,
      displayName: found.displayName,
      avatarUrl: found.avatarUrl,
    };
  }

  // Creates the profile row on first use. One statement, so two quick saves cannot clash.
  async updateProfile(
    userId: string,
    profile: { displayName: string | null; avatarUrl: string | null },
    deviceId?: string,
  ): Promise<PublicUser> {
    // Read first, to ring only when the name or the picture really changed.
    const before = await this.getById(userId);
    try {
      await this.profiles.upsert({ userId, ...profile }, ['userId']);
    } catch (error) {
      // A valid token of an account that no longer exists.
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { constraint?: string }).constraint ===
          'profiles_user_id_fkey'
      ) {
        throw this.noSuchUser();
      }
      throw error;
    }
    const after = await this.getById(userId);
    if (
      before.displayName !== after.displayName ||
      before.avatarUrl !== after.avatarUrl
    ) {
      // The people of my groups see my name and picture in the snapshot of their groups.
      await this.ringer.ringFrom(userId, deviceId, { inSendersGroups: true });
    }
    return after;
  }

  private noSuchUser() {
    return new UnauthorizedException({
      code: 'unauthorized',
      message: 'Missing or invalid access token',
    });
  }
}
