import { MigrationInterface, QueryRunner } from 'typeorm';

// Groups (B5): shared one-off tasks between accounts. Ported from the Supabase scripts 005 + 006.
//
// What changes for existing rows: nothing. A task without `group_id` is personal and keeps every
// rule it had. The group rules live in the code (who may write what); the database keeps the
// ones it can say alone: the shape of a group task, who the author is, an assignee who is in the
// group, and a mark nobody may make.
export class CreateGroups1793195437182 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // The server makes the id (the app never mints one). Deleting an owner's account removes the
    // group with the rest of their data; an ordinary deletion is a `deleted_at` and keeps the row.
    await queryRunner.query(`
      create table groups (
        id uuid not null default gen_random_uuid(),
        name text not null,
        owner_id uuid not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        deleted_at timestamptz,
        constraint groups_pkey primary key (id),
        constraint groups_owner_id_fkey
          foreign key (owner_id) references users (id) on delete cascade,
        constraint groups_name_check check (length(name) between 1 and 100)
      )
    `);

    // The owner has a row here too (role 'owner'): "who is in the group" is one table. A member
    // is never deleted, only stamped `deleted_at`, so coming back by the code revives the same row.
    await queryRunner.query(`
      create table group_members (
        group_id uuid not null,
        user_id uuid not null,
        role text not null default 'member',
        joined_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        deleted_at timestamptz,
        constraint group_members_pkey primary key (group_id, user_id),
        constraint group_members_group_id_fkey
          foreign key (group_id) references groups (id) on delete cascade,
        constraint group_members_user_id_fkey
          foreign key (user_id) references users (id) on delete cascade,
        constraint group_members_role_check check (role in ('owner', 'member'))
      )
    `);
    // The primary key leads with the group; "my groups" asks by user.
    await queryRunner.query(
      `create index group_members_user_idx on group_members (user_id)`,
    );

    // Its own table, not a column of `groups`: the code is the owner's alone to see. Six digits,
    // made by the server. Never read by /sync, so no `updated_at`.
    await queryRunner.query(`
      create table group_invites (
        group_id uuid not null,
        code text not null,
        constraint group_invites_pkey primary key (group_id),
        constraint group_invites_group_id_fkey
          foreign key (group_id) references groups (id) on delete cascade,
        constraint group_invites_code_key unique (code),
        constraint group_invites_code_check check (code ~ '^[0-9]{6}$')
      )
    `);

    // Wrong guesses of a code, for the limit of ten an hour. In the database, not in memory: the
    // server restarts. Old rows are swept by the join itself (no timers).
    await queryRunner.query(`
      create table group_join_failures (
        id integer generated always as identity,
        user_id uuid not null,
        at timestamptz not null default now(),
        constraint group_join_failures_pkey primary key (id),
        constraint group_join_failures_user_id_fkey
          foreign key (user_id) references users (id) on delete cascade
      )
    `);
    await queryRunner.query(
      `create index group_join_failures_user_at_idx on group_join_failures (user_id, at)`,
    );

    await queryRunner.query(`
      create trigger groups_updated_at
        before insert or update on groups
        for each row execute function set_updated_at()
    `);
    await queryRunner.query(`
      create trigger group_members_updated_at
        before insert or update on group_members
        for each row execute function set_updated_at()
    `);

    // A group task is a one-off task without subtasks and not in the "value" mode (habits in
    // groups are not part of this version). The group goes with it on delete; an assignee whose
    // account goes away just stops being one.
    await queryRunner.query(`
      alter table tasks
        add column group_id uuid,
        add column assignee_id uuid,
        add constraint tasks_group_id_fkey
          foreign key (group_id) references groups (id) on delete cascade,
        add constraint tasks_assignee_id_fkey
          foreign key (assignee_id) references users (id) on delete set null,
        add constraint tasks_group_task_shape check (
          group_id is null
          or (repeat_type is null and parent_id is null and tracking_mode <> 'value')
        ),
        add constraint tasks_assignee_needs_group
          check (assignee_id is null or group_id is not null)
    `);
    // The pull of a group's tasks: "this group's rows changed since X".
    await queryRunner.query(
      `create index tasks_group_updated_idx on tasks (group_id, updated_at)`,
    );

    await queryRunner.query(`
      create function is_group_member(g uuid, u uuid)
      returns boolean
      language sql stable
      as $$
        select exists (
          select 1 from group_members m
          where m.group_id = g and m.user_id = u and m.deleted_at is null
        )
      $$
    `);

    // Whether \`u\` may put a mark on the task. Null when the task is not on the server at all, so
    // the caller can tell "refused" from "unknown".
    await queryRunner.query(`
      create function can_mark_task(t uuid, u uuid)
      returns boolean
      language sql stable
      as $$
        select case
          when tk.group_id is null then tk.user_id = u
          else is_group_member(tk.group_id, u)
               and (tk.assignee_id is null or tk.assignee_id = u)
        end
        from tasks tk where tk.id = t
      $$
    `);

    // What the client may not change, and an assignee who is not in the group. Corrected
    // silently, not refused: a phone that was offline while someone was removed can legitimately
    // push a task still naming them. (The code refuses an edit by the wrong person long before
    // this; this is the last line.)
    await queryRunner.query(`
      create function guard_group_task()
      returns trigger
      language plpgsql
      as $$
      begin
        if tg_op = 'UPDATE' then
          new.user_id := old.user_id;
          new.group_id := old.group_id;
        end if;
        if new.assignee_id is not null
           and (new.group_id is null
                or not is_group_member(new.group_id, new.assignee_id)) then
          new.assignee_id := null;
        end if;
        return new;
      end;
      $$
    `);
    await queryRunner.query(`
      create trigger tasks_guard_group
        before insert or update on tasks
        for each row execute function guard_group_task()
    `);

    // The blanking of a deleted task now also lets go of its assignee. \`group_id\` stays: it is
    // what tells the members' phones which group the deleted task belonged to.
    await queryRunner.query(`
      create or replace function blank_deleted_task()
      returns trigger
      language plpgsql
      as $$
      begin
        new.parent_id := null;
        new.title := '';
        new.description := null;
        new.status := 'active';
        new.repeat_type := null;
        new.repeat_interval := null;
        new.repeat_days_mask := null;
        new.tracking_mode := 'checkbox';
        new.target_duration_minutes := null;
        new.target_value := null;
        new.icon_key := null;
        new.color_key := null;
        new.scheduled_time_minutes := null;
        new.end_time_minutes := null;
        new.start_date := null;
        new.assignee_id := null;
        -- Only for a row that exists: on insert there are no marks to erase, and a BEFORE INSERT
        -- trigger runs even when the insert then loses to an existing row (on conflict), where
        -- it would erase the marks of someone else's task.
        if tg_op = 'UPDATE' then
          delete from task_logs where task_id = new.id;
        end if;
        return new;
      end;
      $$
    `);

    // Replaces \`skip_log_of_deleted_task\`: still drops a mark of a deleted task, and now also a
    // new mark its user may not make (not in the group any more, or the task was handed to someone
    // else). Silent, like before: the code refuses such a mark with a reason long before this.
    // A task the server has never heard of is let through, so the foreign key refuses it loudly.
    await queryRunner.query(`
      create function skip_unmarkable_log()
      returns trigger
      language plpgsql
      as $$
      begin
        if exists (
          select 1 from tasks where id = new.task_id and deleted_at is not null
        ) then
          return null;
        end if;
        -- An update that keeps the key of an existing mark was vetted when the mark went in (an
        -- upsert meets this trigger on its insert first). Without this, the touch that a join
        -- gives every mark of the group would skip the marks of people who have since left.
        if tg_op = 'UPDATE' and new.task_id = old.task_id and new.user_id = old.user_id then
          return new;
        end if;
        if can_mark_task(new.task_id, new.user_id) is false then
          return null;
        end if;
        return new;
      end;
      $$
    `);
    await queryRunner.query(`drop trigger task_logs_skip_deleted on task_logs`);
    await queryRunner.query(`
      create trigger task_logs_skip_unmarkable
        before insert or update on task_logs
        for each row execute function skip_unmarkable_log()
    `);
    await queryRunner.query(`drop function skip_log_of_deleted_task()`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create function skip_log_of_deleted_task()
      returns trigger
      language plpgsql
      as $$
      begin
        if exists (
          select 1 from tasks where id = new.task_id and deleted_at is not null
        ) then
          return null;
        end if;
        return new;
      end;
      $$
    `);
    await queryRunner.query(
      `drop trigger task_logs_skip_unmarkable on task_logs`,
    );
    await queryRunner.query(`
      create trigger task_logs_skip_deleted
        before insert or update on task_logs
        for each row execute function skip_log_of_deleted_task()
    `);
    await queryRunner.query(`drop function skip_unmarkable_log()`);
    await queryRunner.query(`drop trigger tasks_guard_group on tasks`);
    await queryRunner.query(`drop function guard_group_task()`);
    await queryRunner.query(`drop function can_mark_task(uuid, uuid)`);
    await queryRunner.query(`drop function is_group_member(uuid, uuid)`);
    await queryRunner.query(`
      create or replace function blank_deleted_task()
      returns trigger
      language plpgsql
      as $$
      begin
        new.parent_id := null;
        new.title := '';
        new.description := null;
        new.status := 'active';
        new.repeat_type := null;
        new.repeat_interval := null;
        new.repeat_days_mask := null;
        new.tracking_mode := 'checkbox';
        new.target_duration_minutes := null;
        new.target_value := null;
        new.icon_key := null;
        new.color_key := null;
        new.scheduled_time_minutes := null;
        new.end_time_minutes := null;
        new.start_date := null;
        if tg_op = 'UPDATE' then
          delete from task_logs where task_id = new.id;
        end if;
        return new;
      end;
      $$
    `);
    await queryRunner.query(`
      alter table tasks
        drop column assignee_id,
        drop column group_id
    `);
    await queryRunner.query('drop table group_join_failures');
    await queryRunner.query('drop table group_invites');
    await queryRunner.query('drop table group_members');
    await queryRunner.query('drop table groups');
  }
}
