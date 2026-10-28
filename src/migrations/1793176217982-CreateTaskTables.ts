import { MigrationInterface, QueryRunner } from 'typeorm';

// Personal tasks and their day marks (B2). Groups add `group_id` / `assignee_id` in B5.
// Ported from the Supabase scripts 003 + 007; `icon_code_point` is not carried over.
export class CreateTaskTables1793176217982 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Checks instead of enum types: adding a value to an enum is a migration with a lock.
    // `date` columns are calendar days, not moments (the app sends `YYYY-MM-DD`).
    // `client_updated_at` is when the device edited; `updated_at` is the server's own stamp.
    await queryRunner.query(`
      create table tasks (
        id uuid not null,
        user_id uuid not null,
        parent_id uuid,
        title text not null default '',
        description text,
        status text not null default 'active',
        repeat_type text,
        repeat_interval integer,
        repeat_days_mask integer,
        tracking_mode text not null default 'checkbox',
        target_duration_minutes integer,
        target_value double precision,
        icon_key text,
        color_key text,
        scheduled_time_minutes integer,
        end_time_minutes integer,
        start_date date,
        created_at timestamptz not null default now(),
        client_updated_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        deleted_at timestamptz,
        constraint tasks_pkey primary key (id),
        constraint tasks_user_id_fkey
          foreign key (user_id) references users (id) on delete cascade,
        constraint tasks_status_check
          check (status in ('active', 'paused', 'archived')),
        constraint tasks_repeat_type_check
          check (repeat_type is null
                 or repeat_type in ('daily', 'weekly', 'monthly', 'custom')),
        constraint tasks_tracking_mode_check
          check (tracking_mode in ('checkbox', 'counter', 'timer', 'value'))
      )
    `);

    // Deferred: checked at the end of the transaction, so a subtask may arrive in the same
    // batch before its parent. Cascade is for the account going away; an ordinary deletion
    // is a `deleted_at` and never removes the row.
    await queryRunner.query(`
      alter table tasks
        add constraint tasks_parent_id_fkey
        foreign key (parent_id) references tasks (id) on delete cascade
        deferrable initially deferred
    `);

    // One mark per task, user and day, so two phones that tick the same day converge on one
    // row with no merge logic. `user_id` is in the key because in groups (B5) every member
    // ticks a shared task separately.
    await queryRunner.query(`
      create table task_logs (
        task_id uuid not null,
        user_id uuid not null,
        date date not null,
        completed boolean not null default false,
        value double precision,
        completed_at timestamptz,
        client_updated_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint task_logs_pkey primary key (task_id, user_id, date),
        constraint task_logs_task_id_fkey
          foreign key (task_id) references tasks (id) on delete cascade,
        constraint task_logs_user_id_fkey
          foreign key (user_id) references users (id) on delete cascade
      )
    `);

    // The one read: "everything of mine changed since X".
    await queryRunner.query(
      `create index tasks_user_updated_idx on tasks (user_id, updated_at)`,
    );
    await queryRunner.query(
      `create index task_logs_user_updated_idx on task_logs (user_id, updated_at)`,
    );
    // Postgres indexes the target of a foreign key, not the referencing column; the cascade
    // and the blanking trigger look children up by it. `task_logs (task_id)` is already the
    // leading column of its primary key.
    await queryRunner.query(
      `create index tasks_parent_id_idx on tasks (parent_id)`,
    );

    await queryRunner.query(`
      create trigger tasks_updated_at
        before insert or update on tasks
        for each row execute function set_updated_at()
    `);
    await queryRunner.query(`
      create trigger task_logs_updated_at
        before insert or update on task_logs
        for each row execute function set_updated_at()
    `);

    // A deleted task keeps its row forever and loses its contents at once. The row is what
    // tells other devices about the deletion: if it were gone, a device that missed it would
    // push the task back. Fires on every write of a deleted row (a new tombstone too), so a
    // device that has not heard of the deletion cannot bring the data back: deletion always wins.
    await queryRunner.query(`
      create function blank_deleted_task()
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
    await queryRunner.query(`
      create trigger tasks_blank_when_deleted
        before insert or update on tasks
        for each row
        when (new.deleted_at is not null)
        execute function blank_deleted_task()
    `);

    // The row of a deleted task still exists, so the foreign key would let a stale device put
    // marks back. A mark for a deleted task is skipped without an error: an error would fail
    // the whole push, and the device drops those marks itself when it learns of the deletion.
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
    await queryRunner.query(`
      create trigger task_logs_skip_deleted
        before insert or update on task_logs
        for each row execute function skip_log_of_deleted_task()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('drop table task_logs');
    await queryRunner.query('drop table tasks');
    await queryRunner.query('drop function skip_log_of_deleted_task()');
    await queryRunner.query('drop function blank_deleted_task()');
  }
}
