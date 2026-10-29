import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Ringer } from '../realtime/ringer.service';
import * as inviteCode from './invite-code';

// A fresh code can meet an existing one (a million codes, few groups); drawing again is the
// answer, and ten in a row is not bad luck.
const CODE_TRIES = 10;

// Wrong guesses of an invite code an account may make in an hour.
const MAX_WRONG_CODES = 10;

// `changed` is false when the caller was a member already: nothing happened, nobody is rung.
type JoinOutcome =
  | { kind: 'joined'; id: string; changed: boolean }
  | { kind: 'blocked' }
  | { kind: 'wrong' };

const notOwner = () =>
  new ForbiddenException({
    code: 'not_owner',
    message: 'Only the owner of the group can do this',
  });

const ownerCannotLeave = () =>
  new ConflictException({
    code: 'owner_cannot_leave',
    message: 'The owner cannot leave the group, delete it instead',
  });

export const groupNotFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Group not found' });

@Injectable()
export class GroupsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ringer: Ringer,
  ) {}

  // The group, its owner's membership and its code are made together or not at all.
  async create(
    userId: string,
    name: string,
    deviceId?: string,
  ): Promise<{ id: string }> {
    const created = await this.dataSource.transaction(async (manager) => {
      const [{ id }] = await manager.query<{ id: string }[]>(
        `insert into groups (name, owner_id) values ($1, $2) returning id`,
        [name, userId],
      );
      await manager.query(
        `insert into group_members (group_id, user_id, role) values ($1, $2, 'owner')`,
        [id, userId],
      );
      await this.insertCode(manager, id);
      return { id };
    });
    // The new group is in the snapshot of the creator's other phones.
    await this.ringer.ringFrom(userId, deviceId);
    return created;
  }

  // Joins by the code. Six digits are easy to enumerate, so an account that guessed wrong ten
  // times in the last hour is refused before the code is even looked at: otherwise the limit
  // would only slow the wrong guesses down. Everything runs under one lock per account, so
  // parallel requests cannot all pass the count before any of them is recorded. The outcome is
  // returned, not thrown, from inside the transaction: a throw would roll back the wrong guess
  // that has just been written, and nothing would ever be counted.
  async join(
    userId: string,
    input: string,
    deviceId?: string,
  ): Promise<{ id: string }> {
    const code = input.replace(/\D/g, '');
    const outcome = await this.dataSource.transaction(
      async (manager): Promise<JoinOutcome> => {
        await manager.query(
          `select pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
          [`join:${userId}`],
        );
        const [{ n }] = await manager.query<{ n: number }[]>(
          `select count(*)::int n from group_join_failures
           where user_id = $1 and at > now() - interval '1 hour'`,
          [userId],
        );
        if (n >= MAX_WRONG_CODES) return { kind: 'blocked' };

        const [found] = await manager.query<{ group_id: string }[]>(
          `select i.group_id from group_invites i
           join groups g on g.id = i.group_id
           where i.code = $1 and g.deleted_at is null`,
          [code],
        );
        if (!found) {
          // Old attempts are swept here, by the next wrong one: no timer touches the database.
          await manager.query(
            `delete from group_join_failures where user_id = $1 and at < now() - interval '1 day'`,
            [userId],
          );
          await manager.query(
            `insert into group_join_failures (user_id) values ($1)`,
            [userId],
          );
          return { kind: 'wrong' };
        }

        const id = found.group_id;
        const [member] = await manager.query<unknown[]>(
          `select 1 from group_members
           where group_id = $1 and user_id = $2 and deleted_at is null`,
          [id, userId],
        );
        if (member) return { kind: 'joined', id, changed: false };

        // A comeback revives the old row.
        await manager.query(
          `insert into group_members (group_id, user_id, role) values ($1, $2, 'member')
           on conflict (group_id, user_id) do update set deleted_at = null, joined_at = now()`,
          [id, userId],
        );
        // The new member pulls "changed since my last sync", and the group's rows were written
        // before that: without a touch they would never come. Only live tasks and their marks
        // (a deleted task is of no use to someone who never had it); the members need no touch,
        // /sync/pull sends the list of members whole every time. The triggers stamp updated_at.
        await manager.query(
          `update tasks set updated_at = now() where group_id = $1 and deleted_at is null`,
          [id],
        );
        await manager.query(
          `update task_logs set updated_at = now()
           where task_id in (select id from tasks where group_id = $1 and deleted_at is null)`,
          [id],
        );
        return { kind: 'joined', id, changed: true };
      },
    );

    if (outcome.kind === 'blocked') {
      throw new HttpException(
        {
          code: 'too_many_requests',
          message: 'Too many wrong codes, try again later',
        },
        429,
      );
    }
    if (outcome.kind === 'wrong') {
      throw new BadRequestException({
        code: 'bad_code',
        message: 'No group has this invite code',
      });
    }
    // The members now include the newcomer, so they and the newcomer's other phones all hear.
    if (outcome.changed) {
      await this.ringer.ringFrom(userId, deviceId, { groups: [outcome.id] });
    }
    return { id: outcome.id };
  }

  // A member leaves. The owner cannot (the group would be left without one): they delete it. A
  // repeat does nothing: a phone whose answer was lost sends it again. Told apart from a
  // stranger only by having a membership row at all, and a stranger is `404`.
  async leave(userId: string, groupId: string, deviceId?: string) {
    const group = await this.findForMember(userId, groupId);
    if (group.owner_id === userId) {
      if (group.group_deleted) return;
      throw ownerCannotLeave();
    }
    const left = await this.dataSource.transaction((manager) =>
      this.dropMember(manager, groupId, userId),
    );
    // Those who stay, and the leaver's other phones (the group left their snapshot).
    if (left) {
      await this.ringer.ringFrom(userId, deviceId, { groups: [groupId] });
    }
  }

  // The owner removes someone else. Removing oneself is leaving, which the owner cannot do.
  async removeMember(
    userId: string,
    groupId: string,
    memberId: string,
    deviceId?: string,
  ) {
    await this.requireOwner(userId, groupId);
    if (memberId === userId) throw ownerCannotLeave();
    const [member] = await this.dataSource.query<unknown[]>(
      `select 1 from group_members where group_id = $1 and user_id = $2`,
      [groupId, memberId],
    );
    if (!member) throw groupNotFound();
    const removed = await this.dataSource.transaction((manager) =>
      this.dropMember(manager, groupId, memberId),
    );
    // Those who stay, and the one removed: the group is gone from their snapshot.
    if (removed) {
      await this.ringer.ringFrom(userId, deviceId, {
        groups: [groupId],
        users: [memberId],
      });
    }
  }

  // The group, its memberships and its tasks are stamped deleted; a deleted task is emptied by
  // the trigger and loses its marks. The rows stay, so that a phone that was off hears of it.
  async remove(userId: string, groupId: string, deviceId?: string) {
    const group = await this.findForMember(userId, groupId);
    if (group.owner_id !== userId) {
      // A member who has left, or of a group already gone, has no business here.
      if (group.member_left || group.group_deleted) throw groupNotFound();
      throw notOwner();
    }
    if (group.group_deleted) return;
    const members = await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `update groups set deleted_at = now() where id = $1`,
        [groupId],
      );
      // An update with `returning` answers [rows, count].
      const [former] = await manager.query<[{ user_id: string }[], number]>(
        `update group_members set deleted_at = now()
         where group_id = $1 and deleted_at is null returning user_id`,
        [groupId],
      );
      await manager.query(
        `update tasks set deleted_at = now(), client_updated_at = now()
         where group_id = $1 and deleted_at is null`,
        [groupId],
      );
      return former.map((m) => m.user_id);
    });
    // Everyone who was in the group, named outright: nobody is left in it to look up.
    await this.ringer.ringFrom(userId, deviceId, { users: members });
  }

  async rename(
    userId: string,
    groupId: string,
    name: string,
    deviceId?: string,
  ) {
    await this.requireOwner(userId, groupId);
    const [renamed] = await this.dataSource.query<[unknown[], number]>(
      `update groups set name = $2 where id = $1 and name is distinct from $2
       returning id`,
      [groupId, name],
    );
    if (renamed.length > 0) {
      await this.ringer.ringFrom(userId, deviceId, { groups: [groupId] });
    }
  }

  async invite(userId: string, groupId: string): Promise<{ code: string }> {
    await this.requireOwner(userId, groupId);
    const [row] = await this.dataSource.query<{ code: string }[]>(
      `select code from group_invites where group_id = $1`,
      [groupId],
    );
    return { code: row.code };
  }

  // The old code stops working at once; people who joined with it stay.
  async regenerateInvite(
    userId: string,
    groupId: string,
  ): Promise<{ code: string }> {
    await this.requireOwner(userId, groupId);
    for (let i = 0; i < CODE_TRIES; i++) {
      const code = inviteCode.newInviteCode();
      // shortcut: the `not exists` is a check, not a lock; two groups drawing the same new code
      // in the same instant would meet the unique key as a 500. When groups are many, retry on 23505.
      // An `update … returning` answers [rows, count], unlike an `insert … returning`.
      const [rows] = await this.dataSource.query<[{ code: string }[], number]>(
        `update group_invites set code = $2
         where group_id = $1 and not exists (select 1 from group_invites where code = $2)
         returning code`,
        [groupId, code],
      );
      if (rows.length > 0) return { code };
    }
    throw new Error('Could not draw an unused invite code');
  }

  private async insertCode(manager: EntityManager, groupId: string) {
    for (let i = 0; i < CODE_TRIES; i++) {
      const rows = await manager.query<unknown[]>(
        `insert into group_invites (group_id, code) values ($1, $2)
         on conflict (code) do nothing returning code`,
        [groupId, inviteCode.newInviteCode()],
      );
      if (rows.length > 0) return;
    }
    throw new Error('Could not draw an unused invite code');
  }

  // What leaving and being removed have in common. The tasks handed to the person go back to
  // "nobody yet", for the owner to hand out again; their `client_updated_at` moves too, or a
  // phone holding an older unsent edit would win the merge and assign them straight back. Their
  // own tasks and marks stay. Safe to repeat: the second time finds nothing left to change.
  private async dropMember(
    manager: EntityManager,
    groupId: string,
    memberId: string,
  ): Promise<boolean> {
    const [dropped] = await manager.query<[unknown[], number]>(
      `update group_members set deleted_at = now()
       where group_id = $1 and user_id = $2 and deleted_at is null returning user_id`,
      [groupId, memberId],
    );
    await manager.query(
      `update tasks set assignee_id = null, client_updated_at = now()
       where group_id = $1 and assignee_id = $2`,
      [groupId, memberId],
    );
    return dropped.length > 0;
  }

  // The group as the caller can see it: they must have a membership row, of any kind. Nobody
  // else learns the group exists.
  private async findForMember(userId: string, groupId: string) {
    const [group] = await this.dataSource.query<
      {
        owner_id: string;
        group_deleted: boolean;
        member_left: boolean;
      }[]
    >(
      `select g.owner_id, g.deleted_at is not null as group_deleted,
              m.deleted_at is not null as member_left
       from groups g
       join group_members m on m.group_id = g.id and m.user_id = $2
       where g.id = $1`,
      [groupId, userId],
    );
    if (!group) throw groupNotFound();
    return group;
  }

  // A group that does not exist, is deleted, or that the caller is not in answers the same
  // `404`: a stranger learns nothing about it. A member who is not the owner is told so (`403`).
  private async requireOwner(userId: string, groupId: string) {
    const [group] = await this.dataSource.query<{ owner_id: string }[]>(
      `select g.owner_id from groups g
       join group_members m
         on m.group_id = g.id and m.user_id = $2 and m.deleted_at is null
       where g.id = $1 and g.deleted_at is null`,
      [groupId, userId],
    );
    if (!group) throw groupNotFound();
    if (group.owner_id !== userId) throw notOwner();
  }
}
