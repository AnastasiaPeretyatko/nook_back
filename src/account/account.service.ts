import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  GoogleTokenVerifier,
  InvalidGoogleToken,
} from '../auth/google-token.verifier';
import { PasswordService } from '../auth/password.service';
import { GroupsService } from '../groups/groups.service';
import { Ringer } from '../realtime/ringer.service';
import { UsersService } from '../users/users.service';
import { DeleteAccountDto } from './dto/delete-account.dto';

const invalidCredentials = () =>
  new UnauthorizedException({
    code: 'invalid_credentials',
    message: 'Wrong password',
  });

@Injectable()
export class AccountService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly google: GoogleTokenVerifier,
    private readonly groups: GroupsService,
    private readonly ringer: Ringer,
  ) {}

  // Deletes the account: everything personal is erased, the groups behave as the plan says, and
  // the user row stays as an empty shell (see the migration). Safe to repeat: an account that is
  // gone already answers as if it had just been deleted, and nothing is checked, because there is
  // nothing left to protect.
  async delete(userId: string, proof: DeleteAccountDto, deviceId?: string) {
    const account = await this.users.findCredentials(userId);
    if (!account) throw this.users.noSuchUser();
    if (account.gone) return;
    await this.confirm(account, proof);

    const toRing = await this.dataSource.transaction(async (manager) => {
      // The lock makes two deletions at once take turns; the second finds it done.
      const [row] = await manager.query<{ gone: boolean }[]>(
        `select deleted_at is not null as gone from users where id = $1 for update`,
        [userId],
      );
      if (row.gone) return null;
      const rings = await this.groups.departFromAll(manager, userId);
      await this.erasePersonalData(manager, userId);
      // The email is made up (the real one can be used again) and cannot receive mail.
      await manager.query(
        `update users
         set email = $2, password_hash = null, google_sub = null, deleted_at = now()
         where id = $1`,
        [userId, `deleted-${userId}@deleted.invalid`],
      );
      return rings;
    });
    if (toRing) await this.ringer.ringFrom(userId, deviceId, toRing);
  }

  private async confirm(
    account: { passwordHash: string | null; googleSub: string | null },
    { password, idToken }: DeleteAccountDto,
  ) {
    if ((password == null) === (idToken == null)) {
      throw new BadRequestException({
        code: 'confirmation_required',
        message: 'Send either the password or a fresh Google ID token',
      });
    }
    if (password != null) {
      // Does the full check even for an account without a password (Google-only).
      if (!(await this.passwords.verify(account.passwordHash, password))) {
        throw invalidCredentials();
      }
      return;
    }
    const identity = await this.google.verify(idToken!).catch((error) => {
      if (!(error instanceof InvalidGoogleToken)) throw error;
      throw new UnauthorizedException({
        code: 'google_token_invalid',
        message: 'Google sign-in could not be verified',
      });
    });
    // A valid token of some other Google account proves nothing about this one.
    if (account.googleSub === null || identity.sub !== account.googleSub) {
      throw invalidCredentials();
    }
  }

  // Everything the person owns alone. What they wrote in shared groups they have left is not
  // here: it stays with the group (the shell keeps it, without a name).
  private async erasePersonalData(manager: EntityManager, userId: string) {
    // Marks on these tasks and the links between notes and their moods and tags go with them.
    for (const sql of [
      `delete from tasks where user_id = $1 and group_id is null`,
      `delete from diary_entries where user_id = $1`,
      `delete from note_moods where user_id = $1`,
      `delete from note_tags where user_id = $1`,
      `delete from cycle_days where user_id = $1`,
      `delete from device_tokens where user_id = $1`,
      `delete from refresh_tokens where user_id = $1`,
      `delete from profiles where user_id = $1`,
      `delete from group_join_failures where user_id = $1`,
    ]) {
      await manager.query(sql, [userId]);
    }
  }
}
