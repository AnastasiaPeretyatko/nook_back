import { MigrationInterface, QueryRunner } from 'typeorm';

// Personal task collections. Projects are server-created like groups; a task keeps living when
// its project is removed, so the project foreign key is nullable and uses SET NULL on deletion.
export class CreateProjects1794298730375 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      create table projects (
        id uuid not null default gen_random_uuid(),
        user_id uuid not null,
        name text not null,
        description text,
        color text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        archived_at timestamptz,
        constraint projects_pkey primary key (id),
        constraint projects_user_id_fkey
          foreign key (user_id) references users (id) on delete cascade,
        constraint projects_name_check check (length(name) between 1 and 100)
      )
    `);
    // Supports a user's projects changing since a sync cursor; this also indexes user_id alone.
    await queryRunner.query(
      `create index projects_user_updated_idx on projects (user_id, updated_at)`,
    );
    await queryRunner.query(`
      create trigger projects_updated_at
        before insert or update on projects
        for each row execute function set_updated_at()
    `);

    // Existing tasks keep their null value. A project may be removed without removing its tasks.
    await queryRunner.query(`
      alter table tasks
        add column project_id uuid,
        add constraint tasks_project_id_fkey
          foreign key (project_id) references projects (id) on delete set null,
        add constraint tasks_project_needs_personal_task
          check (project_id is null or group_id is null)
    `);
    // Project task lists look up this nullable foreign key directly.
    await queryRunner.query(
      `create index tasks_project_id_idx on tasks (project_id)`,
    );

    // A simple foreign key establishes that the project exists. This trigger also establishes
    // that it belongs to the task's owner, so a project can never expose a task to another user.
    await queryRunner.query(`
      create function guard_task_project()
      returns trigger
      language plpgsql
      as $$
      begin
        -- Return before the project lookup: a task without a project must not lock that table.
        if new.project_id is null then
          return new;
        end if;
        if not exists (
          select 1 from projects p
          where p.id = new.project_id and p.user_id = new.user_id
        ) then
          raise exception 'project does not belong to task owner'
            using errcode = '23514', constraint = 'tasks_project_owner_check';
        end if;
        return new;
      end;
      $$
    `);
    await queryRunner.query(`
      create trigger tasks_guard_project
        before insert or update on tasks
        for each row execute function guard_task_project()
    `);

    // Deleted task tombstones have no project membership, just as they no longer have content.
    await queryRunner.query(`
      create or replace function blank_deleted_task()
      returns trigger
      language plpgsql
      as $$
      begin
        new.parent_id := null;
        new.project_id := null;
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
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop trigger tasks_guard_project on tasks`);
    await queryRunner.query(`drop function guard_task_project()`);

    // Restore the B5 version before dropping project_id from tasks.
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
        if tg_op = 'UPDATE' then
          delete from task_logs where task_id = new.id;
        end if;
        return new;
      end;
      $$
    `);
    await queryRunner.query(`drop index tasks_project_id_idx`);
    await queryRunner.query(`
      alter table tasks
        drop constraint tasks_project_needs_personal_task,
        drop column project_id
    `);
    await queryRunner.query(`drop table projects`);
  }
}
